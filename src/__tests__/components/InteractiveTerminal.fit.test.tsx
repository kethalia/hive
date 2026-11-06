// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "@/components/templates/TerminalPanel";
import { InteractiveTerminal } from "@/components/workspaces/InteractiveTerminal";
import { installTerminalBrowserIntegration } from "@/lib/terminal/browser-integration";
import { TERMINAL_AUDIO_PRIME_EVENT } from "@/lib/terminal/events";
import { EVENT_NAME as FONT_SIZE_EVENT, terminalFontSizeScope } from "@/lib/terminal/font-size";

const mockTerminalState = vi.hoisted(() => ({
  fit: vi.fn(),
  resize: vi.fn(),
  send: vi.fn(),
  connectionState: "disconnected",
  terminalInstances: [] as Array<{
    rows: number;
    cols: number;
    options: { fontSize?: number };
    focus: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@/components/terminal/TerminalAudioBridge", () => ({
  TerminalAudioBridge: ({
    onFocusTerminal,
    onStartVoice,
  }: {
    onFocusTerminal: () => void;
    onStartVoice: () => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        onFocusTerminal();
        onStartVoice();
      }}
    >
      Connect voice
    </button>
  ),
}));

// Next replaces server actions with client proxies; jsdom needs the same boundary.
vi.mock("@/lib/actions/workspaces", () => ({
  getExistingTerminalPathsAction: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = mockTerminalState.fit;
  }

  return { FitAddon };
});

vi.mock("@/lib/terminal/browser-integration", () => ({
  installTerminalBrowserIntegration: vi.fn(() => vi.fn()),
}));

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
    connectionState: mockTerminalState.connectionState,
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
  mockTerminalState.connectionState = "disconnected";
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
  it.each([
    false,
    true,
  ])("starts voice without submitting a draft or opening mobile input (mobile=%s)", async (mobileInputMode) => {
    mockTerminalState.connectionState = "connected";
    const onTerminalReady = vi.fn();
    const onUserFocusRequest = vi.fn();
    const view = render(
      <InteractiveTerminal
        agentId="agent-1"
        workspaceId="workspace-1"
        sessionName="main"
        mobileInputMode={mobileInputMode}
        onTerminalReady={onTerminalReady}
        onUserFocusRequest={onUserFocusRequest}
      />,
    );
    await waitFor(() => expect(onTerminalReady).toHaveBeenCalledOnce());
    const terminal = mockTerminalState.terminalInstances[0];
    terminal.focus.mockClear();
    mockTerminalState.send.mockClear();
    fireEvent.click(view.getByRole("button", { name: "Connect voice" }));
    expect(onUserFocusRequest).toHaveBeenCalledOnce();
    expect(terminal.focus).toHaveBeenCalledTimes(mobileInputMode ? 0 : 1);
    // A function key never inserts slash-command text or submits the composer.
    expect(mockTerminalState.send.mock.calls).toEqual([[JSON.stringify({ data: "\x1b[19~" })]]);
  });

  it("Enter primes playback before the asynchronous audio bridge mounts", async () => {
    const { container } = render(
      <InteractiveTerminal agentId="agent-1" workspaceId="workspace-1" sessionName="main" />,
    );
    const surface = container.querySelector<HTMLElement>('[data-terminal-surface="true"]')!;
    const prime = vi.fn();
    surface.addEventListener(TERMINAL_AUDIO_PRIME_EVENT, prime);
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(prime).toHaveBeenCalledOnce();
  });

  it("Touch submission prime playback without microphone approval", async () => {
    const onTerminalReady = vi.fn();
    const { container } = render(
      <InteractiveTerminal
        agentId="agent-1"
        workspaceId="workspace-1"
        sessionName="main"
        onTerminalReady={onTerminalReady}
      />,
    );
    await waitFor(() => expect(onTerminalReady).toHaveBeenCalledOnce());
    const send = onTerminalReady.mock.calls[0][1] as (data: string) => void;
    const surface = container.querySelector<HTMLElement>('[data-terminal-surface="true"]')!;
    const prime = vi.fn();
    surface.addEventListener(TERMINAL_AUDIO_PRIME_EVENT, prime);
    act(() => send("/voice\r"));
    expect(mockTerminalState.send).toHaveBeenCalled();
    expect(prime).toHaveBeenCalledOnce();
  });

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
    expect(installTerminalBrowserIntegration).toHaveBeenLastCalledWith(terminal, {
      allowClipboardWrite: true,
      validatePaths: expect.any(Function),
    });
    expect(terminal?.options.fontSize).toBe(13);

    mockTerminalState.fit.mockImplementationOnce(() => {
      throw fitError;
    });

    expect(() => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(FONT_SIZE_EVENT, {
            detail: { scope: terminalFontSizeScope("workspace-1", "main"), size: 18 },
          }),
        );
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

it("keeps template push output unable to write the local clipboard", async () => {
  const onReady = vi.fn();
  render(<TerminalPanel onClose={vi.fn()} writeRef={{ current: null }} onReady={onReady} />);
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(installTerminalBrowserIntegration).toHaveBeenLastCalledWith(
    mockTerminalState.terminalInstances[0],
    { allowClipboardWrite: false, validatePaths: expect.any(Function) },
  );
});
