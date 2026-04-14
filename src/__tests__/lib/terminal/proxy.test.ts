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
    handleUpgrade: vi.fn((_req, _socket, _head, cb) => {
      cb(mockWsInstance);
    }),
    emit: vi.fn(),
  };
  const WebSocketServer = vi.fn(() => mockWss);

  return { WebSocket, WebSocketServer, default: { WebSocket, WebSocketServer } };
});

import { handleUpgrade } from "@/lib/terminal/proxy";
import { WebSocket, WebSocketServer } from "ws";

function makeReq(query: Record<string, string>): IncomingMessage {
  const params = new URLSearchParams(query);
  return {
    url: `/api/terminal/ws?${params.toString()}`,
    headers: { host: "localhost" },
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
  reconnectId: "reconnect-123",
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
    const { agentId, ...params } = validParams;
    const socket = makeSocket();
    handleUpgrade(makeReq(params), socket, Buffer.alloc(0));
    expect(socket.written[0]).toContain("400");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("rejects with 400 when reconnectId is missing", () => {
    const { reconnectId, ...params } = validParams;
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
    const { sessionName, ...params } = validParams;
    const socket = makeSocket();
    handleUpgrade(makeReq(params), socket, Buffer.alloc(0));

    const WsCtor = WebSocket as unknown as ReturnType<typeof vi.fn>;
    expect(WsCtor).toHaveBeenCalledTimes(1);
    const [url] = WsCtor.mock.calls[0];
    expect(url).toContain("default");
  });
});
