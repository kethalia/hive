// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAudio } from "@/lib/terminal/browser-audio";

const originalLocks = navigator.locks;

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    Socket.instances.push(this);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
class Context {
  static instances: Context[] = [];
  sampleRate = 48_000;
  state = "running";
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  destination = {};
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  constructor() {
    Context.instances.push(this);
  }
}
class Worklet {
  port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}
let sessions: TerminalAudio[];
let stop: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let stream: MediaStream;
beforeEach(() => {
  vi.useFakeTimers();
  sessions = [];
  Socket.instances = [];
  Context.instances = [];
  stop = vi.fn();
  stream = { getTracks: () => [{ stop, onended: null }] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
});
afterEach(() => {
  for (const session of sessions) session.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
});
function session() {
  const status = vi.fn();
  const audio = new TerminalAudio("wss://hive/ws/audio", status);
  sessions.push(audio);
  audio.setVisible(true);
  return { audio, status, socket: Socket.instances.at(-1) as Socket };
}

describe("native terminal browser audio", () => {
  it("retries a busy session until its owner releases it and a native call can start", async () => {
    const { socket, status } = session();
    const busy = {
      type: "error",
      code: "session_busy",
      message: "Audio is already connected in another view of this terminal.",
    };
    socket.emit(busy);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2999);
    expect(Socket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const retry = Socket.instances.at(-1) as Socket;
    retry.emit(busy);
    await vi.advanceTimersByTimeAsync(3000);
    const available = Socket.instances.at(-1) as Socket;
    expect(status).toHaveBeenLastCalledWith({ phase: "error", message: busy.message });
    available.emit({ type: "ready" });
    available.emit({ type: "active", active: false });
    expect(status).toHaveBeenLastCalledWith({ phase: "standby" });
    expect(getUserMedia).not.toHaveBeenCalled();
    available.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.instances).toHaveLength(3);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });

  it("does not retry permanent workspace errors and cancels ownership retries when hidden", async () => {
    const permanent = session();
    permanent.socket.emit({
      type: "error",
      message: "Update the workspace image and open a new terminal.",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Socket.instances).toHaveLength(1);
    const transient = session();
    transient.socket.emit({ type: "error", code: "session_busy", message: "Session is busy." });
    transient.audio.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Socket.instances).toHaveLength(2);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps permission errors visible after the relay reconnects", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const { socket, status } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    const retry = Socket.instances.at(-1) as Socket;
    retry.emit({ type: "ready" });
    retry.emit({ type: "active", active: false });
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("denied"),
    });
  });

  it("does not request microphone when another Hive window owns the origin lock", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback(null));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const { socket, status } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("other Hive tab or window"),
    });
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
  });

  it("holds the origin lock through microphone permission and releases it on hiding", async () => {
    let released = false;
    const request = vi.fn(async (_name, _options, callback) => {
      await callback({ name: "hive-terminal-microphone" });
      released = true;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    getUserMedia.mockReturnValue(new Promise(() => {}));
    const { audio, socket } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    audio.setVisible(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
  });

  it("requests microphone only when native voice starts and releases it when voice ends", async () => {
    const { socket, status } = session();
    socket.emit({ type: "ready" });
    socket.emit({ type: "active", active: false });
    expect(getUserMedia).not.toHaveBeenCalled();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    socket.emit({ type: "active", active: false });
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
  });

  it("stops late microphone grants after hiding or disposing the terminal", async () => {
    let grant: (stream: MediaStream) => void = () => {};
    getUserMedia.mockReturnValue(
      new Promise<MediaStream>((resolve) => {
        grant = resolve;
      }),
    );
    const { audio, socket } = session();
    socket.emit({ type: "active", active: true });
    audio.setVisible(false);
    grant(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances).toHaveLength(0);
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
  });

  it("prevents simultaneous microphone calls and releases native capture on denial", async () => {
    const first = session();
    first.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    const second = session();
    second.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(second.status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("other terminal"),
    });
    first.audio.dispose();
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const denied = session();
    denied.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(denied.socket.send).toHaveBeenCalledWith('{"type":"release"}');
    expect(denied.status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("denied"),
    });
  });

  it("releases active media on socket closure and permits a subsequent native call", async () => {
    const first = session();
    first.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    first.socket.onclose?.();
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    const socket = Socket.instances.at(-1) as Socket;
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });
});
