import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthResult } from "../src/auth.js";
import { createTerminalProxyServer } from "../src/index.js";
import {
  ConnectionRegistry,
  KeepAliveManager,
  serializeKeepAliveStatusPayload,
  type WorkspaceHealth,
} from "../src/keepalive.js";
import { TerminalSessionEventStore } from "../src/session-events.js";

function createMockCoderApi(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function addWithMeta(
  registry: ConnectionRegistry,
  workspaceId: string,
  connectionId: string,
  coderUrl: string,
  token = "integration-test-token",
) {
  registry.addConnection(workspaceId, connectionId, { token, coderUrl });
}

function createFakeKeepAliveManager(health: Record<string, WorkspaceHealth> = {}) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getHealth: vi.fn(() => health),
  };
}

function sessionEventFixtures(): TerminalSessionEventStore {
  const eventStore = new TerminalSessionEventStore();
  eventStore.record({
    workspaceId: "ws-index",
    connectionId: "connection-1",
    sessionName: "terminal-1",
    sessionKind: "terminal",
    type: "upstream_connected",
  });
  eventStore.record({
    workspaceId: "ws-other-user",
    connectionId: "connection-2",
    sessionName: "private-session",
    sessionKind: "terminal",
    type: "upstream_connected",
  });
  return eventStore;
}

async function successfulStatusAuthentication(): Promise<AuthResult> {
  return {
    ok: true,
    value: {
      token: "secret-token",
      coderUrl: "http://coder.test",
      sessionId: "sess-1",
      username: "alice",
    },
  };
}

function makeUpgradeReq(url = "/ws"): IncomingMessage {
  return {
    url,
    headers: { host: "localhost", origin: "http://localhost:3000" },
  } as IncomingMessage;
}

function makeUpgradeSocket(): Duplex & { written: string[] } {
  const written: string[] = [];
  return {
    writable: true,
    written,
    write: vi.fn((data: string) => {
      written.push(data);
      return true;
    }),
    destroy: vi.fn(),
  } as unknown as Duplex & { written: string[] };
}

describe("KeepAliveManager integration", () => {
  let registry: ConnectionRegistry;
  let server: Server;
  let manager: KeepAliveManager;
  let requestLog: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }[];
  let responseStatus: number;
  let mockUrl: string;

  beforeEach(async () => {
    requestLog = [];
    responseStatus = 200;

    const mock = await createMockCoderApi((req, res) => {
      requestLog.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      res.writeHead(responseStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: responseStatus === 200 }));
    });

    server = mock.server;
    mockUrl = mock.url;
    registry = new ConnectionRegistry();
    manager = new KeepAliveManager(registry, mock.url);
  });

  afterEach(async () => {
    manager.stop();
    await closeServer(server);
  });

  it("pings the mock Coder API extend endpoint", async () => {
    addWithMeta(registry, "ws-123", "conn-a", mockUrl);
    await manager.ping("ws-123");

    expect(requestLog).toHaveLength(1);
    expect(requestLog[0].method).toBe("PUT");
    expect(requestLog[0].url).toBe("/api/v2/workspaces/ws-123/extend");
    expect(requestLog[0].headers["coder-session-token"]).toBe("integration-test-token");
  });

  it("sends a valid deadline in the request body", async () => {
    let capturedBody = "";
    await closeServer(server);

    const mock = await createMockCoderApi((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200);
        res.end();
      });
    });
    server = mock.server;
    manager = new KeepAliveManager(registry, mock.url);

    addWithMeta(registry, "ws-1", "conn-1", mock.url, "tok");
    await manager.ping("ws-1");

    const parsed = JSON.parse(capturedBody);
    expect(parsed.deadline).toBeDefined();
    const deadline = new Date(parsed.deadline);
    expect(deadline.getTime()).toBeGreaterThan(Date.now());
  });

  it("increments consecutiveFailures on API 500 error", async () => {
    responseStatus = 500;
    addWithMeta(registry, "ws-err", "conn-1", mockUrl);

    await manager.ping("ws-err");
    expect(manager.getHealth()["ws-err"].consecutiveFailures).toBe(1);

    await manager.ping("ws-err");
    const health = manager.getHealth()["ws-err"];
    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastFailureCategory).toBe("http-server");
    expect(health).not.toHaveProperty("lastError");
  });

  it("increments consecutiveFailures on API 401 (expired token)", async () => {
    responseStatus = 401;
    addWithMeta(registry, "ws-auth", "conn-1", mockUrl);

    await manager.ping("ws-auth");

    const health = manager.getHealth()["ws-auth"];
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureCategory).toBe("http-auth");
    expect(health.lastFailureReason).toBe("coder-auth-rejected");
    expect(health.lastHttpStatus).toBe(401);
    expect(health.lastFailure).toBeTruthy();
    expect(health).not.toHaveProperty("lastError");
  });

  it("reports manual shutdown keepalive as not applicable", async () => {
    responseStatus = 409;
    await closeServer(server);

    const mock = await createMockCoderApi((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Workspace shutdown is manual." }));
    });
    server = mock.server;
    mockUrl = mock.url;
    manager = new KeepAliveManager(registry, mock.url);
    addWithMeta(registry, "ws-manual", "conn-1", mockUrl);

    await manager.ping("ws-manual");

    const health = manager.getHealth()["ws-manual"];
    expect(health.status).toBe("not-applicable");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastFailureCategory).toBe("manual-shutdown");
    expect(health.lastFailureReason).toBe("manual-shutdown");
    expect(health.lastHttpStatus).toBe(409);
    expect(health.lastFailureDetail).toContain("not applicable");
  });

  it("resets consecutiveFailures on recovery after failures", async () => {
    responseStatus = 500;
    addWithMeta(registry, "ws-recover", "conn-1", mockUrl);

    await manager.ping("ws-recover");
    await manager.ping("ws-recover");
    expect(manager.getHealth()["ws-recover"].consecutiveFailures).toBe(2);

    responseStatus = 200;
    await manager.ping("ws-recover");

    const health = manager.getHealth()["ws-recover"];
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastSuccess).toBeTruthy();
  });

  it("does not ping when no workspaces are connected", async () => {
    vi.useFakeTimers();
    manager.start();
    await vi.advanceTimersByTimeAsync(60_000);
    manager.stop();
    vi.useRealTimers();

    expect(requestLog).toHaveLength(0);
  });

  it("handles network timeout (unreachable server) as failure", async () => {
    await closeServer(server);
    const mock = await createMockCoderApi((_req, _res) => {
      // never respond — simulates timeout
    });
    server = mock.server;
    manager = new KeepAliveManager(registry, mock.url);

    addWithMeta(registry, "ws-timeout", "conn-1", mock.url, "tok");

    await manager.ping("ws-timeout");

    const health = manager.getHealth()["ws-timeout"];
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureCategory).toBe("timeout");
    expect(health).not.toHaveProperty("lastError");
  }, 15_000);

  it("accumulates exactly 3 failures for banner threshold scenario", async () => {
    responseStatus = 500;
    addWithMeta(registry, "ws-banner", "conn-1", mockUrl);

    await manager.ping("ws-banner");
    await manager.ping("ws-banner");
    await manager.ping("ws-banner");

    expect(manager.getHealth()["ws-banner"].consecutiveFailures).toBe(3);
  });

  it("does not leak session token in health output", async () => {
    addWithMeta(registry, "ws-sec", "conn-1", mockUrl);
    await manager.ping("ws-sec");

    const healthJson = JSON.stringify(manager.getHealth());
    expect(healthJson).not.toContain("integration-test-token");
  });
});

describe("/keepalive/status endpoint integration", () => {
  let registry: ConnectionRegistry;
  let manager: KeepAliveManager;
  let appServer: Server;
  let appUrl: string;
  let coderServer: Server;
  let coderUrl: string;
  let coderResponseStatus: number;
  let coderResponseBody: string;

  beforeEach(async () => {
    coderResponseStatus = 200;
    coderResponseBody = "{}";

    const coderMock = await createMockCoderApi((_req, res) => {
      res.writeHead(coderResponseStatus, { "Content-Type": "application/json" });
      res.end(coderResponseBody);
    });
    coderServer = coderMock.server;
    coderUrl = coderMock.url;

    registry = new ConnectionRegistry();
    manager = new KeepAliveManager(registry, coderMock.url);

    appServer = createServer((req, res) => {
      if (req.url === "/keepalive/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(serializeKeepAliveStatusPayload(manager.getHealth())));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      appServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = appServer.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address");
    appUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    manager.stop();
    await closeServer(appServer);
    await closeServer(coderServer);
  });

  it("returns correct response shape with empty workspaces", async () => {
    const res = await fetch(`${appUrl}/keepalive/status`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ workspaces: {} });
  });

  it("returns old fields plus sanitized category fields after pings", async () => {
    addWithMeta(registry, "ws-status", "conn-1", coderUrl, "tok");
    await manager.ping("ws-status");

    const res = await fetch(`${appUrl}/keepalive/status`);
    const data = await res.json();

    expect(data.workspaces["ws-status"]).toBeDefined();
    expect(data.workspaces["ws-status"].consecutiveFailures).toBe(0);
    expect(data.workspaces["ws-status"].lastSuccess).toBeTruthy();
    expect(data.workspaces["ws-status"].lastFailure).toBeNull();
    expect(data.workspaces["ws-status"].status).toBe("healthy");
    expect(data.workspaces["ws-status"].lastAttempt).toBeTruthy();
    expect(data.workspaces["ws-status"].lastFailureCategory).toBeNull();
    expect(data.workspaces["ws-status"].lastFailureReason).toBeNull();
    expect(data.workspaces["ws-status"].lastFailureDetail).toBeNull();
    expect(data.workspaces["ws-status"].lastHttpStatus).toBeNull();
    expect(data.workspaces["ws-status"].lastAttemptDurationMs).toEqual(expect.any(Number));
    expect(data.workspaces["ws-status"].activeConnectionCount).toBe(1);
    expect(data.workspaces["ws-status"].lastDisconnectedAt).toBeNull();
    expect(data.workspaces["ws-status"]).not.toHaveProperty("lastError");
  });

  it("does not expose failed response body markers or lastError in status response", async () => {
    coderResponseStatus = 500;
    coderResponseBody =
      "secret-tok clone-proof-abc /Users/alice/projects/kethalia/hive session-name-from-body";
    addWithMeta(registry, "ws-failed", "conn-1", coderUrl, "secret-tok");

    await manager.ping("ws-failed");

    const res = await fetch(`${appUrl}/keepalive/status`);
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.workspaces["ws-failed"].status).toBe("failing");
    expect(data.workspaces["ws-failed"].lastFailureCategory).toBe("http-server");
    expect(data.workspaces["ws-failed"].lastFailureReason).toBe("coder-server-error");
    expect(data.workspaces["ws-failed"].lastFailureDetail).toBeTruthy();
    expect(text).not.toContain("secret-tok");
    expect(text).not.toContain("clone-proof-abc");
    expect(text).not.toContain("/Users/alice/projects/kethalia/hive");
    expect(text).not.toContain("session-name-from-body");
    expect(text).not.toContain("lastError");
  });

  it("reports recently disconnected workspace status without tokens", async () => {
    addWithMeta(registry, "ws-disconnected", "conn-1", coderUrl, "recent-secret-token");
    await manager.ping("ws-disconnected");
    registry.removeConnection("ws-disconnected", "conn-1");

    const res = await fetch(`${appUrl}/keepalive/status`);
    const text = await res.text();
    const data = JSON.parse(text);

    expect(data.workspaces["ws-disconnected"].status).toBe("recently-disconnected");
    expect(data.workspaces["ws-disconnected"].activeConnectionCount).toBe(0);
    expect(data.workspaces["ws-disconnected"].lastDisconnectedAt).toBeTruthy();
    expect(text).not.toContain("recent-secret-token");
  });
});

describe("terminal-proxy server wiring", () => {
  it("serves authenticated session events scoped to authorized workspaces", async () => {
    const fakeKeepAlive = createFakeKeepAliveManager();
    const eventStore = sessionEventFixtures();
    const statusAuthenticator = vi.fn(successfulStatusAuthentication);
    const authorizedWorkspaceResolver = vi.fn(async () => new Set(["ws-index"]));
    const { server } = createTerminalProxyServer({
      keepAliveManager: fakeKeepAlive,
      sessionEventStore: eventStore,
      statusAuthenticator,
      authorizedWorkspaceResolver,
    });

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");

      const res = await fetch(`http://127.0.0.1:${addr.port}/session-events?workspaceId=ws-index`, {
        headers: { cookie: "hive-session=valid" },
      });
      const text = await res.text();
      const data = JSON.parse(text);

      expect(res.status).toBe(200);
      expect(data.events).toHaveLength(1);
      expect(data.events[0]).toMatchObject({
        workspaceId: "ws-index",
        sessionName: "terminal-1",
        type: "upstream_connected",
      });
      expect(text).not.toContain("ws-other-user");
      expect(text).not.toContain("private-session");

      const unauthorized = await fetch(
        `http://127.0.0.1:${addr.port}/session-events?workspaceId=ws-other-user`,
        { headers: { cookie: "hive-session=valid" } },
      );
      expect(unauthorized.status).toBe(404);

      const sessionScoped = await fetch(
        `http://127.0.0.1:${addr.port}/session-events?workspaceId=ws-index&sessionName=terminal-1`,
        { headers: { cookie: "hive-session=valid" } },
      );
      const sessionData = await sessionScoped.json();
      expect(sessionScoped.status).toBe(200);
      expect(sessionData.events).toHaveLength(1);
      expect(sessionData.events[0].sessionName).toBe("terminal-1");
    } finally {
      await closeServer(server);
    }
  });

  it("deduplicates overlapping workspace authorization lookups", async () => {
    const fakeKeepAlive = createFakeKeepAliveManager();
    const eventStore = sessionEventFixtures();
    const statusAuthenticator = vi.fn(successfulStatusAuthentication);
    let finishLookup: ((workspaceIds: Set<string>) => void) | undefined;
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    const authorizedWorkspaceResolver = vi.fn(
      () =>
        new Promise<Set<string>>((resolve) => {
          signalLookupStarted?.();
          finishLookup = resolve;
        }),
    );
    const { server } = createTerminalProxyServer({
      keepAliveManager: fakeKeepAlive,
      sessionEventStore: eventStore,
      statusAuthenticator,
      authorizedWorkspaceResolver,
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const first = fetch(`${baseUrl}/session-events?workspaceId=ws-index`);
      const second = fetch(`${baseUrl}/keepalive/status`);
      await lookupStarted;
      expect(authorizedWorkspaceResolver).toHaveBeenCalledOnce();
      finishLookup?.(new Set(["ws-index"]));

      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 for malformed request hosts without an unhandled rejection", async () => {
    const fakeKeepAlive = createFakeKeepAliveManager();
    const statusAuthenticator = vi.fn(successfulStatusAuthentication);
    const authorizedWorkspaceResolver = vi.fn(async () => new Set(["ws-index"]));
    const { server } = createTerminalProxyServer({
      keepAliveManager: fakeKeepAlive,
      statusAuthenticator,
      authorizedWorkspaceResolver,
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");

      const responseText = await new Promise<string>((resolve, reject) => {
        const socket = connect(addr.port, "127.0.0.1", () => {
          socket.write("GET /session-events HTTP/1.1\r\nHost: %\r\nConnection: close\r\n\r\n");
        });
        let body = "";
        socket.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        socket.on("end", () => resolve(body));
        socket.on("error", reject);
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(responseText).toContain("400 Bad Request");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await closeServer(server);
    }
  });

  it("serves authenticated /keepalive/status rows scoped to authorized workspaces", async () => {
    const fakeKeepAlive = createFakeKeepAliveManager({
      "ws-index": {
        status: "failing",
        consecutiveFailures: 2,
        lastAttempt: "2026-06-07T19:00:00.000Z",
        lastSuccess: null,
        lastFailure: "2026-06-07T19:00:01.000Z",
        lastFailureCategory: "http-server",
        lastFailureReason: "coder-server-error",
        lastFailureDetail: "HTTP 500: Coder failed while extending the workspace.",
        lastHttpStatus: 500,
        lastHttpStatusText: "Internal Server Error",
        lastAttemptDurationMs: 42,
        activeConnectionCount: 1,
        lastDisconnectedAt: null,
      },
      "ws-other-user": {
        status: "healthy",
        consecutiveFailures: 0,
        lastAttempt: "2026-06-07T19:00:00.000Z",
        lastSuccess: "2026-06-07T19:00:00.000Z",
        lastFailure: null,
        lastFailureCategory: null,
        lastFailureReason: null,
        lastFailureDetail: null,
        lastHttpStatus: null,
        lastHttpStatusText: null,
        lastAttemptDurationMs: 12,
        activeConnectionCount: 1,
        lastDisconnectedAt: null,
      },
    });
    const statusAuthenticator = vi.fn(async () => ({
      ok: true as const,
      value: {
        token: "secret-token",
        coderUrl: "http://coder.test",
        sessionId: "sess-1",
        username: "alice",
      },
    }));
    const authorizedWorkspaceResolver = vi.fn(async () => new Set(["ws-index"]));
    const { server } = createTerminalProxyServer({
      keepAliveManager: fakeKeepAlive,
      statusAuthenticator,
      authorizedWorkspaceResolver,
    });

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");

      const res = await fetch(`http://127.0.0.1:${addr.port}/keepalive/status`, {
        headers: { cookie: "hive-session=valid" },
      });
      const text = await res.text();
      const data = JSON.parse(text);

      expect(fakeKeepAlive.start).toHaveBeenCalledOnce();
      expect(statusAuthenticator).toHaveBeenCalledOnce();
      expect(authorizedWorkspaceResolver).toHaveBeenCalledOnce();
      expect(data.workspaces["ws-index"].status).toBe("failing");
      expect(data.workspaces["ws-index"].lastFailureCategory).toBe("http-server");
      expect(data.workspaces["ws-other-user"]).toBeUndefined();
      expect(text).not.toContain("lastError");
      expect(text).not.toContain("secret-token");
      expect(text).not.toContain("cloneProof");
    } finally {
      await closeServer(server);
    }

    expect(fakeKeepAlive.stop).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated /keepalive/status requests", async () => {
    const fakeKeepAlive = createFakeKeepAliveManager();
    const statusAuthenticator = vi.fn(async () => ({
      ok: false as const,
      value: { error: "No cookie provided", status: 401, reason: "no_cookie" },
    }));
    const { server } = createTerminalProxyServer({
      keepAliveManager: fakeKeepAlive,
      statusAuthenticator,
    });

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");

      const res = await fetch(`http://127.0.0.1:${addr.port}/keepalive/status`);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect(data).toEqual({ error: "Unauthorized" });
      expect(fakeKeepAlive.getHealth).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("sanitizes unexpected top-level upgrade fallback errors before logging or writing to socket", async () => {
    const rawError =
      "SECRET_TOKEN=abc cloneProof=proof-material /Users/alice/projects/kethalia/hive session=my-session";
    const fakeKeepAlive = createFakeKeepAliveManager();
    const upgradeHandler = vi.fn(async () => {
      throw new Error(rawError);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const { server } = createTerminalProxyServer({
        keepAliveManager: fakeKeepAlive,
        upgradeHandler,
      });
      const socket = makeUpgradeSocket();

      server.emit(
        "upgrade",
        makeUpgradeReq("/ws?cloneProof=proof-material"),
        socket,
        Buffer.alloc(0),
      );
      await new Promise((resolve) => setImmediate(resolve));

      const logged = errorSpy.mock.calls.flat().map(String).join("\n");
      const socketOutput = socket.written.join("\n");

      expect(upgradeHandler).toHaveBeenCalledOnce();
      expect(logged).toContain("event=upgrade_failed");
      expect(logged).toContain("category=unexpected_upgrade_error");
      expect(logged).not.toContain(rawError);
      expect(logged).not.toContain("SECRET_TOKEN");
      expect(logged).not.toContain("proof-material");
      expect(logged).not.toContain("/Users/alice/projects/kethalia/hive");
      expect(logged).not.toContain("my-session");
      expect(socketOutput).toBe("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      expect(socketOutput).not.toContain(rawError);
      expect(socket.destroy).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
