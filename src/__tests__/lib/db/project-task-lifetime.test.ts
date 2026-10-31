import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn() }));
vi.mock("@hive/db/cloudflare", () => ({ createCloudflareDatabaseRequest: mock.create }));

import { PROJECT_RECONCILE_PATH } from "@/lib/projects/reconcile-transport";
import { runProjectTaskReconciliation } from "../../../../deploy/cloudflare/app/project-tasks";

const secret = "c".repeat(64),
  env = {
    HIVE_PROJECT_TASKS_ENABLED: "true",
    HIVE_PROJECT_TASK_RECONCILE_SECRET: secret,
    DATABASE_URL: "fixture",
  };
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
function request() {
  return new Request(`https://hive-app.internal${PROJECT_RECONCILE_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "X-Hive-Reconcile-Deadline": String(Date.now() + 45000),
    },
    body: '{"schemaVersion":1}',
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mock.close.mockResolvedValue(undefined);
  mock.create.mockReturnValue({ run: (fn: () => unknown) => fn(), close: mock.close });
});
afterEach(() => vi.useRealTimers());
describe("private reconciliation app lifetime", () => {
  it("authenticates before creating DB context or dispatching framework", async () => {
    const handler = vi.fn();
    const response = await runProjectTaskReconciliation(
      new Request(request(), { headers: {} }),
      env,
      context,
      handler,
    );
    expect(response.status).toBe(401);
    expect(mock.create).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("closes before returning even when the caller never reads JSON", async () => {
    const response = await runProjectTaskReconciliation(request(), env, context, async () =>
      Response.json({ schemaVersion: 1, processed: 1, retry: 0, stale: 0 }),
    );
    expect(response.status).toBe(200);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(mock.create).toHaveBeenCalledWith("fixture", {
      queryTimeoutMillis: 10000,
      transactionTimeoutMillis: 10000,
    });
    expect(await response.json()).toEqual({ schemaVersion: 1, processed: 1, retry: 0, stale: 0 });
  });
  it("awaits existing handler and framework work rather than racing disconnect", async () => {
    let finish!: () => void;
    const work = new Promise<void>((r) => {
      finish = r;
    });
    const pending = runProjectTaskReconciliation(request(), env, context, async (tracked) => {
      tracked.waitUntil(work);
      return Response.json({ schemaVersion: 1 });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.close).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("bounds private response bytes and stalled cancellation without leaking its DB context", async () => {
    const oversized = await runProjectTaskReconciliation(request(), env, context, async () =>
      Response.json({ data: "x".repeat(513) }),
    );
    expect(oversized.status).toBe(503);
    expect(mock.close).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    const pending = runProjectTaskReconciliation(
      request(),
      env,
      context,
      async () =>
        new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).status).toBe(503);
    expect(mock.close).toHaveBeenCalledTimes(2);
  });
});
