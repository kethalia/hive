import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addRoute, clearRoutes, matchRoute } from "../src/router.js";
import { sendError } from "../src/server.js";

vi.mock("../src/auth/session.js", () => ({
  getSessionById: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("../src/auth/token-status.js", () => ({
  getTokenStatus: vi.fn(),
  getDecryptedCoderToken: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

import { getSessionById } from "../src/auth/session.js";
import { getDecryptedCoderToken } from "../src/auth/token-status.js";
import { handleGetCoderToken } from "../src/handlers/token.js";

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

describe("GET /sessions/:id/token", () => {
  let server: Server;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    clearRoutes();

    addRoute("GET", "/sessions/:id/token", async (req, res, params) => {
      await handleGetCoderToken(req, res, params);
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
  });

  it("returns 200 with token, coderUrl, and expiresAt on success", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockResolvedValue({
      token: "coder-session-token-value",
      expiresAt: new Date("2026-06-01"),
    });

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("coder-session-token-value");
    expect(body.coderUrl).toBe("https://coder.test");
    expect(body.expiresAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("returns 200 with null expiresAt when token has no expiry", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockResolvedValue({
      token: "coder-session-token-value",
      expiresAt: null,
    });

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("coder-session-token-value");
    expect(body.expiresAt).toBeNull();
  });

  it("returns 404 when session not found", async () => {
    vi.mocked(getSessionById).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/sessions/nonexistent/token`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 when no Coder token exists for user", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_NOT_FOUND");
  });

  it("returns 500 with KEY_UNAVAILABLE when encryption key is missing", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockRejectedValue(new Error("KEY_UNAVAILABLE"));

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("KEY_UNAVAILABLE");
  });

  it("returns 500 with KEY_MISMATCH on key mismatch", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockRejectedValue(new Error("KEY_MISMATCH"));

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("KEY_MISMATCH");
  });

  it("returns 500 with DECRYPT_FAILED on corrupt ciphertext", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockRejectedValue(new Error("DECRYPT_FAILED"));

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DECRYPT_FAILED");
  });

  it("returns 500 with INTERNAL_ERROR on unexpected errors", async () => {
    vi.mocked(getSessionById).mockResolvedValue({
      user: {
        id: "u1",
        coderUrl: "https://coder.test",
        coderUserId: "cu1",
        username: "alice",
        email: "alice@test.com",
      },
      session: { id: "row-1", sessionId: "sess-123", expiresAt: new Date("2026-05-01") },
    });
    vi.mocked(getDecryptedCoderToken).mockRejectedValue(new Error("something unexpected"));

    const res = await fetch(`${baseUrl}/sessions/sess-123/token`);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
