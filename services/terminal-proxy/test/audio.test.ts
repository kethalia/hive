import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  connectAudioRelay,
  handleAudioUpgrade,
  parseBrowserAudio,
  parseWorkspaceAudio,
} from "../src/audio.js";
import { authenticateUpgrade } from "../src/auth.js";
import { verifyWorkspaceAgentAccess } from "../src/workspace-authorization.js";

vi.mock("../src/auth.js", () => ({ authenticateUpgrade: vi.fn() }));
vi.mock("../src/workspace-authorization.js", () => ({ verifyWorkspaceAgentAccess: vi.fn() }));

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  ping = vi.fn();
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("terminal audio boundaries", () => {
  it.each([
    [
      "https://auth.example.com",
      "https://configured.example.com",
      "https://agent.example.com",
      "https://auth.example.com",
    ],
    [
      "",
      "https://configured.example.com",
      "https://agent.example.com",
      "https://configured.example.com",
    ],
    ["", "", "https://agent.example.com", "https://agent.example.com"],
    ["", "", "", ""],
  ])("resolves Coder URL using auth=%s, server=%s, agent=%s", async (authUrl, serverUrl, agentUrl, expectedUrl) => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://hive.example.com");
    vi.stubEnv("CODER_URL", serverUrl);
    vi.stubEnv("CODER_AGENT_URL", agentUrl);
    vi.mocked(authenticateUpgrade).mockResolvedValue({
      ok: true,
      value: { token: "private", coderUrl: authUrl, sessionId: "session", username: "user" },
    });
    vi.mocked(verifyWorkspaceAgentAccess).mockResolvedValue({ ok: false, status: 403 });
    const request = {
      url: "/ws/audio?workspaceId=550e8400-e29b-41d4-a716-446655440000&agentId=550e8400-e29b-41d4-a716-446655440001&sessionName=dev",
      headers: { origin: "https://hive.example.com", "sec-websocket-protocol": "hive-audio-v1" },
    } as unknown as IncomingMessage;
    const socket = new PassThrough();
    const write = vi.spyOn(socket, "write");
    await handleAudioUpgrade(request, socket, Buffer.alloc(0));
    if (expectedUrl) {
      expect(verifyWorkspaceAgentAccess).toHaveBeenCalledWith(
        expect.objectContaining({ coderUrl: expectedUrl }),
      );
      expect(write).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
    } else {
      expect(verifyWorkspaceAgentAccess).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });

  it("forwards only the known recoverable workspace error code", () => {
    expect(
      JSON.parse(
        parseWorkspaceAudio(
          '{"type":"error","code":"session_busy","message":"Already connected"}',
        ) as string,
      ),
    ).toEqual({
      type: "error",
      code: "session_busy",
      message: "Already connected",
    });
    for (const code of ["incompatible", "unknown", true]) {
      expect(
        JSON.parse(
          parseWorkspaceAudio(
            JSON.stringify({ type: "error", code, retry: true, message: "Update workspace" }),
          ) as string,
        ),
      ).toEqual({
        type: "error",
        message: "Update workspace",
      });
    }
  });

  it("accepts bounded PCM and rejects malformed samples and arbitrary controls", () => {
    const pcm = Buffer.alloc(960).toString("base64");
    expect(parseBrowserAudio(JSON.stringify({ type: "microphone", pcm }))).not.toBeNull();
    for (const pcm of ["!bad", "AA==", Buffer.alloc(962).toString("base64"), ""])
      expect(parseBrowserAudio(JSON.stringify({ type: "microphone", pcm }))).toBeNull();
    expect(parseBrowserAudio('{"type":"thread/realtime/start"}')).toBeNull();
    expect(parseWorkspaceAudio('{"type":"active","active":"true"}')).toBeNull();
    expect(parseWorkspaceAudio(JSON.stringify({ type: "speaker", pcm }))).toBe(
      JSON.stringify({ type: "speaker", pcm }),
    );
  });

  it("reassembles workspace lines and releases audio when the browser closes", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    upstream.emit("message", Buffer.from('{"type":"rea'));
    upstream.emit("message", Buffer.from('dy"}\r\n{"type":"active","active":true}\n'));
    expect(browser.send.mock.calls).toEqual([
      [JSON.stringify({ type: "ready" })],
      [JSON.stringify({ type: "active", active: true })],
    ]);
    browser.emit("close");
    expect(upstream.send).toHaveBeenLastCalledWith(
      JSON.stringify({ data: '{"type":"release"}\n' }),
    );
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("closes stalled media instead of growing an audio backlog", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    upstream.bufferedAmount = 70_000;
    browser.emit("message", Buffer.from('{"type":"ping"}'), false);
    expect(browser.close).toHaveBeenCalledWith(1013, "audio connection stalled");
  });

  it("allows a heartbeat during workspace startup and cancels a pending connection", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    upstream.readyState = 0;
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    browser.emit("message", Buffer.from('{"type":"ping"}'), false);
    expect(browser.close).not.toHaveBeenCalled();
    browser.emit("message", Buffer.from('{"type":"release"}'), false);
    expect(upstream.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("requires an allowed origin and an authenticated workspace/agent match", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://hive.example.com");
    const request = {
      url: "/ws/audio?workspaceId=550e8400-e29b-41d4-a716-446655440000&agentId=550e8400-e29b-41d4-a716-446655440001&sessionName=dev",
      headers: { origin: "https://hive.example.com", "sec-websocket-protocol": "hive-audio-v1" },
    } as unknown as IncomingMessage;
    vi.mocked(authenticateUpgrade).mockResolvedValue({
      ok: true,
      value: {
        token: "private",
        coderUrl: "https://coder.example.com",
        sessionId: "session",
        username: "user",
      },
    });
    vi.mocked(verifyWorkspaceAgentAccess).mockResolvedValue({ ok: false, status: 403 });
    const socket = new PassThrough();
    const write = vi.spyOn(socket, "write");
    await handleAudioUpgrade(request, socket, Buffer.alloc(0));
    expect(write).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
    expect(verifyWorkspaceAgentAccess).toHaveBeenCalledWith({
      token: "private",
      coderUrl: "https://coder.example.com",
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "550e8400-e29b-41d4-a716-446655440001",
    });
    vi.clearAllMocks();
    request.headers.origin = "https://evil.example.com";
    await handleAudioUpgrade(request, new PassThrough(), Buffer.alloc(0));
    expect(authenticateUpgrade).not.toHaveBeenCalled();
  });
});
