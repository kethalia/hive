import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthResult = {
  ok: true as const,
  value: {
    token: "per-user-token",
    coderUrl: "http://coder.example.com",
    sessionId: "session-123",
    username: "testuser",
  },
};

vi.mock("../src/auth.js", () => ({
  authenticateUpgrade: vi.fn(() => Promise.resolve(mockAuthResult)),
}));

vi.mock("ws", () => {
  const mockWsInstance = {
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
    readyState: 1,
  };
  const WebSocket = vi.fn(() => mockWsInstance);
  Object.assign(WebSocket, { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 });

  const mockWss = {
    handleUpgrade: vi.fn(
      (_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) => {
        cb(mockWsInstance);
      },
    ),
    emit: vi.fn(),
  };
  const WebSocketServer = vi.fn(() => mockWss);

  return { WebSocket, WebSocketServer, default: { WebSocket, WebSocketServer } };
});

import { WebSocket } from "ws";
import { authenticateUpgrade } from "../src/auth.js";
import { handleUpgrade, isOriginAllowed } from "../src/proxy.js";

const mockAuth = authenticateUpgrade as ReturnType<typeof vi.fn>;

function makeReq(query: Record<string, string>, origin = "http://localhost:3000"): IncomingMessage {
  const params = new URLSearchParams(query);
  return {
    url: `/ws?${params.toString()}`,
    headers: { host: "localhost", origin, cookie: "hive-session=valid-cookie" },
  } as unknown as IncomingMessage;
}

function makeSocket(): Duplex & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((data: string) => {
      written.push(data);
      return true;
    }),
    destroy: vi.fn(),
  } as unknown as Duplex & { written: string[] };
}

const validParams = {
  agentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  reconnectId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  width: "80",
  height: "24",
  sessionName: "my-session",
};

describe("handleUpgrade", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, CODER_URL: "http://coder.example.com" };
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(mockAuthResult);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects with 400 when agentId is missing", async () => {
    const { agentId: _, ...params } = validParams;
    const socket = makeSocket();
    await handleUpgrade(makeReq(params), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when reconnectId is missing", async () => {
    const { reconnectId: _, ...params } = validParams;
    const socket = makeSocket();
    await handleUpgrade(makeReq(params), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when agentId is not UUID format", async () => {
    const socket = makeSocket();
    await handleUpgrade(
      makeReq({ ...validParams, agentId: "not-a-uuid" }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when reconnectId is not UUID format", async () => {
    const socket = makeSocket();
    await handleUpgrade(
      makeReq({ ...validParams, reconnectId: "not-a-uuid" }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when sessionName contains shell metacharacters", async () => {
    const socket = makeSocket();
    await handleUpgrade(
      makeReq({ ...validParams, sessionName: "bad;rm -rf" }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects sessionName with spaces", async () => {
    const socket = makeSocket();
    await handleUpgrade(
      makeReq({ ...validParams, sessionName: "bad name" }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.written[0]).toContain("400");
  });

  it("rejects sessionName with backticks", async () => {
    const socket = makeSocket();
    await handleUpgrade(
      makeReq({ ...validParams, sessionName: "bad`cmd`" }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.written[0]).toContain("400");
  });

  it("uses per-user token from auth result, not env var", async () => {
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    if (WsCtor.mock.calls.length > 0) {
      const opts = WsCtor.mock.calls[0][1] as { headers: Record<string, string> };
      expect(opts.headers["Coder-Session-Token"]).toBe("per-user-token");
    }
  });

  it("opens upstream WebSocket with correct URL and per-user auth on valid request", async () => {
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    expect(WsCtor).toHaveBeenCalledTimes(1);

    const [url, opts] = WsCtor.mock.calls[0];
    expect(url).toContain("ws://coder.example.com/api/v2/workspaceagents/");
    expect(url).toContain(validParams.agentId);
    expect(url).toContain("/pty?");
    expect(opts.headers["Coder-Session-Token"]).toBe("per-user-token");
  });

  it("sets handshakeTimeout on upstream WebSocket", async () => {
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    const [, opts] = WsCtor.mock.calls[0];
    expect(opts.handshakeTimeout).toBe(10_000);
  });

  it("accepts valid UUID agentId formats", async () => {
    const socket = makeSocket();
    await handleUpgrade(
      makeReq({ ...validParams, agentId: "AABBCCDD-EEFF-1122-3344-556677889900" }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("defaults sessionName to 'default' when not provided", async () => {
    const { sessionName: _, ...params } = validParams;
    const socket = makeSocket();
    await handleUpgrade(makeReq(params), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("rejects with 403 when Origin header is missing", async () => {
    const params = new URLSearchParams(validParams);
    const req = {
      url: `/ws?${params.toString()}`,
      headers: { host: "localhost" },
    } as unknown as IncomingMessage;
    const socket = makeSocket();
    await handleUpgrade(req, socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("403");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 403 when Origin is not in allowed list", async () => {
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams, "https://evil.example.com"), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("403");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("accepts localhost origins by default", async () => {
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams, "http://localhost:3000"), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("accepts https localhost origins by default", async () => {
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams, "https://localhost:8443"), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("respects ALLOWED_ORIGINS env var", async () => {
    process.env.ALLOWED_ORIGINS = "https://myapp.example.com,http://localhost:3000";
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams, "https://myapp.example.com"), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("rejects origins not in ALLOWED_ORIGINS when env var is set", async () => {
    process.env.ALLOWED_ORIGINS = "https://myapp.example.com";
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams, "http://localhost:3000"), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("403");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("returns 401 when authenticateUpgrade returns auth failure (no cookie)", async () => {
    mockAuth.mockResolvedValue({
      ok: false,
      value: { error: "No cookie provided", status: 401, reason: "no_cookie" },
    });
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("401");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("returns 401 when authenticateUpgrade returns invalid HMAC", async () => {
    mockAuth.mockResolvedValue({
      ok: false,
      value: { error: "Invalid cookie signature", status: 401, reason: "invalid_hmac" },
    });
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("401");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("returns 502 when auth service is unreachable", async () => {
    mockAuth.mockResolvedValue({
      ok: false,
      value: { error: "Auth service unreachable", status: 502, reason: "auth_service_unreachable" },
    });
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("502");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("returns 401 when session not found", async () => {
    mockAuth.mockResolvedValue({
      ok: false,
      value: { error: "Session not found", status: 401, reason: "session_not_found" },
    });
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("401");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("uses coderUrl from auth result over env var", async () => {
    mockAuth.mockResolvedValue({
      ok: true,
      value: {
        token: "tok",
        coderUrl: "http://per-user-coder.example.com",
        sessionId: "s1",
        username: "u1",
      },
    });
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    const [url] = WsCtor.mock.calls[0];
    expect(url).toContain("ws://per-user-coder.example.com/");
  });

  it("falls back to CODER_URL env var when auth coderUrl is empty", async () => {
    mockAuth.mockResolvedValue({
      ok: true,
      value: { token: "tok", coderUrl: "", sessionId: "s1", username: "u1" },
    });
    const socket = makeSocket();
    await handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    const [url] = WsCtor.mock.calls[0];
    expect(url).toContain("ws://coder.example.com/");
  });
});

describe("isOriginAllowed", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns false for undefined origin", () => {
    expect(isOriginAllowed(undefined)).toBe(false);
  });

  it("matches wildcard port patterns", () => {
    expect(isOriginAllowed("http://localhost:9999")).toBe(true);
  });

  it("matches exact origins from ALLOWED_ORIGINS", () => {
    process.env.ALLOWED_ORIGINS = "https://app.example.com";
    expect(isOriginAllowed("https://app.example.com")).toBe(true);
    expect(isOriginAllowed("https://other.example.com")).toBe(false);
  });
});
