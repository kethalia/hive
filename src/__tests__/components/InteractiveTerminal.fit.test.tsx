// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveTerminal } from "@/components/workspaces/InteractiveTerminal";
import { EVENT_NAME as FONT_SIZE_EVENT } from "@/lib/terminal/font-size";

const mockTerminalState = vi.hoisted(() => ({
  fit: vi.fn(),
  resize: vi.fn(),
  send: vi.fn(),
  terminalInstances: [] as Array<{ rows: number; cols: number; options: { fontSize?: number } }>,
}));

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = mockTerminalState.fit;
  }

  return { FitAddon };
});

vi.mock("@xterm/xterm", () => {
  class Terminal {
    rows = 24;
    cols = 80;
    options: { fontSize?: number };
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));

    constructor(options: { fontSize?: number }) {
      this.options = { ...options };
      mockTerminalState.terminalInstances.push(this);
    }
  }

  return { Terminal };
});

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => ({
    activeSend: vi.fn(),
    handleKeyEvent: vi.fn(() => true),
  }),
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: () => ({
    connectionState: "disconnected",
    resize: mockTerminalState.resize,
    send: mockTerminalState.send,
  }),
}));

vi.mock("@/lib/runtime-config", () => ({
  getClientRuntimeConfig: () => ({ terminalWsUrl: "ws://terminal.example.test" }),
  resolveTerminalWsUrl: (value: string) => value,
}));

vi.mock("@/lib/terminal/config", () => ({
  loadTerminalFont: vi.fn(() => Promise.resolve()),
  TERMINAL_FONT_FAMILY: "Test Mono",
  TERMINAL_THEME: {},
}));

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  mockTerminalState.fit.mockReset();
  mockTerminalState.fit.mockImplementation(() => undefined);
  mockTerminalState.resize.mockClear();
  mockTerminalState.send.mockClear();
  mockTerminalState.terminalInstances.length = 0;
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("InteractiveTerminal safe fit", () => {
  it("warns instead of throwing and preserves font size when a font-step refit fails", async () => {
    const fitError = new Error("zero-sized terminal host");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onTerminalReady = vi.fn();

    render(
      <InteractiveTerminal
        agentId="agent-1"
        workspaceId="workspace-1"
        sessionName="main"
        onTerminalReady={onTerminalReady}
      />,
    );

    await waitFor(() => expect(onTerminalReady).toHaveBeenCalledTimes(1));
    const terminal = mockTerminalState.terminalInstances[0];
    expect(terminal?.options.fontSize).toBe(13);

    mockTerminalState.fit.mockImplementationOnce(() => {
      throw fitError;
    });

    expect(() => {
      act(() => {
        window.dispatchEvent(new CustomEvent(FONT_SIZE_EVENT, { detail: 18 }));
      });
    }).not.toThrow();

    expect(warn).toHaveBeenCalledWith("[InteractiveTerminal] fitAddon.fit() failed", fitError);
    expect(terminal?.options.fontSize).toBe(13);
  });

  it("does not bind a competing pinch font zoom gesture to the terminal host", async () => {
    const onTerminalReady = vi.fn();

    const { container } = render(
      <InteractiveTerminal
        agentId="agent-1"
        workspaceId="workspace-1"
        sessionName="main"
        onTerminalReady={onTerminalReady}
      />,
    );

    expect(container.querySelector("[data-terminal-pinch-zoom]")).toBeNull();

    await waitFor(() => expect(onTerminalReady).toHaveBeenCalledTimes(1));
  });
});
