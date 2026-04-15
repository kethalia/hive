import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

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
    handleUpgrade: vi.fn((_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) => {
      cb(mockWsInstance);
    }),
    emit: vi.fn(),
  };
  const WebSocketServer = vi.fn(() => mockWss);

  return { WebSocket, WebSocketServer, default: { WebSocket, WebSocketServer } };
});

import { handleUpgrade, isOriginAllowed } from "../src/proxy.js";
import { WebSocket } from "ws";

function makeReq(query: Record<string, string>, origin = "http://localhost:3000"): IncomingMessage {
  const params = new URLSearchParams(query);
  return {
    url: `/ws?${params.toString()}`,
    headers: { host: "localhost", origin },
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
    process.env = { ...originalEnv, CODER_SESSION_TOKEN: "test-token", CODER_URL: "http://coder.example.com" };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects with 502 when CODER_URL and CODER_AGENT_URL are both missing", () => {
    delete process.env.CODER_URL;
    delete process.env.CODER_AGENT_URL;
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("502");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 401 when CODER_SESSION_TOKEN is missing", () => {
    delete process.env.CODER_SESSION_TOKEN;
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("401");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when agentId is missing", () => {
    const { agentId: _, ...params } = validParams;
    const socket = makeSocket();
    handleUpgrade(makeReq(params), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when reconnectId is missing", () => {
    const { reconnectId: _, ...params } = validParams;
    const socket = makeSocket();
    handleUpgrade(makeReq(params), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when agentId is not UUID format", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, agentId: "not-a-uuid" }), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when reconnectId is not UUID format", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, reconnectId: "not-a-uuid" }), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when sessionName contains shell metacharacters", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, sessionName: "bad;rm -rf" }), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects sessionName with spaces", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, sessionName: "bad name" }), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
  });

  it("rejects sessionName with backticks", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, sessionName: "bad`cmd`" }), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
  });

  it("reads CODER_SESSION_TOKEN from env, not query params", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, token: "injected-token" }), socket, Buffer.alloc(0));
    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    if (WsCtor.mock.calls.length > 0) {
      const opts = WsCtor.mock.calls[0][1] as { headers: Record<string, string> };
      expect(opts.headers["Coder-Session-Token"]).toBe("test-token");
      expect(opts.headers["Coder-Session-Token"]).not.toBe("injected-token");
    }
  });

  it("opens upstream WebSocket with correct URL and auth header on valid request", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    expect(WsCtor).toHaveBeenCalledTimes(1);

    const [url, opts] = WsCtor.mock.calls[0];
    expect(url).toContain("ws://coder.example.com/api/v2/workspaceagents/");
    expect(url).toContain(validParams.agentId);
    expect(url).toContain("/pty?");
    expect(opts.headers["Coder-Session-Token"]).toBe("test-token");
  });

  it("sets handshakeTimeout on upstream WebSocket", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    const [, opts] = WsCtor.mock.calls[0];
    expect(opts.handshakeTimeout).toBe(10_000);
  });

  it("accepts valid UUID agentId formats", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq({ ...validParams, agentId: "AABBCCDD-EEFF-1122-3344-556677889900" }), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("defaults sessionName to 'default' when not provided", () => {
    const { sessionName: _, ...params } = validParams;
    const socket = makeSocket();
    handleUpgrade(makeReq(params), socket, Buffer.alloc(0));

    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("rejects with 403 when Origin header is missing", () => {
    const params = new URLSearchParams(validParams);
    const req = {
      url: `/ws?${params.toString()}`,
      headers: { host: "localhost" },
    } as unknown as IncomingMessage;
    const socket = makeSocket();
    handleUpgrade(req, socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("403");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 403 when Origin is not in allowed list", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams, "https://evil.example.com"), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("403");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("accepts localhost origins by default", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams, "http://localhost:3000"), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("accepts https localhost origins by default", () => {
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams, "https://localhost:8443"), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("respects ALLOWED_ORIGINS env var", () => {
    process.env.ALLOWED_ORIGINS = "https://myapp.example.com,http://localhost:3000";
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams, "https://myapp.example.com"), socket, Buffer.alloc(0));
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("rejects origins not in ALLOWED_ORIGINS when env var is set", () => {
    process.env.ALLOWED_ORIGINS = "https://myapp.example.com";
    const socket = makeSocket();
    handleUpgrade(makeReq(validParams, "http://localhost:3000"), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("403");
    expect(socket.destroy).toHaveBeenCalled();
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
