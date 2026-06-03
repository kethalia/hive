// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, createEvent, fireEvent, render, waitFor } from "@testing-library/react";
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

const multiSessionRouteMockState = vi.hoisted(() => ({
  props: null as null | { agentId: string; className?: string; workspaceId: string },
}));

const {
  mockCopyTerminalSelection,
  mockCreateSessionAction,
  mockGetTerminalSettingsAction,
  mockGetWorkspaceAgentAction,
  mockGetWorkspaceSessionsAction,
  mockHandleKeyEvent,
  mockUseFavoriteWindowNavigation,
  mockPasteToTerminal,
  mockRegisterKeybinding,
  mockSetActiveTerminal,
  mockUnregisterKeybinding,
  mockUseIsComposeSheet,
  mockUseKeybindings,
  mockUseVisualViewportKeyboardOffset,
  navigationState,
  terminalRouteMockState,
} = vi.hoisted(() => {
  const router = { push: vi.fn(), replace: vi.fn() };
  const register = vi.fn();
  const unregister = vi.fn();
  const handleKeyEvent = vi.fn(() => true);
  const setActiveTerminal = vi.fn();
  return {
    mockCopyTerminalSelection: vi.fn(),
    mockCreateSessionAction: vi.fn(),
    mockGetTerminalSettingsAction: vi.fn(),
    mockGetWorkspaceAgentAction: vi.fn(),
    mockGetWorkspaceSessionsAction: vi.fn(),
    mockHandleKeyEvent: handleKeyEvent,
    mockUseFavoriteWindowNavigation: vi.fn(),
    mockPasteToTerminal: vi.fn(),
    mockRegisterKeybinding: register,
    mockSetActiveTerminal: setActiveTerminal,
    mockUnregisterKeybinding: unregister,
    mockUseIsComposeSheet: vi.fn(() => false),
    mockUseKeybindings: vi.fn<
      () => {
        activeSend: unknown;
        activeTerminal: unknown;
        getAll: ReturnType<typeof vi.fn>;
        handleKeyEvent: ReturnType<typeof vi.fn>;
        register: ReturnType<typeof vi.fn>;
        setActiveTerminal: ReturnType<typeof vi.fn>;
        unregister: ReturnType<typeof vi.fn>;
      }
    >(() => ({
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
    terminalRouteMockState: {
      commandPaletteProps: null as unknown,
      gestureLayerProps: null as unknown,
      mobileControlsProps: null as unknown,
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
      selectionModeEnabled,
      sessionName,
    }: {
      className?: string;
      clonePath?: string;
      cloneProof?: string;
      layoutSignal?: unknown;
      mobileInputMode?: boolean;
      pinToBottomOnResize?: boolean;
      selectionModeEnabled?: boolean;
      sessionName: string;
    }) => (
      <div
        className={className}
        data-clone-path={clonePath ?? ""}
        data-clone-proof={cloneProof ?? ""}
        data-layout-signal={String(layoutSignal ?? "")}
        data-mobile-input-mode={mobileInputMode ? "true" : "false"}
        data-pin-to-bottom-on-resize={pinToBottomOnResize ? "true" : "false"}
        data-selection-mode-enabled={selectionModeEnabled ? "true" : "false"}
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

vi.mock("@/components/workspaces/MultiSessionWorkspace", () => ({
  MultiSessionWorkspace: (props: { agentId: string; className?: string; workspaceId: string }) => {
    multiSessionRouteMockState.props = props;
    return (
      <section
        data-agent-id={props.agentId}
        data-class-name={props.className ?? ""}
        data-testid="multi-session-workspace-route"
        data-workspace-id={props.workspaceId}
      />
    );
  },
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: mockCreateSessionAction,
  getWorkspaceAgentAction: mockGetWorkspaceAgentAction,
  getWorkspaceSessionsAction: mockGetWorkspaceSessionsAction,
}));

vi.mock("@/lib/actions/user-settings", () => ({
  getTerminalSettingsAction: mockGetTerminalSettingsAction,
}));

vi.mock("@/hooks/use-compose-sheet", () => ({
  useIsComposeSheet: mockUseIsComposeSheet,
}));

vi.mock("@/hooks/useFavoriteWindowNavigation", () => ({
  useFavoriteWindowNavigation: (...args: unknown[]) => mockUseFavoriteWindowNavigation(...args),
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
  ClipboardPaste: () => null,
  Copy: () => null,
  Loader2: () => null,
  Plus: () => null,
}));

vi.mock("@/components/terminal/ComposePanel", () => ({
  ComposePanel: ({ hideHeader }: { hideHeader?: boolean }) => (
    <div data-hide-header={hideHeader ? "true" : "false"} data-testid="compose-panel" />
  ),
}));

vi.mock("@/components/terminal/CommandPalette", () => ({
  CommandPalette: ({
    onCreateSession,
    emptyText = "No sessions found.",
    onOpenChange,
    onSelectTab,
    open,
    tabs,
  }: {
    emptyText?: string;
    onCreateSession?: () => void;
    onOpenChange: (open: boolean) => void;
    onSelectTab: (tabId: string) => void;
    open: boolean;
    tabs: Array<{ id: string; sessionName: string }>;
  }) => {
    terminalRouteMockState.commandPaletteProps = {
      hasCreateSession: Boolean(onCreateSession),
      open,
      tabs,
    };

    if (!open) return null;

    return (
      <div data-testid="terminal-window-command-palette">
        <button
          type="button"
          data-testid="terminal-window-command-palette-close"
          onClick={() => onOpenChange(false)}
        >
          Close
        </button>
        {tabs.length === 0 ? <p>{emptyText}</p> : null}
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`terminal-window-option-${tab.id}`}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.sessionName}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/terminal/MobileTerminalControls", () => ({
  MobileTerminalControls: ({
    clipboardStatusText,
    copyDisabledReason,
    hasSelection,
    isKeyboardVisible,
    onCopy,
    onPaste,
    onToggleSelectionMode,
    pasteDisabledReason,
    selectionModeDisabledReason,
    selectionModeEnabled,
    windowNavigation,
  }: {
    clipboardStatusText?: string;
    copyDisabledReason?: string;
    hasSelection?: boolean;
    isKeyboardVisible?: boolean;
    onCopy?: () => void;
    onPaste?: () => void;
    onToggleSelectionMode?: (enabled: boolean) => void;
    pasteDisabledReason?: string;
    selectionModeDisabledReason?: string;
    selectionModeEnabled?: boolean;
    windowNavigation?: {
      canGoNext?: boolean;
      canGoPrevious?: boolean;
      current?: { id?: string; name: string } | null;
      error?: string | null;
      loading?: boolean;
      next?: { id?: string; name: string } | null;
      onOpenSwitcher?: () => void;
      previous?: { id?: string; name: string } | null;
      reload?: () => void;
      select?: (sessionId: string) => boolean | undefined;
      sessions?: Array<{ id?: string; name: string }>;
    };
  }) => {
    const { activeSend } = mockUseKeybindings();
    terminalRouteMockState.mobileControlsProps = {
      clipboardStatusText,
      copyDisabledReason,
      hasSelection,
      isKeyboardVisible,
      pasteDisabledReason,
      selectionModeDisabledReason,
      selectionModeEnabled,
      windowNavigation,
    };

    return (
      <div
        data-copy-disabled={copyDisabledReason ? "true" : "false"}
        data-copy-disabled-reason={copyDisabledReason ?? ""}
        data-current-session={windowNavigation?.current?.name ?? ""}
        data-error={windowNavigation?.error ?? ""}
        data-has-selection={hasSelection ? "true" : "false"}
        data-keyboard-visible={isKeyboardVisible ? "true" : "false"}
        data-loading={windowNavigation?.loading ? "true" : "false"}
        data-next-session={windowNavigation?.next?.name ?? ""}
        data-paste-disabled={pasteDisabledReason ? "true" : "false"}
        data-paste-disabled-reason={pasteDisabledReason ?? ""}
        data-previous-session={windowNavigation?.previous?.name ?? ""}
        data-selection-disabled-reason={selectionModeDisabledReason ?? ""}
        data-selection-mode-enabled={selectionModeEnabled ? "true" : "false"}
        data-session-count={String(windowNavigation?.sessions?.length ?? 0)}
        data-testid="terminal-mobile-controls"
      >
        <p aria-live="polite" data-testid="terminal-clipboard-status">
          {clipboardStatusText}
        </p>
        <button
          type="button"
          data-testid="terminal-smart-enter"
          onClick={() => (activeSend as ((data: string) => void) | null)?.("\r")}
        >
          Enter
        </button>
        <button
          type="button"
          data-testid="terminal-selection-toggle"
          onClick={() => onToggleSelectionMode?.(!selectionModeEnabled)}
        >
          Select
        </button>
        <button
          type="button"
          data-testid="terminal-copy-selection"
          disabled={Boolean(copyDisabledReason)}
          onClick={() => onCopy?.()}
        >
          Copy
        </button>
        <button
          type="button"
          data-testid="terminal-paste-clipboard"
          disabled={Boolean(pasteDisabledReason)}
          onClick={() => onPaste?.()}
        >
          Paste
        </button>
        <button
          type="button"
          data-testid="terminal-window-previous"
          onClick={() =>
            windowNavigation?.previous &&
            windowNavigation.select?.(
              windowNavigation.previous.id ?? windowNavigation.previous.name,
            )
          }
        >
          Previous
        </button>
        <button
          type="button"
          data-testid="terminal-window-switcher"
          onClick={() => windowNavigation?.onOpenSwitcher?.()}
        >
          Windows
        </button>
        <button
          type="button"
          data-testid="terminal-window-next"
          onClick={() =>
            windowNavigation?.next &&
            windowNavigation.select?.(windowNavigation.next.id ?? windowNavigation.next.name)
          }
        >
          Next
        </button>
        <button
          type="button"
          data-testid="terminal-window-reload"
          onClick={() => windowNavigation?.reload?.()}
        >
          Reload
        </button>
      </div>
    );
  },
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
  TerminalGestureLayer: ({
    children,
    selectionModeEnabled,
  }: React.PropsWithChildren<{ selectionModeEnabled?: boolean }>) => {
    terminalRouteMockState.gestureLayerProps = { selectionModeEnabled };
    return (
      <div
        data-selection-mode-enabled={selectionModeEnabled ? "true" : "false"}
        data-testid="terminal-gesture-layer"
      >
        {children}
      </div>
    );
  },
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
  copyTerminalSelection: mockCopyTerminalSelection,
  pasteToTerminal: mockPasteToTerminal,
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
  navigationState.router.push.mockClear();
  navigationState.router.replace.mockClear();
  mockCopyTerminalSelection.mockReset();
  mockPasteToTerminal.mockReset();
  mockCreateSessionAction.mockReset();
  mockGetTerminalSettingsAction.mockReset();
  mockGetTerminalSettingsAction.mockResolvedValue({
    data: { terminalControlsBeyondMobile: false },
  });
  mockGetWorkspaceAgentAction.mockReset();
  mockGetWorkspaceAgentAction.mockResolvedValue({
    data: { agentId: "test-agent", agentName: "Test Agent" },
  });
  mockGetWorkspaceSessionsAction.mockReset();
  mockGetWorkspaceSessionsAction.mockResolvedValue({ data: [] });
  mockUseFavoriteWindowNavigation.mockReset();
  mockUseFavoriteWindowNavigation.mockReturnValue({
    sessions: [],
    current: null,
    previous: null,
    next: null,
    canGoPrevious: false,
    canGoNext: false,
    loading: false,
    error: null,
    reload: vi.fn(),
    select: vi.fn(() => false),
  });
  terminalRouteMockState.commandPaletteProps = null;
  terminalRouteMockState.gestureLayerProps = null;
  terminalRouteMockState.mobileControlsProps = null;
  multiSessionRouteMockState.props = null;
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
  selectionModeEnabled?: boolean;
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

async function renderTerminalClient(
  search: string,
  props: { terminalControlsBeyondMobile?: boolean } = {},
) {
  navigationState.search = search;
  const { TerminalClient } = await import(
    "@/app/(dashboard)/workspaces/[id]/terminal/terminal-client"
  );

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<TerminalClient agentId="test-agent" workspaceId="test-ws" {...props} />);
  });
  return result!;
}

async function renderTerminalPage(search: string) {
  navigationState.search = search;
  const { default: TerminalPage } = await import("@/app/(dashboard)/workspaces/[id]/terminal/page");
  const page = await TerminalPage({ params: Promise.resolve({ id: "test-ws" }) });

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(page);
  });
  return result!;
}

async function renderWorkspaceTerminalPage() {
  const { default: WorkspaceTerminalPage } = await import(
    "@/app/(dashboard)/workspaces/[id]/terminal/workspace/page"
  );
  const page = await WorkspaceTerminalPage({ params: Promise.resolve({ id: "test-ws" }) });

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(page);
  });
  return result!;
}

async function renderActualMultiSessionWorkspace() {
  const { MultiSessionWorkspace: ActualMultiSessionWorkspace } = await vi.importActual<
    typeof import("@/components/workspaces/MultiSessionWorkspace")
  >("@/components/workspaces/MultiSessionWorkspace");

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <ActualMultiSessionWorkspace agentId="workspace-agent" workspaceId="test-ws" />,
    );
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

function pointerDown(element: HTMLElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerDown(element, {
    pointerId: 7,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...init,
  });
}

function pointerMove(element: HTMLElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerMove(element, {
    pointerId: 7,
    pointerType: "mouse",
    buttons: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...init,
  });
}

function pointerUp(element: HTMLElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerUp(element, {
    pointerId: 7,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...init,
  });
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

describe("WorkspaceTerminalPage integration — Multi-session route", () => {
  it("renders the multi-session workspace with the authenticated agent boundary", async () => {
    mockGetWorkspaceAgentAction.mockResolvedValueOnce({
      data: { agentId: "workspace-agent", agentName: "Workspace Agent" },
    });

    const { getByTestId, unmount } = await renderWorkspaceTerminalPage();

    expect(mockGetWorkspaceAgentAction).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(mockGetWorkspaceAgentAction).toHaveBeenCalledTimes(1);
    expect(mockGetTerminalSettingsAction).not.toHaveBeenCalled();
    expect(mockGetWorkspaceSessionsAction).not.toHaveBeenCalled();
    expect(getByTestId("multi-session-workspace-route")).toHaveAttribute(
      "data-agent-id",
      "workspace-agent",
    );
    expect(getByTestId("multi-session-workspace-route")).toHaveAttribute(
      "data-workspace-id",
      "test-ws",
    );
    const routeClassName = getByTestId("multi-session-workspace-route").getAttribute(
      "data-class-name",
    );
    expect(routeClassName).toContain("h-[calc(var(--app-viewport-height)");
    expect(routeClassName).toContain("min-h-0");
    expect(routeClassName).toContain("overflow-hidden");
    expect(multiSessionRouteMockState.props).toMatchObject({
      agentId: "workspace-agent",
      workspaceId: "test-ws",
    });
    unmount();
  });

  it("reuses the stale-entry alert path when the agent lookup fails", async () => {
    mockGetWorkspaceAgentAction.mockResolvedValueOnce({
      serverError: "No agents found for workspace /private/path",
    });

    const { getByText, queryByTestId, unmount } = await renderWorkspaceTerminalPage();

    expect(mockGetWorkspaceAgentAction).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(getByText("Could not find a running agent for this workspace.")).toBeInTheDocument();
    expect(queryByTestId("multi-session-workspace-route")).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid="interactive-terminal"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain("/private/path");
    unmount();
  });

  it("keeps S05 floating layout signals independent from drag-only x/y movement", async () => {
    mockGetWorkspaceSessionsAction.mockResolvedValueOnce({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
      ],
    });

    const { getAllByTestId, getByTestId, unmount } = await renderActualMultiSessionWorkspace();

    await waitFor(() => {
      expect(getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(getByTestId("float-pane-pane-main-session"));
    });

    await waitFor(() => {
      expect(getByTestId("workspace-pane-main-session")).toHaveAttribute(
        "data-pane-mode",
        "floating",
      );
    });

    const findMainTerminal = () =>
      getAllByTestId("interactive-terminal").find(
        (terminal) => terminal.getAttribute("data-session-name") === "main-session",
      );
    const signalBeforeDrag = findMainTerminal()?.getAttribute("data-layout-signal");
    expect(signalBeforeDrag).toBe("floating:720:420");

    const pane = getByTestId("workspace-pane-main-session");
    const handle = getByTestId("drag-handle-pane-main-session");

    await act(async () => {
      pointerDown(handle, 100, 100);
      pointerMove(pane, 180, 160);
    });

    expect(pane).toHaveStyle({ left: "104px", top: "84px" });
    expect(findMainTerminal()?.getAttribute("data-layout-signal")).toBe(signalBeforeDrag);

    await act(async () => {
      pointerUp(pane, 180, 160);
    });

    expect(pane).toHaveStyle({ left: "104px", top: "84px" });
    expect(findMainTerminal()?.getAttribute("data-layout-signal")).toBe(signalBeforeDrag);
    expect(signalBeforeDrag).not.toContain("104");
    expect(signalBeforeDrag).not.toContain("84");
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
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-selection-mode-enabled",
      "false",
    );
    expect(getByTestId("terminal-gesture-layer")).toHaveAttribute(
      "data-selection-mode-enabled",
      "false",
    );
    expect(getByTestId("terminal-desktop-shell")).toBeInTheDocument();
    expect(getByTestId("terminal-desktop-shell")).toHaveClass(
      "h-[calc(var(--app-viewport-height)-var(--safe-area-inset-top)-3.5rem)]",
      "md:h-[calc(var(--app-viewport-height)-var(--safe-area-inset-top)-var(--safe-area-inset-bottom)-5rem)]",
    );
    expect(document.querySelectorAll('[data-testid="interactive-terminal"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="terminal-mobile-controls"]')).toBeNull();
    expect(document.querySelector('[data-testid="terminal-window-command-palette"]')).toBeNull();
    unmount();
  });

  it("shows opt-in desktop controls without enabling mobile terminal input mode", async () => {
    const activeSend = vi.fn();
    mockUseKeybindings.mockReturnValue({
      activeSend,
      activeTerminal: { focus: vi.fn(), getSelection: vi.fn(() => "") },
      getAll: vi.fn(() => []),
      handleKeyEvent: mockHandleKeyEvent,
      register: mockRegisterKeybinding,
      setActiveTerminal: mockSetActiveTerminal,
      unregister: mockUnregisterKeybinding,
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main", {
      terminalControlsBeyondMobile: true,
    });

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toBeInTheDocument();
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-mobile-input-mode", "false");
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "false",
    );
    expect(getByTestId("terminal-desktop-shell")).toHaveClass("flex", "flex-col");

    fireEvent.click(getByTestId("terminal-smart-enter"));
    expect(activeSend).toHaveBeenCalledWith("\r");
    unmount();
  });

  it("updates mounted desktop controls from terminal settings events and ignores malformed events", async () => {
    const { getByTestId, queryByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(queryByTestId("terminal-mobile-controls")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("hive:terminal-settings-changed", {
          detail: { terminalControlsBeyondMobile: "yes" },
        }),
      );
    });
    expect(queryByTestId("terminal-mobile-controls")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("hive:terminal-settings-changed", {
          detail: { terminalControlsBeyondMobile: true },
        }),
      );
    });
    expect(getByTestId("terminal-mobile-controls")).toBeInTheDocument();
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-mobile-input-mode", "false");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("hive:terminal-settings-changed", {
          detail: { terminalControlsBeyondMobile: false },
        }),
      );
    });
    expect(queryByTestId("terminal-mobile-controls")).not.toBeInTheDocument();
    unmount();
  });

  it("passes the server-read setting into the terminal client", async () => {
    mockGetTerminalSettingsAction.mockResolvedValueOnce({
      data: { terminalControlsBeyondMobile: true },
    });

    const { getByTestId, unmount } = await renderTerminalPage("session=main");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toBeInTheDocument();
    });
    expect(mockGetWorkspaceAgentAction).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(mockGetTerminalSettingsAction).toHaveBeenCalledTimes(1);
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-mobile-input-mode", "false");
    unmount();
  });

  it("defaults the server-read setting off when the terminal settings action fails", async () => {
    mockGetTerminalSettingsAction.mockResolvedValueOnce({
      serverError: "Terminal settings are unavailable. Refresh and try again.",
    });

    const { getByTestId, queryByTestId, unmount } = await renderTerminalPage("session=main");

    await waitFor(() => {
      expect(getByTestId("interactive-terminal")).toBeInTheDocument();
    });
    expect(mockGetWorkspaceAgentAction).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(mockGetTerminalSettingsAction).toHaveBeenCalledTimes(1);
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-mobile-input-mode", "false");
    expect(queryByTestId("terminal-mobile-controls")).not.toBeInTheDocument();
    unmount();
  });

  it("restores active terminal focus on desktop terminal routes", async () => {
    const focus = vi.fn();
    mockUseKeybindings.mockReturnValue({
      activeSend: vi.fn(),
      activeTerminal: { focus },
      getAll: vi.fn(() => []),
      handleKeyEvent: mockHandleKeyEvent,
      register: mockRegisterKeybinding,
      setActiveTerminal: mockSetActiveTerminal,
      unregister: mockUnregisterKeybinding,
    });

    const { unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(focus).toHaveBeenCalledTimes(1);
    });
    unmount();
  });

  it("does not steal focus from focused text inputs on desktop terminal routes", async () => {
    const focus = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    mockUseKeybindings.mockReturnValue({
      activeSend: vi.fn(),
      activeTerminal: { focus },
      getAll: vi.fn(() => []),
      handleKeyEvent: mockHandleKeyEvent,
      register: mockRegisterKeybinding,
      setActiveTerminal: mockSetActiveTerminal,
      unregister: mockUnregisterKeybinding,
    });

    const { unmount } = await renderTerminalClient("session=main");

    await act(async () => {
      await Promise.resolve();
    });
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.remove();
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

  it("updates mobile copy availability when terminal selection changes", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    let selected = false;
    let selectionChangeHandler: (() => void) | null = null;
    const disposeSelectionChange = vi.fn();
    const activeTerminal = {
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => (selected ? "selected text" : "")),
      hasSelection: vi.fn(() => selected),
      onSelectionChange: vi.fn((handler: () => void) => {
        selectionChangeHandler = handler;
        return { dispose: disposeSelectionChange };
      }),
    };
    mockUseKeybindings.mockReturnValue({
      activeSend: vi.fn(),
      activeTerminal,
      getAll: vi.fn(() => []),
      handleKeyEvent: mockHandleKeyEvent,
      register: mockRegisterKeybinding,
      setActiveTerminal: mockSetActiveTerminal,
      unregister: mockUnregisterKeybinding,
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
        "data-copy-disabled-reason",
        "Select terminal text before copying",
      );
    });

    selected = true;
    act(() => {
      selectionChangeHandler?.();
    });

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-has-selection", "true");
    });
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-copy-disabled", "false");

    unmount();
    expect(disposeSelectionChange).toHaveBeenCalledTimes(1);
  });

  it("wires mobile clipboard buttons to the active terminal and sender with redacted status", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    const activeTerminal = {
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => "non-empty-selection"),
    };
    const activeSend = vi.fn();
    mockUseKeybindings.mockReturnValue({
      activeSend,
      activeTerminal,
      getAll: vi.fn(() => []),
      handleKeyEvent: mockHandleKeyEvent,
      register: mockRegisterKeybinding,
      setActiveTerminal: mockSetActiveTerminal,
      unregister: mockUnregisterKeybinding,
    });
    mockCopyTerminalSelection.mockImplementation((_term, options) => {
      options?.onStatus?.({ action: "copy", outcome: "copied", method: "clipboard-api" });
      return false;
    });
    mockPasteToTerminal.mockImplementation((_term, _send, options) => {
      options?.onStatus?.({ action: "paste", outcome: "pasted", method: "clipboard-api" });
      return false;
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-has-selection", "true");
    });

    fireEvent.click(getByTestId("terminal-copy-selection"));
    expect(mockCopyTerminalSelection).toHaveBeenCalledWith(
      activeTerminal,
      expect.objectContaining({ onStatus: expect.any(Function) }),
    );
    expect(getByTestId("terminal-clipboard-status")).toHaveTextContent("Copy complete");
    expect(getByTestId("terminal-clipboard-status")).not.toHaveTextContent("non-empty-selection");

    fireEvent.click(getByTestId("terminal-paste-clipboard"));
    expect(mockPasteToTerminal).toHaveBeenCalledWith(
      activeTerminal,
      activeSend,
      expect.objectContaining({ onStatus: expect.any(Function) }),
    );
    expect(getByTestId("terminal-clipboard-status")).toHaveTextContent("Paste complete");
    unmount();
  });

  it("keeps mobile clipboard actions disabled until the active terminal and sender are available", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);

    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-copy-disabled", "true");
    });
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-copy-disabled-reason",
      "Terminal is not ready",
    );
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-paste-disabled", "true");
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-paste-disabled-reason",
      "Paste is unavailable until the terminal sender is ready",
    );
    expect(getByTestId("terminal-clipboard-status")).toHaveTextContent("Terminal is not ready");
    expect(mockCopyTerminalSelection).not.toHaveBeenCalled();
    expect(mockPasteToTerminal).not.toHaveBeenCalled();
    unmount();
  });

  it("forwards mobile selection mode to the gesture layer and terminal only on compose-sheet routes", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    const activeTerminal = {
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => ""),
    };
    const activeSend = vi.fn();
    mockUseKeybindings.mockReturnValue({
      activeSend,
      activeTerminal,
      getAll: vi.fn(() => []),
      handleKeyEvent: mockHandleKeyEvent,
      register: mockRegisterKeybinding,
      setActiveTerminal: mockSetActiveTerminal,
      unregister: mockUnregisterKeybinding,
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
        "data-selection-mode-enabled",
        "false",
      );
    });

    const suppressedContextMenu = createEvent.contextMenu(getByTestId("terminal-gesture-layer"), {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(getByTestId("terminal-gesture-layer"), suppressedContextMenu);
    expect(suppressedContextMenu.defaultPrevented).toBe(true);

    fireEvent.click(getByTestId("terminal-selection-toggle"));

    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-selection-mode-enabled",
      "true",
    );
    expect(getByTestId("terminal-gesture-layer")).toHaveAttribute(
      "data-selection-mode-enabled",
      "true",
    );
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-selection-mode-enabled",
      "true",
    );
    expect(getByTestId("terminal-gesture-layer").parentElement).toHaveAttribute(
      "data-sidebar-gesture-ignore",
      "true",
    );
    expect(getByTestId("terminal-clipboard-status")).toHaveTextContent("Selection mode on");

    const nativeSelectionContextMenu = createEvent.contextMenu(
      getByTestId("terminal-gesture-layer"),
      {
        bubbles: true,
        cancelable: true,
      },
    );
    fireEvent(getByTestId("terminal-gesture-layer"), nativeSelectionContextMenu);
    expect(nativeSelectionContextMenu.defaultPrevented).toBe(false);
    unmount();
  });

  it("passes favorite-window navigation state to mobile controls", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [
        { id: "fav-alpha", name: "alpha" },
        { id: "fav-main", name: "main" },
        { id: "fav-two-words", name: "two words" },
      ],
      current: { id: "fav-main", name: "main" },
      previous: { id: "fav-alpha", name: "alpha" },
      next: { id: "fav-two-words", name: "two words" },
      canGoPrevious: true,
      canGoNext: true,
      loading: false,
      error: null,
      reload: vi.fn(),
      select: vi.fn(() => true),
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main&debugViewport=1");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-session-count", "3");
    });
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-current-session", "main");
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-previous-session",
      "alpha",
    );
    expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-next-session",
      "two words",
    );
    expect(document.querySelectorAll('[data-testid="interactive-terminal"]')).toHaveLength(1);
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-session-name", "main");
    expect(mockUseFavoriteWindowNavigation).toHaveBeenCalledWith("test-ws");
    expect(mockGetWorkspaceSessionsAction).not.toHaveBeenCalled();
    unmount();
  });

  it("selects previous and next favorite windows by id", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    const selectFavoriteWindow = vi.fn(() => true);
    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [
        { id: "fav-alpha", name: "alpha" },
        { id: "fav-main", name: "main" },
        { id: "fav-two-words", name: "two words" },
      ],
      current: { id: "fav-main", name: "main" },
      previous: { id: "fav-alpha", name: "alpha" },
      next: { id: "fav-two-words", name: "two words" },
      canGoPrevious: true,
      canGoNext: true,
      loading: false,
      error: null,
      reload: vi.fn(),
      select: selectFavoriteWindow,
    });

    const { getByTestId, unmount } = await renderTerminalClient("session=main&debugViewport=1");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute(
        "data-next-session",
        "two words",
      );
    });

    fireEvent.click(getByTestId("terminal-window-next"));
    expect(selectFavoriteWindow).toHaveBeenCalledWith("fav-two-words");

    fireEvent.click(getByTestId("terminal-window-previous"));
    expect(selectFavoriteWindow).toHaveBeenCalledWith("fav-alpha");
    expect(navigationState.router.replace).not.toHaveBeenCalled();
    unmount();
  });

  it("opens the existing command palette picker and routes favorite selection without enabling creation", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    const selectFavoriteWindow = vi.fn(() => true);
    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [
        { id: "fav-main", name: "main" },
        { id: "fav-beta", name: "beta/slash" },
      ],
      current: { id: "fav-main", name: "main" },
      previous: null,
      next: { id: "fav-beta", name: "beta/slash" },
      canGoPrevious: false,
      canGoNext: true,
      loading: false,
      error: null,
      reload: vi.fn(),
      select: selectFavoriteWindow,
    });

    const { getByTestId, queryByTestId, unmount } = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-session-count", "2");
    });
    expect(queryByTestId("terminal-window-command-palette")).not.toBeInTheDocument();

    fireEvent.click(getByTestId("terminal-window-switcher"));

    expect(getByTestId("terminal-window-command-palette")).toBeInTheDocument();
    expect(terminalRouteMockState.commandPaletteProps).toMatchObject({
      hasCreateSession: false,
      open: true,
      tabs: [
        { id: "fav-main", sessionName: "main" },
        { id: "fav-beta", sessionName: "beta/slash" },
      ],
    });

    fireEvent.click(getByTestId("terminal-window-option-fav-beta"));

    expect(selectFavoriteWindow).toHaveBeenCalledWith("fav-beta");
    expect(navigationState.router.replace).not.toHaveBeenCalled();
    unmount();
  });

  it("shows an empty favorite picker state instead of navigating when there are no favorite windows", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);

    const { getByTestId, queryByTestId, unmount } = await renderTerminalClient("session=missing");

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-session-count", "0");
    });

    fireEvent.click(getByTestId("terminal-window-switcher"));

    expect(getByTestId("terminal-window-command-palette")).toHaveTextContent(
      "No favorite windows found.",
    );
    expect(queryByTestId("terminal-window-option-missing")).not.toBeInTheDocument();
    expect(navigationState.router.replace).not.toHaveBeenCalled();
    unmount();
  });

  it("selects favorite windows from an active clone URL without generic session fallback", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    const selectFavoriteWindow = vi.fn(() => true);
    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [
        { id: "fav-git", name: "Hive repo" },
        { id: "fav-terminal-two-words", name: "two words" },
      ],
      current: { id: "fav-git", name: "Hive repo" },
      previous: null,
      next: { id: "fav-terminal-two-words", name: "two words" },
      canGoPrevious: false,
      canGoNext: true,
      loading: false,
      error: null,
      reload: vi.fn(),
      select: selectFavoriteWindow,
    });

    const { getByTestId, unmount } = await renderTerminalClient(
      "session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneProof=proof-token&debugViewport=1",
    );

    await waitFor(() => {
      expect(getByTestId("terminal-mobile-controls")).toHaveAttribute("data-session-count", "2");
    });
    expect(getByTestId("interactive-terminal")).toHaveAttribute(
      "data-session-name",
      "git-clone-safe-hive",
    );
    expect(getByTestId("interactive-terminal")).toHaveAttribute("data-clone-proof", "proof-token");

    fireEvent.click(getByTestId("terminal-window-switcher"));
    fireEvent.click(getByTestId("terminal-window-option-fav-terminal-two-words"));

    expect(selectFavoriteWindow).toHaveBeenCalledWith("fav-terminal-two-words");
    expect(navigationState.router.replace).not.toHaveBeenCalled();
    unmount();
  });

  it("surfaces loading and server-error favorite navigation states without leaving the active route", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [],
      current: null,
      previous: null,
      next: null,
      canGoPrevious: false,
      canGoNext: false,
      loading: true,
      error: null,
      reload: vi.fn(),
      select: vi.fn(() => false),
    });

    const loadingRender = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(loadingRender.getByTestId("terminal-mobile-controls")).toHaveAttribute(
        "data-loading",
        "true",
      );
    });
    expect(navigationState.router.replace).not.toHaveBeenCalled();
    loadingRender.unmount();

    mockUseFavoriteWindowNavigation.mockReturnValue({
      sessions: [],
      current: null,
      previous: null,
      next: null,
      canGoPrevious: false,
      canGoNext: false,
      loading: false,
      error: "Favorites unavailable",
      reload: vi.fn(),
      select: vi.fn(() => false),
    });

    const errorRender = await renderTerminalClient("session=main");

    await waitFor(() => {
      expect(errorRender.getByTestId("terminal-mobile-controls")).toHaveAttribute(
        "data-error",
        "Favorites unavailable",
      );
    });
    expect(navigationState.router.replace).not.toHaveBeenCalled();
    errorRender.unmount();
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

  it("keeps selection mode passive so native text selection wins over keyboard, scroll, and sidebar gestures", async () => {
    const { container, rerender, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();

    const helper = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    expect(helper).toHaveAttribute("data-terminal-mobile-input", "true");
    helper?.focus();
    expect(document.activeElement).toBe(helper);

    const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");
    await act(async () => {
      rerender(
        <InteractiveTerminal
          agentId="test-agent"
          mobileInputMode
          selectionModeEnabled
          sessionName="main"
          workspaceId="test-ws"
        />,
      );
    });
    await flushTerminalEffects();

    const inputTarget = container.querySelector(".flex-1.p-1");
    expect(inputTarget).toHaveAttribute("data-sidebar-gesture-ignore", "true");
    expect(inputTarget).toHaveAttribute("data-terminal-selection-mode", "true");
    expect(inputTarget).not.toHaveAttribute("data-terminal-pinch-zoom");
    expect(helper).not.toHaveAttribute("data-terminal-mobile-input");
    expect(document.activeElement).not.toBe(helper);

    terminal?.focus.mockClear();
    terminal?.scrollLines.mockClear();
    fireEvent.pointerDown(inputTarget as Element, {
      clientX: 80,
      clientY: 240,
      pointerId: 1,
      pointerType: "touch",
    });
    fireTouchEvent(inputTarget as Element, "touchstart", [touchPoint(1, 80, 320)]);
    const touchMove = fireTouchEvent(inputTarget as Element, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget as Element, "touchend", [], [touchPoint(1, 80, 240)]);
    fireEvent.click(inputTarget as Element);

    expect(touchMove.defaultPrevented).toBe(false);
    expect(terminal?.scrollLines).not.toHaveBeenCalled();
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
