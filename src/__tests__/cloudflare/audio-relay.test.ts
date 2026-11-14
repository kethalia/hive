import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericTerminalFailure } from "@/lib/terminal/generic-auth.server";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import {
  openAudioRelay,
  parseAudioTarget,
  parseBrowserAudio,
  parseWorkspaceAudio,
} from "../../../deploy/cloudflare/app/audio-relay";
import type { GenericTerminalDependencies } from "../../../deploy/cloudflare/app/generic-terminal-relay";

class Socket implements RelaySocket {
  readyState = 1;
  binaryType: "arraybuffer" | "blob" = "blob";
  bufferedAmount = 0;
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(event: string, listener: unknown) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(event, set);
  }
  removeEventListener(event: string, listener: unknown) {
    this.listeners.get(event)?.delete(listener as (event: never) => void);
  }
  emit(event: string, value: unknown = {}) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value as never);
  }
}
const origin = "https://hive.example";
const target = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  agentId: "20000000-0000-4000-8000-000000000001",
  sessionName: "session-1",
};
const request = (query = new URLSearchParams(target).toString()) =>
  new Request(`${origin}/ws/audio?${query}`, { headers: { Upgrade: "websocket", Origin: origin } });
let closers: Array<() => void> = [];
function fixture() {
  const server = new Socket(),
    client = new Socket(),
    upstream = new Socket();
  const authority = {
    sessionId: "session",
    userId: "hive-owner",
    coderUserId: "coder-owner",
    coderOrigin: "https://coder.example",
    token: "synthetic-credential",
    buildId: "build-1",
    expiresAt: Date.now() + 3600000,
  };
  const deps = {
    authorize: vi.fn(async () => ({ ...authority })),
    extend: vi.fn(async () => {}),
    upgrade: vi.fn(async (_url: string, _options: RequestInit) => ({
      status: 101,
      webSocket: upstream,
    })),
    pair: () => ({ client, server }),
    response: () => {
      const r = new Response();
      Object.defineProperty(r, "status", { value: 101 });
      return r;
    },
    trackCleanup: vi.fn(),
    onClosed: vi.fn(),
  } satisfies GenericTerminalDependencies;
  const open = async (r = request()) => {
    const value = await openAudioRelay(r, origin, Date.now() + 3600000, deps);
    closers.push(() => server.emit("close"));
    return value;
  };
  return { server, client, upstream, authority, deps, open };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
});
afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  await Promise.resolve();
  vi.useRealTimers();
});

const browserFrame = (socket: Socket, value: unknown) =>
  socket.emit("message", { data: JSON.stringify(value) });
const hostFrame = (socket: Socket, value: unknown) =>
  socket.emit("message", { data: new TextEncoder().encode(`${JSON.stringify(value)}\n`).buffer });
describe("native audio Cloudflare relay", () => {
  it("admits only the fixed target and server-generated reconnect", () => {
    const url = new URL(request().url);
    const parsed = parseAudioTarget(url)!;
    expect(parsed.sessionName).toBe("session-1");
    expect(parsed.reconnectId).toMatch(/^[a-f0-9-]{36}$/);
    url.searchParams.set("command", "arbitrary");
    expect(parseAudioTarget(url)).toBeNull();
    expect(parseAudioTarget(new URL(`${request().url}&workspaceId=bad`))).toBeNull();
  });
  it("uses only the native hive-audio command and binary Coder input envelopes", async () => {
    const f = fixture();
    expect((await f.open()).status).toBe(101);
    const url = new URL(f.deps.upgrade.mock.calls[0][0]);
    expect(url.origin).toBe("https://coder.example");
    expect(url.searchParams.get("command")).toContain("exec hive-audio relay -- 'session-1'");
    expect(url.searchParams.get("command")).not.toContain("new-session");
    hostFrame(f.upstream, { type: "ready", claimRequired: true });
    expect(f.server.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "ready", claimRequired: true, playbackGeneration: true }),
    );
    browserFrame(f.server, { type: "claim" });
    const envelope = f.upstream.send.mock.calls.at(-1)![0];
    expect(envelope).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(envelope))).toEqual({ data: '{"type":"claim"}\n' });
    browserFrame(f.server, { type: "microphone", pcm: "AAA=" });
    expect(
      JSON.parse(new TextDecoder().decode(f.upstream.send.mock.calls.at(-1)![0])).data,
    ).toContain('"microphone"');
  });
  it("preserves PCM focus generations and drops fragmented previous-generation playback", async () => {
    const f = fixture();
    await f.open();
    browserFrame(f.server, { type: "playback", enabled: true, generation: 1 });
    f.upstream.emit("message", { data: new TextEncoder().encode('{"type":"speaker",').buffer });
    browserFrame(f.server, { type: "playback", enabled: true, generation: 2 });
    f.upstream.emit("message", { data: new TextEncoder().encode('"pcm":"AAA="}\n').buffer });
    expect(f.server.send).not.toHaveBeenCalled();
    hostFrame(f.upstream, { type: "speaker", pcm: "AAA=" });
    expect(f.server.send).toHaveBeenLastCalledWith(
      '{"type":"speaker","pcm":"AAA=","generation":2}',
    );
    browserFrame(f.server, { type: "playback", enabled: false, generation: 3 });
    f.server.send.mockClear();
    hostFrame(f.upstream, { type: "speaker", pcm: "AAA=" });
    expect(f.server.send).not.toHaveBeenCalled();
  });
  it("releases native audio on browser consent release and clears all timers/listeners", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(0);
    browserFrame(f.server, { type: "release" });
    expect(f.server.close).toHaveBeenCalledWith(1000, "audio ended");
    expect(JSON.parse(new TextDecoder().decode(f.upstream.send.mock.calls.at(-1)![0]))).toEqual({
      data: '{"type":"release"}\n',
    });
    expect(f.server.listeners.get("message")?.size ?? 0).toBe(0);
    expect(f.deps.onClosed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds malformed binary and oversized browser input", async () => {
    expect(
      parseBrowserAudio(JSON.stringify({ type: "microphone", pcm: "A".repeat(1284) })),
    ).toBeNull();
    expect(parseWorkspaceAudio('{"type":"speaker","pcm":"AA=="}')).toBeNull();
    const f = fixture();
    await f.open();
    f.server.emit("message", { data: new Uint8Array([1, 2]).buffer });
    expect(f.server.close).toHaveBeenCalledWith(1008, "invalid audio frame");
  });
  it("retains control order under backpressure and closes a stalled control queue", async () => {
    const f = fixture();
    await f.open();
    f.server.bufferedAmount = 100000;
    hostFrame(f.upstream, { type: "active", active: true });
    hostFrame(f.upstream, { type: "active", active: false });
    f.server.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    expect(f.server.send.mock.calls.map(([value]) => value)).toEqual([
      '{"type":"active","active":true}',
      '{"type":"active","active":false}',
    ]);
    f.server.bufferedAmount = 100000;
    for (let i = 0; i < 33; i++) hostFrame(f.upstream, { type: "active", active: true });
    expect(f.server.close).toHaveBeenCalledWith(1013, "audio controls stalled");
  });
  it("requires host READY and subsequent browser/host heartbeats", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.server.close).toHaveBeenCalledWith(1013, "workspace audio timed out");
    const other = fixture();
    await other.open();
    hostFrame(other.upstream, { type: "ready" });
    await vi.advanceTimersByTimeAsync(25000);
    expect(other.server.close).toHaveBeenCalledWith(1013, "audio heartbeat timed out");
  });
  it("has no shell attachment cap and retains the original credential expiry after refresh", async () => {
    const f = fixture();
    f.authority.expiresAt = Date.now() + 200000;
    await f.open();
    hostFrame(f.upstream, { type: "ready" });
    f.authority.expiresAt = Date.now() + 3600000;
    for (let i = 0; i < 39; i++) {
      browserFrame(f.server, { type: "ping" });
      hostFrame(f.upstream, { type: "pong" });
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(f.server.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.server.close).toHaveBeenCalledWith(4401, "Audio authorization expired");
  });
  it.each([
    "build",
    "owner",
    "revoked",
  ])("closes on %s drift during fresh authorization", async (kind) => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(0);
    hostFrame(f.upstream, { type: "ready" });
    if (kind === "build") f.authority.buildId = "build-2";
    if (kind === "owner") f.authority.coderUserId = "other-owner";
    if (kind === "revoked") f.deps.authorize.mockRejectedValue(new GenericTerminalFailure(4401));
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.server.close).toHaveBeenCalledWith(kind === "build" ? 4404 : 4401, expect.any(String));
    expect(f.deps.extend).not.toHaveBeenCalled();
  });
  it("bounds a stalled handshake by the original credential expiry", async () => {
    const f = fixture();
    f.authority.expiresAt = Date.now() + 10;
    f.deps.upgrade.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const opening = f.open();
    await vi.advanceTimersByTimeAsync(10);
    expect((await opening).status).toBe(401);
  });
  it("clips a refresh to an earlier credential expiry", async () => {
    const f = fixture();
    await f.open();
    await vi.advanceTimersByTimeAsync(0);
    hostFrame(f.upstream, { type: "ready" });
    f.authority.expiresAt = Date.now() + 25000;
    for (let i = 0; i < 5; i++) {
      browserFrame(f.server, { type: "ping" });
      hostFrame(f.upstream, { type: "pong" });
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(f.server.close).toHaveBeenCalledWith(4401, "Audio authorization expired");
  });
  it("closes and releases native audio when socket delivery throws", async () => {
    const f = fixture();
    await f.open();
    f.upstream.send.mockImplementation(() => {
      throw new Error("socket gone");
    });
    browserFrame(f.server, { type: "claim" });
    expect(f.server.close).toHaveBeenCalledWith(1011, "Audio transport unavailable");
    expect(f.upstream.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects foreign origins and failed upgrades before creating a browser pair", async () => {
    const f = fixture();
    const foreign = new Request(request(), {
      headers: { Upgrade: "websocket", Origin: "https://other.example" },
    });
    expect((await f.open(foreign)).status).toBe(403);
    expect(f.deps.upgrade).not.toHaveBeenCalled();
    f.deps.upgrade.mockResolvedValue({ status: 403, webSocket: f.upstream });
    expect((await f.open()).status).toBe(403);
    expect(f.upstream.close).toHaveBeenCalled();
  });
});
