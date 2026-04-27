import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AuthServiceClient } from "../src/client.js";

type MockHandler = (req: IncomingMessage, res: ServerResponse) => void;

function createMockServer(handler: MockHandler): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
  });
}

describe("AuthServiceClient", () => {
  let server: Server;
  let port: number;
  let client: AuthServiceClient;
  let handler: MockHandler;

  beforeAll(async () => {
    const result = await createMockServer((req, res) => handler(req, res));
    server = result.server;
    port = result.port;
    client = new AuthServiceClient(`http://localhost:${port}`);
  });

  afterAll(() => {
    server.close();
  });

  describe("login", () => {
    it("sends correct request and returns response", async () => {
      handler = async (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/login");
        const body = (await readBody(req)) as Record<string, string>;
        expect(body.email).toBe("alice@test.com");
        sendJson(res, 200, {
          sessionId: "sess-1",
          user: { id: "u1", username: "alice", email: "alice@test.com", coderUrl: "https://coder.test" },
        });
      };

      const result = await client.login({
        coderUrl: "https://coder.test",
        email: "alice@test.com",
        password: "pass",
      });

      expect(result.sessionId).toBe("sess-1");
      expect(result.user.username).toBe("alice");
    });

    it("throws on error response", async () => {
      handler = (_req, res) => {
        sendJson(res, 401, { error: "Invalid credentials", code: "INVALID_CREDENTIALS" });
      };

      await expect(
        client.login({ coderUrl: "https://coder.test", email: "a@b.com", password: "wrong" }),
      ).rejects.toThrow("Invalid credentials");
    });
  });

  describe("logout", () => {
    it("sends correct request", async () => {
      handler = async (req, res) => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/logout");
        const body = (await readBody(req)) as Record<string, string>;
        expect(body.sessionId).toBe("sess-1");
        sendJson(res, 200, { ok: true });
      };

      await client.logout("sess-1");
    });

    it("throws on error response", async () => {
      handler = (_req, res) => {
        sendJson(res, 500, { error: "DB error" });
      };

      await expect(client.logout("sess-1")).rejects.toThrow("DB error");
    });
  });

  describe("getSession", () => {
    it("returns session payload on 200", async () => {
      handler = (_req, res) => {
        sendJson(res, 200, {
          userId: "u1",
          username: "alice",
          email: "alice@test.com",
          coderUrl: "https://coder.test",
          sessionId: "sess-1",
          expiresAt: "2026-05-01T00:00:00.000Z",
        });
      };

      const result = await client.getSession("sess-1");
      expect(result).not.toBeNull();
      expect(result!.userId).toBe("u1");
    });

    it("returns null on 404", async () => {
      handler = (_req, res) => {
        sendJson(res, 404, { error: "Session not found" });
      };

      const result = await client.getSession("nonexistent");
      expect(result).toBeNull();
    });

    it("throws on 500", async () => {
      handler = (_req, res) => {
        sendJson(res, 500, { error: "DB error" });
      };

      await expect(client.getSession("sess-1")).rejects.toThrow("DB error");
    });
  });

  describe("getCoderToken", () => {
    it("returns token response on 200", async () => {
      handler = (_req, res) => {
        sendJson(res, 200, { token: "coder-tok", coderUrl: "https://coder.test", expiresAt: "2026-05-01T00:00:00.000Z" });
      };

      const result = await client.getCoderToken("sess-1");
      expect(result).not.toBeNull();
      expect(result!.token).toBe("coder-tok");
      expect(result!.coderUrl).toBe("https://coder.test");
    });

    it("returns null on 404", async () => {
      handler = (_req, res) => {
        sendJson(res, 404, { error: "Session not found" });
      };

      const result = await client.getCoderToken("nonexistent");
      expect(result).toBeNull();
    });

    it("throws on 500", async () => {
      handler = (_req, res) => {
        sendJson(res, 500, { error: "Failed to retrieve token" });
      };

      await expect(client.getCoderToken("sess-1")).rejects.toThrow("Failed to retrieve token");
    });
  });

  describe("getCredentials", () => {
    it("returns credential response on 200", async () => {
      handler = (_req, res) => {
        sendJson(res, 200, { status: "valid", expiresAt: "2026-05-01T00:00:00.000Z" });
      };

      const result = await client.getCredentials("sess-1");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("valid");
    });

    it("returns null on 404", async () => {
      handler = (_req, res) => {
        sendJson(res, 404, { error: "Session not found" });
      };

      const result = await client.getCredentials("nonexistent");
      expect(result).toBeNull();
    });

    it("throws on 500", async () => {
      handler = (_req, res) => {
        sendJson(res, 500, { error: "DB error" });
      };

      await expect(client.getCredentials("sess-1")).rejects.toThrow("DB error");
    });
  });
});
