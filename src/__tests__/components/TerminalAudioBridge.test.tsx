// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAudioBridge } from "@/components/terminal/TerminalAudioBridge";
import { primeTerminalAudio } from "@/lib/terminal/audio-interaction";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    Socket.instances.push(this);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  claims() {
    return this.send.mock.calls.filter(([data]) => data === '{"type":"claim"}').length;
  }
}

class Context {
  sampleRate = 48_000;
  state = "running";
  audioWorklet = { addModule: async () => {} };
  destination = {};
  close = async () => {};
  resume = async () => {};
  createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
}

class Worklet {
  port = { onmessage: null, postMessage() {}, close() {} };
  connect() {}
  disconnect() {}
}

const originalMediaDevices = navigator.mediaDevices;
const originalLocks = navigator.locks;
let surface: HTMLDivElement;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  surface = document.createElement("div");
  surface.dataset.terminalSurface = "true";
  document.body.append(surface);
});

afterEach(async () => {
  cleanup();
  surface.remove();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
});

function mount() {
  const container = document.createElement("div");
  surface.append(container);
  const view = render(
    <TerminalAudioBridge
      proxyUrl="wss://hive"
      workspaceId="workspace"
      agentId="agent"
      sessionName="terminal"
    />,
    { container },
  );
  const socket = Socket.instances.at(-1)!;
  act(() => socket.emit({ type: "ready", claimRequired: true }));
  return { view, socket };
}

async function emit(socket: Socket, value: unknown) {
  await act(async () => {
    socket.emit(value);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("terminal audio interaction ownership", () => {
  it("pauses a deselected pane even while xterm temporarily retains keyboard focus", async () => {
    surface.dataset.paneMode = "tiled";
    surface.dataset.active = "true";
    const input = document.createElement("input");
    surface.append(input);
    input.focus();
    const { socket, view } = mount();
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: true });
    await emit(socket, { type: "claimed" });
    await act(async () => {
      surface.dataset.active = "false";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).toBe(input);
    expect(view.getByRole("status").textContent).toContain("Voice paused");
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
    await act(async () => {
      surface.dataset.active = "true";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status").textContent).toBe("Voice connected");
    expect(socket.claims()).toBe(1);
  });

  it("pauses on workspace parking and window blur without releasing the call", async () => {
    const { socket, view } = mount();
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: true });
    await emit(socket, { type: "claimed" });
    await act(async () => {
      surface.setAttribute("inert", "");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status", { hidden: true }).textContent).toContain("Voice paused");
    await act(async () => {
      surface.removeAttribute("inert");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status").textContent).toBe("Voice connected");
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status").textContent).toContain("Voice paused");
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status").textContent).toBe("Voice connected");
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("claims already-active capture using a gesture made before the bridge mounted", async () => {
    primeTerminalAudio(surface);
    await vi.advanceTimersByTimeAsync(1000);
    const { socket, view } = mount();
    await emit(socket, { type: "active", active: true });
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    await emit(socket, { type: "claimed" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(view.getByRole("status").textContent).toBe("Voice connected");
  });

  it("does not race a subsequent call on another device after successfully claiming", async () => {
    const { socket } = mount();
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: true });
    await emit(socket, { type: "claimed" });
    await emit(socket, { type: "active", active: false });
    await emit(socket, { type: "active", active: true });
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
    // Fresh interaction may claim an already-active call on this device.
    act(() => primeTerminalAudio(surface));
    expect(socket.claims()).toBe(2);
    await emit(socket, { type: "claimed" });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not race a subsequent call after the preceding claim was rejected", async () => {
    const { socket, view } = mount();
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: true });
    await emit(socket, { type: "error", code: "session_busy", message: "Already connected." });
    expect(view.getByRole("status").textContent).toBe("Already connected.");
    await emit(socket, { type: "active", active: false });
    await emit(socket, { type: "active", active: true });
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("does not leave Enter used to stop an owned call armed for the next call", async () => {
    const { socket } = mount();
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: true });
    await emit(socket, { type: "claimed" });
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: false });
    await emit(socket, { type: "active", active: true });
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("does not reuse an arm after a claim timeout and relay reconnect", async () => {
    const { socket } = mount();
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: true });
    await act(async () => vi.advanceTimersByTimeAsync(11_000));
    expect(socket.claims()).toBe(1);
    const retry = Socket.instances.at(-1)!;
    expect(retry).not.toBe(socket);
    await emit(retry, { type: "ready", claimRequired: true });
    await emit(retry, { type: "active", active: true });
    expect(retry.claims()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("does not reuse a consumed arm when the bridge remounts", async () => {
    primeTerminalAudio(surface);
    const first = mount();
    await emit(first.socket, { type: "active", active: true });
    await emit(first.socket, { type: "claimed" });
    first.view.unmount();
    const second = mount();
    await emit(second.socket, { type: "active", active: true });
    expect(second.socket.claims()).toBe(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("leaves capture unclaimed when the deferred bridge loads after the arm expires", async () => {
    primeTerminalAudio(surface);
    await vi.advanceTimersByTimeAsync(15_000);
    const { socket } = mount();
    await emit(socket, { type: "active", active: true });
    expect(socket.claims()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
