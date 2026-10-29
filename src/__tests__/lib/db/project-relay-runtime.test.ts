import { signCookie } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelaySocket } from "../../../../deploy/cloudflare/app/project-relay";

const mock = vi.hoisted(() => ({
  scope: vi.fn(),
  run: vi.fn(),
  close: vi.fn(),
  authorize: vi.fn(),
  coder: vi.fn(),
  exchangeSession: vi.fn(),
  exchangeTerminal: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => ({}) }));
vi.mock("@hive/db/cloudflare", () => ({ createCloudflareDatabaseRequest: mock.scope }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mock.coder }));
vi.mock("@/lib/codex-session/registered-session.server", () => ({
  registeredSessionConfig: () => ({
    sessionTransport: "relay",
    hiveOrigin: "https://preview.example",
  }),
  createRegisteredSessionService: () => ({ authorizeRelayTarget: mock.authorize }),
}));
vi.mock("@/lib/codex-session/bootstrap-delivery.server", () => ({
  exchangeVerifiedWorkspaceAppSessionCookie: mock.exchangeSession,
  exchangeVerifiedWorkspaceAppTerminalCookie: mock.exchangeTerminal,
}));

import { projectRelay } from "../../../../deploy/cloudflare/app/project-relay-runtime";

class Socket implements RelaySocket {
  readyState = 1;
  listeners = new Map<string, Set<(value: never) => void>>();
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  addEventListener(event: string, listener: unknown) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (value: never) => void);
    this.listeners.set(event, set);
  }
  removeEventListener(event: string, listener: unknown) {
    this.listeners.get(event)?.delete(listener as (value: never) => void);
  }
  emit(event: string, value: unknown = {}) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value as never);
  }
}
const NativeResponse = Response,
  origin = "https://preview.example",
  projectId = "00000000-0000-4000-8000-000000000001",
  sessionId = "00000000-0000-4000-8000-000000000002";
let upstream: Socket, pairs: Array<{ client: Socket; server: Socket }>;
const cookieKey = "a".repeat(64);
function env() {
  return {
    HIVE_CODEX_GATEWAY_ENABLED: "true",
    HIVE_CODEX_SESSION_TRANSPORT: "relay",
    HIVE_PREVIEW_ORIGIN: origin,
    COOKIE_SECRET: cookieKey,
    CODER_URL: "https://coder.example",
    AUTH_SERVICE_SECRET: "b".repeat(64),
    AUTH_SERVICE: {
      fetch: vi.fn().mockImplementation(async () =>
        NativeResponse.json({
          userId: "hive-owner",
          coderUserId: "coder-owner",
          coderUrl: "https://coder.example",
          username: "user",
          email: "fixture@example.invalid",
          sessionId,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      ),
    },
  };
}
function request(
  kind = "session",
  cookie = `__Host-hive-session=${signCookie(sessionId, cookieKey)}`,
) {
  return new Request(`${origin}/api/projects/${projectId}/${kind}`, {
    headers: { Origin: origin, Upgrade: "websocket", Cookie: cookie },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T18:00:00Z"));
  upstream = new Socket();
  pairs = [];
  mock.run.mockImplementation((run: () => unknown) => run());
  mock.close.mockResolvedValue(undefined);
  mock.scope.mockImplementation(() => ({ run: mock.run, close: mock.close }));
  mock.coder.mockResolvedValue({});
  mock.authorize.mockResolvedValue({
    coderOrigin: "https://coder.example",
    appOrigin: "https://registered-app.example",
    registrationId: "registration",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    binding: {
      ownerId: "coder-owner",
      workspaceId: "workspace",
      buildId: "build",
      serverInstanceId: "instance",
      threadId: "thread",
    },
  });
  const exchanged = (path: string) => ({
    url: `https://registered-app.example${path}`,
    cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=scoped-cookie`,
  });
  mock.exchangeSession.mockResolvedValue(exchanged("/session"));
  mock.exchangeTerminal.mockResolvedValue(exchanged("/terminal"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 101, webSocket: upstream }));
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0: Socket;
      1: Socket;
      constructor() {
        this[0] = new Socket();
        this[1] = new Socket();
        pairs.push({ client: this[0], server: this[1] });
      }
    },
  );
  vi.stubGlobal(
    "Response",
    class extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        const edge = init as ResponseInit & { webSocket?: RelaySocket };
        super(body, edge?.status === 101 ? { ...edge, status: 200 } : init);
        if (edge?.status === 101) Object.defineProperty(this, "status", { value: 101 });
      }
    },
  );
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("project relay request/database boundary (edge socket simulated)", () => {
  it("releases reservations when database scope creation rejects", async () => {
    mock.scope.mockImplementationOnce(() => {
      throw new Error("Invalid database configuration");
    });
    expect((await projectRelay(request(), env(), Date.now() + 900000)).status).toBe(503);
    expect(mock.close).not.toHaveBeenCalled();
    // All four isolate reservations remain available after the rejected setup.
    for (let index = 0; index < 4; index++)
      expect((await projectRelay(request(), env(), Date.now() + 900000)).status).toBe(101);
  });
  it("closes its database scope before returning101 and performs no DB/auth IO from later messages", async () => {
    const bindings = env();
    const response = await projectRelay(request(), bindings, Date.now() + 900000);
    expect(response.status).toBe(101);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(bindings.AUTH_SERVICE.fetch).toHaveBeenCalledTimes(2);
    expect(mock.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ hiveUserId: "hive-owner", coderUserId: "coder-owner" }),
      projectId,
    );
    pairs[0].server.emit("message", { data: "signed host read ticket" });
    expect(upstream.send).toHaveBeenCalledWith("signed host read ticket");
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
    expect(mock.authorize).toHaveBeenCalledTimes(2);
    expect(bindings.AUTH_SERVICE.fetch).toHaveBeenCalledTimes(2);
  });
  it("fails closed for missing owner cookies/disabled terminal and never attempts cookie exchange", async () => {
    const bindings = env();
    expect((await projectRelay(request("session", ""), bindings, Date.now() + 900000)).status).toBe(
      401,
    );
    expect(mock.exchangeSession).not.toHaveBeenCalled();
    expect(bindings.AUTH_SERVICE.fetch).not.toHaveBeenCalled();
    expect((await projectRelay(request("terminal"), bindings, Date.now() + 900000)).status).toBe(
      503,
    );
    expect(mock.exchangeTerminal).not.toHaveBeenCalled();
  });
  it("terminal capability uses only its separate fixed cookie exchange path", async () => {
    const response = await projectRelay(
      request("terminal"),
      { ...env(), HIVE_CODEX_TERMINAL_ENABLED: "true" },
      Date.now() + 900000,
    );
    expect(response.status).toBe(101);
    expect(mock.exchangeTerminal).toHaveBeenCalledOnce();
    expect(mock.exchangeSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://registered-app.example/terminal",
      expect.objectContaining({
        headers: {
          Upgrade: "websocket",
          Cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=scoped-cookie`,
          Origin: origin,
        },
      }),
    );
  });
  it("disconnect failure cancels both WebSockets instead of returning a live101", async () => {
    mock.close.mockRejectedValueOnce(new Error("disconnect failed"));
    const response = await projectRelay(request(), env(), Date.now() + 900000);
    expect(response.status).toBe(503);
    expect(upstream.close).toHaveBeenCalledWith(1011, "Project transport unavailable");
    expect(pairs[0].server.close).toHaveBeenCalled();
  });
});
