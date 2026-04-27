import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { addRoute, matchRoute, clearRoutes } from "../src/router.js";
import { parseBody, sendJson, sendError } from "../src/server.js";

vi.mock("../src/auth/login.js", () => ({
  performLogin: vi.fn(),
}));

vi.mock("../src/auth/session.js", () => ({
  getSessionById: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("../src/auth/token-status.js", () => ({
  getTokenStatus: vi.fn(),
}));

vi.mock("../src/auth/rate-limit.js", () => ({
  loginRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true, remaining: 4, resetMs: 60000 }),
  },
}));

vi.mock("../src/db.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

import { handleLogin } from "../src/handlers/login.js";
import { handleLogout } from "../src/handlers/logout.js";
import { handleGetSession } from "../src/handlers/session.js";
import { handleGetCredentials } from "../src/handlers/credentials.js";
import { performLogin } from "../src/auth/login.js";
import { getSessionById, deleteSession } from "../src/auth/session.js";
import { getTokenStatus } from "../src/auth/token-status.js";
import { loginRateLimiter } from "../src/auth/rate-limit.js";

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

describe("HTTP handlers", () => {
  let server: Server;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    clearRoutes();

    addRoute("POST", "/login", async (req, res) => {
      await handleLogin(req, res);
    });

    addRoute("POST", "/logout", async (req, res) => {
      await handleLogout(req, res);
    });

    addRoute("GET", "/sessions/:id", async (req, res, params) => {
      await handleGetSession(req, res, params);
    });

    addRoute("GET", "/sessions/:id/credentials", async (req, res, params) => {
      await handleGetCredentials(req, res, params);
    });

    const result = await startTestServer();
    server = result.server;
    port = result.port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loginRateLimiter.check).mockReturnValue({
      allowed: true,
      remaining: 4,
      resetMs: 60000,
    });
  });

  describe("POST /login", () => {
    it("returns 200 with session on successful login", async () => {
      vi.mocked(performLogin).mockResolvedValue({
        sessionId: "sess-123",
        user: { id: "u1", username: "alice", email: "alice@test.com", coderUrl: "https://coder.test" },
      });

      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://coder.test", email: "alice@test.com", password: "pass" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBe("sess-123");
      expect(body.user.username).toBe("alice");
    });

    it("returns 400 when body is empty", async () => {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("BAD_REQUEST");
    });

    it("returns 400 when email is missing", async () => {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://coder.test", password: "pass" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("email");
    });

    it("returns 400 when password is missing", async () => {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://coder.test", email: "a@b.com" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("password");
    });

    it("returns 400 when coderUrl is missing", async () => {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "pass" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("coderUrl");
    });

    it("returns 401 on invalid credentials", async () => {
      vi.mocked(performLogin).mockRejectedValue(new Error("Invalid credentials"));

      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://coder.test", email: "a@b.com", password: "wrong" }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("INVALID_CREDENTIALS");
    });

    it("returns 502 when Coder is unreachable", async () => {
      vi.mocked(performLogin).mockRejectedValue(new Error("Invalid Coder instance: unreachable"));

      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://bad.coder", email: "a@b.com", password: "pass" }),
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.code).toBe("CODER_UNREACHABLE");
    });

    it("returns 429 when rate limited", async () => {
      vi.mocked(loginRateLimiter.check).mockReturnValue({
        allowed: false,
        remaining: 0,
        resetMs: 45000,
      });

      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://coder.test", email: "a@b.com", password: "pass" }),
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.retryAfterMs).toBe(45000);
      expect(body.code).toBe("RATE_LIMITED");
    });

    it("returns 500 on unexpected error", async () => {
      vi.mocked(performLogin).mockRejectedValue(new Error("something broke"));

      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coderUrl: "https://coder.test", email: "a@b.com", password: "pass" }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("INTERNAL_ERROR");
    });
  });

  describe("POST /logout", () => {
    it("returns 200 on successful logout", async () => {
      vi.mocked(deleteSession).mockResolvedValue();

      const res = await fetch(`${baseUrl}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-123" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(deleteSession).toHaveBeenCalledWith("sess-123");
    });

    it("returns 400 when sessionId is missing", async () => {
      const res = await fetch(`${baseUrl}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("BAD_REQUEST");
    });
  });

  describe("GET /sessions/:id", () => {
    it("returns 200 with session payload when found", async () => {
      vi.mocked(getSessionById).mockResolvedValue({
        user: { id: "u1", coderUrl: "https://coder.test", coderUserId: "cu1", username: "alice", email: "alice@test.com" },
        session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
      });

      const res = await fetch(`${baseUrl}/sessions/sess-123`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe("u1");
      expect(body.username).toBe("alice");
      expect(body.sessionId).toBe("sess-123");
    });

    it("returns 404 when session not found", async () => {
      vi.mocked(getSessionById).mockResolvedValue(null);

      const res = await fetch(`${baseUrl}/sessions/nonexistent`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Session not found");
    });
  });

  describe("GET /sessions/:id/credentials", () => {
    it("returns 200 with credential status when session exists", async () => {
      vi.mocked(getSessionById).mockResolvedValue({
        user: { id: "u1", coderUrl: "https://coder.test", coderUserId: "cu1", username: "alice", email: "alice@test.com" },
        session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
      });
      vi.mocked(getTokenStatus).mockResolvedValue({
        status: "valid",
        expiresAt: new Date("2026-05-01"),
      });

      const res = await fetch(`${baseUrl}/sessions/sess-123/credentials`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("valid");
    });

    it("returns 404 when session not found", async () => {
      vi.mocked(getSessionById).mockResolvedValue(null);

      const res = await fetch(`${baseUrl}/sessions/nonexistent/credentials`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Session not found");
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await fetch(`${baseUrl}/does-not-exist`);
      expect(res.status).toBe(404);
    });

    it("returns 404 for wrong method on existing path", async () => {
      const res = await fetch(`${baseUrl}/login`);
      expect(res.status).toBe(404);
    });
  });
});
