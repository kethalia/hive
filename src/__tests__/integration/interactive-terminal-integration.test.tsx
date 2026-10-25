// @vitest-environment jsdom

import { getMobileModifiers, setMobileModifiers } from "@/lib/terminal/mobile-modifiers";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, TerminalRecoveryState } from "@/hooks/useTerminalWebSocket";
import { setTerminalFontSize, terminalFontSizeScope } from "@/lib/terminal/font-size";
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
      constructorOptions: Record<string, unknown>;
      options: { disableStdin: boolean; fontSize?: number };
      dataHandler?: (data: string) => void;
      focus: ReturnType<typeof vi.fn>;
      onData: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      resizeHandler?: (dimensions: { rows: number; cols: number }) => void;
      scrollLines: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
      modes: { mouseTrackingMode: string };
    }>,
  }),
);

const {
  mockCopyTerminalSelection,
  mockCreateSessionAction,
  mockGetTerminalSettingsAction,
  mockGetWorkspaceAgentAction,
  mockGetWorkspaceSessionsAction,
  mockHandleKeyEvent,
  mockPasteClipboardApiToTerminal,
  mockPasteNativeClipboardEventToTerminal,
  mockPasteToTerminal,
  mockRegisterKeybinding,
  mockResolveGitCloneTerminalAction,
  mockSetActiveTerminal,
  mockUnregisterKeybinding,
  mockUseIsMobile,
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
    mockPasteClipboardApiToTerminal: vi.fn(),
    mockPasteNativeClipboardEventToTerminal: vi.fn(),
    mockPasteToTerminal: vi.fn(),
    mockRegisterKeybinding: register,
    mockResolveGitCloneTerminalAction: vi.fn(),
    mockSetActiveTerminal: setActiveTerminal,
    mockUnregisterKeybinding: unregister,
    mockUseIsMobile: vi.fn(() => false),
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
      interactiveTerminalProps: null as null | {
        clonePath?: string;
        cloneProof?: string;
        refreshCloneTerminalIdentity?: (context: {
          sessionName: string;
          clonePath: string;
          reason: "scheduled-reconnect" | "manual-reconnect";
          retryCount: number;
          closeCode: number | null;
          closeCategory: string | null;
          reasonCategory: string | null;
        }) => Promise<{ sessionName: string; clonePath: string; cloneProof: string }>;
        sessionName: string;
      },
      mobileControlsProps: null as unknown,
    },
  };
});

vi.mock("@/lib/terminal/browser-integration", () => ({
  installTerminalBrowserIntegration: vi.fn(() => vi.fn()),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    options = { disableStdin: false };
    rows = 24;
    cols = 80;
    buffer = { active: { baseY: 10, viewportY: 9 } };
    modes = { mouseTrackingMode: "none" };
    open = vi.fn((element: HTMLElement) => {
      const terminal = document.createElement("div");
      terminal.className = "xterm";
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.appendChild(screen);
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
    constructorOptions: Record<string, unknown>;

    constructor(options: Record<string, unknown> = {}) {
      this.constructorOptions = options;
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
      refreshCloneTerminalIdentity,
      selectionModeEnabled,
      sessionName,
    }: {
      className?: string;
      clonePath?: string;
      cloneProof?: string;
      layoutSignal?: unknown;
      mobileInputMode?: boolean;
      pinToBottomOnResize?: boolean;
      refreshCloneTerminalIdentity?: (context: {
        sessionName: string;
        clonePath: string;
        reason: "scheduled-reconnect" | "manual-reconnect";
        retryCount: number;
        closeCode: number | null;
        closeCategory: string | null;
        reasonCategory: string | null;
      }) => Promise<{ sessionName: string; clonePath: string; cloneProof: string }>;
      selectionModeEnabled?: boolean;
      sessionName: string;
    }) => {
      terminalRouteMockState.interactiveTerminalProps = {
        clonePath,
        cloneProof,
        refreshCloneTerminalIdentity,
        sessionName,
      };
      return (
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
    };
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
  getWorkspaceAgentAction: mockGetWorkspaceAgentAction,
  getWorkspaceSessionsAction: mockGetWorkspaceSessionsAction,
}));

vi.mock("@/lib/actions/git-clones", () => ({
  resolveGitCloneTerminalAction: mockResolveGitCloneTerminalAction,
}));

vi.mock("@/lib/actions/user-settings", () => ({
  getTerminalSettingsAction: mockGetTerminalSettingsAction,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: mockUseIsMobile,
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
  AlertTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("lucide-react", () => ({
  Bot: () => <span data-testid="icon-bot" />,
  Activity: () => null,
  AlertCircle: () => null,
  Upload: () => null,
  ArrowDown: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  Code2: () => null,
  ClipboardPaste: () => null,
  Copy: () => null,
  Ellipsis: () => null,
  ExternalLink: () => null,
  Files: () => null,
  FolderOpen: () => null,
  Focus: () => null,
  ScrollText: () => null,
  GripVertical: () => null,
  RefreshCw: () => null,
  Loader2: () => null,
  Minus: () => null,
  Plus: () => null,
  X: () => null,
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

vi.mock("@/components/ui/button", () => ({
  buttonVariants: () => "button-variant",
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
  Sheet: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? (
      <div data-open={open ? "true" : "false"} data-testid="sheet">
        {children}
      </div>
    ) : null,
  SheetContent: ({ children, side }: React.PropsWithChildren<{ side?: string }>) => (
    <section data-side={side} data-testid="sheet-content">
      {children}
    </section>
  ),
  SheetDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  SheetHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

vi.mock("@/lib/device/haptics", () => ({
  triggerHapticFeedback: vi.fn(),
}));

vi.mock("@/lib/terminal/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/terminal/actions")>()),
  copyTerminalSelection: mockCopyTerminalSelection,
  dropDataTransferToTerminal: vi.fn(),
  pasteClipboardApiToTerminal: mockPasteClipboardApiToTerminal,
  pasteNativeClipboardEventToTerminal: mockPasteNativeClipboardEventToTerminal,
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
  mockFit.mockReset();
  mockSend.mockReset();
  mockResize.mockReset();
  terminalInstances.length = 0;
  resetMobileTerminalDiagnosticsState();
  window.localStorage.clear();
  navigationState.search = "session=main";
  navigationState.router.push.mockClear();
  navigationState.router.replace.mockClear();
  mockCopyTerminalSelection.mockReset();
  mockPasteClipboardApiToTerminal.mockReset();
  mockPasteNativeClipboardEventToTerminal.mockReset();
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
  mockResolveGitCloneTerminalAction.mockReset();
  terminalRouteMockState.commandPaletteProps = null;
  terminalRouteMockState.interactiveTerminalProps = null;
  terminalRouteMockState.mobileControlsProps = null;
  mockRegisterKeybinding.mockClear();
  mockUnregisterKeybinding.mockClear();
  mockHandleKeyEvent.mockClear();
  mockSetActiveTerminal.mockClear();
  mockUseIsMobile.mockReset();
  mockUseIsMobile.mockReturnValue(false);
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

  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
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

type RefreshedCloneTerminalIdentity = {
  sessionName: string;
  clonePath: string;
  cloneProof: string;
};

type RenderTerminalOptions = {
  clonePath?: string;
  cloneProof?: string;
  layoutSignal?: unknown;
  mobileInputMode?: boolean;
  onClipboardStatus?: (status: import("@/lib/terminal/actions").ClipboardActionStatus) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onRecoveryStateChange?: (state: TerminalRecoveryState) => void;
  onUserFocusRequest?: () => void;
  pinToBottomOnResize?: boolean;
  refreshCloneTerminalIdentity?: () =>
    | Promise<RefreshedCloneTerminalIdentity>
    | RefreshedCloneTerminalIdentity;
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

function terminalWebSocketUrls() {
  return mockUseTerminalWebSocket.mock.calls
    .map(([options]) => (options as { url: string | null }).url)
    .filter((url): url is string => typeof url === "string");
}

function latestTerminalWebSocketOptions() {
  return mockUseTerminalWebSocket.mock.calls.at(-1)?.[0] as
    | {
        onRecoveryStateChange?: (state: TerminalRecoveryState) => void;
        refreshUrlBeforeReconnect?: (context: {
          currentUrl: string;
          reason: "scheduled-reconnect" | "manual-reconnect";
          retryCount: number;
          closeCode: number | null;
          closeCategory: string | null;
          reasonCategory: string | null;
        }) => Promise<string | { failureCategory: string } | null | undefined>;
        url: string | null;
      }
    | undefined;
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

function terminalRecoveryState(
  overrides: Partial<TerminalRecoveryState> = {},
): TerminalRecoveryState {
  return {
    phase: "idle",
    retryCount: 0,
    maxRetryCount: null,
    lastCloseCode: null,
    lastCloseCategory: null,
    lastReasonCategory: null,
    failureCategory: null,
    lastDelayMs: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastRecoveryAction: "none",
    lastRefreshAction: "none",
    refreshFailureCategory: null,
    lastRefreshStartedAt: null,
    lastRefreshFinishedAt: null,
    isRecoverable: true,
    canRetry: false,
    ...overrides,
  };
}

describe("InteractiveTerminal file drop feedback", () => {
  it("detects files, keeps feedback across child transitions, clears it on drop and exit", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "connected",
    });
    await renderTerminal();
    const host = document.querySelector('[data-terminal-surface="true"]')!;
    const child = document.querySelector('[data-testid="terminal-fit-host"]')!;
    const transfer = { types: ["Files"], dropEffect: "none", items: [{ kind: "file" }] };
    fireEvent.dragOver(host, { dataTransfer: transfer });
    expect(
      document.querySelector('[data-testid="terminal-file-drop-indicator"]'),
    ).toHaveTextContent("Drop files to upload");
    expect(transfer.dropEffect).toBe("copy");
    const leave = new Event("dragleave", { bubbles: true });
    Object.defineProperty(leave, "relatedTarget", { value: child });
    fireEvent(host, leave);
    expect(
      document.querySelector('[data-testid="terminal-file-drop-indicator"]'),
    ).toBeInTheDocument();
    fireEvent.drop(host, { dataTransfer: transfer });
    expect(
      document.querySelector('[data-testid="terminal-file-drop-indicator"]'),
    ).not.toBeInTheDocument();
    fireEvent.dragOver(host, { dataTransfer: transfer });
    fireEvent.dragLeave(host);
    expect(
      document.querySelector('[data-testid="terminal-file-drop-indicator"]'),
    ).not.toBeInTheDocument();
    fireEvent.dragOver(host, { dataTransfer: { types: ["text/plain"] } });
    expect(
      document.querySelector('[data-testid="terminal-file-drop-indicator"]'),
    ).not.toBeInTheDocument();
  });
});

describe("InteractiveTerminal integration — Connection state banners", () => {
  it("drops xterm device answerbacks before forwarding terminal input", async () => {
    const { unmount } = await renderTerminal();
    const terminal = terminalInstances.at(-1);

    act(() => {
      terminal?.dataHandler?.("\x1b[?1;2c\x1b[>0;276;0c");
    });
    expect(mockSend).not.toHaveBeenCalled();

    act(() => {
      terminal?.dataHandler?.("echo ok\x1b[?1;2c\r");
    });
    expect(mockSend).toHaveBeenCalledWith("echo ok\r");

    unmount();
  });

  it("configures xterm native selection options for tmux mouse mode", async () => {
    const { unmount } = await renderTerminal();
    const terminal = terminalInstances.at(-1);

    expect(terminal?.constructorOptions).toEqual(
      expect.objectContaining({
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        scrollback: 0,
      }),
    );

    unmount();
  });

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

  it("shows sanitized final-failure banner only when recovery reaches final failure", async () => {
    const manualReconnect = vi.fn();
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "failed",
      manualReconnect,
      recoveryState: terminalRecoveryState({
        phase: "final-failure",
        failureCategory: "auth-expired",
        isRecoverable: false,
        canRetry: true,
      }),
    });

    const { container, getByRole, unmount } = await renderTerminal();
    expect(container.textContent).toContain("authentication expired");
    expect(container.textContent).not.toContain("Refresh the page");
    fireEvent.click(getByRole("button", { name: "Retry terminal connection" }));
    expect(manualReconnect).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("shows quiet recoverable reconnect status without refresh-page failure text", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: vi.fn(),
      resize: vi.fn(),
      connectionState: "failed",
      recoveryState: terminalRecoveryState({
        phase: "recovering",
        retryCount: 2,
        lastRecoveryAction: "schedule-reconnect",
        isRecoverable: true,
        canRetry: true,
      }),
    });

    const { container, unmount } = await renderTerminal();
    expect(container.textContent).toContain("Reconnecting terminal… Retry 2.");
    expect(container.textContent).not.toContain("Connection failed after multiple attempts");
    expect(container.textContent).not.toContain("Refresh the page");
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

  it("forwards sanitized recovery callbacks while preserving connection callbacks and clone URL refresh", async () => {
    window.localStorage.setItem(
      "terminal:reconnect:test-agent:git-clone-safe-hive",
      JSON.stringify({ id: "cached-clone-reconnect", ts: Date.now() }),
    );
    const emittedRecoveryState = terminalRecoveryState({
      phase: "recovering",
      retryCount: 2,
      lastCloseCode: 1008,
      lastCloseCategory: "clone-proof-invalid",
      lastReasonCategory: "clone-proof-invalid",
      failureCategory: null,
      lastDelayMs: 1250,
      lastRecoveryAction: "schedule-reconnect",
      lastRefreshAction: "refresh-failed",
      refreshFailureCategory: "malformed-identity",
      isRecoverable: true,
      canRetry: true,
    });
    const onConnectionStateChange = vi.fn();
    const onRecoveryStateChange = vi.fn();
    const refreshCloneTerminalIdentity = vi.fn(async () => ({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      cloneProof: "fresh-proof-token",
    }));

    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "reconnecting",
      recoveryState: emittedRecoveryState,
    });

    const { container, unmount } = await renderTerminal({
      clonePath: "kethalia/hive",
      cloneProof: "stale-proof-token",
      onConnectionStateChange,
      onRecoveryStateChange,
      refreshCloneTerminalIdentity,
      sessionName: "git-clone-safe-hive",
    });

    await waitFor(() => {
      expect(onConnectionStateChange).toHaveBeenCalledWith("reconnecting");
      expect(latestTerminalWebSocketOptions()?.onRecoveryStateChange).toBe(onRecoveryStateChange);
      expect(latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect).toEqual(
        expect.any(Function),
      );
    });

    act(() => {
      latestTerminalWebSocketOptions()?.onRecoveryStateChange?.(emittedRecoveryState);
    });
    expect(onRecoveryStateChange).toHaveBeenCalledWith(emittedRecoveryState);
    expect(onRecoveryStateChange.mock.calls[0][0]).toMatchObject({
      phase: "recovering",
      lastCloseCategory: "clone-proof-invalid",
      lastReasonCategory: "clone-proof-invalid",
      lastRefreshAction: "refresh-failed",
      refreshFailureCategory: "malformed-identity",
    });
    expect(JSON.stringify(onRecoveryStateChange.mock.calls)).not.toContain("fresh-proof-token");
    expect(JSON.stringify(onRecoveryStateChange.mock.calls)).not.toContain("stale-proof-token");
    expect(JSON.stringify(onRecoveryStateChange.mock.calls)).not.toContain("kethalia/hive");
    expect(JSON.stringify(onRecoveryStateChange.mock.calls)).not.toContain("/ws?");
    expect(container.textContent).toContain("Reconnecting terminal… Retry 2.");
    expect(container.textContent).not.toContain("automatic recovery stopped");

    const staleUrl = new URL(terminalWebSocketUrls().at(-1)!);
    const refreshedUrlValue = await latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect?.({
      currentUrl: staleUrl.toString(),
      reason: "scheduled-reconnect",
      retryCount: 2,
      closeCode: 1008,
      closeCategory: "clone-proof-invalid",
      reasonCategory: "clone-proof-invalid",
    });

    expect(refreshCloneTerminalIdentity).toHaveBeenCalledWith({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      reason: "scheduled-reconnect",
      retryCount: 2,
      closeCode: 1008,
      closeCategory: "clone-proof-invalid",
      reasonCategory: "clone-proof-invalid",
    });
    const refreshedUrl = new URL(refreshedUrlValue as string);
    expect(refreshedUrl.searchParams.get("sessionName")).toBe("git-clone-safe-hive");
    expect(refreshedUrl.searchParams.get("reconnectId")).toBe("cached-clone-reconnect");
    expect(refreshedUrl.searchParams.get("cloneProof")).toBe("fresh-proof-token");
    unmount();
  });

  it("refreshes stale Git clone proof material before reconnecting without persisting proofs", async () => {
    window.localStorage.setItem(
      "terminal:reconnect:test-agent:git-clone-safe-hive",
      JSON.stringify({ id: "cached-clone-reconnect", ts: Date.now() }),
    );
    const refreshCloneTerminalIdentity = vi.fn(async () => ({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      cloneProof: "fresh-proof-token",
    }));

    const { unmount } = await renderTerminal({
      clonePath: "kethalia/hive",
      cloneProof: "stale-proof-token",
      refreshCloneTerminalIdentity,
      sessionName: "git-clone-safe-hive",
    });

    await waitFor(() => {
      expect(latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect).toEqual(
        expect.any(Function),
      );
    });
    const staleUrl = new URL(terminalWebSocketUrls().at(-1)!);
    expect(staleUrl.searchParams.get("cloneProof")).toBe("stale-proof-token");

    const refreshedUrlValue = await latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect?.({
      currentUrl: staleUrl.toString(),
      reason: "scheduled-reconnect",
      retryCount: 1,
      closeCode: 1008,
      closeCategory: "clone-proof-invalid",
      reasonCategory: "clone-proof-invalid",
    });

    expect(refreshCloneTerminalIdentity).toHaveBeenCalledTimes(1);
    expect(refreshCloneTerminalIdentity).toHaveBeenCalledWith({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      reason: "scheduled-reconnect",
      retryCount: 1,
      closeCode: 1008,
      closeCategory: "clone-proof-invalid",
      reasonCategory: "clone-proof-invalid",
    });
    expect(typeof refreshedUrlValue).toBe("string");
    const refreshedUrl = new URL(refreshedUrlValue as string);
    expect(refreshedUrl.searchParams.get("agentId")).toBe("test-agent");
    expect(refreshedUrl.searchParams.get("workspaceId")).toBe("test-ws");
    expect(refreshedUrl.searchParams.get("sessionName")).toBe("git-clone-safe-hive");
    expect(refreshedUrl.searchParams.get("reconnectId")).toBe("cached-clone-reconnect");
    expect(refreshedUrl.searchParams.get("width")).toBe("80");
    expect(refreshedUrl.searchParams.get("height")).toBe("24");
    expect(refreshedUrl.searchParams.get("clonePath")).toBe("kethalia/hive");
    expect(refreshedUrl.searchParams.get("cloneProof")).toBe("fresh-proof-token");

    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.key(0)).toBe("terminal:reconnect:test-agent:git-clone-safe-hive");
    expect(JSON.stringify(window.localStorage)).not.toContain("fresh-proof-token");
    expect(JSON.stringify(window.localStorage)).not.toContain("/ws?");
    unmount();
  });

  it("rejects refreshed Git clone identity when the session name changes", async () => {
    const refreshCloneTerminalIdentity = vi.fn(async () => ({
      sessionName: "git-clone-other-repo",
      clonePath: "kethalia/hive",
      cloneProof: "fresh-proof-token",
    }));

    const { unmount } = await renderTerminal({
      clonePath: "kethalia/hive",
      cloneProof: "stale-proof-token",
      refreshCloneTerminalIdentity,
      sessionName: "git-clone-safe-hive",
    });

    await waitFor(() => {
      expect(latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect).toEqual(
        expect.any(Function),
      );
    });
    const staleUrl = new URL(terminalWebSocketUrls().at(-1)!);

    const refreshedUrlValue = await latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect?.({
      currentUrl: staleUrl.toString(),
      reason: "scheduled-reconnect",
      retryCount: 1,
      closeCode: 1008,
      closeCategory: "clone-proof-invalid",
      reasonCategory: "clone-proof-invalid",
    });

    expect(refreshedUrlValue).toEqual({ failureCategory: "session-name-mismatch" });
    expect(JSON.stringify(window.localStorage)).not.toContain("fresh-proof-token");
    unmount();
  });

  it("rejects malformed refreshed Git clone identity without exposing proof material", async () => {
    const refreshCloneTerminalIdentity = vi.fn(async () => ({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      cloneProof: "",
    }));

    const { unmount } = await renderTerminal({
      clonePath: "kethalia/hive",
      cloneProof: "stale-proof-token",
      refreshCloneTerminalIdentity,
      sessionName: "git-clone-safe-hive",
    });

    await waitFor(() => {
      expect(latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect).toEqual(
        expect.any(Function),
      );
    });
    const staleUrl = new URL(terminalWebSocketUrls().at(-1)!);

    const refreshedUrlValue = await latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect?.({
      currentUrl: staleUrl.toString(),
      reason: "scheduled-reconnect",
      retryCount: 1,
      closeCode: 1008,
      closeCategory: "clone-proof-invalid",
      reasonCategory: "clone-proof-invalid",
    });

    expect(refreshedUrlValue).toEqual({ failureCategory: "malformed-identity" });
    expect(JSON.stringify(window.localStorage)).not.toContain("fresh-proof-token");
    expect(JSON.stringify(window.localStorage)).not.toContain("/ws?");
    unmount();
  });

  it("does not enable clone identity refresh for ordinary terminal sessions", async () => {
    const refreshCloneTerminalIdentity = vi.fn(async () => ({
      sessionName: "main",
      clonePath: "kethalia/hive",
      cloneProof: "fresh-proof-token",
    }));

    const { unmount } = await renderTerminal({
      clonePath: "kethalia/hive",
      cloneProof: "stale-proof-token",
      refreshCloneTerminalIdentity,
      sessionName: "main",
    });

    await waitFor(() => {
      expect(terminalWebSocketUrls().length).toBeGreaterThan(0);
    });
    expect(latestTerminalWebSocketOptions()?.refreshUrlBeforeReconnect).toBeUndefined();
    expect(refreshCloneTerminalIdentity).not.toHaveBeenCalled();
    unmount();
  });

  it("rebuilds the WebSocket URL when clonePath changes for the same session", async () => {
    const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <InteractiveTerminal
          mobileInputMode
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

    const host = result!.container.querySelector('[data-testid="terminal-fit-host"]')!;
    const text = document.createElement("span");
    text.textContent = "selected old output";
    host.append(text);
    window.getSelection()!.selectAllChildren(text);
    const oldTerminal = terminalInstances.at(-1)!;
    oldTerminal.write.mockClear();
    const receive = () =>
      mockUseTerminalWebSocket.mock.calls.at(-1)![0].onData as (data: string) => void;
    act(() => receive()("old queued output"));
    expect(oldTerminal.write).not.toHaveBeenCalled();

    await act(async () => {
      result!.rerender(
        <InteractiveTerminal
          mobileInputMode
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
    const replacement = terminalInstances.at(-1)!;
    expect(replacement).not.toBe(oldTerminal);
    window.getSelection()!.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    act(() => receive()("fresh output"));
    expect(replacement.write.mock.calls.map(([data]) => data)).toEqual(["fresh output"]);
    result!.unmount();
  });

  it("preserves the renderer when a clone proof refreshes and disables input until ready", async () => {
    const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");
    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "connecting",
    });
    const props = {
      agentId: "test-agent",
      workspaceId: "test-ws",
      sessionName: "git-clone-proof-test",
      clonePath: "/home/coder/repo",
    };
    const view = render(<InteractiveTerminal {...props} cloneProof="first-proof" />);
    await flushTerminalEffects();
    const terminal = terminalInstances.at(-1)!;
    expect(terminal.options.disableStdin).toBe(true);
    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "connected",
    });
    view.rerender(<InteractiveTerminal {...props} cloneProof="new-proof" />);
    await flushTerminalEffects();
    expect(terminalInstances.at(-1)).toBe(terminal);
    expect(terminalInstances).toHaveLength(1);
    expect(terminal.options.disableStdin).toBe(false);
    view.unmount();
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

  it("refits and records resize-sent diagnostics after reconnect without changing normal terminal identity", async () => {
    window.localStorage.setItem(
      "terminal:reconnect:test-agent:main",
      JSON.stringify({ id: "cached-reconnect", ts: Date.now() }),
    );

    let connectionState: "disconnected" | "reconnecting" | "connected" = "disconnected";
    let latestOptions: null | {
      onResizeSent?: (event: {
        rows: number;
        cols: number;
        source: string;
        sentAt: number;
      }) => void;
      url: string | null;
    } = null;

    mockResize.mockImplementation((rows: number, cols: number, source: string) => {
      latestOptions?.onResizeSent?.({ rows, cols, source, sentAt: 3333 });
    });
    mockUseTerminalWebSocket.mockImplementation((options: unknown) => {
      latestOptions = options as typeof latestOptions;
      return {
        send: mockSend,
        resize: mockResize,
        connectionState,
        recoveryState: terminalRecoveryState({
          phase: connectionState === "connected" ? "connected" : "recovering",
          retryCount: connectionState === "connected" ? 0 : 1,
          lastRecoveryAction: connectionState === "connected" ? "connected" : "schedule-reconnect",
          canRetry: connectionState !== "connected",
        }),
      };
    });

    const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <InteractiveTerminal agentId="test-agent" workspaceId="test-ws" sessionName="main" />,
      );
    });
    await flushTerminalEffects();

    await waitFor(() => {
      expect(terminalWebSocketUrls().length).toBeGreaterThan(0);
    });
    const initialUrl = new URL(terminalWebSocketUrls().at(-1)!);
    expect(initialUrl.searchParams.get("sessionName")).toBe("main");
    expect(initialUrl.searchParams.get("reconnectId")).toBe("cached-reconnect");

    mockResize.mockClear();
    mockFit.mockClear();
    resetMobileTerminalDiagnosticsState();

    connectionState = "reconnecting";
    await act(async () => {
      result!.rerender(
        <InteractiveTerminal agentId="test-agent" workspaceId="test-ws" sessionName="main" />,
      );
    });
    await flushTerminalEffects();
    expect(mockResize).not.toHaveBeenCalledWith(24, 80, "connection-refit");

    connectionState = "connected";
    await act(async () => {
      result!.rerender(
        <InteractiveTerminal agentId="test-agent" workspaceId="test-ws" sessionName="main" />,
      );
    });
    await flushTerminalEffects();

    await waitFor(() => {
      expect(mockResize).toHaveBeenCalledWith(24, 80, "connection-refit");
    });
    expect(mockFit).toHaveBeenCalled();
    expect(getMobileTerminalDiagnosticsState().resizeSent).toEqual({
      count: 1,
      lastAt: 3333,
      lastSource: "connection-refit",
      rows: 24,
      cols: 80,
    });
    expect(getMobileTerminalDiagnosticsState().resizeSent.rows).toBeGreaterThan(0);
    expect(getMobileTerminalDiagnosticsState().resizeSent.cols).toBeGreaterThan(0);

    const latestUrl = new URL(terminalWebSocketUrls().at(-1)!);
    expect(latestUrl.toString()).toBe(initialUrl.toString());
    expect(latestUrl.searchParams.get("sessionName")).toBe("main");
    expect(latestUrl.searchParams.get("reconnectId")).toBe("cached-reconnect");
    result!.unmount();
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

  it("intercepts terminal Ctrl+V through the browser clipboard before xterm sends it", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();
    const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];
    expect(keyHandler).toEqual(expect.any(Function));

    const result = keyHandler?.({
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });

    expect(result).toBe(false);
    expect(mockPasteClipboardApiToTerminal).toHaveBeenCalledWith(
      terminal,
      expect.any(Function),
      expect.objectContaining({
        workspaceId: "test-ws",
      }),
    );
    expect(mockHandleKeyEvent).not.toHaveBeenCalled();

    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: {
        items: null,
        getData: vi.fn(() => "echo duplicate"),
      },
    });
    const xterm = document.querySelector(".xterm");
    expect(xterm).not.toBeNull();
    xterm?.dispatchEvent(nativePaste);

    expect(nativePaste.defaultPrevented).toBe(true);
    expect(mockPasteNativeClipboardEventToTerminal).not.toHaveBeenCalled();
    unmount();
  });

  it("intercepts terminal Ctrl+Shift+V before xterm injects multiline text", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const terminal = terminalInstances.at(-1);
    const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    const result = keyHandler?.({
      type: "keydown",
      key: "V",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    });

    expect(result).toBe(false);
    expect(mockPasteClipboardApiToTerminal).toHaveBeenCalledWith(
      terminal,
      expect.any(Function),
      expect.objectContaining({
        workspaceId: "test-ws",
      }),
    );
    expect(mockHandleKeyEvent).not.toHaveBeenCalled();
    unmount();
  });

  it.each([
    false,
    true,
  ])("replays native text when shifted Clipboard API paste fails (failure first: %s)", async (failureFirst) => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const terminal = terminalInstances.at(-1);
    const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    keyHandler?.({
      type: "keydown",
      key: "V",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    });

    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: {
        items: null,
        getData: vi.fn(() => "echo first\necho second"),
      },
    });
    const pasteOptions = mockPasteClipboardApiToTerminal.mock.calls.at(-1)?.[2];
    if (failureFirst) expect(pasteOptions?.onPasteFailure?.()).toBe(false);

    document.querySelector(".xterm")?.dispatchEvent(nativePaste);

    expect(nativePaste.defaultPrevented).toBe(true);
    if (!failureFirst) {
      expect(pasteOptions?.onPasteFailure?.()).toBe(true);
    }

    expect(mockSend).toHaveBeenCalledExactlyOnceWith("echo first\necho second");
    unmount();
  });

  it("keeps overlapping shifted paste fallbacks isolated by request", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const keyHandler = terminalInstances.at(-1)?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];
    const shiftedPasteEvent = {
      type: "keydown",
      key: "V",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    };

    keyHandler?.(shiftedPasteEvent);
    keyHandler?.(shiftedPasteEvent);

    for (const text of ["first one\nfirst two", "second one\nsecond two"]) {
      const nativePaste = new Event("paste", {
        bubbles: true,
        cancelable: true,
      }) as ClipboardEvent;
      Object.defineProperty(nativePaste, "clipboardData", {
        value: { items: null, getData: vi.fn(() => text) },
      });
      document.querySelector(".xterm")?.dispatchEvent(nativePaste);
      expect(nativePaste.defaultPrevented).toBe(true);
    }

    const firstPasteOptions = mockPasteClipboardApiToTerminal.mock.calls[0]?.[2];
    const secondPasteOptions = mockPasteClipboardApiToTerminal.mock.calls[1]?.[2];
    expect(secondPasteOptions?.onPasteFailure?.()).toBe(true);
    expect(firstPasteOptions?.onPasteFailure?.()).toBe(true);

    expect(mockSend.mock.calls.map(([frame]) => frame)).toEqual([
      "second one\nsecond two",
      "first one\nfirst two",
    ]);
    unmount();
  });

  it("replays cached native text on timeout and ignores the late API outcome", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const keyHandler = terminalInstances.at(-1)?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    keyHandler?.({
      type: "keydown",
      key: "V",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    });
    const timeoutCallback = timeoutSpy.mock.calls.at(-1)?.[0];
    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: { items: null, getData: vi.fn(() => "cached one\ncached two") },
    });
    document.querySelector(".xterm")?.dispatchEvent(nativePaste);

    if (typeof timeoutCallback !== "function") throw new Error("Paste timeout was not scheduled.");
    act(() => timeoutCallback());

    expect(mockSend).toHaveBeenCalledExactlyOnceWith("cached one\ncached two");
    const pasteOptions = mockPasteClipboardApiToTerminal.mock.calls.at(-1)?.[2];
    expect(
      pasteOptions?.onPasteOutcome?.({ kind: "text", text: "late API text", multiline: false }),
    ).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
    timeoutSpy.mockRestore();
    unmount();
  });

  it("routes a synchronous exec fallback event to its rejecting attempt", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const keyHandler = terminalInstances.at(-1)?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];
    const shiftedPasteEvent = {
      type: "keydown",
      key: "V",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    };
    keyHandler?.(shiftedPasteEvent);
    keyHandler?.(shiftedPasteEvent);

    const firstPasteOptions = mockPasteClipboardApiToTerminal.mock.calls[0]?.[2];
    const secondPasteOptions = mockPasteClipboardApiToTerminal.mock.calls[1]?.[2];
    expect(secondPasteOptions?.onPasteFailure?.()).toBe(false);
    secondPasteOptions?.runPasteFallback?.(() => {
      const fallbackPaste = new Event("paste", {
        bubbles: true,
        cancelable: true,
      }) as ClipboardEvent;
      Object.defineProperty(fallbackPaste, "clipboardData", {
        value: { items: null, getData: vi.fn(() => "newer one\nnewer two") },
      });
      document.querySelector(".xterm")?.dispatchEvent(fallbackPaste);
      return true;
    });

    const olderPaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(olderPaste, "clipboardData", {
      value: { items: null, getData: vi.fn(() => "older one\nolder two") },
    });
    document.querySelector(".xterm")?.dispatchEvent(olderPaste);
    expect(firstPasteOptions?.onPasteFailure?.()).toBe(true);

    expect(mockSend.mock.calls.map(([frame]) => frame)).toEqual([
      "newer one\nnewer two",
      "older one\nolder two",
    ]);
    unmount();
  });

  it("prefers a captured native file over a successful API text representation", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ paths: ["/tmp/hive-terminal-paste/native.png"] }),
      }),
    );
    const { unmount } = await renderTerminal({});
    const keyHandler = terminalInstances.at(-1)?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];
    keyHandler?.({
      type: "keydown",
      key: "V",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    });

    const file = new File(["png"], "native.png", { type: "image/png" });
    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: {
        items: { length: 1, 0: { kind: "file", getAsFile: () => file } },
        getData: vi.fn(() => "/local/native.png"),
      },
    });
    document.querySelector(".xterm")?.dispatchEvent(nativePaste);

    const pasteOptions = mockPasteClipboardApiToTerminal.mock.calls.at(-1)?.[2];
    expect(
      pasteOptions?.onPasteOutcome?.({
        kind: "text",
        text: "/local/native.png",
        multiline: false,
      }),
    ).toBe(true);

    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith("/tmp/hive-terminal-paste/native.png"),
    );
    expect(mockSend).not.toHaveBeenCalledWith("/local/native.png");
    unmount();
  });

  it("lets native file paste through after terminal Ctrl+V when clipboard item reads are unavailable", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(true);
    const { unmount } = await renderTerminal({});
    const terminal = terminalInstances.at(-1);
    const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    keyHandler?.({
      type: "keydown",
      key: "v",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    });

    const file = new File(["png"], "pasted.png", { type: "image/png" });
    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: {
        items: {
          length: 1,
          0: { kind: "file", getAsFile: () => file },
        },
        getData: vi.fn(() => ""),
      },
    });
    const xterm = document.querySelector(".xterm");
    xterm?.dispatchEvent(nativePaste);

    expect(mockPasteNativeClipboardEventToTerminal).toHaveBeenCalledWith(
      nativePaste,
      expect.objectContaining({
        workspaceId: "test-ws",
      }),
    );
    unmount();
  });

  it("suppresses the native file paste after terminal Ctrl+V when clipboard item reads are available", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { read: vi.fn() },
      configurable: true,
    });
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    const { unmount } = await renderTerminal({});
    const terminal = terminalInstances.at(-1);
    const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    keyHandler?.({
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });

    const file = new File(["png"], "pasted.png", { type: "image/png" });
    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: {
        items: {
          length: 1,
          0: { kind: "file", getAsFile: () => file },
        },
        getData: vi.fn(() => ""),
      },
    });
    const xterm = document.querySelector(".xterm");
    xterm?.dispatchEvent(nativePaste);

    expect(nativePaste.defaultPrevented).toBe(true);
    expect(mockPasteClipboardApiToTerminal).toHaveBeenCalledOnce();
    expect(mockPasteNativeClipboardEventToTerminal).not.toHaveBeenCalled();
    unmount();
  });

  it("uses captured native files when Clipboard API paste does not provide files", async () => {
    mockPasteClipboardApiToTerminal.mockReturnValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ paths: ["/tmp/hive-terminal-paste/pasted.txt"] }),
      }),
    );
    const { unmount } = await renderTerminal({});
    const terminal = terminalInstances.at(-1);
    const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];

    keyHandler?.({
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });

    const file = new File(["file"], "pasted.txt", { type: "text/plain" });
    const nativePaste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(nativePaste, "clipboardData", {
      value: {
        items: {
          length: 1,
          0: { kind: "file", getAsFile: () => file },
        },
        getData: vi.fn(() => ""),
      },
    });
    const xterm = document.querySelector(".xterm");
    xterm?.dispatchEvent(nativePaste);

    expect(nativePaste.defaultPrevented).toBe(true);
    expect(mockPasteNativeClipboardEventToTerminal).not.toHaveBeenCalled();
    const pasteOptions = mockPasteClipboardApiToTerminal.mock.calls.at(-1)?.[2];
    pasteOptions?.onPasteOutcome?.({ kind: "empty" });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/workspaces/test-ws/terminal/paste-assets",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      );
      expect(mockSend).toHaveBeenCalledWith("/tmp/hive-terminal-paste/pasted.txt");
    });
    unmount();
  });

  it.each([
    false,
    true,
  ])("reports empty clipboard after pending keyboard paste (native event: %s)", async (nativeEvent) => {
    const onClipboardStatus = vi.fn();
    mockPasteClipboardApiToTerminal.mockImplementation((_term, _send, options) => {
      options.onStatus({ action: "paste", outcome: "reading", method: "clipboard-api" });
      return false;
    });
    const { unmount } = await renderTerminal({ onClipboardStatus });
    const timer = vi.spyOn(window, "setTimeout");
    const keyHandler = terminalInstances.at(-1)?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0];
    act(() =>
      keyHandler?.({ type: "keydown", key: "v", ctrlKey: true, metaKey: false, altKey: false }),
    );
    expect(onClipboardStatus).toHaveBeenCalledWith({
      action: "paste",
      outcome: "reading",
      method: "clipboard-api",
    });
    const options = mockPasteClipboardApiToTerminal.mock.calls.at(-1)?.[2];
    act(() => options?.onPasteOutcome?.({ kind: "empty" }));

    if (nativeEvent) {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { items: [], getData: () => "" } });
      act(() => document.querySelector(".xterm")?.dispatchEvent(event));
    } else {
      const finishAttempt = timer.mock.calls.find(([, delay]) => delay === 750)?.[0];
      expect(finishAttempt).toBeTypeOf("function");
      act(() => (finishAttempt as () => void)());
    }
    expect(onClipboardStatus).toHaveBeenLastCalledWith({
      action: "paste",
      outcome: "empty",
      method: "clipboard-api",
    });
    expect(mockSend).not.toHaveBeenCalled();
    unmount();
  });

  it.each(
    [
      { modifiers: { ctrl: true, alt: false, shift: false }, input: "c", output: "\x03" },
      { modifiers: { ctrl: false, alt: true, shift: false }, input: "x", output: "\x1bx" },
      { modifiers: { ctrl: false, alt: false, shift: true }, input: "1", output: "!" },
      { modifiers: { ctrl: true, alt: false, shift: false }, input: "\r", output: "\x1b[13;5u" },
    ].flatMap((entry) => [true, false].map((mobileInputMode) => ({ ...entry, mobileInputMode }))),
  )("applies helper modifiers to xterm input $input (mobile=$mobileInputMode)", async ({
    modifiers,
    input,
    output,
    mobileInputMode,
  }) => {
    const { unmount } = await renderTerminal({ mobileInputMode });
    const terminal = terminalInstances.at(-1)!;
    setMobileModifiers(terminal, modifiers);
    act(() => {
      terminal.dataHandler?.(input);
    });
    expect(mockSend).toHaveBeenLastCalledWith(output);
    expect(getMobileModifiers(terminal)).toEqual({ ctrl: false, alt: false, shift: false });
    act(() => {
      terminal.dataHandler?.("a");
    });
    expect(mockSend).toHaveBeenLastCalledWith("a");
    unmount();
  });

  it("focuses xterm through the mobile input adapter after native terminal surface taps", async () => {
    const onUserFocusRequest = vi.fn();
    const { container, unmount } = await renderTerminal({
      mobileInputMode: true,
      onUserFocusRequest,
    });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();
    expect(terminal?.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);

    terminal?.focus.mockClear();
    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
    expect(inputTarget).toBeTruthy();

    const pointerDownAllowed = fireEvent.pointerDown(inputTarget as Element, {
      clientX: 80,
      clientY: 240,
      pointerId: 1,
      pointerType: "touch",
      cancelable: true,
    });
    const touchStart = fireTouchEvent(inputTarget as Element, "touchstart", [
      touchPoint(1, 80, 240),
    ]);
    fireEvent.pointerUp(inputTarget as Element, {
      clientX: 82,
      clientY: 242,
      pointerId: 1,
      pointerType: "touch",
    });
    fireTouchEvent(inputTarget as Element, "touchend", [], [touchPoint(1, 82, 242)]);

    expect(pointerDownAllowed).toBe(true);
    expect(touchStart.defaultPrevented).toBe(false);
    expect(terminal?.focus).toHaveBeenCalledTimes(1);
    expect(onUserFocusRequest).toHaveBeenCalledTimes(1);

    fireEvent.click(inputTarget as Element);
    expect(terminal?.focus).toHaveBeenCalledTimes(1);

    act(() => {
      terminal?.dataHandler?.("echo mobile\r");
    });
    expect(mockSend).toHaveBeenCalledWith("echo mobile\r");
    unmount();
  });

  it.each([
    450, 500,
  ])("uses the shared long-press boundary for tap focus (%sms)", async (duration) => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1)!;
    const host = container.querySelector('[data-testid="terminal-fit-host"]')!;
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      terminal.focus.mockClear();
      fireTouchEvent(host, "touchstart", [touchPoint(1, 80, 240)]);
      now.mockReturnValue(1000 + duration);
      fireTouchEvent(host, "touchend", [], [touchPoint(1, 80, 240)]);
      expect(terminal.focus).toHaveBeenCalledTimes(duration < 500 ? 1 : 0);
    } finally {
      now.mockRestore();
      unmount();
    }
  });

  it.each(["touchcancel", "hold", "link"])("does not focus after %s gestures", async (gesture) => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1)!;
    const host = container.querySelector('[data-testid="terminal-fit-host"]')!;
    const target = document.createElement("span");
    host.append(target);
    terminal.focus.mockClear();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    fireTouchEvent(target, "touchstart", [touchPoint(1, 80, 240)]);
    if (gesture === "hold") now.mockReturnValue(1500);
    if (gesture === "link")
      target.addEventListener("touchend", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      });
    fireTouchEvent(
      target,
      gesture === "touchcancel" ? "touchcancel" : "touchend",
      [],
      [touchPoint(1, 80, 240)],
    );
    fireEvent.click(target);
    expect(terminal.focus).not.toHaveBeenCalled();
    now.mockRestore();
    unmount();
  });

  it("uses tmux for held mobile selection without wheel scrolling or keyboard focus", async () => {
    mockUseTerminalWebSocket.mockReturnValue({
      send: mockSend,
      resize: mockResize,
      connectionState: "connected",
    });
    const onUserFocusRequest = vi.fn();
    const { container, unmount } = await renderTerminal({
      mobileInputMode: true,
      onUserFocusRequest,
    });
    const terminal = terminalInstances.at(-1)!;
    terminal.modes.mouseTrackingMode = "drag";
    terminal.focus.mockClear();
    const host = container.querySelector('[data-testid="terminal-fit-host"]')!;
    const screen = container.querySelector(".xterm-screen")!;
    const events: string[] = [];
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 480,
      width: 800,
      height: 480,
    } as DOMRect);
    for (const type of ["mousedown", "mousemove", "mouseup", "wheel"])
      screen.addEventListener(type, () => events.push(type));
    expect(host).toHaveAttribute("data-terminal-touch-selection", "true");
    expect(host).not.toHaveAttribute("data-terminal-native-selection");
    fireTouchEvent(screen, "touchstart", [touchPoint(1, 80, 240)]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(host).toHaveAttribute("data-terminal-touch-selecting", "true");
    expect(fireTouchEvent(screen, "touchmove", [touchPoint(1, 160, 240)]).defaultPrevented).toBe(
      true,
    );
    expect(fireTouchEvent(screen, "touchend", [], [touchPoint(1, 160, 240)]).defaultPrevented).toBe(
      true,
    );
    fireEvent.click(screen);
    expect(events).toEqual(["mousedown", "mousemove", "mouseup"]);
    expect(onUserFocusRequest).toHaveBeenCalledOnce();
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(host).not.toHaveAttribute("data-terminal-touch-selecting");
    // The next short tap can still request the keyboard.
    fireTouchEvent(screen, "touchstart", [touchPoint(1, 80, 240)]);
    fireTouchEvent(screen, "touchend", [], [touchPoint(1, 80, 240)]);
    expect(terminal.focus).toHaveBeenCalledOnce();
    unmount();
  });

  it("blocks touch compatibility presses while allowing physical mouse selection", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const host = container.querySelector('[data-testid="terminal-fit-host"]')!;
    const target = document.createElement("span");
    host.append(target);
    const descendantPress = vi.fn();
    target.addEventListener("mousedown", descendantPress);
    expect(fireEvent.mouseDown(target)).toBe(true);
    expect(descendantPress).toHaveBeenCalledTimes(1);

    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    fireTouchEvent(target, "touchstart", [touchPoint(1, 80, 240)]);
    now.mockReturnValue(5000); // A held touch also produces compatibility mouse events.
    fireTouchEvent(target, "touchend", [], [touchPoint(1, 80, 240)]);
    expect(fireEvent.mouseDown(target)).toBe(true);
    expect(descendantPress).toHaveBeenCalledTimes(1);

    const mouse = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    Object.defineProperty(mouse, "sourceCapabilities", { value: { firesTouchEvents: false } });
    expect(fireEvent(target, mouse)).toBe(true);
    expect(descendantPress).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(target, { pointerType: "mouse" });
    expect(fireEvent.mouseDown(target)).toBe(true);
    expect(descendantPress).toHaveBeenCalledTimes(3);

    const compatibility = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    Object.defineProperty(compatibility, "sourceCapabilities", {
      value: { firesTouchEvents: true },
    });
    expect(fireEvent(target, compatibility)).toBe(true);
    expect(descendantPress).toHaveBeenCalledTimes(3);

    fireTouchEvent(target, "touchstart", [touchPoint(1, 80, 240)]);
    fireTouchEvent(target, "touchend", [], [touchPoint(1, 80, 240)]);
    now.mockReturnValue(6100);
    expect(fireEvent.mouseDown(target)).toBe(true);
    expect(descendantPress).toHaveBeenCalledTimes(4);
    now.mockRestore();
    unmount();
  });

  it.each([
    false,
    true,
  ])("scopes mobile selection gesture ownership to this pane (local=%s)", async (local) => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1)!;
    const host = container.querySelector('[data-testid="terminal-fit-host"]')!;
    const screen = container.querySelector(".xterm-screen")!;
    const text = document.createElement("span");
    text.textContent = "selected text";
    (local ? host : document.body).append(text);
    window.getSelection()!.selectAllChildren(text);
    terminal.modes.mouseTrackingMode = "any";
    const wheel = vi.fn();
    screen.addEventListener("wheel", wheel);
    fireTouchEvent(host, "touchstart", [touchPoint(1, 80, 320)]);
    fireTouchEvent(host, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(host, "touchend", [], [touchPoint(1, 80, 240)]);
    expect(wheel).toHaveBeenCalledTimes(local ? 0 : 1);
    terminal.focus.mockClear();
    fireTouchEvent(host, "touchstart", [touchPoint(1, 80, 240)]);
    fireTouchEvent(host, "touchend", [], [touchPoint(1, 80, 240)]);
    expect(terminal.focus).toHaveBeenCalledTimes(local ? 0 : 1);
    window.getSelection()!.removeAllRanges();
    text.remove();
    unmount();
  });

  it.each([
    false,
    true,
  ])("activates native selection only in an interactive workspace (inert=%s)", async (inert) => {
    const activateFirst = vi.fn();
    const activateSecond = vi.fn();
    const first = await renderTerminal({
      mobileInputMode: true,
      onUserFocusRequest: activateFirst,
    });
    const firstTerminal = terminalInstances.at(-1)!;
    const second = await renderTerminal({
      mobileInputMode: true,
      onUserFocusRequest: activateSecond,
    });
    const secondTerminal = terminalInstances.at(-1)!;
    firstTerminal.focus.mockClear();
    secondTerminal.focus.mockClear();
    activateFirst.mockClear();
    activateSecond.mockClear();
    const text = document.createElement("span");
    text.textContent = "selection in inactive pane";
    second.container.querySelector('[data-testid="terminal-fit-host"]')!.append(text);
    window.getSelection()!.selectAllChildren(text);
    // A browser selection event can arrive after switching away from its board.
    if (inert) second.container.setAttribute("inert", "");
    fireEvent(document, new Event("selectionchange"));
    expect(activateFirst).not.toHaveBeenCalled();
    expect(activateSecond).toHaveBeenCalledTimes(inert ? 0 : 1);
    expect(firstTerminal.focus).not.toHaveBeenCalled();
    expect(secondTerminal.focus).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
    first.unmount();
    second.unmount();
  });

  it("does not refocus a terminal after a multi-touch sequence", async () => {
    const onUserFocusRequest = vi.fn();
    const { container, unmount } = await renderTerminal({
      mobileInputMode: true,
      onUserFocusRequest,
    });
    const terminal = terminalInstances.at(-1);
    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
    expect(terminal).toBeDefined();
    if (!inputTarget) throw new Error("Terminal input surface is missing.");

    terminal?.focus.mockClear();
    fireTouchEvent(inputTarget, "touchstart", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget, "touchmove", [touchPoint(1, 82, 242), touchPoint(2, 120, 242)]);
    fireTouchEvent(inputTarget, "touchend", [], [touchPoint(1, 82, 242), touchPoint(2, 120, 242)]);
    fireEvent.click(inputTarget);

    expect(terminal?.focus).not.toHaveBeenCalled();
    expect(onUserFocusRequest).not.toHaveBeenCalled();
    unmount();
  });

  it("does not resume one-finger terminal scrolling after a multi-touch sequence", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
    const screen = container.querySelector(".xterm-screen");
    expect(terminal).toBeDefined();
    if (!inputTarget || !screen || !terminal) throw new Error("Terminal touch surface is missing.");

    terminal.modes.mouseTrackingMode = "any";
    let wheelEventCount = 0;
    screen.addEventListener("wheel", () => {
      wheelEventCount += 1;
    });

    fireTouchEvent(inputTarget, "touchstart", [touchPoint(1, 80, 320)]);
    fireTouchEvent(inputTarget, "touchmove", [touchPoint(1, 80, 300), touchPoint(2, 120, 300)]);
    const remainingFingerMove = fireTouchEvent(inputTarget, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget, "touchend", [], [touchPoint(1, 80, 240)]);

    expect(remainingFingerMove.defaultPrevented).toBe(false);
    expect(wheelEventCount).toBe(0);
    unmount();
  });

  it.each([
    -1, 1,
  ])("does not send diagonal drawer swipes to the remote TUI (direction=%s)", async (direction) => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1)!;
    terminal.modes.mouseTrackingMode = "any";
    terminal.focus.mockClear();
    const host = container.querySelector('[data-testid="terminal-fit-host"]')!;
    const screen = container.querySelector(".xterm-screen")!;
    const wheel = vi.fn();
    screen.addEventListener("wheel", wheel);
    fireTouchEvent(host, "touchstart", [touchPoint(1, 200, 200)]);
    fireTouchEvent(host, "touchmove", [touchPoint(1, 200 + direction * 80, 220)]);
    fireTouchEvent(host, "touchmove", [touchPoint(1, 200 + direction * 80, 300)]);
    fireTouchEvent(host, "touchend", [], [touchPoint(1, 200 + direction * 80, 300)]);
    expect(wheel).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
    unmount();
  });

  it("does not use browser scrollback for mobile terminal touch drags", async () => {
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();

    terminal?.focus.mockClear();
    terminal?.scrollLines.mockClear();
    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
    expect(inputTarget).toBeTruthy();

    fireTouchEvent(inputTarget as Element, "touchstart", [touchPoint(1, 80, 320)]);
    const touchMove = fireTouchEvent(inputTarget as Element, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget as Element, "touchend", [], [touchPoint(1, 80, 240)]);
    fireEvent.click(inputTarget as Element);

    expect(touchMove.defaultPrevented).toBe(true);
    expect(terminal?.scrollLines).not.toHaveBeenCalled();
    expect(terminal?.focus).not.toHaveBeenCalled();
    unmount();
  });

  it.each([
    0, 600,
  ])("forwards mobile touch drags to tmux after a %sms hold without selection", async (hold) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { container, unmount } = await renderTerminal({ mobileInputMode: true });
    const terminal = terminalInstances.at(-1);
    expect(terminal).toBeDefined();

    if (terminal) {
      terminal.modes.mouseTrackingMode = "any";
    }
    terminal?.scrollLines.mockClear();
    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
    const screen = container.querySelector(".xterm-screen");
    expect(inputTarget).toBeTruthy();
    expect(screen).toBeTruthy();

    const wheelEvents: WheelEvent[] = [];
    screen?.addEventListener("wheel", (event) => {
      wheelEvents.push(event as WheelEvent);
    });

    fireTouchEvent(inputTarget as Element, "touchstart", [touchPoint(1, 80, 320)]);
    now.mockReturnValue(1000 + hold);
    const touchMove = fireTouchEvent(inputTarget as Element, "touchmove", [touchPoint(1, 80, 240)]);
    fireTouchEvent(inputTarget as Element, "touchend", [], [touchPoint(1, 80, 240)]);

    expect(touchMove.defaultPrevented).toBe(true);
    expect(terminal?.scrollLines).not.toHaveBeenCalled();
    expect(wheelEvents).toHaveLength(1);
    expect(wheelEvents[0]?.deltaY).toBe(80);
    expect(wheelEvents[0]?.clientX).toBe(80);
    expect(wheelEvents[0]?.clientY).toBe(240);
    now.mockRestore();
    unmount();
  });

  it.each(
    [true, false].flatMap((selectionModeEnabled) =>
      [true, false].map((sourceCapabilities) => ({ selectionModeEnabled, sourceCapabilities })),
    ),
  )("preserves native fallback context menus without xterm interference (native=$selectionModeEnabled, capabilities=$sourceCapabilities)", async ({
    selectionModeEnabled,
    sourceCapabilities,
  }) => {
    const { container, unmount } = await renderTerminal({
      mobileInputMode: true,
      selectionModeEnabled,
    });
    const screen = container.querySelector(".xterm-screen")!;
    const xtermContext = vi.fn((event: Event) => event.preventDefault());
    screen.addEventListener("contextmenu", xtermContext);
    // Native fallback's React capture handler stops touchstart before the
    // compatibility-event tracker. Safari also omits sourceCapabilities.
    fireTouchEvent(screen, "touchstart", [touchPoint(1, 80, 240)]);
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    if (sourceCapabilities)
      Object.defineProperty(context, "sourceCapabilities", { value: { firesTouchEvents: true } });
    screen.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(!selectionModeEnabled);
    expect(xtermContext).not.toHaveBeenCalled();
    unmount();
  });

  it("keeps selection mode passive so native text selection wins over keyboard, scroll, and sidebar gestures", async () => {
    const { container, rerender, unmount } = await renderTerminal({ mobileInputMode: true });
    expect(container.querySelector('[data-testid="terminal-fit-host"]')).not.toHaveAttribute(
      "data-launcher-gesture-ignore",
    );
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

    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
    expect(inputTarget).toHaveAttribute("data-launcher-gesture-ignore", "true");
    expect(inputTarget).toHaveAttribute("data-terminal-selection-mode", "true");
    expect(inputTarget).toHaveAttribute("data-terminal-native-selection", "true");
    expect(inputTarget).not.toHaveAttribute("data-terminal-touch-selection");
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
    const inputTarget = container.querySelector('[data-testid="terminal-fit-host"]');
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

describe("InteractiveTerminal integration — Session font size", () => {
  it("refits only the matching terminal and restores its size after remount", async () => {
    const firstView = await renderTerminal({ sessionName: "main" });
    const first = terminalInstances.at(-1)!;
    await renderTerminal({ sessionName: "other" });
    const other = terminalInstances.at(-1)!;
    const { InteractiveTerminal } = await import("@/components/workspaces/InteractiveTerminal");
    render(
      <InteractiveTerminal
        agentId="other-agent"
        workspaceId="other-workspace"
        sessionName="main"
      />,
    );
    await flushTerminalEffects();
    const otherWorkspace = terminalInstances.at(-1)!;
    const previousOtherSize = other.options.fontSize;
    const previousOtherWorkspaceSize = otherWorkspace.options.fontSize;
    mockFit.mockClear();
    act(() => setTerminalFontSize(20, terminalFontSizeScope("test-ws", "main")));
    expect(first.options.fontSize).toBe(20);
    expect(other.options.fontSize).toBe(previousOtherSize);
    expect(otherWorkspace.options.fontSize).toBe(previousOtherWorkspaceSize);
    expect(mockFit).toHaveBeenCalledTimes(1);
    firstView.unmount();
    await renderTerminal({ sessionName: "main" });
    expect(terminalInstances.at(-1)!.constructorOptions.fontSize).toBe(20);
  });
});
