import { AuthServiceClient } from "@hive/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Context, runRequestLifetime } from "../../../deploy/cloudflare/app/request-lifetime";
import { createNativeWorker } from "../../../deploy/cloudflare/native/composition.mjs";
import { createFetchAuthHandler } from "../../../services/auth/src/fetch-handler";

type Binding = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
const secret = "a".repeat(64);
const env = {
  HIVE_NATIVE_MODE: "preview",
  HIVE_PUBLIC_ORIGIN: "https://foundation.example",
  DATABASE_URL:
    "postgresql://hive_foundation_runtime:fixture@database.invalid/hive_foundation_preview",
  HIVE_DATABASE_NAME: "hive_foundation_preview",
  HIVE_DATABASE_ROLE: "hive_foundation_runtime",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  auth: (request: Request, context: Context) => Promise<Response>,
  app: (binding: Binding) => Promise<Response>,
) {
  const tasks: Promise<unknown>[] = [];
  const context: Context = { waitUntil: (work) => tasks.push(work), passThroughOnException() {} };
  const dispatch = vi.fn((request: Request, _env: unknown, current: Context) =>
    auth(request, current),
  );
  const worker = createNativeWorker({
    app: {
      fetch: (_request: Request, local: { AUTH_SERVICE: Binding }) => app(local.AUTH_SERVICE),
    },
    auth: { fetch: dispatch },
  });
  return {
    dispatch,
    tasks,
    run: () => worker.fetch(new Request(env.HIVE_PUBLIC_ORIGIN), env, context),
    async drain() {
      let count = 0;
      while (count < tasks.length) {
        const batch = tasks.slice(count);
        count = tasks.length;
        await Promise.all(batch);
      }
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("native internal authentication cancellation", () => {
  it("rejects the client's deadline while retaining dispatched domain work and closing its late response lifetime", async () => {
    const deadline = new AbortController();
    const clock = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const entered = deferred<void>(),
      finish = deferred<null>();
    const close = vi.fn(async () => {});
    const handle = createFetchAuthHandler(secret, {
      performLogin: vi.fn(),
      deleteSession: vi.fn(),
      getTokenStatus: vi.fn(),
      getDecryptedCoderToken: vi.fn(),
      getSessionById: async () => {
        entered.resolve();
        return finish.promise;
      },
    });
    const f = fixture(
      (request, context) =>
        runRequestLifetime({ run: (operation) => operation(), close }, context, async () =>
          handle(request),
        ),
      async (binding) => {
        const client = new AuthServiceClient("https://auth.internal", undefined, {
          serviceSecret: secret,
          fetch: binding.fetch,
        });
        await client.getSession("fixture-session");
        return new Response("done");
      },
    );
    const pending = f.run();
    await entered.promise;
    expect(clock).toHaveBeenCalledWith(10000);
    const expired = new DOMException("fixture deadline", "TimeoutError");
    deadline.abort(expired);
    await expect(pending).rejects.toBe(expired);
    expect(close).not.toHaveBeenCalled();
    expect(f.tasks.length).toBeGreaterThan(0);
    finish.resolve(null);
    await f.drain();
    expect(close).toHaveBeenCalledOnce();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    true,
    false,
  ])("does not dispatch a pre-aborted or immediately canceled request (pre=%s)", async (pre) => {
    const controller = new AbortController();
    const reason = new DOMException("fixture abort", "AbortError");
    if (pre) controller.abort(reason);
    const f = fixture(
      async () => new Response("unexpected"),
      (binding) => binding.fetch("https://auth.internal/health", { signal: controller.signal }),
    );
    const pending = f.run();
    if (!pre) controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await f.drain();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("cancels an unconsumed late response and handles a late operation rejection", async () => {
    for (const reject of [false, true]) {
      const controller = new AbortController();
      const entered = deferred<void>(),
        finish = deferred<Response>();
      const cancel = vi.fn();
      const f = fixture(
        async () => {
          entered.resolve();
          return finish.promise;
        },
        (binding) => binding.fetch("https://auth.internal/health", { signal: controller.signal }),
      );
      const pending = f.run();
      await entered.promise;
      controller.abort();
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      if (reject) finish.reject(Error("fixture late domain failure"));
      else finish.resolve(new Response(new ReadableStream({ cancel })));
      await f.drain();
      expect(cancel).toHaveBeenCalledTimes(reject ? 0 : 1);
    }
  });

  it("aborts a pending response body after its headers have already been delivered", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const f = fixture(
      async () => new Response(new ReadableStream({ cancel })),
      (binding) => binding.fetch("https://auth.internal/health", { signal: controller.signal }),
    );
    const response = await f.run();
    const body = response.text();
    controller.abort();
    await expect(body).rejects.toHaveProperty("name", "AbortError");
    await f.drain();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves successful authentication responses and ordinary operation failures", async () => {
    const f = fixture(
      async () =>
        Response.json({ status: "ok" }, { status: 201, headers: { "X-Fixture": "preserved" } }),
      (binding) => binding.fetch("https://auth.internal/health"),
    );
    const response = await f.run();
    expect(response.status).toBe(201);
    expect(response.headers.get("X-Fixture")).toBe("preserved");
    expect(await response.json()).toEqual({ status: "ok" });
    await f.drain();
    const failure = Error("fixture domain failure");
    const g = fixture(
      async () => {
        throw failure;
      },
      (binding) => binding.fetch("https://auth.internal/health"),
    );
    await expect(g.run()).rejects.toBe(failure);
    await g.drain();
  });
});
