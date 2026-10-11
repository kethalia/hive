import { EventEmitter, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
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
  it("drops paused playback and tags resumed PCM without forwarding focus controls upstream", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    const pcm = Buffer.alloc(960).toString("base64");
    const speaker = () =>
      upstream.emit("message", Buffer.from(`${JSON.stringify({ type: "speaker", pcm })}\n`));
    const focus = (enabled: boolean, generation: number) =>
      browser.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "playback", enabled, generation })),
        false,
      );
    speaker();
    expect(JSON.parse(browser.send.mock.calls.at(-1)![0])).toEqual({ type: "speaker", pcm });
    focus(true, 1);
    speaker();
    expect(JSON.parse(browser.send.mock.calls.at(-1)![0])).toEqual({
      type: "speaker",
      pcm,
      generation: 1,
    });
    focus(false, 2);
    browser.send.mockClear();
    speaker();
    expect(browser.send).not.toHaveBeenCalled();
    focus(true, 3);
    focus(false, 2);
    speaker();
    expect(JSON.parse(browser.send.mock.calls.at(-1)![0])).toEqual({
      type: "speaker",
      pcm,
      generation: 3,
    });
    expect(upstream.send).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    browser.emit("close");
  });

  it.each([
    0,
    -1,
    1.5,
    "1",
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid playback generation %s", (generation) => {
    expect(
      parseBrowserAudio(JSON.stringify({ type: "playback", enabled: true, generation })),
    ).toBeNull();
  });
  it("bounds pending controls and cancels retries when congestion persists", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    browser.bufferedAmount = 70_000;
    for (let index = 0; index < 33; index++)
      upstream.emit(
        "message",
        Buffer.from(`${JSON.stringify({ type: "active", active: index % 2 === 0 })}\n`),
      );
    expect(browser.close).toHaveBeenCalledExactlyOnceWith(1013, "audio controls stalled");
    expect(upstream.close).toHaveBeenCalledTimes(1);
    browser.bufferedAmount = 0;
    vi.advanceTimersByTime(30_000);
    expect(browser.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers call-end and subsequent call-start controls in order after congestion", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    browser.bufferedAmount = 70_000;
    upstream.emit(
      "message",
      Buffer.from('{"type":"active","active":false}\n{"type":"active","active":true}\n'),
    );
    expect(browser.send).not.toHaveBeenCalled();
    browser.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(browser.send.mock.calls).toEqual([
      ['{"type":"active","active":false}'],
      ['{"type":"active","active":true}'],
    ]);
    expect(browser.close).not.toHaveBeenCalled();
    browser.emit("close");
  });

  it("retries an upstream claim and clears pending controls when the connection closes", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    upstream.bufferedAmount = 70_000;
    browser.emit("message", Buffer.from('{"type":"claim"}'), false);
    expect(upstream.send).not.toHaveBeenCalled();
    upstream.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(upstream.send).toHaveBeenCalledWith(JSON.stringify({ data: '{"type":"claim"}\n' }), {
      binary: true,
    });
    browser.bufferedAmount = 70_000;
    upstream.emit("message", Buffer.from('{"type":"active","active":false}\n'));
    browser.emit("close");
    browser.bufferedAmount = 0;
    vi.advanceTimersByTime(100);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("keeps the Coder PTY connected through claims, PCM, heartbeats and release", async () => {
    const server = new WebSocketServer({ port: 0 });
    const frames: Array<{ type: string; pcm?: string }> = [];
    let workspace: WebSocket | undefined;
    server.on("connection", (socket) => {
      workspace = socket;
      socket.on("message", (data, binary) => {
        // Coder's PTY uses websocket.NetConn with MessageBinary.
        if (!binary) {
          socket.close(1003, "expected MessageBinary");
          return;
        }
        const frame = JSON.parse(JSON.parse(data.toString()).data.trim());
        frames.push(frame);
        if (frame.type === "claim" || frame.type === "ping")
          socket.send(`${JSON.stringify({ type: frame.type === "claim" ? "claimed" : "pong" })}\n`);
      });
    });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No test server address");
    const upstream = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const browser = new Socket();
    browser.ping.mockImplementation(() => browser.emit("pong"));
    try {
      await once(upstream, "open");
      connectAudioRelay(browser as unknown as WebSocket, upstream);
      workspace?.send('{"type":"ready","claimRequired":true}\n');
      await vi.waitFor(() =>
        expect(browser.send).toHaveBeenCalledWith(
          '{"type":"ready","claimRequired":true,"playbackGeneration":true}',
        ),
      );
      browser.emit("message", Buffer.from('{"type":"claim"}'), false);
      await vi.waitFor(() => expect(browser.send).toHaveBeenCalledWith('{"type":"claimed"}'));
      const pcm = Buffer.alloc(960).toString("base64");
      browser.emit("message", Buffer.from(JSON.stringify({ type: "microphone", pcm })), false);
      browser.emit("message", Buffer.from('{"type":"ping"}'), false);
      await vi.waitFor(() => expect(frames).toHaveLength(3));
      expect(frames).toEqual([{ type: "claim" }, { type: "microphone", pcm }, { type: "ping" }]);
      // Also exercise the proxy's first automatic heartbeat, where idle views failed.
      await vi.waitFor(
        () => expect(frames.filter((frame) => frame.type === "ping")).toHaveLength(2),
        { timeout: 6000 },
      );
      expect(upstream.readyState).toBe(WebSocket.OPEN);
      expect(browser.close).not.toHaveBeenCalled();
      browser.emit("message", Buffer.from('{"type":"release"}'), false);
      await vi.waitFor(() => expect(frames.at(-1)).toEqual({ type: "release" }));
      expect(browser.close).toHaveBeenCalledWith(1000, "audio ended");
    } finally {
      browser.emit("close");
      upstream.terminate();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("preserves call claiming capabilities and permits the bounded claim control", () => {
    expect(parseWorkspaceAudio('{"type":"ready","claimRequired":true,"extra":1}')).toBe(
      '{"type":"ready","claimRequired":true}',
    );
    expect(parseWorkspaceAudio('{"type":"claimed"}')).toBe('{"type":"claimed"}');
    expect(parseBrowserAudio('{"type":"claim","extra":1}')).toBe('{"type":"claim"}');
  });

  it("a watcher readiness frame clears startup timeout without losing its capability", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    upstream.emit("message", Buffer.from('{"type":"ready","claimRequired":true}\n'));
    vi.advanceTimersByTime(10_000);
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.send).toHaveBeenCalledWith(
      '{"type":"ready","claimRequired":true,"playbackGeneration":true}',
    );
    browser.emit("close");
  });
  it("authorizes long session names accepted by ordinary terminals", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://hive.example.com");
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
    const sessionName = `voice-${"a".repeat(256)}`;
    const request = {
      url: `/ws/audio?workspaceId=550e8400-e29b-41d4-a716-446655440000&agentId=550e8400-e29b-41d4-a716-446655440001&sessionName=${sessionName}`,
      headers: { origin: "https://hive.example.com", "sec-websocket-protocol": "hive-audio-v1" },
    } as unknown as IncomingMessage;
    const socket = new PassThrough();
    const write = vi.spyOn(socket, "write");
    await handleAudioUpgrade(request, socket, Buffer.alloc(0));
    expect(authenticateUpgrade).toHaveBeenCalledOnce();
    expect(verifyWorkspaceAgentAccess).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

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
      [JSON.stringify({ type: "ready", playbackGeneration: true })],
      [JSON.stringify({ type: "active", active: true })],
    ]);
    browser.emit("close");
    expect(upstream.send).toHaveBeenLastCalledWith(
      JSON.stringify({ data: '{"type":"release"}\n' }),
      { binary: true },
    );
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("drops delayed microphone audio and recovers without disconnecting the call", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    upstream.bufferedAmount = 70_000;
    const frame = JSON.stringify({ type: "microphone", pcm: Buffer.alloc(960).toString("base64") });
    browser.emit("message", Buffer.from(frame), false);
    expect(upstream.send).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    upstream.bufferedAmount = 0;
    browser.emit("message", Buffer.from(frame), false);
    expect(upstream.send).toHaveBeenCalledWith(JSON.stringify({ data: `${frame}\n` }), {
      binary: true,
    });
    browser.emit("close");
  });

  it("drops delayed speaker frames while preserving controls and bounded queues", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    const speaker = JSON.stringify({ type: "speaker", pcm: Buffer.alloc(960).toString("base64") });
    browser.bufferedAmount = upstream.bufferedAmount = 66_000;
    upstream.emit("message", Buffer.from(`${speaker}\n{"type":"pong"}\n`));
    expect(browser.send.mock.calls).toEqual([['{"type":"pong"}']]);
    browser.emit("message", Buffer.from('{"type":"ping"}'), false);
    expect(upstream.send).toHaveBeenCalledWith(JSON.stringify({ data: '{"type":"ping"}\n' }), {
      binary: true,
    });
    browser.bufferedAmount = upstream.bufferedAmount = 70_000;
    browser.send.mockClear();
    upstream.send.mockClear();
    upstream.emit("message", Buffer.from('{"type":"pong"}\n'));
    browser.emit("message", Buffer.from('{"type":"ping"}'), false);
    expect(browser.send).not.toHaveBeenCalled();
    expect(upstream.send).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    browser.bufferedAmount = 0;
    upstream.emit("message", Buffer.from(`${speaker}\n`));
    expect(browser.send).toHaveBeenCalledWith(speaker);
    browser.emit("close");
  });

  it("still terminates an unresponsive workspace after dropping congested audio", () => {
    vi.useFakeTimers();
    const browser = new Socket(),
      upstream = new Socket();
    connectAudioRelay(browser as unknown as WebSocket, upstream as unknown as WebSocket);
    upstream.emit("message", Buffer.from('{"type":"ready"}\n'));
    browser.ping.mockImplementation(() => browser.emit("pong"));
    upstream.bufferedAmount = 70_000;
    vi.advanceTimersByTime(20_000);
    expect(upstream.send).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(browser.close).toHaveBeenCalledWith(1013, "audio heartbeat timed out");
    expect(upstream.close).toHaveBeenCalledOnce();
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
