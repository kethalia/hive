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
  static instances: Worklet[] = [];
  port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  constructor() {
    Worklet.instances.push(this);
  }
}
let sessions: TerminalAudio[];
let stop: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let stream: MediaStream;
let pendingGrants: Array<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  sessions = [];
  pendingGrants = [];
  Socket.instances = [];
  Context.instances = [];
  Worklet.instances = [];
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
afterEach(async () => {
  for (const session of sessions) session.dispose();
  for (const grant of pendingGrants) grant();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
});
function session(canStart = () => true, url = "wss://hive/ws/audio", canClaim = canStart) {
  const status = vi.fn();
  const audio = new TerminalAudio(url, status, canStart, canClaim);
  sessions.push(audio);
  audio.setVisible(true);
  return { audio, status, socket: Socket.instances.at(-1) as Socket };
}

function pendingPermission() {
  let grant = () => {};
  const promise = new Promise<MediaStream>((resolve) => {
    grant = () => resolve(stream);
  });
  pendingGrants.push(grant);
  return { promise, grant };
}

describe("native terminal browser audio", () => {
  it("retries a congested call claim without consuming another interaction", async () => {
    let armed = true;
    const canClaim = vi.fn(() => {
      const value = armed;
      armed = false;
      return value;
    });
    const { socket, status } = session(() => true, "wss://hive/ws/audio", canClaim);
    socket.emit({ type: "ready", claimRequired: true });
    socket.bufferedAmount = 70_000;
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.send).not.toHaveBeenCalled();
    expect(canClaim).toHaveBeenCalledOnce();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.send).toHaveBeenCalledWith('{"type":"claim"}');
    socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(canClaim).toHaveBeenCalledOnce();
  });

  it("cancels a queued claim when native capture ends", async () => {
    const { socket } = session();
    socket.emit({ type: "ready", claimRequired: true });
    socket.bufferedAmount = 70_000;
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(100);
    socket.emit({ type: "active", active: false });
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"claim"}');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("drops microphone frames during a short network stall and resumes the same call", async () => {
    const { socket, status } = session();
    socket.onopen?.();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    const port = Worklet.instances[0].port;
    const transmit = () =>
      (port.onmessage as unknown as (event: { data: ArrayBuffer }) => void)({
        data: new ArrayBuffer(960),
      });
    socket.send.mockClear();
    socket.bufferedAmount = 70_000;
    transmit();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    transmit();
    expect(JSON.parse(socket.send.mock.calls[0][0]).type).toBe("microphone");
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });

  it("keeps heartbeats bounded during congestion and closes a persistently unresponsive connection", async () => {
    const { socket } = session();
    socket.onopen?.();
    socket.bufferedAmount = 66_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.send).toHaveBeenCalledWith('{"type":"ping"}');
    socket.bufferedAmount = 70_000;
    socket.send.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("keeps a rejected call observer connected until the owner finishes", async () => {
    const first = session();
    first.socket.emit({ type: "ready", claimRequired: true });
    first.socket.emit({ type: "active", active: true });
    first.socket.emit({ type: "error", code: "session_busy", message: "Already connected." });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(first.socket.close).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(1);
    first.socket.emit({ type: "active", active: false });
    expect(first.status).toHaveBeenLastCalledWith({ phase: "standby" });
    first.socket.emit({ type: "active", active: true });
    first.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
  it("allows separate terminals to exchange microphone audio at the same time", async () => {
    const first = session();
    const second = session(() => true, "wss://hive/ws/audio?sessionName=other");
    first.socket.emit({ type: "active", active: true });
    second.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    for (const call of [first, second])
      expect(call.status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    first.socket.emit({ type: "active", active: false });
    expect(second.socket.close).not.toHaveBeenCalled();
    expect(Context.instances[1].close).not.toHaveBeenCalled();
  });

  it("claims a workspace call before requesting microphone permission", async () => {
    const first = session();
    first.socket.emit({ type: "ready", claimRequired: true });
    first.socket.emit({ type: "active", active: true });
    expect(first.socket.send).toHaveBeenCalledWith('{"type":"claim"}');
    expect(getUserMedia).not.toHaveBeenCalled();
    first.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("an unused device observes native capture without reserving the call or prompting", async () => {
    const unused = session(
      () => true,
      "wss://hive/ws/audio",
      () => false,
    );
    unused.socket.emit({ type: "ready", claimRequired: true });
    unused.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(unused.socket.send).not.toHaveBeenCalledWith('{"type":"claim"}');
    expect(getUserMedia).not.toHaveBeenCalled();
    const current = session();
    current.socket.emit({ type: "ready", claimRequired: true });
    current.socket.emit({ type: "active", active: true });
    current.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(current.status).toHaveBeenLastCalledWith({
      phase: "active",
      message: "Voice connected",
    });
  });

  it("does not use a late claim confirmation after native capture ends", async () => {
    const first = session();
    first.socket.emit({ type: "ready", claimRequired: true });
    first.socket.emit({ type: "active", active: true });
    first.socket.emit({ type: "active", active: false });
    first.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("does not claim an idle session relay from a background view", () => {
    session(() => false);
    expect(Socket.instances).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("hands an idle relay to the focused view without disturbing a live call", async () => {
    let focused = true;
    const first = session(() => focused);
    focused = false;
    first.audio.refreshFocus();
    expect(first.socket.close).toHaveBeenCalledOnce();
    focused = true;
    first.audio.refreshFocus();
    const replacement = Socket.instances.at(-1) as Socket;
    replacement.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    focused = false;
    first.audio.refreshFocus();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    replacement.emit({ type: "active", active: false });
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    first.audio.refreshFocus();
    expect(Socket.instances).toHaveLength(2);
  });

  it("does not retry session ownership from an unfocused view", async () => {
    let focused = true;
    const first = session(() => focused);
    first.socket.emit({ type: "error", code: "session_busy", message: "Session is busy." });
    focused = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(Socket.instances).toHaveLength(1);
    focused = true;
    first.audio.refreshFocus();
    expect(Socket.instances).toHaveLength(2);
  });

  it("rejects background capture and keeps an existing call pinned after focus changes", async () => {
    let focused = true;
    const background = session(() => focused);
    // Native activity may arrive just before the DOM focus update runs.
    focused = false;
    background.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(background.socket.send).toHaveBeenCalledWith('{"type":"release"}');
    focused = true;
    await vi.advanceTimersByTimeAsync(3000);
    const socket = Socket.instances.at(-1) as Socket;
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    focused = false;
    const other = session();
    other.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(background.status).toHaveBeenLastCalledWith({
      phase: "active",
      message: "Voice connected",
    });
  });

  it("does not open another permission request before a canceled request settles", async () => {
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValueOnce(promise);
    const first = session();
    first.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    first.audio.setVisible(false);
    const other = session();
    other.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    (Socket.instances.at(-1) as Socket).emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("ignores a retired audio processor's error after starting another call", async () => {
    const { socket, status } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    const oldError = Worklet.instances[0].onprocessorerror;
    socket.emit({ type: "active", active: false });
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    oldError?.();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
  });

  it("blocks a same-terminal restart while its previous permission request is pending", async () => {
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValueOnce(promise);
    const { socket, status } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    socket.emit({ type: "active", active: false });
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("permission request"),
    });
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    (Socket.instances.at(-1) as Socket).emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });

  it("ignores a retired microphone track's end event after starting another call", async () => {
    const track = { stop, onended: null as (() => void) | null };
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    const { socket, status } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    const oldEnded = track.onended;
    socket.emit({ type: "active", active: false });
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    oldEnded?.();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
  });

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

  it("holds the origin lock until a hidden terminal's pending permission settles", async () => {
    let released = false;
    const request = vi.fn(async (_name, _options, callback) => {
      await callback({ name: "hive-terminal-microphone" });
      released = true;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValue(promise);
    const { audio, socket } = session();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    audio.setVisible(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
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
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValue(promise);
    const { audio, socket } = session();
    socket.emit({ type: "active", active: true });
    audio.setVisible(false);
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances).toHaveLength(0);
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
  });

  it("prevents duplicate views of one call and releases native capture on denial", async () => {
    const first = session();
    first.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    const second = session();
    second.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(second.status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("another view"),
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
