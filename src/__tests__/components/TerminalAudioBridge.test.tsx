// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAudioBridge } from "@/components/terminal/TerminalAudioBridge";
import { primeTerminalAudio } from "@/lib/terminal/audio-interaction";
import { TerminalAudio } from "@/lib/terminal/browser-audio";

const ticket = `fixture.${"a".repeat(43)}`;

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols: string | string[],
  ) {
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
let containers: HTMLElement[];

beforeEach(() => {
  vi.useFakeTimers();
  containers = [];
  Socket.instances = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "/api/auth/terminal-ticket") throw new Error("Unexpected fixture request");
      return Response.json({ ticket });
    }),
  );
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
  for (const container of containers) container.remove();
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

async function mount() {
  const container = document.createElement("div");
  surface.append(container);
  const view = render(
    <TerminalAudioBridge
      proxyUrl="wss://hive"
      workspaceId="workspace"
      agentId="agent"
      sessionName="terminal"
    />,
    { container, baseElement: document.body },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const socket = Socket.instances.at(-1)!;
  expect(socket.protocols).toEqual(["hive-audio-v1", `hive-ticket.${ticket}`]);
  act(() => socket.emit({ type: "ready", claimRequired: true }));
  return { view, socket };
}

async function emit(socket: Socket, value: unknown) {
  await act(async () => {
    socket.emit(value);
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function openMicrophoneMenu(view: ReturnType<typeof render>) {
  if (view.queryByRole("button", { name: /^(Connect|Stop) microphone$/ })) return;
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Microphone:/ }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function approve(view: ReturnType<typeof render>) {
  await openMicrophoneMenu(view);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Connect microphone" }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function start(view: ReturnType<typeof render>, socket: Socket) {
  await emit(socket, { type: "active", active: true });
  await approve(view);
  await emit(socket, { type: "claimed" });
}

function frame() {
  const owner = document.createElement("div");
  owner.dataset.terminalAudioFrame = "true";
  owner.dataset.paneMode = "tiled";
  owner.dataset.active = "true";
  const header = document.createElement("header");
  const slot = document.createElement("div");
  slot.dataset.terminalAudioSlot = "true";
  header.append(slot);
  owner.append(header);
  document.body.append(owner);
  containers.push(owner);
  return { owner, slot, header };
}

describe("audio bridge location observation", () => {
  it("ignores output, popover, toast, and other-pane mutations", async () => {
    const current = frame();
    current.owner.append(surface);
    const { view, socket } = await mount();
    await start(view, socket);
    const refresh = vi.spyOn(TerminalAudio.prototype, "refreshFocus");
    await act(async () => {
      for (let i = 0; i < 100; i++) surface.append(document.createElement("span"));
      current.slot.append(document.createElement("div"));
      const unrelated = frame();
      unrelated.owner.dataset.active = "false";
      unrelated.owner.append(document.createElement("span"));
      const toast = document.createElement("div");
      document.body.append(toast);
      toast.append(document.createElement("span"));
      toast.remove();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("rebinds after ancestor moves, follows headers, and retains the call through parking", async () => {
    const first = frame();
    const second = frame();
    const host = document.createElement("div");
    host.append(surface);
    first.owner.append(host);
    const { view, socket } = await mount();
    await start(view, socket);
    expect(first.slot.querySelector('[data-audio-device="microphone"]')).not.toBeNull();
    await act(async () => {
      second.owner.append(host);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(first.slot.children).toHaveLength(0);
    expect(second.slot.querySelector('[data-audio-device="microphone"]')).not.toBeNull();
    const refresh = vi.spyOn(TerminalAudio.prototype, "refreshFocus");
    await act(async () => {
      first.owner.dataset.active = "false";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      second.owner.dataset.active = "false";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status").textContent).toContain("Voice paused");
    const parking = document.createElement("div");
    parking.setAttribute("inert", "");
    document.body.append(parking);
    containers.push(parking);
    await act(async () => {
      parking.append(host);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(second.slot.children).toHaveLength(0);
    await act(async () => {
      second.owner.dataset.active = "true";
      second.owner.append(host);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(second.slot.querySelector('[data-audio-device="microphone"]')).not.toBeNull();
    expect(view.getByRole("status").textContent).toBe("Voice connected");
    // Replacing a frame's header also moves the audio portal to its new slot.
    const newHeader = second.header.cloneNode(false) as HTMLElement;
    const newSlot = document.createElement("div");
    newSlot.dataset.terminalAudioSlot = "true";
    newHeader.append(newSlot);
    await act(async () => {
      second.header.replaceWith(newHeader);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(newSlot.querySelector('[data-audio-device="microphone"]')).not.toBeNull();
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});

describe("explicit terminal microphone approval", () => {
  it.each([
    true,
    false,
    undefined,
  ])("Enter never approves capture when claimRequired is %s", async (claimRequired) => {
    primeTerminalAudio(surface);
    const { socket, view } = await mount();
    await emit(socket, { type: "ready", claimRequired });
    await emit(socket, { type: "active", active: true });
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "claimed" });
    expect(socket.claims()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Microphone: disconnected" })).toBeDefined();
    await approve(view);
    if (claimRequired) await emit(socket, { type: "claimed" });
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("pauses a deselected pane even while xterm retains keyboard focus", async () => {
    surface.dataset.paneMode = "tiled";
    surface.dataset.active = "true";
    const input = document.createElement("input");
    surface.append(input);
    input.focus();
    const { socket, view } = await mount();
    await start(view, socket);
    act(() => input.focus());
    await act(async () => {
      surface.dataset.active = "false";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(document.activeElement).toBe(input);
    expect(view.getByRole("status").textContent).toContain("Voice paused");
    expect(socket.close).not.toHaveBeenCalled();
    await act(async () => {
      surface.dataset.active = "true";
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status").textContent).toBe("Voice connected");
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("pauses on workspace parking and window blur without releasing an approved call", async () => {
    const { socket, view } = await mount();
    await start(view, socket);
    await act(async () => {
      surface.setAttribute("inert", "");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.getByRole("status", { hidden: true }).textContent).toContain("Voice paused");
    await act(async () => {
      surface.removeAttribute("inert");
      await vi.advanceTimersByTimeAsync(0);
    });
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
    expect(view.getByRole("status").textContent).toContain("Voice connected");
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("requires fresh approval for each native capture after a successful call", async () => {
    const { socket, view } = await mount();
    await start(view, socket);
    act(() => primeTerminalAudio(surface));
    await emit(socket, { type: "active", active: false });
    await emit(socket, { type: "active", active: true });
    act(() => primeTerminalAudio(surface));
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await approve(view);
    await emit(socket, { type: "claimed" });
    expect(socket.claims()).toBe(2);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not race another device after a rejected claim", async () => {
    const { socket, view } = await mount();
    await emit(socket, { type: "active", active: true });
    await approve(view);
    await emit(socket, { type: "error", code: "session_busy", message: "Already connected." });
    expect(view.getByRole("status").textContent).toBe("Already connected.");
    await emit(socket, { type: "active", active: false });
    await emit(socket, { type: "active", active: true });
    act(() => primeTerminalAudio(surface));
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("does not reuse approval after a claim timeout and reconnect", async () => {
    const { socket, view } = await mount();
    await emit(socket, { type: "active", active: true });
    await approve(view);
    await act(async () => vi.advanceTimersByTimeAsync(11_000));
    const retry = Socket.instances.at(-1)!;
    expect(retry).not.toBe(socket);
    await emit(retry, { type: "ready", claimRequired: true });
    await emit(retry, { type: "active", active: false });
    await emit(retry, { type: "active", active: true });
    expect(retry.claims()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Microphone: disconnected" })).toBeDefined();
  });

  it("does not reuse approval when the bridge remounts", async () => {
    const first = await mount();
    await start(first.view, first.socket);
    first.view.unmount();
    const second = await mount();
    await emit(second.socket, { type: "active", active: true });
    expect(second.socket.claims()).toBe(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("a queued click cannot approve a replacement capture before its prompt renders", async () => {
    const { socket, view } = await mount();
    await emit(socket, { type: "active", active: true });
    await openMicrophoneMenu(view);
    const button = view.getByRole("button", { name: "Connect microphone" });
    act(() => {
      socket.emit({ type: "active", active: false });
      socket.emit({ type: "active", active: true });
      fireEvent.click(button);
    });
    expect(socket.claims()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    await approve(view);
    await emit(socket, { type: "claimed" });
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("a queued click cannot approve a replacement terminal before its prompt renders", async () => {
    const { socket, view } = await mount();
    await emit(socket, { type: "active", active: true });
    await openMicrophoneMenu(view);
    const button = view.getByRole("button", { name: "Connect microphone" });
    view.rerender(
      <TerminalAudioBridge
        proxyUrl="wss://hive"
        workspaceId="workspace"
        agentId="agent"
        sessionName="replacement"
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const replacement = Socket.instances.at(-1)!;
    expect(view.queryByRole("status")).toBeNull();
    act(() => {
      replacement.emit({ type: "ready", claimRequired: true });
      replacement.emit({ type: "active", active: true });
      fireEvent.click(button);
    });
    expect(replacement.claims()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    await approve(view);
    await emit(replacement, { type: "claimed" });
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("stops an approved microphone, retains speakers, and requires fresh approval after native capture ends", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    const { socket, view } = await mount();
    await start(view, socket);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop microphone" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalledWith('{"type":"release"}');
    expect(view.getByRole("button", { name: "Microphone: disconnected" })).toBeDefined();
    expect(view.getByRole("button", { name: "Speakers: connected" })).toBeDefined();
    await emit(socket, { type: "active", active: false });
    await emit(socket, { type: "active", active: true });
    expect(socket.claims()).toBe(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("Stop cancels a pending ownership claim and ignores late confirmation", async () => {
    const { socket, view } = await mount();
    await emit(socket, { type: "active", active: true });
    await approve(view);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop microphone" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await emit(socket, { type: "claimed" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith('{"type":"release"}');
  });

  it("Stop discards a late browser permission grant", async () => {
    const stop = vi.fn();
    let grant!: (stream: unknown) => void;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const { socket, view } = await mount();
    await start(view, socket);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Stop microphone" }));
      grant({ getTracks: () => [{ stop }] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(view.queryByRole("button", { name: "Stop microphone" })).toBeNull();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
