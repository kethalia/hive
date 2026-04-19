import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { addRoute, matchRoute, clearRoutes } from "../src/router.js";
import { sendJson, sendError } from "../src/server.js";

function startTestServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const match = matchRoute(method, url.pathname);
      if (!match) {
        sendError(res, 404, "Not found", "NOT_FOUND");
        return;
      }
      try {
        await match.handler(req, res, match.params);
      } catch {
        sendError(res, 500, "Internal server error", "INTERNAL_ERROR");
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("health endpoint", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    clearRoutes();
    addRoute("GET", "/health", async (_req, res) => {
      sendJson(res, 200, { status: "ok", uptime: process.uptime() });
    });
    const result = await startTestServer();
    server = result.server;
    port = result.port;
  });

  afterAll(() => {
    server.close();
  });

  it("returns 200 with status ok and uptime", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThan(0);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("router", () => {
  beforeAll(() => {
    clearRoutes();
    addRoute("GET", "/sessions/:id", async (_req, res, params) => {
      sendJson(res, 200, { sessionId: params.id });
    });
    addRoute("GET", "/sessions/:id/credentials", async (_req, res, params) => {
      sendJson(res, 200, { sessionId: params.id, type: "credentials" });
    });
  });

  it("matches parameterized paths", () => {
    const match = matchRoute("GET", "/sessions/abc-123");
    expect(match).not.toBeNull();
    expect(match!.params.id).toBe("abc-123");
  });

  it("matches nested parameterized paths", () => {
    const match = matchRoute("GET", "/sessions/abc-123/credentials");
    expect(match).not.toBeNull();
    expect(match!.params.id).toBe("abc-123");
  });

  it("returns null for unmatched routes", () => {
    const match = matchRoute("POST", "/sessions/abc-123");
    expect(match).toBeNull();
  });
});
