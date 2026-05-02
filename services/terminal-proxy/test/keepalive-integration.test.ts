import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionRegistry, KeepAliveManager } from "../src/keepalive.js";

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
    expect(manager.getHealth()["ws-err"].consecutiveFailures).toBe(2);
    expect(manager.getHealth()["ws-err"].lastError).toContain("500");
  });

  it("increments consecutiveFailures on API 401 (expired token)", async () => {
    responseStatus = 401;
    addWithMeta(registry, "ws-auth", "conn-1", mockUrl);

    await manager.ping("ws-auth");

    const health = manager.getHealth()["ws-auth"];
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toContain("401");
    expect(health.lastFailure).toBeTruthy();
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
    expect(health.lastError).toBeTruthy();
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

  beforeEach(async () => {
    const coderMock = await createMockCoderApi((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    coderServer = coderMock.server;
    coderUrl = coderMock.url;

    registry = new ConnectionRegistry();
    manager = new KeepAliveManager(registry, coderMock.url);

    appServer = createServer((req, res) => {
      if (req.url === "/keepalive/status") {
        const workspaces = manager.getHealth();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ workspaces }));
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

  it("returns workspace health after pings", async () => {
    addWithMeta(registry, "ws-status", "conn-1", coderUrl, "tok");
    await manager.ping("ws-status");

    const res = await fetch(`${appUrl}/keepalive/status`);
    const data = await res.json();

    expect(data.workspaces["ws-status"]).toBeDefined();
    expect(data.workspaces["ws-status"].consecutiveFailures).toBe(0);
    expect(data.workspaces["ws-status"].lastSuccess).toBeTruthy();
    expect(data.workspaces["ws-status"].lastFailure).toBeNull();
  });

  it("does not expose session token in status response", async () => {
    addWithMeta(registry, "ws-sec", "conn-1", coderUrl, "secret-tok");
    await manager.ping("ws-sec");

    const res = await fetch(`${appUrl}/keepalive/status`);
    const text = await res.text();
    expect(text).not.toContain("secret-tok");
  });
});
