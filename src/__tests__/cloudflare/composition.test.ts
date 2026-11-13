import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  audio: vi.fn(),
  shell: vi.fn(),
  diagnostics: vi.fn(),
}));
vi.mock("@hive/db/cloudflare", () => ({ createCloudflareDatabaseRequest: mocks.database }));
vi.mock("../../../deploy/cloudflare/app/audio-runtime", () => ({ audioRuntime: mocks.audio }));
vi.mock("../../../deploy/cloudflare/app/generic-terminal-runtime", () => ({
  genericTerminalRelay: mocks.shell,
}));
vi.mock("@/lib/terminal/diagnostics.server", () => ({
  terminalDiagnosticsPath: (request: Request) =>
    ["/keepalive/status", "/session-events"].includes(new URL(request.url).pathname),
  terminalDiagnosticsRuntime: mocks.diagnostics,
}));

import { createAppWorker } from "../../../deploy/cloudflare/app/composition";
import {
  isPortableDiscovery,
  isPortableServerAction,
} from "../../../deploy/cloudflare/app/portable-actions";

const origin = "https://hive.example",
  actionId = "0".repeat(42);
const actions = {
  schemaVersion: 1,
  actions: { [actionId]: { paths: ["/workspaces"], maxBodyBytes: 65536 } },
};
const env = { DATABASE_URL: "postgresql://fixture.invalid/database", HIVE_PUBLIC_ORIGIN: origin };
let run: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>,
  framework: ReturnType<typeof vi.fn>,
  tasks: Promise<unknown>[];
const context = {
  waitUntil(task: Promise<unknown>) {
    tasks.push(task);
  },
  passThroughOnException: vi.fn(),
};
const action = (path = "/workspaces", headers: Record<string, string> = {}) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    body: '[{"workspaceId":"synthetic"}]',
    headers: {
      Origin: origin,
      "Next-Action": actionId,
      "Content-Type": "text/plain;charset=UTF-8",
      ...headers,
    },
  });
function upgrade() {
  const response = new Response(null);
  Object.defineProperty(response, "status", { value: 101 });
  return response;
}
beforeEach(() => {
  vi.clearAllMocks();
  tasks = [];
  run = vi.fn((operation: () => unknown) => operation());
  close = vi.fn(async () => {});
  mocks.database.mockReturnValue({ run, close });
  framework = vi.fn(async () => Response.json({ authenticatedRoute: true }));
  mocks.audio.mockResolvedValue(upgrade());
  mocks.shell.mockResolvedValue(upgrade());
  mocks.diagnostics.mockResolvedValue(Response.json({ workspaces: {} }));
});
describe("normal application Worker entrypoints", () => {
  it("injects a lazy sibling database factory only at the custom Worker shell boundary", async () => {
    const request = new Request(`${origin}/ws`, { headers: { Upgrade: "websocket" } });
    const worker = createAppWorker({ fetch: framework }, actions);
    const response = await worker.fetch(request, env, context);
    expect(response.status).toBe(101);
    expect(mocks.database).not.toHaveBeenCalled();
    const factory = mocks.shell.mock.calls[0][4];
    const bounds = { queryTimeoutMillis: 5000, transactionTimeoutMillis: 5000 };
    const sibling = factory(bounds);
    expect(mocks.database).toHaveBeenCalledWith(env.DATABASE_URL, bounds);
    await sibling.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    "/ws/audio?workspaceId=w&agentId=a&sessionName=s",
    "/ws?workspaceId=w",
  ])("dispatches dedicated WebSocket transport %s outside the HTTP DB lifetime", async (path) => {
    const request = new Request(`${origin}${path}`, { headers: { Upgrade: "websocket" } });
    const response = await createAppWorker({ fetch: framework }, actions).fetch(
      request,
      env,
      context,
    );
    expect(response.status).toBe(101);
    const handler = path.startsWith("/ws/audio") ? mocks.audio : mocks.shell;
    if (path.startsWith("/ws/audio"))
      expect(handler).toHaveBeenCalledWith(request, env, Number.MAX_SAFE_INTEGER, context);
    else
      expect(handler).toHaveBeenCalledWith(
        request,
        env,
        Number.MAX_SAFE_INTEGER,
        context,
        expect.any(Function),
      );
    expect(mocks.database).not.toHaveBeenCalled();
    expect(framework).not.toHaveBeenCalled();
  });
  it.each([
    "/api/workspaces/w/terminal/paste-assets",
    "/api/notifications/events",
    "/api/notifications/sources",
    "/api/templates/ai-dev-k8s/push",
    "/api/workspaces/w/voice",
  ])("preserves existing route auth and request bytes through the DB lifetime for %s", async (path) => {
    const request = new Request(`${origin}${path}`, {
      method: "POST",
      headers: { Cookie: "synthetic", Origin: origin, "Content-Type": "application/json" },
      body: '{"input":"unchanged"}',
    });
    framework.mockImplementation(async (received: Request) => {
      expect(received).toBe(request);
      expect(await received.text()).toBe('{"input":"unchanged"}');
      expect(received.headers.get("Cookie")).toBe("synthetic");
      return Response.json({ error: "Sign in required" }, { status: 401 });
    });
    const response = await createAppWorker({ fetch: framework }, actions).fetch(
      request,
      env,
      context,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(close).not.toHaveBeenCalled();
    await response.text();
    await Promise.all(tasks);
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([
    "/keepalive/status",
    "/session-events?after=2&limit=500",
  ])("runs signed diagnostics handler %s in the HTTP database scope", async (path) => {
    const request = new Request(`${origin}${path}`, {
      headers: { Authorization: "Bearer synthetic-ticket" },
    });
    const response = await createAppWorker({ fetch: framework }, actions).fetch(
      request,
      env,
      context,
    );
    expect(mocks.diagnostics).toHaveBeenCalledWith(request, env);
    expect(framework).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    await response.text();
    await Promise.all(tasks);
    expect(close).toHaveBeenCalledOnce();
  });
  it("retains the database until both streamed content and tracked framework work drain", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>, done!: () => void;
    const work = new Promise<void>((resolve) => {
      done = resolve;
    });
    framework.mockImplementation(
      async (_request: Request, _env: object, tracked: typeof context) => {
        tracked.waitUntil(work);
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
            },
          }),
        );
      },
    );
    const response = await createAppWorker({ fetch: framework }, actions).fetch(
      new Request(`${origin}/workspaces`),
      env,
      context,
    );
    expect(close).not.toHaveBeenCalled();
    stream.enqueue(new TextEncoder().encode("html"));
    stream.close();
    expect(await response.text()).toBe("html");
    expect(close).not.toHaveBeenCalled();
    done();
    await Promise.all(tasks);
    expect(close).toHaveBeenCalledOnce();
  });
  it("admits repository discovery and retains GET-only unknown-resource rejection", async () => {
    expect(
      isPortableDiscovery(
        new Request(`${origin}/api/discovery/repositories?workspaceId=w`),
        true,
        true,
      ),
    ).toBe(true);
    expect(
      isPortableDiscovery(
        new Request(`${origin}/api/discovery/repositories`, { method: "POST" }),
        true,
        true,
      ),
    ).toBe(false);
    const worker = createAppWorker({ fetch: framework }, actions);
    const okay = await worker.fetch(
      new Request(`${origin}/api/discovery/repositories?workspaceId=w`),
      env,
      context,
    );
    expect(okay.status).toBe(200);
    await okay.text();
    await Promise.all(tasks);
    const rejected = await worker.fetch(
      new Request(`${origin}/api/discovery/unknown`),
      env,
      context,
    );
    expect(rejected.status).toBe(503);
  });
  it("preserves deep-link action bytes while keeping method, origin and export admission", async () => {
    const request = action("/workspaces?panel=agents&workspace=synthetic");
    expect(isPortableServerAction(request, actions)).toBe(true);
    framework.mockImplementation(async (received: Request) => {
      expect(await received.text()).toBe('[{"workspaceId":"synthetic"}]');
      expect(received.headers.get("Next-Action")).toBe(actionId);
      return Response.json({ data: true });
    });
    const response = await createAppWorker({ fetch: framework }, actions).fetch(
      request,
      env,
      context,
    );
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(tasks);
    expect(framework).toHaveBeenCalledOnce();
    for (const invalid of [
      action("/workspaces", { "Next-Action": "1".repeat(42) }),
      action("/workspaces", { Origin: "https://attacker.example" }),
      action("/admin"),
      new Request(`${origin}/workspaces`, { method: "POST", body: "form-without-action" }),
    ]) {
      expect(
        (await createAppWorker({ fetch: framework }, actions).fetch(invalid, env, context)).status,
      ).toBe(503);
    }
    expect(framework).toHaveBeenCalledOnce();
  });
  it("rejects unknown upgrades before opening a database", async () => {
    const worker = createAppWorker({ fetch: framework }, actions);
    expect(
      (
        await worker.fetch(
          new Request(`${origin}/unknown`, { headers: { Upgrade: "websocket" } }),
          env,
          context,
        )
      ).status,
    ).toBe(503);
    expect(framework).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
  });
});
