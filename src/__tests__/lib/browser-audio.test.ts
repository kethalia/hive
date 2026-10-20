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
  constructor(
    readonly url?: string,
    readonly protocols?: string | string[],
  ) {
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
  onstatechange: (() => void) | null = null;
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
let callbacks: WeakMap<TerminalAudio, ReturnType<typeof vi.fn>>;
let stop: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let stream: MediaStream;
let pendingGrants: Array<() => void>;
beforeEach(() => {
  vi.useFakeTimers();
  sessions = [];
  callbacks = new WeakMap();
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
function session(canStart = () => true, url = "wss://hive/ws/audio") {
  const status = vi.fn();
  const audio = new TerminalAudio(url, status, canStart);
  callbacks.set(audio, status);
  sessions.push(audio);
  audio.setVisible(true);
  return { audio, status, socket: Socket.instances.at(-1) as Socket };
}

// Existing media/lifecycle cases explicitly approve their simulated voice call.
// Security cases below send native activity without using this helper.
function approveVoice(socket: Socket) {
  const audio = sessions.find(
    (audio) => (audio as unknown as { socket: Socket }).socket === socket,
  );
  expect(audio).toBeDefined();
  socket.emit({ type: "active", active: true });
  audio?.approveMicrophone(callbacks.get(audio)?.mock.lastCall?.[0]?.requestId ?? -1);
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
  it.each([
    true,
    false,
    undefined,
  ])("requires explicit approval even when a relay sets claimRequired=%s", async (claimRequired) => {
    const { audio, socket, status } = session();
    audio.approveMicrophone(-1); // Approval cannot arm a future workspace request.
    socket.emit({ type: "ready", claimRequired });
    socket.emit({ type: "active", active: true });
    audio.prime();
    socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"claim"}');
    expect(status).toHaveBeenLastCalledWith({
      phase: "request",
      message: expect.any(String),
      requestId: expect.any(Number),
    });
    const requestId = status.mock.lastCall![0].requestId;
    audio.approveMicrophone(requestId);
    audio.approveMicrophone(requestId); // Duplicate clicks cannot create parallel claims.
    if (claimRequired) socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    socket.emit({ type: "active", active: false });
    socket.emit({ type: "active", active: true });
    audio.prime();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("rejects approval for an expired request after a replacement capture starts", async () => {
    const { audio, socket, status } = session();
    socket.emit({ type: "active", active: true });
    const expired = status.mock.lastCall![0].requestId;
    socket.emit({ type: "active", active: false });
    socket.emit({ type: "active", active: true });
    const current = status.mock.lastCall![0].requestId;
    expect(current).not.toBe(expired);
    audio.approveMicrophone(expired);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    audio.approveMicrophone(current);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("does not carry microphone approval through a disconnected relay", async () => {
    const { audio, socket } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(3000);
    const replacement = Socket.instances.at(-1)!;
    replacement.emit({ type: "active", active: true });
    audio.prime();
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("authorizes before opening audio and ignores grants after disposal", async () => {
    let complete!: (protocols: string[]) => void;
    const authorize = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const audio = new TerminalAudio("wss://terminal/ws/audio", vi.fn(), () => true, authorize);
    sessions.push(audio);
    audio.setVisible(true);
    audio.refreshFocus();
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(0);
    complete(["hive-audio-v1", "hive-ticket.fixture"]);
    await Promise.resolve();
    expect(Socket.instances[0].protocols).toEqual(["hive-audio-v1", "hive-ticket.fixture"]);
    audio.dispose();

    const pending = new TerminalAudio("wss://terminal/ws/audio", vi.fn(), () => true, authorize);
    sessions.push(pending);
    pending.setVisible(true);
    pending.dispose();
    complete(["hive-audio-v1", "hive-ticket.stale"]);
    await Promise.resolve();
    expect(Socket.instances).toHaveLength(1);
  });
  it.each([
    "hidden",
    "unfocused",
    "frozen",
  ])("suspends the ownership deadline while the pane is %s", async (mode) => {
    let focused = true;
    const { audio, socket, status } = session(() => focused);
    socket.emit({ type: "ready", claimRequired: true });
    approveVoice(socket);
    expect(socket.send).toHaveBeenCalledWith('{"type":"claim"}');
    await vi.advanceTimersByTimeAsync(7000);
    if (mode === "hidden") audio.setVisible(false);
    else if (mode === "frozen") audio.setFrozen(true);
    else {
      focused = false;
      audio.refreshFocus();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
    expect(socket.close).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    if (mode === "hidden") audio.setVisible(true);
    else if (mode === "frozen") audio.setFrozen(false);
    else {
      focused = true;
      audio.refreshFocus();
    }
    // Allow queued ownership confirmation to arrive before a fresh deadline.
    await vi.advanceTimersByTimeAsync(7999);
    socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(socket.send.mock.calls.filter(([value]) => value === '{"type":"claim"}')).toHaveLength(
      1,
    );
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
  });

  it("still times out unconfirmed ownership while the pane stays focused", async () => {
    const { socket, status } = session();
    socket.emit({ type: "ready", claimRequired: true });
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(8000);
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: "Voice ownership timed out. Run /voice again.",
    });
  });

  it("cancels a paused ownership deadline when native capture ends", async () => {
    const { audio, socket } = session();
    socket.emit({ type: "ready", claimRequired: true });
    approveVoice(socket);
    audio.setFrozen(true);
    socket.emit({ type: "active", active: false });
    const releases = () =>
      socket.send.mock.calls.filter(([value]) => value === '{"type":"release"}').length;
    const endedReleases = releases();
    audio.setFrozen(false);
    socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(releases()).toBe(endedReleases);
  });

  it("ignores a superseded resume rejection while the latest attempt succeeds", async () => {
    let rejectFirst = (_error: Error) => {};
    let resolveLatest = () => {};
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const latest = new Promise<void>((resolve) => {
      resolveLatest = resolve;
    });
    vi.stubGlobal(
      "AudioContext",
      class extends Context {
        state = "suspended";
        resume = vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(latest);
      },
    );
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.setVisible(false);
    audio.setVisible(true);
    const context = Context.instances[0];
    expect(context.resume).toHaveBeenCalledTimes(3);
    rejectFirst(new Error("Older focus attempt rejected"));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
    expect(stop).not.toHaveBeenCalled();
    context.state = "running";
    resolveLatest();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("rejects queued capture packets from before a pause after focus resumes", async () => {
    const { audio, socket } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    const port = Worklet.instances[0].port;
    const controls = () =>
      port.postMessage.mock.calls.map(([data]) => data).filter((data) => data.type === "pause");
    const firstGeneration = controls().at(-1).generation;
    const queued = { pcm: new ArrayBuffer(960), generation: firstGeneration };
    audio.setVisible(false);
    audio.setVisible(true);
    const generation = controls().at(-1).generation;
    expect(generation).toBeGreaterThan(firstGeneration);
    socket.send.mockClear();
    const capture = port.onmessage as unknown as (event: { data: unknown }) => void;
    capture({ data: queued });
    capture({ data: new ArrayBuffer(960) });
    capture({ data: { pcm: new ArrayBuffer(960), generation: generation - 1 } });
    capture({ data: { pcm: new ArrayBuffer(958), generation } });
    expect(socket.send).not.toHaveBeenCalled();
    capture({ data: { pcm: new ArrayBuffer(960), generation } });
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: "microphone",
      pcm: btoa(String.fromCharCode(...new Uint8Array(960))),
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("keeps backgrounded playback initialization alive beyond the autoplay deadline", async () => {
    vi.stubGlobal(
      "AudioContext",
      class extends Context {
        state = "suspended";
        resume = vi.fn(() => new Promise<void>(() => {}));
      },
    );
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    const context = Context.instances[0];
    context.resume.mockImplementation(async () => {
      context.state = "running";
    });
    audio.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("still ends playback initialization if autoplay stays blocked while focused", async () => {
    vi.stubGlobal(
      "AudioContext",
      class extends Context {
        state = "suspended";
        resume = vi.fn(() => new Promise<void>(() => {}));
      },
    );
    const { socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(8000);
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
    expect(stop).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "error" }));
  });

  it("resumes a suspended call before enabling tracks or reporting connected", async () => {
    const track = { enabled: true, stop, onended: null };
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.setVisible(false);
    const context = Context.instances[0];
    context.state = "suspended";
    context.onstatechange?.();
    let resume = () => {};
    context.resume.mockReturnValue(
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
    );
    audio.setVisible(true);
    expect(track.enabled).toBe(false);
    expect(status).toHaveBeenLastCalledWith({ phase: "connecting", message: "Resuming voice…" });
    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.enabled).toBe(false);
    context.state = "running";
    context.onstatechange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.enabled).toBe(true);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(socket.close).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("re-probes an overdue heartbeat after a frozen tab without releasing the call", async () => {
    const { audio, socket } = session();
    socket.onopen?.();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.setFrozen(true);
    vi.setSystemTime(Date.now() + 60_000);
    // The overdue timer can run before the page's resume or queued pong handlers.
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.close).not.toHaveBeenCalled();
    audio.setFrozen(false);
    expect(socket.send).toHaveBeenCalledWith('{"type":"ping"}');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("rejects speaker frames queued before focus resumed even after a queued pong", async () => {
    const { audio, socket } = session();
    socket.emit({ type: "ready", playbackGeneration: true });
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    const generation = () =>
      JSON.parse(
        socket.send.mock.calls.filter(([data]) => JSON.parse(data).type === "playback").at(-1)![0],
      ).generation;
    const oldGeneration = generation();
    const port = Worklet.instances[0].port;
    const pcm = btoa(String.fromCharCode(...new Uint8Array(960)));
    audio.setFrozen(true);
    audio.setFrozen(false);
    port.postMessage.mockClear();
    socket.emit({ type: "pong" });
    socket.emit({ type: "speaker", pcm, generation: oldGeneration });
    socket.emit({ type: "speaker", pcm });
    expect(port.postMessage).not.toHaveBeenCalled();
    socket.emit({ type: "speaker", pcm, generation: generation() });
    expect(port.postMessage).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("retries the latest playback generation after congestion and cancels it on end", async () => {
    const { audio, socket } = session();
    socket.emit({ type: "ready", playbackGeneration: true });
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    socket.send.mockClear();
    socket.bufferedAmount = 70_000;
    audio.setVisible(false);
    audio.setVisible(true);
    expect(socket.send).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { type: "playback", enabled: true, generation: 3 },
    ]);
    socket.bufferedAmount = 70_000;
    audio.setVisible(false);
    socket.emit({ type: "active", active: false });
    socket.send.mockClear();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("cancels pending context recovery when native voice ends", async () => {
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.setVisible(false);
    const context = Context.instances[0];
    context.state = "suspended";
    let resume = () => {};
    context.resume.mockReturnValue(
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
    );
    audio.setVisible(true);
    socket.emit({ type: "active", active: false });
    context.state = "running";
    resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status).toHaveBeenLastCalledWith({ phase: "standby" });
    expect(context.close).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it.each([
    "module",
    "resume",
  ] as const)("disables microphone tracks while %s initialization is pending in an unfocused pane", async (stage) => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal(
      "AudioContext",
      class extends Context {
        constructor() {
          super();
          if (stage === "module") this.audioWorklet.addModule.mockReturnValue(pending);
          else this.resume.mockReturnValue(pending);
        }
      },
    );
    const track = { enabled: true, stop, onended: null };
    stream = { getTracks: () => [track] } as unknown as MediaStream;
    getUserMedia.mockResolvedValue(stream);
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(Worklet.instances).toHaveLength(0);
    audio.setVisible(false);
    expect(track.enabled).toBe(false);
    audio.setVisible(true);
    expect(track.enabled).toBe(true);
    audio.setVisible(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.enabled).toBe(false);
    expect(status).toHaveBeenLastCalledWith({
      phase: "paused",
      message: "Voice paused — focus this pane to resume",
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    audio.setVisible(true);
    expect(track.enabled).toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("routes microphone and speaker audio only to the focused call without releasing other calls", async () => {
    let selected = 0;
    const tracks = [0, 1].map(() => ({ enabled: true, stop: vi.fn(), onended: null }));
    getUserMedia
      .mockResolvedValueOnce({ getTracks: () => [tracks[0]] })
      .mockResolvedValueOnce({ getTracks: () => [tracks[1]] });
    const first = session(() => selected === 0);
    first.socket.onopen?.();
    first.socket.emit({ type: "ready", claimRequired: true });
    approveVoice(first.socket);
    first.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    selected = 1;
    first.audio.refreshFocus();
    const second = session(() => selected === 1, "wss://hive/ws/audio?sessionName=other");
    approveVoice(second.socket);
    await vi.advanceTimersByTimeAsync(0);
    const pcm = btoa(String.fromCharCode(...new Uint8Array(960)));
    const transmit = (index: number, generation: number) =>
      (Worklet.instances[index].port.onmessage as unknown as (event: { data: unknown }) => void)({
        data: { pcm: new ArrayBuffer(960), generation },
      });
    for (let index = 0; index < 4; index++) {
      selected = index % 2;
      first.audio.refreshFocus();
      second.audio.refreshFocus();
      for (const [at, call] of [first, second].entries()) {
        call.socket.send.mockClear();
        const port = Worklet.instances[at].port;
        const generation = port.postMessage.mock.calls
          .filter(([data]) => data?.type === "pause")
          .at(-1)![0].generation;
        port.postMessage.mockClear();
        transmit(at, generation);
        call.socket.emit({ type: "speaker", pcm });
        expect(tracks[at].enabled).toBe(at === selected);
        expect(call.socket.send.mock.calls).toHaveLength(at === selected ? 1 : 0);
        expect(port.postMessage.mock.calls).toHaveLength(at === selected ? 1 : 0);
        expect(call.socket.close).not.toHaveBeenCalled();
        expect(tracks[at].stop).not.toHaveBeenCalled();
      }
    }
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.socket.send).toHaveBeenCalledWith('{"type":"ping"}');
  });

  it("keeps hidden workspace calls connected and resumes without reclaiming or prompting", async () => {
    const { audio, socket, status } = session();
    socket.emit({ type: "ready", claimRequired: true });
    approveVoice(socket);
    socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    audio.setVisible(false);
    expect(status).toHaveBeenLastCalledWith({
      phase: "paused",
      message: "Voice paused — focus this pane to resume",
    });
    expect(Worklet.instances[0].port.postMessage).toHaveBeenLastCalledWith({
      type: "pause",
      paused: true,
      playbackPaused: true,
      generation: 2,
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
    expect(stop).not.toHaveBeenCalled();
    audio.setVisible(true);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(
      socket.send.mock.calls.filter(([message]) => message === '{"type":"claim"}'),
    ).toHaveLength(1);
    socket.emit({ type: "active", active: false });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("finishes a pending microphone grant in a paused workspace without transmitting audio", async () => {
    let loadModule = () => {};
    const module = new Promise<void>((resolve) => {
      loadModule = resolve;
    });
    vi.stubGlobal(
      "AudioContext",
      class extends Context {
        constructor() {
          super();
          this.audioWorklet.addModule.mockReturnValue(module);
        }
      },
    );
    const track = { enabled: true, stop, onended: null };
    const { promise, grant } = pendingPermission();
    stream = { getTracks: () => [track] } as unknown as MediaStream;
    getUserMedia.mockReturnValueOnce(promise);
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.setVisible(false);
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(track.enabled).toBe(false);
    expect(Worklet.instances).toHaveLength(0);
    loadModule();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({
      phase: "paused",
      message: "Voice paused — focus this pane to resume",
    });
    audio.setVisible(true);
    expect(track.enabled).toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
    audio.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("retries a congested call claim without consuming another interaction", async () => {
    const { socket, status } = session();
    socket.emit({ type: "ready", claimRequired: true });
    socket.bufferedAmount = 70_000;
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.send).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.send).toHaveBeenCalledWith('{"type":"claim"}');
    socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });

  it("cancels a queued claim when native capture ends", async () => {
    const { socket } = session();
    socket.emit({ type: "ready", claimRequired: true });
    socket.bufferedAmount = 70_000;
    approveVoice(socket);
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
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    const port = Worklet.instances[0].port;
    const generation = port.postMessage.mock.calls.at(-1)![0].generation;
    const transmit = () =>
      (port.onmessage as unknown as (event: { data: unknown }) => void)({
        data: { pcm: new ArrayBuffer(960), generation },
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
    approveVoice(first.socket);
    first.socket.emit({ type: "error", code: "session_busy", message: "Already connected." });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(first.socket.close).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(1);
    first.socket.emit({ type: "active", active: false });
    expect(first.status).toHaveBeenLastCalledWith({ phase: "standby" });
    approveVoice(first.socket);
    first.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
  it("keeps separate terminal calls connected without ending the other call", async () => {
    const first = session();
    const second = session(() => true, "wss://hive/ws/audio?sessionName=other");
    approveVoice(first.socket);
    approveVoice(second.socket);
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
    approveVoice(first.socket);
    expect(first.socket.send).toHaveBeenCalledWith('{"type":"claim"}');
    expect(getUserMedia).not.toHaveBeenCalled();
    first.socket.emit({ type: "claimed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("an unused device observes native capture without reserving the call or prompting", async () => {
    const unused = session();
    unused.socket.emit({ type: "ready", claimRequired: true });
    unused.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(unused.socket.send).not.toHaveBeenCalledWith('{"type":"claim"}');
    expect(getUserMedia).not.toHaveBeenCalled();
    const current = session();
    current.socket.emit({ type: "ready", claimRequired: true });
    approveVoice(current.socket);
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
    approveVoice(first.socket);
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
    approveVoice(replacement);
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

  it("rejects background capture and keeps paused call ownership after focus changes", async () => {
    let focused = true;
    const background = session(() => focused);
    // Native activity may arrive just before the DOM focus update runs.
    focused = false;
    approveVoice(background.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    background.audio.refreshFocus();
    expect(background.socket.send).toHaveBeenCalledWith('{"type":"release"}');
    focused = true;
    background.audio.refreshFocus();
    await vi.advanceTimersByTimeAsync(3000);
    const socket = Socket.instances.at(-1) as Socket;
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    focused = false;
    background.audio.refreshFocus();
    const other = session();
    approveVoice(other.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(background.status).toHaveBeenLastCalledWith({
      phase: "paused",
      message: "Voice paused — focus this pane to resume",
    });
  });

  it("does not open another permission request before a disposed request settles", async () => {
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValueOnce(promise);
    const first = session();
    approveVoice(first.socket);
    await vi.advanceTimersByTimeAsync(0);
    first.audio.dispose();
    const other = session();
    approveVoice(other.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances.every((context) => context.close.mock.calls.length > 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    const retry = Socket.instances.at(-1) as Socket;
    retry.emit({ type: "active", active: false });
    approveVoice(retry);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("ignores a retired audio processor's error after starting another call", async () => {
    const { socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    const oldError = Worklet.instances[0].onprocessorerror;
    socket.emit({ type: "active", active: false });
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    oldError?.();
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
  });

  it("blocks a same-terminal restart while its previous permission request is pending", async () => {
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValueOnce(promise);
    const { socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    socket.emit({ type: "active", active: false });
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("permission request"),
    });
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances.every((context) => context.close.mock.calls.length > 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    const retry = Socket.instances.at(-1) as Socket;
    retry.emit({ type: "active", active: false });
    approveVoice(retry);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });

  it("ignores a retired microphone track's end event after starting another call", async () => {
    const track = { stop, onended: null as (() => void) | null };
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    const { socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    const oldEnded = track.onended;
    socket.emit({ type: "active", active: false });
    approveVoice(socket);
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
    approveVoice(available);
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
    approveVoice(socket);
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
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("other Hive tab or window"),
    });
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
  });

  it("holds the origin lock until a disposed terminal's pending permission settles", async () => {
    let released = false;
    const request = vi.fn(async (_name, _options, callback) => {
      await callback({ name: "hive-terminal-microphone" });
      released = true;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValue(promise);
    const { audio, socket } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    audio.dispose();
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
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
    socket.emit({ type: "active", active: false });
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
  });

  it("stops late microphone grants after disposing the terminal", async () => {
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValue(promise);
    const { audio, socket } = session();
    approveVoice(socket);
    audio.dispose();
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(Context.instances.every((context) => context.close.mock.calls.length > 0)).toBe(true);
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
  });

  it("prevents duplicate views of one call and releases native capture on denial", async () => {
    const first = session();
    approveVoice(first.socket);
    await vi.advanceTimersByTimeAsync(0);
    const second = session();
    approveVoice(second.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(second.status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("another view"),
    });
    first.audio.dispose();
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const denied = session();
    approveVoice(denied.socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(denied.socket.send).toHaveBeenCalledWith('{"type":"release"}');
    expect(denied.status).toHaveBeenLastCalledWith({
      phase: "error",
      message: expect.stringContaining("denied"),
    });
  });

  it("releases active media on socket closure and permits a subsequent native call", async () => {
    const first = session();
    approveVoice(first.socket);
    await vi.advanceTimersByTimeAsync(0);
    first.socket.onclose?.();
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    const socket = Socket.instances.at(-1) as Socket;
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.status).toHaveBeenLastCalledWith({ phase: "active", message: "Voice connected" });
  });
});

describe("header device controls", () => {
  it("starts native voice from one bounded explicit menu approval", async () => {
    const { audio, socket } = session();
    const start = vi.fn();
    audio.connectDevice("microphone", start);
    expect(start).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
    socket.emit({ type: "active", active: false });
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "focus loss"])("does not carry menu approval past %s", async (reason) => {
    let focused = true;
    const { audio, socket } = session(() => focused);
    audio.connectDevice("microphone", vi.fn());
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(8000);
    else {
      focused = false;
      audio.refreshFocus();
      focused = true;
      audio.refreshFocus();
    }
    Socket.instances.at(-1)!.emit({ type: "active", active: true });
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("pauses and stops the microphone while retaining speaker playback, then reconnects input", async () => {
    const track = { enabled: true, stop, onended: null };
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    const { audio, socket } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    const worklet = Worklet.instances[0];
    audio.toggleMicrophone();
    expect(track.enabled).toBe(false);
    expect(worklet.port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ paused: true, playbackPaused: false }),
    );
    audio.toggleMicrophone();
    expect(track.enabled).toBe(true);
    audio.stopMicrophone();
    expect(stop).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    expect(worklet.disconnect).not.toHaveBeenCalled();
    audio.connectDevice("microphone", vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(Worklet.instances).toHaveLength(1);
  });

  it("keeps speakers stopped when microphone permission finishes later", async () => {
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValueOnce(promise);
    const { audio, socket } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    audio.stopSpeaker();
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(Worklet.instances[0].port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ paused: false, playbackPaused: true }),
    );
    expect(socket.close).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("can connect only speakers without requesting microphone permission", async () => {
    const { audio, socket } = session();
    audio.connectDevice("speaker", vi.fn());
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(Worklet.instances).toHaveLength(1);
    audio.stopSpeaker();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    {},
  ])("supports speaker-only browsers with mediaDevices=%s", async (mediaDevices) => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    const { audio, socket, status } = session();
    audio.connectDevice("speaker", vi.fn());
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(Worklet.instances).toHaveLength(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    audio.connectDevice("microphone", vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenLastCalledWith({
      phase: "error",
      message: "Microphone access is unavailable in this browser.",
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(Worklet.instances[0].disconnect).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("cleans up an ended microphone with speakers stopped=%s", async (speakerStopped) => {
    const track = { enabled: true, stop, onended: null as (() => void) | null };
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    const { audio, socket, status } = session();
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    if (speakerStopped) audio.stopSpeaker();
    track.onended?.();
    expect(stop).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "error",
        message: expect.stringContaining("Microphone access ended"),
      }),
    );
    if (speakerStopped) {
      expect(socket.close).toHaveBeenCalledOnce();
      expect(Worklet.instances[0].disconnect).toHaveBeenCalledOnce();
    } else {
      expect(socket.close).not.toHaveBeenCalled();
      expect(Worklet.instances[0].disconnect).not.toHaveBeenCalled();
      const pcm = btoa(String.fromCharCode(...new Uint8Array(960)));
      socket.emit({ type: "speaker", pcm });
      expect(Worklet.instances[0].port.postMessage).toHaveBeenLastCalledWith(
        expect.any(ArrayBuffer),
        expect.any(Array),
      );
      audio.connectDevice("microphone", vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(Worklet.instances).toHaveLength(1);
    }
  });

  it("detects background sound without playing it and clears the indicator after silence", async () => {
    let focused = true;
    const devices = vi.fn();
    const audio = new TerminalAudio(
      "wss://hive/ws/audio",
      vi.fn(),
      () => focused,
      undefined,
      devices,
    );
    sessions.push(audio);
    audio.setVisible(true);
    const socket = Socket.instances.at(-1)!;
    audio.connectDevice("speaker", vi.fn());
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    focused = false;
    audio.refreshFocus();
    const port = Worklet.instances[0].port;
    port.postMessage.mockClear();
    const pcm = btoa(String.fromCharCode(...new Uint8Array(new Int16Array(480).fill(8192).buffer)));
    socket.emit({ type: "speaker", pcm });
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(devices).toHaveBeenLastCalledWith(
      expect.objectContaining({ playing: true, focused: false, speaker: "paused" }),
    );
    audio.toggleSpeaker();
    expect(devices).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }));
    socket.emit({ type: "speaker", pcm });
    expect(devices).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }));
    audio.toggleSpeaker();
    socket.emit({ type: "speaker", pcm });
    await vi.advanceTimersByTimeAsync(400);
    expect(devices).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }));
  });

  it("discards a microphone grant stopped while speakers remain connected", async () => {
    const { audio, socket } = session();
    audio.connectDevice("speaker", vi.fn());
    socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    const { promise, grant } = pendingPermission();
    getUserMedia.mockReturnValueOnce(promise);
    audio.connectDevice("microphone", vi.fn());
    audio.stopMicrophone();
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    expect(Worklet.instances[0].disconnect).not.toHaveBeenCalled();
    const duplicate = session();
    duplicate.audio.connectDevice("speaker", vi.fn());
    duplicate.socket.emit({ type: "active", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(duplicate.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "error", message: expect.stringContaining("another view") }),
    );
    expect(Worklet.instances).toHaveLength(1);
  });
});

describe("temporary background reply playback", () => {
  async function backgroundReply() {
    let focused = true;
    const track = { enabled: true, stop, onended: null };
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    const { audio, socket } = session(() => focused);
    approveVoice(socket);
    await vi.advanceTimersByTimeAsync(0);
    focused = false;
    audio.refreshFocus();
    const port = Worklet.instances[0].port;
    const pcm = btoa(String.fromCharCode(...new Uint8Array(new Int16Array(480).fill(8192).buffer)));
    socket.emit({ type: "speaker", pcm });
    port.postMessage.mockClear();
    return {
      audio,
      socket,
      track,
      port,
      pcm,
      focus: () => {
        focused = true;
        audio.refreshFocus();
      },
    };
  }

  it("plays the live reply without enabling the background microphone or selecting its pane", async () => {
    const { audio, socket, track, port, pcm } = await backgroundReply();
    expect(audio.listenToCurrentReply()).toBe(true);
    expect(track.enabled).toBe(false);
    expect(port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ paused: true, playbackPaused: false }),
    );
    port.postMessage.mockClear();
    socket.emit({ type: "speaker", pcm });
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), expect.any(Array));
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("ends the exception after two seconds of silence and keeps later replies silent", async () => {
    const { audio, socket, port, pcm } = await backgroundReply();
    audio.listenToCurrentReply();
    await vi.advanceTimersByTimeAsync(1000);
    socket.emit({ type: "speaker", pcm });
    await vi.advanceTimersByTimeAsync(1500);
    expect(
      port.postMessage.mock.calls.filter(([data]) => data?.type === "pause").at(-1)?.[0]
        .playbackPaused,
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    expect(port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ paused: true, playbackPaused: true }),
    );
    expect(audio.listenToCurrentReply()).toBe(false);
    port.postMessage.mockClear();
    socket.emit({ type: "speaker", pcm });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    "mute",
    "stop",
    "hide",
    "freeze",
    "end",
    "dispose",
  ])("cancels temporary listening on %s", async (action) => {
    const { audio, socket, port, pcm } = await backgroundReply();
    audio.listenToCurrentReply();
    if (action === "mute") audio.toggleSpeaker();
    else if (action === "stop") audio.stopSpeaker();
    else if (action === "hide") audio.setPageActive(false);
    else if (action === "freeze") audio.setFrozen(true);
    else if (action === "end") socket.emit({ type: "active", active: false });
    else audio.dispose();
    if (action === "mute") audio.toggleSpeaker();
    if (action === "stop") audio.connectDevice("speaker", vi.fn());
    if (action === "hide") audio.setPageActive(true);
    if (action === "freeze") audio.setFrozen(false);
    port.postMessage.mockClear();
    socket.emit({ type: "speaker", pcm });
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("returns to normal routing after focusing the source pane", async () => {
    const reply = await backgroundReply();
    reply.audio.listenToCurrentReply();
    reply.focus();
    expect(reply.track.enabled).toBe(true);
    reply.audio.setVisible(false);
    expect(reply.port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ paused: true, playbackPaused: true }),
    );
  });
});
