// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMobileTerminalDiagnosticsState,
  resetMobileTerminalDiagnosticsState,
} from "@/lib/terminal/mobile-terminal-diagnostics-state";

const { mockUseTerminalWebSocket, mockFit, mockSend, mockResize, terminalInstances } = vi.hoisted(
  () => ({
    mockUseTerminalWebSocket: vi.fn(),
    mockFit: vi.fn(),
    mockSend: vi.fn(),
    mockResize: vi.fn(),
    terminalInstances: [] as Array<{
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      buffer: { active: { baseY: number; viewportY: number } };
      dataHandler?: (data: string) => void;
      focus: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
      resizeHandler?: (dimensions: { rows: number; cols: number }) => void;
      scrollLines: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
    }>,
  }),
);

const {
  mockCreateSessionAction,
  mockGetWorkspaceSessionsAction,
  mockHandleKeyEvent,
  mockRegisterKeybinding,
  mockSetActiveTerminal,
  mockUnregisterKeybinding,
  mockUseIsComposeSheet,
  mockUseKeybindings,
  mockUseVisualViewportKeyboardOffset,
  navigationState,
} = vi.hoisted(() => {
  const router = { replace: vi.fn() };
  const register = vi.fn();
  const unregister = vi.fn();
  const handleKeyEvent = vi.fn(() => true);
  const setActiveTerminal = vi.fn();
  return {
    mockCreateSessionAction: vi.fn(),
    mockGetWorkspaceSessionsAction: vi.fn(),
    mockHandleKeyEvent: handleKeyEvent,
    mockRegisterKeybinding: register,
    mockSetActiveTerminal: setActiveTerminal,
    mockUnregisterKeybinding: unregister,
    mockUseIsComposeSheet: vi.fn(() => false),
    mockUseKeybindings: vi.fn(() => ({
      activeSend: null,
      activeTerminal: null,
      getAll: vi.fn(() => []),
      handleKeyEvent,
      register,
      setActiveTerminal,
      unregister,
    })),
    mockUseVisualViewportKeyboardOffset: vi.fn(() => ({
      isKeyboardVisible: false,
      liftPx: 0,
      visualViewportHeightPx: 0,
      visualViewportOffsetTopPx: 0,
    })),
    navigationState: {
      router,
      search: "session=main",
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    rows = 24;
    cols = 80;
    buffer = { active: { baseY: 10, viewportY: 9 } };
    open = vi.fn((element: HTMLElement) => {
      const terminal = document.createElement("div");
      terminal.className = "xterm";
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.appendChild(helper);
      element.appendChild(terminal);
    });
    loadAddon = vi.fn();
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    });
    resizeHandler?: (dimensions: { rows: number; cols: number }) => void;
    onResize = vi.fn((handler: (dimensions: { rows: number; cols: number }) => void) => {
      this.resizeHandler = handler;
      return { dispose: vi.fn() };
    });
    dispose = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    scrollLines = vi.fn();
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = this.buffer.active.baseY;
    });
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
    clearSelection = vi.fn();
    dataHandler?: (data: string) => void;

    constructor() {
      terminalInstances.push(this);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    dispose = vi.fn();
  },
}));

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const Stub = ({
      className,
      clonePath,
      cloneProof,
      layoutSignal,
      mobileInputMode,
      pinToBottomOnResize,
      sessionName,
    }: {
      className?: string;
      clonePath?: string;
      cloneProof?: string;
      layoutSignal?: unknown;
      mobileInputMode?: boolean;
      pinToBottomOnResize?: boolean;
      sessionName: string;
    }) => (
      <div
        className={className}
        data-clone-path={clonePath ?? ""}
        data-clone-proof={cloneProof ?? ""}
        data-layout-signal={String(layoutSignal ?? "")}
        data-mobile-input-mode={mobileInputMode ? "true" : "false"}
        data-pin-to-bottom-on-resize={pinToBottomOnResize ? "true" : "false"}
        data-session-name={sessionName}
        data-testid="interactive-terminal"
      />
    );
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationState.router,
  useSearchParams: () => new URLSearchParams(navigationState.search),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: mockCreateSessionAction,
  getWorkspaceSessionsAction: mockGetWorkspaceSessionsAction,
}));

vi.mock("@/hooks/use-compose-sheet", () => ({
  useIsComposeSheet: mockUseIsComposeSheet,
}));

vi.mock("@/hooks/useVisualViewportKeyboardOffset", () => ({
  useVisualViewportKeyboardOffset: mockUseVisualViewportKeyboardOffset,
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: () => mockUseKeybindings(),
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: (...args: unknown[]) => mockUseTerminalWebSocket(...args),
}));

vi.mock("@/lib/terminal/protocol", () => ({
  encodeInput: (data: string) => data,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => (
    <div data-testid="alert" data-variant={props.variant}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: { children: React.ReactNode; className?: string }) => (
    <div>{children}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  Loader2: () => null,
}));

vi.mock("@/components/terminal/ComposePanel", () => ({
  ComposePanel: ({ hideHeader }: { hideHeader?: boolean }) => (
    <div data-hide-header={hideHeader ? "true" : "false"} data-testid="compose-panel" />
  ),
}));

vi.mock("@/components/terminal/MobileTerminalControls", () => ({
  MobileTerminalControls: ({ isKeyboardVisible }: { isKeyboardVisible?: boolean }) => (
    <button
      type="button"
      data-keyboard-visible={isKeyboardVisible ? "true" : "false"}
      data-testid="terminal-mobile-controls"
    />
  ),
}));

vi.mock("@/components/terminal/MobileTerminalDiagnosticsOverlay", () => ({
  MobileTerminalDiagnosticsOverlay: ({ enabled }: { enabled: boolean }) =>
    enabled ? <div data-testid="mobile-terminal-diagnostics-overlay" /> : null,
}));

vi.mock("@/components/terminal/MobileTerminalShell", () => ({
  MobileTerminalShell: ({ children }: React.PropsWithChildren<{ className?: string }>) => (
    <div data-testid="mobile-terminal-shell">{children}</div>
  ),
}));

vi.mock("@/components/terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: () => null,
}));

vi.mock("@/components/terminal/TerminalGestureLayer", () => ({
  TerminalGestureLayer: ({ children }: React.PropsWithChildren) => (
    <div data-testid="terminal-gesture-layer">{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: ({ withHandle }: { withHandle?: boolean }) => (
    <div data-testid="resizable-handle" data-with-handle={withHandle ? "true" : "false"} />
  ),
  ResizablePanel: ({
    children,
    defaultSize,
  }: React.PropsWithChildren<{ defaultSize?: number; minSize?: number; maxSize?: number }>) => (
    <div data-default-size={defaultSize} data-testid="resizable-panel">
      {children}
    </div>
  ),
  ResizablePanelGroup: ({
    children,
    orientation,
  }: React.PropsWithChildren<{ className?: string; orientation?: string }>) => (
    <div data-orientation={orientation} data-testid="resizable-group">
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => (
    <div data-open={open ? "true" : "false"} data-testid="compose-sheet">
      {open ? children : null}
    </div>
  ),
  SheetContent: ({ children, side }: React.PropsWithChildren<{ side?: string }>) => (
    <section data-side={side} data-testid="compose-sheet-content">
      {children}
    </section>
  ),
  SheetTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

vi.mock("@/lib/device/haptics", () => ({
  triggerHapticFeedback: vi.fn(),
}));

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: vi.fn(),
  pasteToTerminal: vi.fn(),
}));

vi.mock("@/styles/xterm.css", () => ({}));

type ResizeObserverCallback = (
  entries: Array<{ contentRect: { width: number; height: number } }>,
) => void;

let resizeObserverCallback: ResizeObserverCallback | null = null;

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  resizeObserverCallback = null;
  mockFit.mockClear();
  mockSend.mockClear();
  mockResize.mockClear();
  terminalInstances.length = 0;
  resetMobileTerminalDiagnosticsState();
  window.localStorage.clear();
  navigationState.search = "session=main";
  navigationState.router.replace.mockClear();
  mockCreateSessionAction.mockReset();
  mockGetWorkspaceSessionsAction.mockReset();
  mockRegisterKeybinding.mockClear();
  mockUnregisterKeybinding.mockClear();
  mockHandleKeyEvent.mockClear();
  mockSetActiveTerminal.mockClear();
  mockUseIsComposeSheet.mockReset();
  mockUseIsComposeSheet.mockReturnValue(false);
  mockUseVisualViewportKeyboardOffset.mockReset();
  mockUseVisualViewportKeyboardOffset.mockReturnValue({
    isKeyboardVisible: false,
    liftPx: 0,
    visualViewportHeightPx: 0,
    visualViewportOffsetTopPx: 0,
  });
  mockUseKeybindings.mockReset();
  mockUseKeybindings.mockReturnValue({
    activeSend: null,
    activeTerminal: null,
    getAll: vi.fn(() => []),
    handleKeyEvent: mockHandleKeyEvent,
    register: mockRegisterKeybinding,
    setActiveTerminal: mockSetActiveTerminal,
    unregister: mockUnregisterKeybinding,
  });

  mockUseTerminalWebSocket.mockReturnValue({
    send: mockSend,
    resize: mockResize,
    connectionState: "disconnected",
  });

  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
    configurable: true,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 0;
  });

  process.env.NEXT_PUBLIC_TERMINAL_WS_URL = "ws://localhost:9999";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_TERMINAL_WS_URL;
});

type RenderTerminalOptions = {
  clonePath?: string;
  cloneProof?: string;
  layoutSignal?: unknown;
  mobileInputMode?: boolean;
  pinToBottomOnResize?: boolean;
  sessionName?: string;
};

async function flushTerminalEffects() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

async function renderTerminal(props: RenderTerminalOptions = {}) {
  const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");
  const { clonePath, cloneProof, sessionName = "main", ...terminalProps } = props;

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <InteractiveTerminal
        agentId="test-agent"
        clonePath={clonePath}
        cloneProof={cloneProof}
        workspaceId="test-ws"
        sessionName={sessionName}
        {...terminalProps}
      />,
    );
  });

  await flushTerminalEffects();

  return result!;
}

async function renderTerminalClient(search: string) {
  navigationState.search = search;
  const { TerminalClient } = await import(
    "@/app/(dashboard)/workspaces/[id]/terminal/terminal-client"
  );

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<TerminalClient agentId="test-agent" workspaceId="test-ws" />);
  });
  return result!;
}

function terminalWebSocketUrls() {
  return mockUseTerminalWebSocket.mock.calls
    .map(([options]) => (options as { url: string | null }).url)
    .filter((url): url is string => typeof url === "string");
}

function touchPoint(identifier: number, clientX: number, clientY: number): Touch {
  return { identifier, clientX, clientY } as Touch;
}

function fireTouchEvent(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: Touch[],
  changedTouches = touches,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changedTouches });
  fireEvent(target, event);
  return event;
}

describe("InteractiveTerminal integration — Connection state banners", () => {
  it("shows workspace offline banner", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "workspace-offline",
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Workspace is offline");
    unmount();
  });

  it("shows connection failed banner", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "failed",
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Connection failed");
    unmount();
  });

  it("shows no banner when disconnected", async () => {
    const { container, unmount } = await renderTerminal();
    expect(container.textContent).not.toContain("offline");
    expect(container.textContent).not.toContain("failed");
    unmount();
  });
});

describe("InteractiveTerminal integration — ResizeObserver", () => {
  it("calls fit() when container resizes with non-zero dimensions", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    mockFit.mockClear();

    act(() => {
      resizeObserverCallback!([{ contentRect: { width: 800, height: 600 } }]);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(mockFit).toHaveBeenCalled();
    unmount();
  });

  it("skips fit() when dimensions are zero (hidden container)", async () => {
    const { unmount } = await renderTerminal();

    expect(resizeObserverCallback).not.toBeNull();
    mockFit.mockClear();

    act(() => {
      resizeObserverCallback!([{ contentRect: { width: 0, height: 0 } }]);
    });

    expect(mockFit).not.toHaveBeenCalled();
    unmount();
  });
});

describe("InteractiveTerminal integration — Session lifecycle", () => {
  it("reuses cached reconnect IDs and builds the WebSocket URL with session dimensions", async () => {
    window.localStorage.setItem(
      "terminal:reconnect:test-agent:main",
      JSON.stringify({ id: "cached-reconnect", ts: Date.now() }),
    );

    const { unmount } = await renderTerminal();

    await waitFor(() => {
      expect(terminalWebSocketUrls().length).toBeGreaterThan(0);
    });
    const url = new URL(terminalWebSocketUrls().at(-1)!);
    expect(url.origin).toBe("ws://localhost:9999");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("agentId")).toBe("test-agent");
    expect(url.searchParams.get("workspaceId")).toBe("test-ws");
    expect(url.searchParams.get("sessionName")).toBe("main");
    expect(url.searchParams.get("reconnectId")).toBe("cached-reconnect");
    expect(url.searchParams.get("width")).toBe("80");
    expect(url.searchParams.get("height")).toBe("24");
    expect(url.searchParams.has("clonePath")).toBe(false);
    unmount();
  });

  it("adds clonePath and cloneProof to the WebSocket URL when provided", async () => {
    const { unmount } = await renderTerminal({
      clonePath: "kethalia/hive",
      cloneProof: "proof-token",
      sessionName: "git-clone-safe-hive",
    });

    await waitFor(() => {
      expect(terminalWebSocketUrls().length).toBeGreaterThan(0);
    });
    const url = new URL(terminalWebSocketUrls().at(-1)!);
    expect(url.searchParams.get("sessionName")).toBe("git-clone-safe-hive");
    expect(url.searchParams.get("clonePath")).toBe("kethalia/hive");
    expect(url.searchParams.get("cloneProof")).toBe("proof-token");
    unmount();
  });

  it("rebuilds the WebSocket URL when clonePath changes for the same session", async () => {
    const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <InteractiveTerminal
          agentId="test-agent"
          clonePath="kethalia/hive"
          workspaceId="test-ws"
          sessionName="git-clone-safe-hive"
        />,
      );
    });
    await flushTerminalEffects();

    await waitFor(() => {
      const url = new URL(terminalWebSocketUrls().at(-1)!);
      expect(url.searchParams.get("clonePath")).toBe("kethalia/hive");
    });

    await act(async () => {
      result!.rerender(
        <InteractiveTerminal
          agentId="test-agent"
          clonePath="kethalia/hive-renamed"
          workspaceId="test-ws"
          sessionName="git-clone-safe-hive"
        />,
      );
    });
    await flushTerminalEffects();

    await waitFor(() => {
      const url = new URL(terminalWebSocketUrls().at(-1)!);
      expect(url.searchParams.get("clonePath")).toBe("kethalia/hive-renamed");
    });
    result!.unmount();
  });

  it("resizes the PTY after connection and preserves bottom pinning when configured", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "connected",
    });

    const { unmount } = await renderTerminal({ pinToBottomOnResize: true });
    const terminal = terminalInstances.at(-1);

    await waitFor(() => {
      expect(mockResize).toHaveBeenCalledWith(24, 80, "initial-layout-refit");
    });
    expect(terminal?.scrollToBottom).toHaveBeenCalled();
    expect(terminal?.buffer.active.viewportY).toBe(terminal?.buffer.active.baseY);
    unmount();
  });

  it("records fit and xterm resize-request diagnostics without terminal content", async () => {
    const { unmount } = await renderTerminal();
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();

    await waitFor(() => {
      expect(getMobileTerminalDiagnosticsState().fit.count).toBeGreaterThan(0);
    });

    act(() => {
      terminal?.resizeHandler?.({ rows: 30, cols: 100 });
    });

    expect(mockResize).toHaveBeenCalledWith(30, 100, "xterm-on-resize");
    expect(getMobileTerminalDiagnosticsState()).toMatchObject({
      xterm: { rows: 30, cols: 100, source: "xterm-on-resize" },
      resizeRequest: {
        count: expect.any(Number),
        lastSource: "xterm-on-resize",
        rows: 30,
        cols: 100,
      },
      resizeSent: { count: 0, rows: null, cols: null },
    });
    expect(JSON.stringify(getMobileTerminalDiagnosticsState())).not.toContain("SECRET");
    unmount();
  });

  it("records resize-sent diagnostics from the websocket callback", async () => {
    const { unmount } = await renderTerminal();

    const options = mockUseTerminalWebSocket.mock.calls.at(-1)?.[0] as {
      onResizeSent?: (event: {
        rows: number;
        cols: number;
        source: string;
        sentAt: number;
      }) => void;
    };
    act(() => {
      options.onResizeSent?.({
        rows: 31,
        cols: 101,
        source: "xterm-on-resize",
        sentAt: 2222,
      });
    });

    expect(getMobileTerminalDiagnosticsState().resizeSent).toEqual({
      count: 1,
      lastAt: 2222,
      lastSource: "xterm-on-resize",
      rows: 31,
      cols: 101,
    });
    unmount();
  });
});

describe("TerminalClient integration — Mobile terminal route props", () => {
  it("leaves bottom-preserving refits disabled on desktop terminal routes", async () => {
    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-mobile-input-mode", "false");
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "false",
    );
    unmount();
  });

  it("enables bottom-preserving refits on mobile compose-sheet terminal routes", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);

    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-mobile-input-mode", "true");
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "true",
    );
    unmount();
  });

  it("keeps keyboard-visible visual viewport height and offset in the mobile layout signal", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    mockUseVisualViewportKeyboardOffset.mockReturnValue({
      isKeyboardVisible: true,
      liftPx: 0,
      visualViewportHeightPx: 420,
      visualViewportOffsetTopPx: 180,
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-layout-signal",
      "keyboard:420:180",
    );
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "true",
    );
    unmount();
  });
});

describe("TerminalClient integration — Clone route parameters", () => {
  it("passes clonePath and cloneProof from a clone route to InteractiveTerminal and preserves debug diagnostics", async () => {
    const { getByTestId, unmount } = await renderTerminalClient(
      "session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneProof=proof-token&debugViewport=1",
    );

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-session-name",
      "git-clone-safe-hive",
    );
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-clone-path", "kethalia/hive");
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-clone-proof", "proof-token");
    expect(getByTestId("mobile-terminal-diagnostics-overlay")).toBeInTheDocument();
    expect(mockGetWorkspaceSessionsAction).not.toHaveBeenCalled();
    expect(mockCreateSessionAction).not.toHaveBeenCalled();
    unmount();
  });

  it("omits clonePath for normal session routes", async () => {
    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-session-name", "main");
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-clone-path", "");
    unmount();
  });

  it("ignores clonePath while bootstrapping a generic no-session terminal", async () => {
    mockGetWorkspaceSessionsAction.mockResolvedValue({ data: [] });
    mockCreateSessionAction.mockResolvedValue({ data: { name: "created-main" } });

    const { unmount } = await renderTerminalClient("clonePath=kethalia%2Fhive&debugViewport=1");

    await waitFor(() => {
      expect(navigationState.router.replace).toHaveBeenCalledWith(
        "/workspaces/test-ws/terminal?session=created-main&debugViewport=1",
      );
    });
    expect(navigationState.router.replace).not.toHaveBeenCalledWith(
      expect.stringContaining("clonePath"),
    );
    unmount();
  });
});

describe("InteractiveTerminal integration — Mobile input adapter", () => {
  it("applies mobile helper attributes only in mobile input mode", async () => {
    const mobile = await renderTerminal({ mobileInputMode: true });
    const mobileHelper = mobile.container.querySelector(".xterm-helper-textarea");

    expect(mobileHelper).toHaveAttribute("data-terminal-mobile-input", "true");
    expect(mobileHelper).toHaveAttribute("autocapitalize", "off");
    expect(mobileHelper).toHaveAttribute("autocorrect", "off");
    expect(mobileHelper).toHaveAttribute("autocomplete", "off");
    expect(mobileHelper).toHaveAttribute("spellcheck", "false");
    expect(mobileHelper).toHaveAttribute("inputmode", "text");
    expect(mobileHelper).toHaveAttribute("enterkeyhint", "enter");
    expect((mobileHelper as HTMLTextAreaElement).style.fontSize).toBe("16px");
    mobile.unmount();

    const desktop = await renderTerminal({ mobileInputMode: false });
    const desktopHelper = desktop.container.querySelector(".xterm-helper-textarea");

    expect(desktopHelper).not.toHaveAttribute("data-terminal-mobile-input");
    expect(desktopHelper).not.toHaveAttribute("autocorrect");
    desktop.unmount();
  });

  it("does not focus xterm from mobile terminal surface touches", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();
    expect(terminal?.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);

    terminal?.focus.mockClear();
    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toBeTruthy();

    fireEvent.pointerDown(inputTarget as Element, {
      clientX: 80,
      clientY: 240,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerUp(inputTarget as Element, {
      clientX: 82,
      clientY: 242,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.click(inputTarget as Element);

    expect(terminal?.focus).not.toHaveBeenCalled();

    act(() => {
      terminal?.dataHandler?.("echo mobile\r");
    });
    expect(mockSend).toHaveBeenCalledWith("echo mobile\r");
    unmount();
  });

  it("scrolls mobile terminal touch drags without allowing native page scroll or keyboard focus", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();

    terminal?.focus.mockClear();
    terminal?.scrollLines.mockClear();
    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toBeTruthy();

    fireTouchEvent(inputTarget as Element, "touchstart", [touchPoint(1, 80, 320)]);
    const touchMove = fireTouchEvent(inputTarget as Element, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget as Element, "touchend", [], [touchPoint(1, 80, 240)]);
    fireEvent.click(inputTarget as Element);

    expect(touchMove.defaultPrevented).toBe(true);
    expect(terminal?.scrollLines).toHaveBeenCalledWith(4);
    expect(terminal?.focus).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps desktop pointer entry focusing immediately", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: false });
    const terminal = terminalInstances.at(-1);
    terminal?.focus.mockClear();
    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toBeTruthy();

    fireEvent.pointerDown(inputTarget as Element, {
      clientX: 80,
      clientY: 240,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(terminal?.focus).toHaveBeenCalledTimes(1);
    unmount();
  });
});
