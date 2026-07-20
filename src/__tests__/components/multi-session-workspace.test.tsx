// @vitest-environment jsdom

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import type React from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { KeepAliveStatus } from "@/hooks/useKeepAliveStatus";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";
import { TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";

const mockCreateSession = vi.fn();
const mockGetSessions = vi.fn();
const mockGetWorkspaceSessionTools = vi.fn();
const mockKillSession = vi.fn();
const mockListGitClones = vi.fn();
const mockResolveGitCloneTerminal = vi.fn();
const mockCloseGitCloneTerminal = vi.fn();
const mockListNavigationFavorites = vi.fn();
const mockSetActiveTerminal = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();
const mockRouterPush = vi.fn();
const mockToastInfo = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockUseIsComposeSheet = vi.hoisted(() => vi.fn(() => false));
const mockCopyTerminalSelection = vi.hoisted(() => vi.fn());
const mockPasteClipboardApiToTerminal = vi.hoisted(() => vi.fn());
const mockTriggerHapticFeedback = vi.hoisted(() => vi.fn());
const mockReadPendingWorkspaceToolIntent = vi.hoisted(() => vi.fn());
const mockClearPendingWorkspaceToolIntent = vi.hoisted(() => vi.fn());
const mockReloadForWorkspaceTool = vi.hoisted(() => vi.fn());
let emitConnectionStateOnCallbackChange = false;
const mockUseKeepAliveStatus = vi.hoisted(() =>
  vi.fn(
    (_workspaceId: string): KeepAliveStatus => ({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      lastFailureReason: null,
      lastFailureDetail: null,
      lastHttpStatus: null,
      lastHttpStatusText: null,
      lastAttemptDurationMs: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    }),
  ),
);
type StubConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "failed"
  | "workspace-offline";
type StubRecoveryState = {
  phase?: string;
  retryCount?: number;
  lastCloseCategory?: string | null;
  lastReasonCategory?: string | null;
  failureCategory?: string | null;
  lastRecoveryAction?: string;
  lastRefreshAction?: string;
  refreshFailureCategory?: string | null;
  isRecoverable?: boolean;
};
const terminalProps = new Map<
  string,
  {
    agentId: string;
    workspaceId: string;
    sessionName: string;
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
    className?: string;
    layoutSignal?: unknown;
    onConnectionStateChange?: (state: StubConnectionState) => void;
    onRecoveryStateChange?: (state: StubRecoveryState) => void;
    onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
    onTerminalDestroy?: () => void;
    onUserFocusRequest?: () => void;
    onComposeRequest?: (request: { draft: string; append?: boolean; targetLabel?: string }) => void;
    onClipboardStatus?: (status: {
      action: "paste";
      outcome: "uploading" | "pasted" | "empty" | "failed";
      method?: "clipboard-api";
      reason?: string;
      message?: string;
    }) => void;
    mobileInputMode?: boolean;
    suppressAutoFocus?: boolean;
    pinToBottomOnResize?: boolean;
    selectionModeEnabled?: boolean;
  }
>();
const terminalDestroyCounts = new Map<string, number>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    info: mockToastInfo,
  },
}));

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<{ InteractiveTerminal: React.ComponentType<any> }>) => {
    void loader;
    const Stub = ({
      agentId,
      workspaceId,
      sessionName,
      clonePath,
      cloneProof,
      refreshCloneTerminalIdentity,
      className,
      layoutSignal,
      onConnectionStateChange,
      onRecoveryStateChange,
      onTerminalReady,
      onUserFocusRequest,
      onComposeRequest,
      onClipboardStatus,
      mobileInputMode,
      suppressAutoFocus,
      pinToBottomOnResize,
      selectionModeEnabled,
    }: {
      agentId: string;
      workspaceId: string;
      sessionName: string;
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
      className?: string;
      layoutSignal?: unknown;
      onConnectionStateChange?: (state: StubConnectionState) => void;
      onRecoveryStateChange?: (state: StubRecoveryState) => void;
      onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
      onTerminalDestroy?: () => void;
      onUserFocusRequest?: () => void;
      onComposeRequest?: (request: {
        draft: string;
        append?: boolean;
        targetLabel?: string;
      }) => void;
      onClipboardStatus?: (status: {
        action: "paste";
        outcome: "uploading" | "pasted" | "empty" | "failed";
        method?: "clipboard-api";
        reason?: string;
        message?: string;
      }) => void;
      mobileInputMode?: boolean;
      suppressAutoFocus?: boolean;
      pinToBottomOnResize?: boolean;
      selectionModeEnabled?: boolean;
    }) => {
      useEffect(
        () => () => {
          terminalDestroyCounts.set(sessionName, (terminalDestroyCounts.get(sessionName) ?? 0) + 1);
        },
        [sessionName],
      );

      useEffect(() => {
        if (!emitConnectionStateOnCallbackChange) return;
        onConnectionStateChange?.("connected");
      }, [onConnectionStateChange]);

      terminalProps.set(sessionName, {
        agentId,
        workspaceId,
        sessionName,
        clonePath,
        cloneProof,
        refreshCloneTerminalIdentity,
        className,
        layoutSignal,
        onConnectionStateChange,
        onRecoveryStateChange,
        onTerminalReady,
        onUserFocusRequest,
        onComposeRequest,
        onClipboardStatus,
        mobileInputMode,
        suppressAutoFocus,
        pinToBottomOnResize,
        selectionModeEnabled,
      });
      return (
        <div
          data-testid={`interactive-terminal-${sessionName}`}
          data-agent-id={agentId}
          data-workspace-id={workspaceId}
          data-session-name={sessionName}
          data-terminal-surface="true"
          className={className}
          data-clone-path={clonePath}
          data-clone-proof={cloneProof}
          data-layout-signal={String(layoutSignal ?? "")}
          data-mobile-input-mode={mobileInputMode ? "true" : "false"}
          data-suppress-auto-focus={suppressAutoFocus ? "true" : "false"}
          data-pin-to-bottom-on-resize={pinToBottomOnResize ? "true" : "false"}
          data-selection-mode-enabled={selectionModeEnabled ? "true" : "false"}
          onClick={onUserFocusRequest}
        >
          Terminal: {sessionName}
          <textarea
            aria-label={`Terminal input ${sessionName}`}
            className="xterm-helper-textarea"
            data-testid={`terminal-input-${sessionName}`}
          />
        </div>
      );
    };
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("@/lib/actions/git-clones", () => ({
  closeGitCloneTerminalAction: (...args: unknown[]) => mockCloseGitCloneTerminal(...args),
  listGitClonesAction: (...args: unknown[]) => mockListGitClones(...args),
  resolveGitCloneTerminalAction: (...args: unknown[]) => mockResolveGitCloneTerminal(...args),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetSessions(...args),
  getWorkspaceSessionToolsAction: (...args: unknown[]) => mockGetWorkspaceSessionTools(...args),
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
}));

vi.mock("@/lib/workspaces/tool-reload", () => ({
  readPendingWorkspaceToolIntent: mockReadPendingWorkspaceToolIntent,
  clearPendingWorkspaceToolIntent: mockClearPendingWorkspaceToolIntent,
  reloadForWorkspaceTool: mockReloadForWorkspaceTool,
}));

vi.mock("@/lib/actions/navigation-favorites", () => ({
  listNavigationFavoritesAction: (...args: unknown[]) => mockListNavigationFavorites(...args),
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: (): Partial<KeybindingContextValue> => ({
    register: mockRegister,
    setActiveTerminal: mockSetActiveTerminal,
    unregister: mockUnregister,
  }),
}));

vi.mock("@/hooks/useKeepAliveStatus", () => ({
  useKeepAliveStatus: (workspaceId: string) => mockUseKeepAliveStatus(workspaceId),
}));

vi.mock("@/hooks/use-compose-sheet", () => ({
  useIsComposeSheet: () => mockUseIsComposeSheet(),
}));

vi.mock("@/lib/device/haptics", () => ({
  triggerHapticFeedback: () => mockTriggerHapticFeedback(),
}));

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: (...args: unknown[]) => mockCopyTerminalSelection(...args),
  pasteClipboardApiToTerminal: (...args: unknown[]) => mockPasteClipboardApiToTerminal(...args),
  pasteToTerminal: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
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
      sessions: Array<{ id?: string; name: string }>;
      current: { id?: string; name: string } | null;
      previous: { id?: string; name: string } | null;
      next: { id?: string; name: string } | null;
      select?: (id: string) => boolean;
      onOpenSwitcher?: () => void;
    };
  }) => (
    <div
      data-copy-disabled-reason={copyDisabledReason ?? ""}
      data-current-session={windowNavigation?.current?.name ?? ""}
      data-has-selection={hasSelection ? "true" : "false"}
      data-is-keyboard-visible={isKeyboardVisible ? "true" : "false"}
      data-next-session={windowNavigation?.next?.name ?? ""}
      data-paste-disabled-reason={pasteDisabledReason ?? ""}
      data-previous-session={windowNavigation?.previous?.name ?? ""}
      data-selection-disabled-reason={selectionModeDisabledReason ?? ""}
      data-selection-mode-enabled={selectionModeEnabled ? "true" : "false"}
      data-session-count={String(windowNavigation?.sessions.length ?? 0)}
      data-testid="terminal-mobile-controls"
    >
      <p data-testid="terminal-clipboard-status">{clipboardStatusText}</p>
      <button type="button" data-testid="terminal-copy-selection" onClick={onCopy}>
        Copy
      </button>
      <button type="button" data-testid="terminal-paste-clipboard" onClick={onPaste}>
        Paste
      </button>
      <button
        type="button"
        data-testid="terminal-selection-toggle"
        onClick={() => onToggleSelectionMode?.(!selectionModeEnabled)}
      >
        Selection
      </button>
      <button
        type="button"
        data-testid="terminal-window-next"
        onClick={() => {
          const next = windowNavigation?.next;
          if (next) windowNavigation?.select?.(next.id ?? next.name);
        }}
      >
        Next
      </button>
      <button
        type="button"
        data-testid="terminal-window-switcher"
        onClick={windowNavigation?.onOpenSwitcher}
      >
        Switch
      </button>
    </div>
  ),
}));

vi.mock("@/components/terminal/CommandPalette", () => ({
  CommandPalette: ({
    open,
    onOpenChange,
    actions = [],
    searchValue = "",
    onSearchValueChange,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    actions?: Array<{
      id: string;
      label: string;
      description?: string;
      rightLabel?: string;
      disabled?: boolean;
      onSelect: () => void;
      options?: {
        id: string;
        label: string;
        disabled?: boolean;
        onSelect: () => void;
      }[];
    }>;
    searchValue?: string;
    onSearchValueChange?: (value: string) => void;
  }) =>
    open ? (
      <div data-testid="multi-session-command-palette">
        <input
          data-testid="workspace-command-palette-search"
          value={searchValue}
          onChange={(event) => onSearchValueChange?.(event.currentTarget.value)}
        />
        {actions.map((action) => (
          <div key={action.id}>
            <button
              type="button"
              data-testid={`palette-action-${action.id}`}
              disabled={action.disabled}
              onClick={() => {
                if (action.disabled) return;
                action.onSelect();
                onOpenChange?.(false);
              }}
            >
              <span>{action.label}</span>
              {action.description ? <span>{action.description}</span> : null}
              {action.rightLabel ? <span>{action.rightLabel}</span> : null}
            </button>
            {action.options?.map((option) => (
              <button
                key={option.id}
                type="button"
                data-testid={`palette-option-${action.id}-${option.id}`}
                disabled={action.disabled ?? option.disabled}
                onClick={() => {
                  option.onSelect();
                  onOpenChange?.(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    ) : null,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="workspace-sidebar-trigger">
      Toggle sidebar
    </button>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant,
    size,
    ...props
  }: React.PropsWithChildren<
    React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }
  >) => (
    <button type={props.type ?? "button"} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    variant,
    ...rest
  }: React.PropsWithChildren<{ variant?: string; "data-testid"?: string }>) => (
    <div data-testid={rest["data-testid"] ?? "alert"} data-variant={variant}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  AlertTitle: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({
    children,
    className,
    ...rest
  }: React.PropsWithChildren<{ className?: string; "data-testid"?: string }>) => (
    <div className={className} data-testid={rest["data-testid"]}>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
    onOpenChange,
  }: React.PropsWithChildren<{
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>) => (
    <div data-testid="compose-sheet" data-open={open ? "true" : "false"}>
      {open ? children : null}
      <button
        type="button"
        data-testid="compose-sheet-close-proxy"
        onClick={() => onOpenChange?.(false)}
      >
        Close sheet
      </button>
    </div>
  ),
  SheetContent: ({
    children,
    className,
    side,
    style,
  }: React.PropsWithChildren<{
    className?: string;
    side?: string;
    style?: React.CSSProperties;
  }>) => (
    <section
      className={className}
      data-testid="compose-sheet-content"
      data-side={side}
      style={style}
    >
      {children}
    </section>
  ),
  SheetTitle: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <h2 className={className}>{children}</h2>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Code2: () => <span data-testid="icon-code" />,
  ClipboardPaste: () => <span data-testid="icon-paste" />,
  Copy: () => <span data-testid="icon-copy" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
  FolderOpen: () => <span data-testid="icon-folder" />,
  GripVertical: () => <span data-testid="icon-grip" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Lock: () => <span data-testid="icon-lock" />,
  Minus: () => <span data-testid="icon-minus" />,
  Plus: () => <span data-testid="icon-plus" />,
  Search: () => <span data-testid="icon-search" />,
  Send: () => <span data-testid="icon-send" />,
  TerminalSquare: () => <span data-testid="icon-terminal-square" />,
  X: () => <span data-testid="icon-x" />,
}));

import { MultiSessionWorkspace } from "@/components/workspaces/MultiSessionWorkspace";

const defaultProps = {
  agentId: "agent-1",
  workspaceId: "ws-1",
};

function makeTerminal(name: string, focus?: () => void): Terminal {
  return {
    name,
    focus: vi.fn(focus),
    getSelection: vi.fn(() => `${name}-selection`),
    clearSelection: vi.fn(),
  } as unknown as Terminal;
}

function makeSender(name: string) {
  return vi.fn((data: string) => `${name}:${data}`);
}

function twoSessionPayload() {
  return {
    data: [
      { name: "main-session", created: 1, windows: 1 },
      { name: "dev-server", created: 2, windows: 1 },
    ],
  };
}

function markSessionConnected(sessionName: string) {
  act(() => {
    terminalProps.get(sessionName)?.onConnectionStateChange?.("connected");
    terminalProps.get(sessionName)?.onRecoveryStateChange?.({
      phase: "connected",
      lastRecoveryAction: "connected",
      isRecoverable: true,
    });
  });
}

function markTwoSessionsConnected() {
  markSessionConnected("main-session");
  markSessionConnected("dev-server");
}

async function renderTwoSessionWorkspace(options: { connect?: boolean } = {}) {
  mockGetSessions.mockResolvedValue(twoSessionPayload());
  render(<MultiSessionWorkspace {...defaultProps} />);

  await waitFor(() => {
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
  });

  if (options.connect !== false) {
    markTwoSessionsConnected();
    await waitFor(() => {
      expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    });
  }
}

function lastRegisteredEntry(id: string) {
  return mockRegister.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.id === id)
    .at(-1);
}

function setPwaStandalone(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("MultiSessionWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitConnectionStateOnCallbackChange = false;
    terminalProps.clear();
    terminalDestroyCounts.clear();
    window.localStorage.clear();
    setPwaStandalone(false);
    mockGetSessions.mockResolvedValue({ data: [] });
    mockGetWorkspaceSessionTools.mockResolvedValue({
      data: {
        codeUrl: "https://code.test/?folder=%2Fhome%2Fcoder",
        filesUrl: "https://filebrowser.test/files/home/coder",
        folderPath: "/home/coder",
      },
    });
    mockReadPendingWorkspaceToolIntent.mockReturnValue(null);
    mockUseIsComposeSheet.mockReturnValue(false);
    mockCopyTerminalSelection.mockReset();
    mockPasteClipboardApiToTerminal.mockReset();
    mockTriggerHapticFeedback.mockReset();
    mockKillSession.mockResolvedValue({ data: { name: "main-session" } });
    mockCloseGitCloneTerminal.mockResolvedValue({ data: { sessionName: "git-clone-safe-hive" } });
    mockListNavigationFavorites.mockResolvedValue({ data: [] });
    mockUseKeepAliveStatus.mockReturnValue({
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      lastFailureReason: null,
      lastFailureDetail: null,
      lastHttpStatus: null,
      lastHttpStatusText: null,
      lastAttemptDurationMs: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    });
    mockRouterPush.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("adds File Browser and VS Code as tiled workspace panes instead of dialogs", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderTwoSessionWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Browse files for main-session" }));
    const filesPane = await screen.findByTestId("workspace-tool-pane-files");
    expect(filesPane).toBeInTheDocument();
    expect(screen.getByTestId("workspace-tool-frame-files")).toHaveAttribute(
      "src",
      "https://filebrowser.test/files/home/coder",
    );
    expect(screen.getByTestId("workspace-tool-frame-files").getAttribute("sandbox")).toContain(
      "allow-same-origin",
    );
    expect(screen.getByTestId("pop-out-workspace-tool-files")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-main-session")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-tool-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open VS Code for main-session" }));
    expect(await screen.findByTestId("workspace-tool-pane-code")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-tool-frame-code")).toHaveAttribute(
      "src",
      "https://code.test/?folder=%2Fhome%2Fcoder",
    );
    expect(screen.getByTestId("workspace-tool-frame-code").getAttribute("sandbox")).toContain(
      "allow-same-origin",
    );
    expect(screen.getByTestId("workspace-tool-pane-code")).toHaveAttribute("data-active", "true");
    expect(document.querySelector('[data-workspace-window-id="main-session"]')).toHaveStyle({
      left: "0%",
      top: "0%",
      width: "50%",
      height: "50%",
    });
    expect(
      document.querySelector(
        '[data-workspace-window-id="workspace-tool:default:main-session:files"]',
      ),
    ).toHaveStyle({ left: "0%", top: "50%", width: "25%", height: "50%" });
    expect(
      document.querySelector(
        '[data-workspace-window-id="workspace-tool:default:main-session:code"]',
      ),
    ).toHaveStyle({ left: "25%", top: "50%", width: "25%", height: "50%" });
    expect(window.localStorage.getItem("workspace-window-layout:workspace:ws-1")).toContain(
      '"axis":"x"',
    );
    fireEvent.click(screen.getByTestId("pop-out-workspace-tool-code"));
    expect(openSpy).toHaveBeenCalledWith(
      "https://code.test/?folder=%2Fhome%2Fcoder",
      "_blank",
      "noopener,noreferrer",
    );

    fireEvent.click(screen.getByTestId("remove-workspace-tool-files"));
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-tool-pane-code")).toBeInTheDocument();
  });

  it("restores File Browser and VS Code panes with fresh URLs after remount", async () => {
    mockGetSessions.mockResolvedValue(twoSessionPayload());
    const firstRender = render(<MultiSessionWorkspace {...defaultProps} />);
    await screen.findByTestId("workspace-pane-main-session");
    markTwoSessionsConnected();
    await waitFor(() => {
      expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Browse files for main-session" }));
    await screen.findByTestId("workspace-tool-pane-files");
    fireEvent.click(screen.getByRole("button", { name: "Open VS Code for main-session" }));
    await screen.findByTestId("workspace-tool-pane-code");

    const persisted = window.localStorage.getItem("workspace-tool-panes:workspace:ws-1");
    expect(persisted).toContain('"tool":"files"');
    expect(persisted).toContain('"tool":"code"');
    expect(persisted).not.toContain("https://code.test");
    expect(persisted).not.toContain("/api/workspace-proxy/");

    firstRender.unmount();
    mockGetWorkspaceSessionTools.mockClear();
    mockGetWorkspaceSessionTools.mockImplementation(() => ({
      data: {
        codeUrl: "https://fresh-code.test/?coder_application_connect_api_key=fresh",
        filesUrl: "https://filebrowser.test/files/home/coder/fresh",
        folderPath: "/home/coder/fresh",
        source: "tmux",
      },
    }));

    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("workspace-tool-frame-files")).toHaveAttribute(
      "src",
      "https://filebrowser.test/files/home/coder/fresh",
    );
    expect(await screen.findByTestId("workspace-tool-frame-code")).toHaveAttribute(
      "src",
      "https://fresh-code.test/?coder_application_connect_api_key=fresh",
    );
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledTimes(2);
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "main-session",
      fallbackPath: undefined,
      documentFrameHosts: [],
      tool: "files",
    });
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "main-session",
      fallbackPath: undefined,
      documentFrameHosts: [],
      tool: "code",
    });
  });

  it("restores tool panes in parallel without blocking sessions or changing explicit focus", async () => {
    const filesRequest = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string;
        source: "tmux";
      };
    }>();
    const codeRequest = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string;
        source: "tmux";
      };
    }>();
    window.localStorage.setItem(
      "workspace-tool-panes:workspace:ws-1",
      JSON.stringify({
        version: 1,
        panes: [
          {
            boardKey: "default",
            sessionName: "main-session",
            tool: "files",
            label: "main-session",
          },
          {
            boardKey: "default",
            sessionName: "main-session",
            tool: "code",
            label: "main-session",
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValue(twoSessionPayload());
    mockGetWorkspaceSessionTools.mockImplementation(({ tool }: { tool: "code" | "files" }) =>
      tool === "files" ? filesRequest.promise : codeRequest.promise,
    );

    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-tool-pane-files")).toHaveAttribute(
      "data-pane-state",
      "authorizing",
    );
    expect(screen.getByTestId("workspace-tool-pane-code")).toHaveAttribute(
      "data-pane-state",
      "authorizing",
    );
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("workspace-pane-dev-server"));
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");

    await act(async () => {
      codeRequest.resolve({
        data: {
          codeUrl: "https://fresh-code.test",
          filesUrl: "https://fresh-files.test/files/",
          folderPath: "/home/coder",
          source: "tmux",
        },
      });
      await codeRequest.promise;
    });

    expect(await screen.findByTestId("workspace-tool-frame-code")).toHaveAttribute(
      "src",
      "https://fresh-code.test",
    );
    expect(screen.getByTestId("workspace-tool-pane-code")).toHaveAttribute(
      "data-pane-state",
      "loading",
    );
    expect(screen.getByTestId("workspace-tool-pane-files")).toHaveAttribute(
      "data-pane-state",
      "authorizing",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");

    fireEvent.load(screen.getByTestId("workspace-tool-frame-code"));
    expect(screen.getByTestId("workspace-tool-pane-code")).toHaveAttribute(
      "data-pane-state",
      "ready",
    );

    await act(async () => {
      filesRequest.resolve({
        data: {
          codeUrl: "https://fresh-code.test",
          filesUrl: "https://fresh-files.test/files/",
          folderPath: "/home/coder",
          source: "tmux",
        },
      });
      await filesRequest.promise;
    });
    fireEvent.load(await screen.findByTestId("workspace-tool-frame-files"));

    expect(screen.getByTestId("workspace-tool-pane-files")).toHaveAttribute(
      "data-pane-state",
      "ready",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("does not reload for a restored tool pane closed while authorization is pending", async () => {
    const filesRequest = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string;
        reloadRequired: true;
      };
    }>();
    window.localStorage.setItem(
      "workspace-tool-panes:workspace:ws-1",
      JSON.stringify({
        version: 1,
        panes: [
          {
            boardKey: "default",
            sessionName: "main-session",
            tool: "files",
            label: "main-session",
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValue(twoSessionPayload());
    mockGetWorkspaceSessionTools.mockReturnValue(filesRequest.promise);

    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("workspace-tool-pane-files")).toHaveAttribute(
      "data-pane-state",
      "authorizing",
    );
    fireEvent.click(screen.getByTestId("remove-workspace-tool-files"));
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();

    await act(async () => {
      filesRequest.resolve({
        data: {
          codeUrl: "https://fresh-code.test",
          filesUrl: "https://fresh-files.test/files/",
          folderPath: "/home/coder",
          reloadRequired: true,
        },
      });
      await filesRequest.promise;
    });

    expect(mockReloadForWorkspaceTool).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
  });

  it("restores a repository tool pane even when its Git terminal is not on the board", async () => {
    window.localStorage.setItem(
      "workspace-tool-panes:unified:ws-1",
      JSON.stringify({
        version: 1,
        panes: [
          {
            boardKey: "default",
            sessionName: "git-clone-safe-hive",
            tool: "files",
            label: "hive",
            cloneSessionKey: "git-clone:kethalia/hive",
            relativePath: "kethalia/hive",
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("workspace-tool-pane-files")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-tool-pane-files")).toHaveTextContent("Files · hive");
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "git-clone-safe-hive",
      fallbackPath: "kethalia/hive",
      documentFrameHosts: [],
      tool: "files",
    });
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("reloads under the refreshed CSP before opening a recovered application host", async () => {
    mockGetWorkspaceSessionTools.mockResolvedValueOnce({
      data: {
        codeUrl: "https://code.apps.test",
        filesUrl: "https://files.apps.test",
        folderPath: "/home/coder",
        reloadRequired: true,
      },
    });
    await renderTwoSessionWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "Browse files for main-session" }));
    await waitFor(() => {
      expect(mockReloadForWorkspaceTool).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        boardKey: "default",
        sessionName: "main-session",
        tool: "files",
      });
    });
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
  });

  it("replays the pending tool intent after the refreshed CSP document loads", async () => {
    mockReadPendingWorkspaceToolIntent
      .mockReturnValueOnce({
        workspaceId: "ws-1",
        boardKey: "default",
        sessionName: "main-session",
        tool: "files",
      })
      .mockReturnValue(null);

    await renderTwoSessionWorkspace();

    expect(await screen.findByTestId("workspace-tool-pane-files")).toBeInTheDocument();
    expect(mockClearPendingWorkspaceToolIntent).toHaveBeenCalledOnce();
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "main-session",
      fallbackPath: undefined,
      documentFrameHosts: [],
      tool: "files",
    });
  });

  it("re-resolves a Git session when replaying a pending tool intent", async () => {
    mockReadPendingWorkspaceToolIntent
      .mockReturnValueOnce({
        workspaceId: "ws-1",
        boardKey: "default",
        sessionName: "git-clone-safe-hive",
        tool: "files",
        cloneSessionKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
        label: "hive",
      })
      .mockReturnValue(null);
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("workspace-tool-pane-files")).toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
      agentId: "agent-1",
      workspaceId: "ws-1",
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
    });
    expect(mockGetWorkspaceSessionTools).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "git-clone-safe-hive",
      fallbackPath: "kethalia/hive",
      documentFrameHosts: [],
      tool: "files",
    });
  });

  it("removes workspace tool panes when their board is deleted", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });
    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");
    fireEvent.click(screen.getByTestId("workspace-board-new"));
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId("palette-option-workspace:session:main-session-add"));
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(
      screen.getByTestId("palette-option-workspace:session:main-session-filebrowser"),
    );
    expect(await screen.findByTestId("workspace-tool-pane-files")).toBeInTheDocument();

    const secondBoard = screen.getByTestId("workspace-board-tab-workspace-2");
    fireEvent.mouseEnter(secondBoard);
    fireEvent.click(secondBoard);
    expect(screen.queryByTestId("workspace-board-tab-workspace-2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-new"));
    expect(screen.getByTestId("workspace-board-tab-workspace-2")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
  });

  it("invalidates pending tool requests when their board is deleted and recreated", async () => {
    const pending = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string | null;
      };
    }>();
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });
    mockGetWorkspaceSessionTools.mockReturnValueOnce(pending.promise);
    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");
    fireEvent.click(screen.getByTestId("workspace-board-new"));
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId("palette-option-workspace:session:main-session-add"));
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(
      screen.getByTestId("palette-option-workspace:session:main-session-filebrowser"),
    );

    const secondBoard = screen.getByTestId("workspace-board-tab-workspace-2");
    fireEvent.mouseEnter(secondBoard);
    fireEvent.click(secondBoard);
    fireEvent.click(screen.getByTestId("workspace-board-new"));
    await act(async () => {
      pending.resolve({
        data: {
          codeUrl: "https://old-code.test",
          filesUrl: "https://old-files.test",
          folderPath: "/old",
        },
      });
      await pending.promise;
    });

    expect(screen.getByTestId("workspace-board-tab-workspace-2")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
  });

  it("invalidates a pending Git resolution when its board is deleted and recreated", async () => {
    const pending = Promise.withResolvers<{
      data: {
        sessionName: string;
        clonePath: string;
        cloneSessionKey: string;
        cloneProof: string;
      };
    }>();
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockReturnValueOnce(pending.promise);
    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");
    fireEvent.click(screen.getByTestId("workspace-board-new"));
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    fireEvent.click(
      screen.getByTestId(
        "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-filebrowser",
      ),
    );

    const secondBoard = screen.getByTestId("workspace-board-tab-workspace-2");
    fireEvent.mouseEnter(secondBoard);
    fireEvent.click(secondBoard);
    fireEvent.click(screen.getByTestId("workspace-board-new"));
    await act(async () => {
      pending.resolve({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "proof-token",
        },
      });
      await pending.promise;
    });

    expect(screen.getByTestId("workspace-board-tab-workspace-2")).toBeInTheDocument();
    expect(mockGetWorkspaceSessionTools).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
  });

  it("clears embedded tool panes when the workspace identity changes", async () => {
    mockGetSessions.mockResolvedValue(twoSessionPayload());
    const { rerender } = render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");
    markTwoSessionsConnected();
    await waitFor(() => {
      expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Browse files for main-session" }));
    expect(await screen.findByTestId("workspace-tool-pane-files")).toBeInTheDocument();

    rerender(<MultiSessionWorkspace agentId="agent-2" workspaceId="ws-2" source="unified" />);

    await waitFor(() => {
      expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
    });
  });

  it("ignores pending command-palette tool responses after the workspace changes", async () => {
    const pending = Promise.withResolvers<{
      data: {
        codeUrl: string;
        filesUrl: string;
        folderPath: string | null;
      };
    }>();
    mockGetSessions.mockResolvedValue(twoSessionPayload());
    mockGetWorkspaceSessionTools.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(
      screen.getByTestId("palette-option-workspace:session:main-session-filebrowser"),
    );

    rerender(<MultiSessionWorkspace agentId="agent-2" workspaceId="ws-2" source="unified" />);
    await act(async () => {
      pending.resolve({
        data: {
          codeUrl: "https://old-code.test",
          filesUrl: "https://old-files.test",
          folderPath: "/old",
        },
      });
      await pending.promise;
    });

    expect(screen.queryByTestId("workspace-tool-pane-files")).not.toBeInTheDocument();
  });

  it("renders tiled real panes with InteractiveTerminal props and active diagnostics", async () => {
    await renderTwoSessionWorkspace();

    expect(screen.getByTestId("workspace-board-bar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-default")).toHaveTextContent("1");
    expect(screen.getByTestId("workspace-board-tab-default")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("workspace-header-board-controls")).toContainElement(
      screen.getByTestId("workspace-board-bar"),
    );
    expect(screen.getByTestId("workspace-header-board-controls")).toHaveClass("justify-center");
    expect(screen.getByTestId("workspace-header-board-controls")).toHaveClass(
      "col-span-2",
      "row-start-2",
      "min-[1025px]:row-start-1",
    );
    expect(screen.getByTestId("workspace-board-bar")).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
    );
    expect(screen.queryByTestId("board-persistence-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("2");
    expect(screen.getByTestId("workspace-sidebar-trigger")).toHaveClass("h-7", "shrink-0");
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-agent-id",
      "agent-1",
    );
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveAttribute(
      "data-workspace-id",
      "ws-1",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(screen.getByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-pane-mode",
      "tiled",
    );
    expect(screen.getByTestId("multi-session-body")).toHaveClass(
      "overflow-hidden",
      "overscroll-none",
    );
    expect(screen.getByTestId("multi-session-body")).not.toHaveClass("p-1");
    expect(screen.getByTestId("multi-session-grid")).toHaveAttribute(
      "data-layout-mode",
      "binary-split",
    );
    expect(screen.getByTestId("multi-session-grid")).not.toHaveClass("gap-1");
    expect(screen.queryByTestId("copy-active-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("paste-active-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-mobile-controls")).not.toBeInTheDocument();
    expect(screen.queryByTestId("float-pane-pane-main-session")).not.toBeInTheDocument();
  });

  it("loads terminal panes independently without aggregate loading or passive focus", async () => {
    await renderTwoSessionWorkspace({ connect: false });

    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-suppress-auto-focus",
      "true",
    );
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveAttribute(
      "data-suppress-auto-focus",
      "true",
    );

    markSessionConnected("main-session");

    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");

    markSessionConnected("dev-server");

    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-suppress-auto-focus",
      "true",
    );
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveAttribute(
      "data-suppress-auto-focus",
      "true",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
  });

  it("mounts hidden board sessions without blocking the active workspace", async () => {
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "terminal:main-session",
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                order: 0,
              },
            ],
          },
          {
            key: "review",
            name: "Review",
            order: 1,
            activePaneKey: "terminal:dev-server",
            panes: [
              {
                kind: "terminal",
                key: "terminal:dev-server",
                sessionName: "dev-server",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    await renderTwoSessionWorkspace({ connect: false });

    expect(screen.getByTestId("workspace-review-pane-dev-server")).toBeInTheDocument();
    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();

    markSessionConnected("main-session");

    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();

    markSessionConnected("dev-server");

    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
  });

  it("does not focus terminals when sessions mount from passive load or recovery", async () => {
    await renderTwoSessionWorkspace();
    const focusMainTerminal = vi.fn();
    const mainTerm = makeTerminal("main-session", focusMainTerminal);
    const mainSend = makeSender("main-session");

    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
    });

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(mainTerm, mainSend);
    expect(focusMainTerminal).not.toHaveBeenCalled();
  });

  it("shows mobile terminal controls in compose-sheet workspace mode", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    await renderTwoSessionWorkspace();

    expect(screen.getByTestId("terminal-mobile-shell")).toContainElement(
      screen.getByTestId("multi-session-workspace"),
    );

    const mainTerm = makeTerminal("main-session");
    const mainSend = makeSender("main-session");
    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
    });

    const controls = screen.getByTestId("terminal-mobile-controls");
    expect(controls).toHaveAttribute("data-session-count", "2");
    expect(controls).toHaveAttribute("data-current-session", "main-session");
    expect(controls).toHaveAttribute("data-next-session", "dev-server");
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-mobile-input-mode",
      "true",
    );
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-pin-to-bottom-on-resize",
      "true",
    );
    expect(mainTerm.focus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("terminal-paste-clipboard"));
    expect(mockPasteClipboardApiToTerminal).toHaveBeenCalledWith(
      mainTerm,
      mainSend,
      expect.objectContaining({
        targetLabel: "main-session",
        workspaceId: "ws-1",
      }),
    );

    fireEvent.click(screen.getByTestId("terminal-window-next"));
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mainTerm.focus).not.toHaveBeenCalled();
  });

  it("wraps loading and failure states in the visual viewport shell on mobile", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    mockGetSessions.mockReturnValueOnce(new Promise(() => undefined));
    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(screen.getByTestId("terminal-mobile-shell")).toContainElement(
      screen.getByTestId("multi-session-loading"),
    );

    cleanup();
    mockGetSessions.mockRejectedValueOnce(new Error("private load failure"));
    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("session-load-error")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-mobile-shell")).toContainElement(
      screen.getByTestId("session-load-error"),
    );
  });

  it("shows a toast with the exact paste limit error", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    mockPasteClipboardApiToTerminal.mockImplementation((_term, _send, options) => {
      options?.onStatus?.({
        action: "paste",
        outcome: "failed",
        reason: "file-too-large",
        message: "Each pasted file must be 10 MiB or smaller.",
      });
      return false;
    });
    await renderTwoSessionWorkspace();

    const mainTerm = makeTerminal("main-session");
    const mainSend = makeSender("main-session");
    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
    });

    fireEvent.click(screen.getByTestId("terminal-paste-clipboard"));

    expect(screen.getByTestId("terminal-clipboard-status")).toHaveTextContent(
      "Each pasted file must be 10 MiB or smaller.",
    );
    expect(mockToastError).toHaveBeenCalledWith("Each pasted file must be 10 MiB or smaller.");
  });

  it("stages multiple pasted file paths in the mobile compose sheet for the active multi-session pane", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    await renderTwoSessionWorkspace();

    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(makeTerminal("main-session"), vi.fn());
    });

    act(() => {
      terminalProps.get("main-session")?.onComposeRequest?.({
        draft: "/tmp/hive-terminal-paste/one.png\n/tmp/hive-terminal-paste/two.txt",
        append: true,
        targetLabel: "main-session",
      });
      terminalProps.get("main-session")?.onClipboardStatus?.({
        action: "paste",
        outcome: "pasted",
        method: "clipboard-api",
      });
    });

    expect(screen.getByTestId("compose-sheet")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("compose-sheet-content")).toHaveAttribute("data-side", "bottom");
    expect(screen.getByTestId("compose-sheet-content")).toHaveClass(
      "h-[var(--app-viewport-height)]",
      "max-h-[var(--app-viewport-height)]",
    );
    expect(screen.getByLabelText("Dismiss compose panel")).toBeInTheDocument();
    expect(screen.queryByText(/Compose to main-session/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("multi-session-compose-inline")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type multi-line command...")).toHaveValue(
      "/tmp/hive-terminal-paste/one.png\n/tmp/hive-terminal-paste/two.txt",
    );
    expect(screen.getByTestId("terminal-clipboard-status")).toHaveTextContent("Paste complete");
  });

  it("keeps the compose panel inline on desktop multi-session workspaces", async () => {
    mockUseIsComposeSheet.mockReturnValue(false);
    await renderTwoSessionWorkspace();

    act(() => {
      terminalProps.get("main-session")?.onComposeRequest?.({
        draft: "printf desktop",
        targetLabel: "main-session",
      });
    });

    expect(screen.queryByTestId("compose-sheet-content")).not.toBeInTheDocument();
    expect(screen.getByTestId("multi-session-compose-inline")).toBeInTheDocument();
    expect(screen.getByText(/Compose to main-session/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type multi-line command...")).toHaveValue("printf desktop");
  });

  it("sends compose drafts to the pane that opened compose", async () => {
    mockUseIsComposeSheet.mockReturnValue(false);
    await renderTwoSessionWorkspace();
    const mainSend = makeSender("main-session");
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(makeTerminal("main-session"), mainSend);
      terminalProps.get("dev-server")?.onTerminalReady?.(makeTerminal("dev-server"), devSend);
      terminalProps.get("dev-server")?.onComposeRequest?.({
        draft: "printf dev",
        targetLabel: "dev-server",
      });
    });

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(screen.getByText(/Compose to dev-server/)).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveAttribute(
      "data-compose-disabled",
      "false",
    );
    expect(screen.getByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-compose-disabled",
      "true",
    );
    expect(screen.getByTestId("workspace-pane-main-session-disabled-overlay")).toHaveTextContent(
      "Compose locked",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(devSend).toHaveBeenNthCalledWith(1, "printf dev");
    expect(devSend).toHaveBeenNthCalledWith(2, "\r");
    expect(mainSend).not.toHaveBeenCalled();
  });

  it("keeps global compose locked to the session focused when compose opened", async () => {
    mockUseIsComposeSheet.mockReturnValue(false);
    await renderTwoSessionWorkspace();
    const mainSend = makeSender("main-session");
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(makeTerminal("main-session"), mainSend);
      terminalProps.get("dev-server")?.onTerminalReady?.(makeTerminal("dev-server"), devSend);
      window.dispatchEvent(new Event(TERMINAL_COMPOSE_TOGGLE_EVENT));
    });

    expect(screen.getByText(/Compose to main-session/)).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-compose-disabled",
      "false",
    );
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveAttribute(
      "data-compose-disabled",
      "true",
    );
    expect(screen.getByTestId("workspace-pane-dev-server-disabled-overlay")).toHaveTextContent(
      "Compose locked",
    );

    fireEvent.change(screen.getByPlaceholderText("Type multi-line command..."), {
      target: { value: "printf main" },
    });
    fireEvent.mouseEnter(screen.getByTestId("workspace-pane-dev-server"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(screen.getByText(/Compose to main-session/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send command" }));

    expect(mainSend).toHaveBeenNthCalledWith(1, "printf main");
    expect(mainSend).toHaveBeenNthCalledWith(2, "\r");
    expect(devSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveAttribute(
      "data-compose-disabled",
      "false",
    );
  });

  it("passes multi-session selection mode to mobile workspace panes", async () => {
    mockUseIsComposeSheet.mockReturnValue(true);
    await renderTwoSessionWorkspace();

    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(makeTerminal("main-session"), vi.fn());
    });

    fireEvent.click(screen.getByTestId("terminal-selection-toggle"));

    expect(screen.getByTestId("terminal-mobile-controls")).toHaveAttribute(
      "data-selection-mode-enabled",
      "true",
    );
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-selection-mode-enabled",
      "true",
    );
  });

  it("ignores duplicate pane connection updates from callback identity changes", async () => {
    emitConnectionStateOnCallbackChange = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderTwoSessionWorkspace();
    await waitFor(() => {
      expect(screen.getByTestId("interactive-terminal-main-session")).toBeInTheDocument();
      expect(screen.getByTestId("interactive-terminal-dev-server")).toBeInTheDocument();
    });

    expect(consoleError.mock.calls.flat().join("\n")).not.toContain("Maximum update depth");
  });

  it("fills the viewport with a focused-window split tree when three sessions are open", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
        { name: "shell", created: 3, windows: 1 },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    await screen.findByTestId("workspace-pane-main-session");
    expect(document.querySelector('[data-workspace-window-id="main-session"]')).toHaveStyle({
      left: "0%",
      top: "0%",
      width: "50%",
      height: "100%",
    });
    expect(document.querySelector('[data-workspace-window-id="dev-server"]')).toHaveStyle({
      left: "50%",
      top: "0%",
      width: "50%",
      height: "50%",
    });
    expect(document.querySelector('[data-workspace-window-id="shell"]')).toHaveStyle({
      left: "50%",
      top: "50%",
      width: "50%",
      height: "50%",
    });
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "default:terminal:main-session:2:2:1 / 1 / span 2 / span 1:viewport:0:0",
    );
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveClass(
      "flex",
      "flex-col",
      "min-h-0",
    );
    expect(
      screen
        .getByTestId("workspace-pane-dev-server")
        .querySelector("[data-terminal-frame-content='true']"),
    ).toHaveClass("flex", "flex-col", "overflow-hidden");
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveClass("min-h-0", "flex-1");
    expect(screen.getByTestId("interactive-terminal-dev-server").className).not.toContain(
      "calc(100%-2rem)",
    );
  });

  it("changes active pane only on explicit interaction, never passive pointer movement", async () => {
    await renderTwoSessionWorkspace();
    const focusDevTerminal = vi.fn();
    const devTerm = makeTerminal("dev-server", focusDevTerminal);
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    const devPane = screen.getByTestId("workspace-pane-dev-server");
    fireEvent.mouseEnter(devPane);

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(focusDevTerminal).not.toHaveBeenCalled();

    fireEvent.mouseMove(devPane);

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(focusDevTerminal).not.toHaveBeenCalled();

    fireEvent.click(devPane);

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(devTerm, devSend);
    expect(focusDevTerminal).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .boards[0].activePaneKey,
    ).toBe("terminal:dev-server");

    fireEvent.click(screen.getByTestId("workspace-pane-main-session"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
  });

  it("activates inactive panes when the terminal surface requests focus", async () => {
    await renderTwoSessionWorkspace();
    const focusDevTerminal = vi.fn();
    const devTerm = makeTerminal("dev-server", focusDevTerminal);
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    fireEvent.click(screen.getByTestId("interactive-terminal-dev-server"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(devTerm, devSend);
    expect(focusDevTerminal).not.toHaveBeenCalled();
  });

  it("focuses a terminal that becomes ready after an explicit pane activation", async () => {
    await renderTwoSessionWorkspace();
    const focusDevTerminal = vi.fn();
    const devTerm = makeTerminal("dev-server", focusDevTerminal);
    const devSend = makeSender("dev-server");

    fireEvent.click(screen.getByTestId("workspace-pane-dev-server"));
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(null, null);

    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(devTerm, devSend);
    expect(focusDevTerminal).toHaveBeenCalledTimes(1);
  });

  it("allows the native xterm context menu in multi-session panes", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue("printf ok"),
      },
    });
    await renderTwoSessionWorkspace();
    const devTerm = makeTerminal("dev-server");
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });
    mockSetActiveTerminal.mockClear();

    const nativeContextMenu = createEvent.contextMenu(
      screen.getByTestId("interactive-terminal-dev-server"),
      {
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 220,
      },
    );
    fireEvent(screen.getByTestId("interactive-terminal-dev-server"), nativeContextMenu);

    expect(nativeContextMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu", { name: /terminal context menu/i })).not.toBeInTheDocument();
    expect(mockSetActiveTerminal).not.toHaveBeenCalled();
  });

  it("does not consume space or enter typed inside terminal panes", async () => {
    await renderTwoSessionWorkspace();
    const terminalInput = screen.getByTestId("terminal-input-main-session");
    const spaceEvent = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      terminalInput.dispatchEvent(spaceEvent);
      terminalInput.dispatchEvent(enterEvent);
    });

    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(enterEvent.defaultPrevented).toBe(false);
  });

  it("focuses the closest directional pane without wrapping at an edge", async () => {
    await renderTwoSessionWorkspace();
    const workspace = screen.getByTestId("multi-session-workspace");
    const devTerm = makeTerminal("dev-server");
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    fireEvent.keyDown(workspace, { key: "ArrowRight", ctrlKey: true });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(devTerm.focus).toHaveBeenCalled();

    fireEvent.keyDown(workspace, { key: "ArrowLeft", metaKey: true });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");

    const nextBinding = lastRegisteredEntry("multi-session:ws-1:focus-right-pane");
    act(() => {
      expect(nextBinding.action(null, null)).toBe(false);
    });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");

    act(() => {
      expect(nextBinding.action(null, null)).toBe(false);
    });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("registers exact global board shortcuts that switch boards through board persistence only", async () => {
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "later",
        boards: [
          {
            key: "later",
            name: "Later",
            order: 20,
            activePaneKey: "terminal:main-session",
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                label: "Main Board Pane",
                order: 0,
              },
            ],
          },
          {
            key: "earlier",
            name: "Earlier",
            order: 10,
            activePaneKey: "terminal:dev-server",
            panes: [
              {
                kind: "terminal",
                key: "terminal:dev-server",
                sessionName: "dev-server",
                label: "Review Board Pane",
                order: 0,
              },
            ],
          },
        ],
      }),
    );

    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("workspace-board-tab-later")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Main Board Pane");
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "later:terminal:main-session:1:1:1 / 1 / span 1 / span 1:viewport:0:0",
    );

    const previousBoard = lastRegisteredEntry("multi-session:ws-1:previous-board");
    const nextBoard = lastRegisteredEntry("multi-session:ws-1:next-board");
    expect(previousBoard).toMatchObject({
      id: "multi-session:ws-1:previous-board",
      keys: ["cmd+alt+arrowleft", "ctrl+alt+arrowleft"],
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });
    expect(nextBoard).toMatchObject({
      id: "multi-session:ws-1:next-board",
      keys: ["cmd+alt+arrowright", "ctrl+alt+arrowright"],
      category: "terminal",
      enabledInBrowser: true,
      global: true,
    });

    act(() => {
      expect(previousBoard.action(null, null)).toBe(false);
    });

    expect(screen.getByTestId("workspace-board-tab-earlier")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Review Board Pane");
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveAttribute(
      "data-layout-signal",
      "earlier:terminal:dev-server:1:1:1 / 1 / span 1 / span 1:viewport:0:0",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("earlier");

    act(() => {
      expect(lastRegisteredEntry("multi-session:ws-1:next-board").action(null, null)).toBe(false);
    });

    expect(screen.getByTestId("workspace-board-tab-later")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Main Board Pane");
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("later");

    const capturedPreviousBoard = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(capturedPreviousBoard);
    });
    expect(capturedPreviousBoard.defaultPrevented).toBe(true);
    expect(screen.getByTestId("workspace-board-tab-earlier")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("earlier");

    const capturedSecondBoard = new KeyboardEvent("keydown", {
      key: "2",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      screen.getByTestId("terminal-input-dev-server").dispatchEvent(capturedSecondBoard);
    });
    expect(capturedSecondBoard.defaultPrevented).toBe(true);
    expect(screen.getByTestId("workspace-board-tab-later")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("later");

    const capturedTerminalPreviousBoard = new KeyboardEvent("keydown", {
      key: "Left",
      code: "ArrowLeft",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      screen
        .getByTestId("terminal-input-main-session")
        .dispatchEvent(capturedTerminalPreviousBoard);
    });
    expect(capturedTerminalPreviousBoard.defaultPrevented).toBe(true);
    expect(screen.getByTestId("workspace-board-tab-earlier")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("earlier");

    const capturedPhysicalSecondBoard = new KeyboardEvent("keydown", {
      key: "!",
      code: "Digit2",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      screen.getByTestId("terminal-input-dev-server").dispatchEvent(capturedPhysicalSecondBoard);
    });
    expect(capturedPhysicalSecondBoard.defaultPrevented).toBe(true);
    expect(screen.getByTestId("workspace-board-tab-later")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("later");

    const firstBoard = lastRegisteredEntry("multi-session:ws-1:board-1");
    const thirdBoard = lastRegisteredEntry("multi-session:ws-1:board-3");
    expect(firstBoard).toMatchObject({
      id: "multi-session:ws-1:board-1",
      keys: ["cmd+1", "ctrl+1"],
      enabledInBrowser: true,
      global: true,
    });
    act(() => {
      expect(firstBoard.action(null, null)).toBe(false);
    });
    expect(screen.getByTestId("workspace-board-tab-earlier")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("earlier");

    act(() => {
      expect(thirdBoard.action(null, null)).toBe(false);
    });
    expect(mockToastInfo).toHaveBeenCalledWith("Workspace 3 does not exist.");
    expect(screen.getByTestId("workspace-board-tab-earlier")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();

    cleanup();
    vi.clearAllMocks();
    terminalProps.clear();
    window.localStorage.clear();
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "solo",
        boards: [
          {
            key: "solo",
            name: "Solo",
            order: 0,
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());

    render(<MultiSessionWorkspace {...defaultProps} />);
    expect(await screen.findByTestId("workspace-board-tab-solo")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    act(() => {
      expect(lastRegisteredEntry("multi-session:ws-1:previous-board").action(null, null)).toBe(
        false,
      );
      expect(lastRegisteredEntry("multi-session:ws-1:next-board").action(null, null)).toBe(false);
    });

    expect(screen.getByTestId("workspace-board-tab-solo")).toHaveAttribute("aria-selected", "true");
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .activeBoardKey,
    ).toBe("solo");
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("exposes dedicated drag handles without legacy reorder controls or status badges", async () => {
    await renderTwoSessionWorkspace();

    expect(screen.getByRole("button", { name: "Drag main-session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drag dev-server" })).toBeInTheDocument();
    expect(screen.queryByTestId("move-pane-left-pane-dev-server")).not.toBeInTheDocument();
    expect(screen.queryByTestId("move-pane-right-pane-dev-server")).not.toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(screen.getByText("dev-server")).toBeInTheDocument();
  });

  it("creates, selects, deletes, and persists numbered local workspaces without terminal side effects", async () => {
    await renderTwoSessionWorkspace();

    fireEvent.click(screen.getByTestId("workspace-board-new"));

    expect(screen.getByTestId("workspace-board-tab-workspace-2")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("active-board-empty")).toHaveTextContent(
      "This workspace has no panes yet.",
    );
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("0");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("No active pane");
    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-pane-dev-server")).not.toBeInTheDocument();
    expect(screen.getByTestId("create-session-button")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-tab-default"));
    expect(screen.getByTestId("workspace-board-tab-default")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("2");

    fireEvent.click(screen.getByTestId("workspace-board-tab-workspace-2"));
    fireEvent.mouseEnter(screen.getByTestId("workspace-board-tab-workspace-2"));
    fireEvent.click(screen.getByTestId("workspace-board-tab-workspace-2"));
    expect(screen.queryByTestId("workspace-board-tab-workspace-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-default")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const stored = window.localStorage.getItem("workspace-board-state:workspace:ws-1");
    expect(stored).toBeTruthy();
    const storedState = JSON.parse(stored ?? "{}");
    expect(storedState).toMatchObject({
      version: 1,
      activeBoardKey: "default",
      boards: [{ key: "default", name: "Default", order: 0 }],
    });
    expect(storedState.boards[0].panes).toEqual([
      expect.objectContaining({ kind: "terminal", sessionName: "main-session", order: 0 }),
      expect.objectContaining({ kind: "terminal", sessionName: "dev-server", order: 1 }),
    ]);
    expect(stored).not.toMatch(/proof|token|secret|terminal contents|\/home\/coder/);
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("keeps valid empty boards empty and falls back around stale active membership", async () => {
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "review",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "terminal:stale-session",
            panes: [
              {
                kind: "terminal",
                key: "terminal:stale-session",
                sessionName: "stale-session",
                order: 0,
              },
              {
                kind: "terminal",
                key: "terminal:dev-server",
                sessionName: "dev-server",
                order: 1,
              },
            ],
          },
          { key: "review", name: "Review", order: 1, panes: [] },
        ],
      }),
    );

    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("active-board-empty")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("0");
    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-pane-dev-server")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-default-pane-dev-server")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-tab-default"));

    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(window.localStorage.getItem("workspace-board-state:workspace:ws-1")).toContain(
      "stale-session",
    );
  });

  it("keeps inactive workspace board terminals mounted and avoids reloading sessions on switch", async () => {
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "terminal:main-session",
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                order: 0,
              },
            ],
          },
          {
            key: "review",
            name: "Review",
            order: 1,
            activePaneKey: "terminal:dev-server",
            panes: [
              {
                kind: "terminal",
                key: "terminal:dev-server",
                sessionName: "dev-server",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());

    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-review-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-dev-server")).toBeInTheDocument();
    expect(mockGetSessions).toHaveBeenCalledTimes(1);
    markTwoSessionsConnected();

    fireEvent.click(screen.getByTestId("workspace-board-tab-review"));

    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-default-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("interactive-terminal-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(screen.queryByTestId("multi-session-loading")).not.toBeInTheDocument();
    expect(mockGetSessions).toHaveBeenCalledTimes(1);
    expect(terminalDestroyCounts.get("main-session") ?? 0).toBe(0);
    expect(terminalDestroyCounts.get("dev-server") ?? 0).toBe(0);
  });

  it("adds live backing sessions to an empty active board from the command palette", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");

    fireEvent.click(screen.getByTestId("workspace-board-new"));

    expect(screen.getByTestId("active-board-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "dev" },
    });

    expect(screen.getByTestId("palette-action-workspace:session:dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("palette-option-workspace:session:dev-server-add")).toHaveTextContent(
      "Add",
    );

    fireEvent.click(screen.getByTestId("palette-option-workspace:session:dev-server-add"));

    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-default-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    const storedState = JSON.parse(
      window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "{}",
    );
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "default").panes,
    ).toEqual([expect.objectContaining({ kind: "terminal", sessionName: "main-session" })]);
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "workspace-2").panes,
    ).toEqual([expect.objectContaining({ kind: "terminal", sessionName: "dev-server" })]);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("preserves Git identity when adding an existing clone session to another board", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    fireEvent.click(screen.getByTestId("workspace-board-new"));
    expect(screen.getByTestId("active-board-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "git-clone-safe-hive" },
    });
    fireEvent.click(screen.getByTestId("palette-option-workspace:session:git-clone-safe-hive-add"));

    const storedState = JSON.parse(
      window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "{}",
    );
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "workspace-2").panes,
    ).toEqual([
      expect.objectContaining({
        kind: "git",
        sessionName: "git-clone-safe-hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
      }),
    ]);
  });

  it("shows sessions already in the active board as disabled add actions", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    const action = await screen.findByTestId("palette-option-workspace:session:main-session-add");

    expect(action).toBeDisabled();
    expect(action).toHaveTextContent("Add");
  });

  it("restores persisted boards from git-scoped storage and writes selection back to the git key", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "review",
        boards: [
          { key: "main", name: "Main", order: 0, panes: [] },
          { key: "review", name: "Review", order: 1, panes: [] },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("multi-session-empty")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(window.localStorage.getItem("workspace-board-state:workspace:ws-1")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-board-tab-main"));

    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "{}"),
    ).toMatchObject({
      activeBoardKey: "main",
      boards: [
        { key: "main", name: "Main", order: 0, panes: [] },
        { key: "review", name: "Review", order: 1, panes: [] },
      ],
    });
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("restores persisted board Git panes with fresh clone identity and redacted persistence", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "review",
        boards: [
          { key: "main", name: "Main", order: 0, panes: [] },
          {
            key: "review",
            name: "Review",
            order: 1,
            activePaneKey: "git:persisted-hive",
            panes: [
              {
                kind: "git",
                key: "git:persisted-hive",
                cloneSessionKey: "git-clone:kethalia/hive",
                relativePath: "kethalia/hive",
                sessionName: "stale-session-name",
                label: "Hive Review",
                cloneProof: "persisted-proof-should-not-be-read",
                clonePath: "/home/coder/projects/kethalia/hive",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive-fresh",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "fresh-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(
      await screen.findByTestId("interactive-terminal-git-clone-safe-hive-fresh"),
    ).toHaveAttribute("data-clone-proof", "fresh-proof-token");
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive-fresh")).toHaveAttribute(
      "data-clone-path",
      "kethalia/hive",
    );
    expect(screen.queryByTestId("interactive-terminal-stale-session-name")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Hive Review");
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
      agentId: "agent-1",
      workspaceId: "ws-1",
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
    });
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("cloneProof");
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("clonePath");
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("sessionName");

    fireEvent.click(screen.getByTestId("workspace-board-tab-main"));
    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "";
    expect(stored).toContain("git-clone:kethalia/hive");
    expect(stored).toContain("kethalia/hive");
    expect(stored).not.toMatch(
      /cloneProof|clonePath|persisted-proof|fresh-proof-token|stale-session-name|\/home\/coder/,
    );
  });

  it("keeps workspace sessions visible when Git discovery fails in unified workspaces", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockRejectedValueOnce(
      new Error("secret discovery failure /home/coder/projects/kethalia/hive token-123"),
    );

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("git-session-restore-error")).toHaveTextContent(
      "Git panes need refresh. Retry to restore repository panes.",
    );
    expect(screen.queryByTestId("session-load-error")).not.toBeInTheDocument();
    expect(screen.queryByText(/secret discovery|\/home\/coder|token-123/)).not.toBeInTheDocument();
  });

  it("shows sanitized board repair diagnostics for malformed board storage", async () => {
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      '{"secret":"token","path":"/home/coder/projects/kethalia/hive"',
    );

    await renderTwoSessionWorkspace();

    expect(screen.getByTestId("workspace-board-tab-default")).toHaveTextContent("1");
    expect(screen.getByTestId("board-persistence-status")).toHaveTextContent(
      "Stored board state was unreadable. Safe default board is active.",
    );
    expect(screen.getByTestId("board-persistence-status")).toHaveAttribute(
      "data-board-codes",
      "persisted-json-invalid",
    );
    expect(screen.getByTestId("board-persistence-status").textContent).not.toMatch(
      /secret|token|\/home\/coder|workspace-board-state/,
    );
  });

  it("does not render a reset layout control in the workspace header", async () => {
    await renderTwoSessionWorkspace();

    expect(screen.queryByTestId("reset-layout")).not.toBeInTheDocument();
  });

  it("falls back to live sessions when persisted board state has no usable boards", async () => {
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({ version: 1, activeBoardKey: "missing", boards: [] }),
    );

    await renderTwoSessionWorkspace();

    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("board-persistence-status")).toHaveTextContent(
      "Stored board state was repaired. Safe board metadata is active.",
    );
  });

  it("creates boards in the empty state without creating or closing terminal sessions", async () => {
    mockGetSessions.mockResolvedValueOnce({ data: [] });

    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("multi-session-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("workspace-board-new"));

    expect(screen.getByTestId("workspace-board-tab-workspace-2")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}"),
    ).toMatchObject({
      activeBoardKey: "workspace-2",
      boards: [
        { key: "default", name: "Default", order: 0, panes: [] },
        { key: "workspace-2", name: "Workspace 2", order: 1, panes: [] },
      ],
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("keeps in-memory board changes active when board storage writes fail", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("secret write failure /home/coder/projects/kethalia/hive");
    });

    await renderTwoSessionWorkspace();
    fireEvent.click(screen.getByTestId("workspace-board-new"));

    expect(screen.getByTestId("workspace-board-tab-workspace-2")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("board-persistence-status")).toHaveTextContent(
      "Board changes are active for this view but could not be saved locally.",
    );
    expect(screen.getByTestId("board-persistence-status")).toHaveAttribute(
      "data-board-codes",
      "storage-write-failed",
    );
    expect(screen.getByTestId("board-persistence-status").textContent).not.toMatch(
      /secret|\/home\/coder/,
    );
    expect(setItem).toHaveBeenCalledWith(
      "workspace-board-state:workspace:ws-1",
      expect.stringContaining('"activeBoardKey":"workspace-2"'),
    );
  });

  it("restores persisted pane order from source-scoped storage", async () => {
    window.localStorage.setItem(
      "multi-session-layout:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeSessionName: "dev-server",
        panes: [
          { sessionName: "dev-server", mode: "tiled", order: 0 },
          { sessionName: "main-session", mode: "tiled", order: 1 },
        ],
      }),
    );

    await renderTwoSessionWorkspace();

    const windowIds = Array.from(
      screen.getByTestId("multi-session-grid").querySelectorAll("[data-workspace-window-id]"),
    ).map((pane) => pane.getAttribute("data-workspace-window-id"));
    expect(windowIds).toEqual(["dev-server", "main-session"]);
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("restores focus from the active board instead of stale legacy layout state", async () => {
    window.localStorage.setItem(
      "multi-session-layout:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeSessionName: "main-session",
        panes: [
          { sessionName: "main-session", mode: "tiled", order: 0 },
          { sessionName: "dev-server", mode: "tiled", order: 1 },
        ],
      }),
    );
    window.localStorage.setItem(
      "workspace-board-state:workspace:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "terminal:dev-server",
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                order: 0,
              },
              {
                kind: "terminal",
                key: "terminal:dev-server",
                sessionName: "dev-server",
                order: 1,
              },
            ],
          },
        ],
      }),
    );

    await renderTwoSessionWorkspace();

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("creates generic workspace sessions while unified source creation lives in the command palette", async () => {
    await renderTwoSessionWorkspace();
    mockCreateSession.mockResolvedValueOnce({ data: { name: "created-main" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-session-button"));
    });

    expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(await screen.findByTestId("workspace-pane-created-main")).toBeInTheDocument();

    cleanup();
    terminalProps.clear();
    mockGetSessions.mockResolvedValue({ data: [] });
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    expect(screen.queryByTestId("create-session-button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    expect(await screen.findByTestId("multi-session-command-palette")).toBeInTheDocument();
    expect(
      screen.getByTestId("palette-action-workspace:new-terminal-from-query"),
    ).toHaveTextContent("New terminal session in workspace");
  });

  it("searches terminal sessions and Git repositories from the command palette", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-workspace");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "dev" },
    });

    expect(screen.getByTestId("palette-action-workspace:session:dev-server")).toHaveTextContent(
      "dev-server",
    );
    expect(
      screen.getByTestId("palette-option-workspace:session:dev-server-open"),
    ).toHaveTextContent("Open");

    fireEvent.change(screen.getByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add"),
    ).toHaveTextContent("Add");
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-open"),
    ).toHaveTextContent("Open");

    fireEvent.click(screen.getByTestId("palette-action-workspace:session:dev-server"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("searches terminal sessions beyond the first sixteen results", async () => {
    mockGetSessions.mockResolvedValueOnce({
      data: Array.from({ length: 17 }, (_, index) => ({
        name: `session-${String(index + 1).padStart(2, "0")}`,
        created: index + 1,
        windows: 1,
      })),
    });
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-session-01");
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "session-17" },
    });

    expect(screen.getByTestId("palette-action-workspace:session:session-17")).toBeInTheDocument();
    expect(
      screen.queryByTestId("palette-option-workspace:new-terminal-from-query"),
    ).not.toBeInTheDocument();
  });

  it("uses clone key plus relative path for Git command palette identities", async () => {
    mockGetSessions.mockResolvedValueOnce({ data: [] });
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia",
            },
            {
              id: "repo-docs",
              kind: "repository",
              label: "docs",
              relativePath: "kethalia/docs",
              relativePathSegments: ["kethalia", "docs"],
              displaySegments: ["Git", "home", "kethalia", "docs"],
              cloneSessionKey: "git-clone:kethalia",
            },
          ],
        },
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "kethalia" },
    });

    expect(
      screen.getByTestId("palette-action-workspace:git:git-clone:kethalia:kethalia/hive"),
    ).toHaveTextContent("kethalia/hive");
    expect(
      screen.getByTestId("palette-action-workspace:git:git-clone:kethalia:kethalia/docs"),
    ).toHaveTextContent("kethalia/docs");
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:kethalia:kethalia/hive-open"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:kethalia:kethalia/docs-open"),
    ).toBeInTheDocument();
  });

  it("creates a named workspace terminal from a non-matching command palette query", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });
    mockCreateSession.mockResolvedValueOnce({ data: { name: "api-shell" } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-workspace");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "api-shell" },
    });

    const createAction = screen.getByTestId("palette-action-workspace:new-terminal-from-query");
    expect(createAction).toHaveTextContent("New terminal session named api-shell");

    await act(async () => {
      fireEvent.click(createAction);
    });

    expect(mockCreateSession).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "api-shell",
    });
    expect(await screen.findByTestId("workspace-pane-api-shell")).toBeInTheDocument();
  });

  it("closes regular workspace sessions through the pane close button", async () => {
    await renderTwoSessionWorkspace();

    await act(async () => {
      fireEvent.click(screen.getByTestId("remove-pane-pane-main-session"));
    });

    expect(mockKillSession).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionName: "main-session",
    });
    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("removes plain workspace panes from the active board without killing sessions", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");
    const mainTerm = makeTerminal("main-session");
    const mainSend = makeSender("main-session");
    act(() => {
      terminalProps.get("main-session")?.onTerminalReady?.(mainTerm, mainSend);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("remove-pane-pane-main-session"));
    });

    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();

    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1");
    expect(stored).not.toContain("main-session");
    expect(stored).toContain("dev-server");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId("palette-option-workspace:session:main-session-add"));

    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(mainTerm, mainSend);
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("does not restore a removed pane when focusing the fallback terminal bubbles from xterm", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");

    const devTerm = makeTerminal("dev-server", () => {
      fireEvent.focus(screen.getByTestId("terminal-input-dev-server"));
    });
    const devSend = makeSender("dev-server");
    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("remove-pane-pane-main-session"));
    });
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(devTerm.focus).toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");

    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1");
    expect(stored).not.toContain("main-session");
    expect(stored).toContain("dev-server");
  });

  it("repairs persisted terminal panes that share the same session across boards", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                label: "main-session",
                order: 0,
              },
            ],
          },
          {
            key: "review",
            name: "Review",
            order: 1,
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session-review",
                sessionName: "main-session",
                label: "main-session",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    await screen.findByTestId("interactive-terminal-main-session");
    expect(screen.getAllByTestId("interactive-terminal-main-session")).toHaveLength(1);
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-review-pane-main-session")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-tab-review"));

    expect(screen.getByTestId("active-board-empty")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-default-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("No active pane");
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("adds a Git repository to a second board by reusing the live resolved session", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            panes: [
              {
                kind: "git",
                key: "git:git-clone:kethalia/hive:kethalia/hive",
                cloneSessionKey: "git-clone:kethalia/hive",
                relativePath: "kethalia/hive",
                sessionName: "git-clone-safe-hive",
                label: "kethalia/hive",
                cloneProof: "persisted-proof-should-not-be-read",
                clonePath: "/home/coder/projects/kethalia/hive",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValue({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "fresh-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("workspace-board-new"));
    expect(screen.getByTestId("active-board-empty")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    expect(screen.getByTestId("workspace-pane-git-clone-safe-hive")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("kethalia/hive");
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);

    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "";
    const storedState = JSON.parse(stored);
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "default").panes,
    ).toEqual([]);
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "workspace-2").panes,
    ).toEqual([
      expect.objectContaining({
        cloneSessionKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
      }),
    ]);
    expect(stored).not.toMatch(
      /cloneProof|clonePath|persisted-proof|fresh-proof-token|\/home\/coder/,
    );
  });

  it("filters Git repository add actions by active board identity rather than clone key", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            panes: [
              {
                kind: "git",
                key: "git:git-clone:monorepo:kethalia/hive",
                cloneSessionKey: "git-clone:monorepo",
                relativePath: "kethalia/hive",
                sessionName: "git-clone-safe-hive",
                label: "kethalia/hive",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:monorepo",
            },
            {
              id: "repo-docs",
              kind: "repository",
              label: "docs",
              relativePath: "kethalia/docs",
              relativePathSegments: ["kethalia", "docs"],
              displaySegments: ["Git", "home", "kethalia", "docs"],
              cloneSessionKey: "git-clone:monorepo",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:monorepo",
        cloneProof: "fresh-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-git-clone-safe-hive");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "docs" },
    });

    expect(
      screen.queryByTestId("palette-option-workspace:git:git-clone:monorepo:kethalia/hive-add"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:monorepo:kethalia/docs-add"),
    ).toBeInTheDocument();
  });

  it("surfaces sanitized restore failures for malformed persisted Git pane resolver output", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "git:persisted-hive",
            panes: [
              {
                kind: "git",
                key: "git:persisted-hive",
                cloneSessionKey: "git-clone:kethalia/hive",
                relativePath: "kethalia/hive",
                sessionName: "stale-session-name",
                label: "Hive Review",
                cloneProof: "persisted-proof-should-not-be-read",
                clonePath: "/home/coder/projects/kethalia/hive",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "",
        clonePath: "/home/coder/projects/kethalia/hive",
        cloneProof: "secret-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("git-session-restore-error")).toHaveTextContent(
      "Git panes need refresh. Retry to restore repository panes.",
    );
    expect(screen.getByTestId("retry-git-session-restore")).toHaveTextContent("Retry Git restore");
    expect(screen.queryByTestId("interactive-terminal-stale-session-name")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/secret-proof|\/home\/coder|persisted-proof|stale-session-name/),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "").toContain(
      "persisted-proof-should-not-be-read",
    );
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("surfaces repository-missing persisted Git refs without hiding repository search or killing sessions", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "git:persisted-hive",
            panes: [
              {
                kind: "git",
                key: "git:persisted-hive",
                cloneSessionKey: "git-clone:kethalia/hive",
                relativePath: "kethalia/hive",
                sessionName: "stale-session-name",
                label: "Hive Review",
                cloneProof: "persisted-proof-should-not-be-read",
                clonePath: "/home/coder/projects/kethalia/hive",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockListGitClones
      .mockResolvedValueOnce({
        data: {
          ok: true,
          tree: {
            nodes: [
              {
                id: "repo-docs",
                kind: "repository",
                label: "docs",
                relativePath: "kethalia/docs",
                relativePathSegments: ["kethalia", "docs"],
                displaySegments: ["Git", "home", "kethalia", "docs"],
                cloneSessionKey: "git-clone:kethalia/docs",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          tree: {
            nodes: [
              {
                id: "repo-hive",
                kind: "repository",
                label: "hive",
                relativePath: "kethalia/hive",
                relativePathSegments: ["kethalia", "hive"],
                displaySegments: ["Git", "home", "kethalia", "hive"],
                cloneSessionKey: "git-clone:kethalia/hive",
              },
            ],
          },
        },
      });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "fresh-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("git-session-restore-error")).toHaveTextContent(
      "Git panes need refresh. Retry to restore repository panes.",
    );
    expect(
      screen.queryByText(/persisted-proof|\/home\/coder|stale-session-name/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("multi-session-empty")).toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "docs" },
    });
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:kethalia/docs:kethalia/docs-add"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("retry-git-session-restore"));

    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(screen.queryByTestId("git-session-restore-error")).not.toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);
    expect(mockListGitClones).toHaveBeenCalledTimes(2);
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("keeps rejected Git pane restore actions sanitized and retries without duplicate concurrent calls", async () => {
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "git:persisted-hive",
            panes: [
              {
                kind: "git",
                key: "git:persisted-hive",
                cloneSessionKey: "git-clone:kethalia/hive",
                relativePath: "kethalia/hive",
                sessionName: "stale-session-name",
                label: "Hive Review",
                order: 0,
              },
            ],
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValue({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal
      .mockRejectedValueOnce(new Error("secret-proof-token at /home/coder/projects/kethalia/hive"))
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "fresh-proof-token",
        },
      });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("git-session-restore-error")).toHaveTextContent(
      "Git panes need refresh. Retry to restore repository panes.",
    );
    expect(
      screen.queryByText(/secret-proof-token|\/home\/coder|stale-session-name/),
    ).not.toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("retry-git-session-restore"));

    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(screen.queryByTestId("git-session-restore-error")).not.toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(2);
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("keeps Git add resolver failures sanitized and leaves board membership unchanged", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    const serverError =
      "Configured home folder is not available. Mount the home root, then refresh.";
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      serverError,
      data: {
        sessionName: "",
        clonePath: "/home/coder/projects/kethalia/hive",
        cloneProof: "secret-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    expect(await screen.findByTestId("git-session-add-error")).toHaveTextContent(serverError);
    expect(screen.getByTestId("git-session-add-error").textContent).not.toMatch(
      /secret-proof|\/home\/coder/,
    );
    expect(mockToastError).toHaveBeenCalledWith("Could not add Git terminal", {
      description: serverError,
    });
    expect(screen.getByTestId("multi-session-empty")).toBeInTheDocument();
    expect(window.localStorage.getItem("workspace-board-state:git:ws-1")).toBeNull();
  });

  it("starts Git workspaces empty, adds searched repositories, and persists selected clone refs", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
            {
              id: "repo-docs",
              kind: "repository",
              label: "docs",
              relativePath: "kethalia/docs",
              relativePathSegments: ["kethalia", "docs"],
              displaySegments: ["Git", "home", "kethalia", "docs"],
              cloneSessionKey: "git-clone:kethalia/docs",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("multi-session-empty")).toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-command-palette-search")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    expect(await screen.findByTestId("multi-session-command-palette")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    expect(
      screen.getByTestId("palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add"),
    ).toHaveTextContent("Add");

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    expect(await screen.findByTestId("multi-session-workspace")).toHaveAttribute(
      "data-session-source",
      "unified",
    );
    expect(screen.queryByTestId("multi-session-command-palette")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("kethalia/hive");
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-path",
      "kethalia/hive",
    );
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "proof-token",
    );
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
      agentId: "agent-1",
      workspaceId: "ws-1",
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
    });

    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1");
    expect(stored).toContain("git-clone:kethalia/hive");
    expect(stored).toContain("kethalia/hive");
    expect(stored).not.toContain("proof-token");

    await act(async () => {
      fireEvent.click(screen.getByTestId("remove-pane-pane-git-clone-safe-hive"));
    });
    expect(await screen.findByTestId("active-board-empty")).toBeInTheDocument();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("workspace-board-state:git:ws-1")).not.toContain(
      "git-clone:kethalia/hive",
    );
  });

  it("renders quiet aggregate recovery status without mutating workspace or Git identity", async () => {
    let keepAliveStatus: KeepAliveStatus = {
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      lastFailureReason: null,
      lastFailureDetail: null,
      lastHttpStatus: null,
      lastHttpStatusText: null,
      lastAttemptDurationMs: null,
      activeConnectionCount: 0,
      lastDisconnectedAt: null,
      isLoading: false,
    };
    mockUseKeepAliveStatus.mockImplementation(() => keepAliveStatus);
    window.localStorage.setItem(
      "workspace-board-state:git:ws-1",
      JSON.stringify({
        version: 1,
        activeBoardKey: "default",
        boards: [
          {
            key: "default",
            name: "Default",
            order: 0,
            activePaneKey: "terminal:main-session",
            panes: [
              {
                kind: "terminal",
                key: "terminal:main-session",
                sessionName: "main-session",
                label: "main-session",
                order: 0,
              },
              {
                kind: "git",
                key: "git:git-clone:kethalia/hive:kethalia/hive",
                cloneSessionKey: "git-clone:kethalia/hive",
                relativePath: "kethalia/hive",
                sessionName: "git-clone-safe-hive",
                label: "kethalia/hive",
                order: 1,
              },
            ],
          },
        ],
      }),
    );
    mockGetSessions.mockResolvedValueOnce({ data: [{ name: "main-session", created: 1 }] });
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "stale-proof-token",
        },
      })
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "fresh-proof-token",
        },
      });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "stale-proof-token",
    );
    const activeLabelBefore = screen.getByTestId("active-pane-label").textContent;
    const mainLayoutSignal = screen
      .getByTestId("interactive-terminal-main-session")
      .getAttribute("data-layout-signal");
    const gitLayoutSignal = screen
      .getByTestId("interactive-terminal-git-clone-safe-hive")
      .getAttribute("data-layout-signal");
    expect([...terminalProps.keys()].sort()).toEqual(["git-clone-safe-hive", "main-session"]);
    expect(terminalProps.get("git-clone-safe-hive")).toMatchObject({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      cloneProof: "stale-proof-token",
    });
    expect(window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "").toContain(
      "git-clone:kethalia/hive",
    );

    keepAliveStatus = {
      status: "failing",
      consecutiveFailures: 1,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: "2026-06-07T19:41:00.000Z",
      lastFailureCategory: "network",
      lastFailureReason: "network-error",
      lastFailureDetail: "Network error while contacting Coder API.",
      lastHttpStatus: null,
      lastHttpStatusText: null,
      lastAttemptDurationMs: 123,
      activeConnectionCount: 2,
      lastDisconnectedAt: null,
      isLoading: false,
    };
    act(() => {
      terminalProps.get("main-session")?.onConnectionStateChange?.("reconnecting");
      terminalProps.get("main-session")?.onRecoveryStateChange?.({
        phase: "recovering",
        retryCount: 2,
        lastCloseCategory: "transient",
        lastReasonCategory: "upstream-timeout",
        lastRecoveryAction: "schedule-reconnect",
        isRecoverable: true,
      });
      terminalProps.get("git-clone-safe-hive")?.onConnectionStateChange?.("reconnecting");
      terminalProps.get("git-clone-safe-hive")?.onRecoveryStateChange?.({
        phase: "recovering",
        retryCount: 1,
        lastCloseCategory: "clone-proof-invalid",
        lastReasonCategory: "clone-proof-invalid",
        lastRecoveryAction: "schedule-reconnect",
        isRecoverable: true,
      });
    });

    const status = await screen.findByTestId("workspace-recovery-status");
    expect(status).toHaveTextContent("Workspace panes are recovering.");
    expect(status).toHaveAttribute("data-workspace-recovery-pane-count", "2");
    expect(status).toHaveAttribute("data-workspace-recovery-unhealthy-pane-count", "2");
    expect(status).toHaveAttribute("data-workspace-recovery-phase", "recovering");
    expect(status).toHaveAttribute("data-workspace-recovery-keepalive-status", "failing");
    expect(status).toHaveAttribute("data-workspace-recovery-keepalive-category", "network");
    expect(status.getAttribute("data-workspace-recovery-categories") ?? "").toContain(
      "terminal:upstream-timeout",
    );
    expect(status.getAttribute("data-workspace-recovery-categories") ?? "").toContain(
      "terminal:clone-proof-invalid",
    );
    expect(status.getAttribute("data-workspace-recovery-categories") ?? "").toContain(
      "keepalive:network",
    );
    expect(status.textContent).not.toMatch(
      /stale-proof-token|fresh-proof-token|cloneProof|clonePath|\/home\/coder|token|wss?:\/\//,
    );
    expect(screen.getByTestId("workspace-pane-main-session").firstElementChild).toHaveTextContent(
      "main-session",
    );
    expect(
      screen.getByTestId("workspace-pane-git-clone-safe-hive").firstElementChild,
    ).toHaveTextContent("kethalia/hive");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent(activeLabelBefore ?? "");
    expect(screen.getByTestId("workspace-pane-main-session")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      mainLayoutSignal ?? "",
    );
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-layout-signal",
      gitLayoutSignal ?? "",
    );

    let refreshed: { sessionName: string; clonePath: string; cloneProof: string } | undefined;
    await act(async () => {
      refreshed = await terminalProps.get("git-clone-safe-hive")?.refreshCloneTerminalIdentity?.({
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        reason: "scheduled-reconnect",
        retryCount: 1,
        closeCode: 4401,
        closeCategory: "clone-proof-invalid",
        reasonCategory: "clone-proof-invalid",
      });
    });

    expect(refreshed).toEqual({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      cloneProof: "fresh-proof-token",
    });
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(screen.queryByTestId("interactive-terminal-git-clone-other")).not.toBeInTheDocument();
    const storedAfterRefresh = window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "";
    expect(storedAfterRefresh).toContain("git-clone:kethalia/hive");
    expect(storedAfterRefresh).toContain("kethalia/hive");
    expect(storedAfterRefresh).not.toMatch(
      /cloneProof|clonePath|stale-proof-token|fresh-proof-token|\/home\/coder/,
    );

    keepAliveStatus = {
      status: "healthy",
      consecutiveFailures: 0,
      lastAttempt: null,
      lastSuccess: null,
      lastFailure: null,
      lastFailureCategory: null,
      lastFailureReason: null,
      lastFailureDetail: null,
      lastHttpStatus: null,
      lastHttpStatusText: null,
      lastAttemptDurationMs: null,
      activeConnectionCount: 2,
      lastDisconnectedAt: null,
      isLoading: false,
    };
    act(() => {
      terminalProps.get("main-session")?.onConnectionStateChange?.("connected");
      terminalProps.get("main-session")?.onRecoveryStateChange?.({
        phase: "connected",
        lastRecoveryAction: "connected",
        isRecoverable: true,
      });
      terminalProps.get("git-clone-safe-hive")?.onConnectionStateChange?.("connected");
      terminalProps.get("git-clone-safe-hive")?.onRecoveryStateChange?.({
        phase: "connected",
        lastRecoveryAction: "connected",
        isRecoverable: true,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("workspace-recovery-status")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent(activeLabelBefore ?? "");
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-layout-signal",
      gitLayoutSignal ?? "",
    );

    act(() => {
      terminalProps.get("main-session")?.onConnectionStateChange?.("reconnecting");
      terminalProps.get("main-session")?.onRecoveryStateChange?.({
        phase: "recovering",
        lastCloseCategory: "transient",
        lastReasonCategory: "upstream-timeout",
        lastRecoveryAction: "schedule-reconnect",
        isRecoverable: true,
      });
    });
    expect(await screen.findByTestId("workspace-recovery-status")).toHaveAttribute(
      "data-workspace-recovery-unhealthy-pane-count",
      "1",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("remove-pane-pane-main-session"));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-recovery-status")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId("palette-option-workspace:session:main-session-add"));
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-recovery-status")).not.toBeInTheDocument();
  });

  it("refreshes Git pane clone identity in memory without persisting proof material", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "stale-proof-token",
        },
      })
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "fresh-proof-token",
        },
      });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "stale-proof-token",
    );
    expect(typeof terminalProps.get("git-clone-safe-hive")?.refreshCloneTerminalIdentity).toBe(
      "function",
    );

    let refreshed: { sessionName: string; clonePath: string; cloneProof: string } | undefined;
    await act(async () => {
      refreshed = await terminalProps.get("git-clone-safe-hive")?.refreshCloneTerminalIdentity?.({
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        reason: "scheduled-reconnect",
        retryCount: 1,
        closeCode: 4401,
        closeCategory: "clone-proof-invalid",
        reasonCategory: "clone-proof-invalid",
      });
    });

    expect(refreshed).toEqual({
      sessionName: "git-clone-safe-hive",
      clonePath: "kethalia/hive",
      cloneProof: "fresh-proof-token",
    });
    expect(mockResolveGitCloneTerminal).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      workspaceId: "ws-1",
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
    });
    expect(mockResolveGitCloneTerminal.mock.calls[1][0]).not.toHaveProperty("cloneProof");
    expect(mockResolveGitCloneTerminal.mock.calls[1][0]).not.toHaveProperty("clonePath");
    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("kethalia/hive");

    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "";
    expect(stored).toContain("git-clone:kethalia/hive");
    expect(stored).toContain("kethalia/hive");
    expect(stored).not.toMatch(/cloneProof|clonePath|stale-proof-token|fresh-proof-token/);
  });

  it("rejects mismatched Git pane refresh identity without changing live or persisted proof state", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-safe-hive",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "stable-proof-token",
        },
      })
      .mockResolvedValueOnce({
        data: {
          sessionName: "git-clone-other",
          clonePath: "kethalia/hive",
          cloneSessionKey: "git-clone:kethalia/hive",
          cloneProof: "wrong-proof-token",
        },
      });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    await expect(
      terminalProps.get("git-clone-safe-hive")?.refreshCloneTerminalIdentity?.({
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        reason: "manual-reconnect",
        retryCount: 0,
        closeCode: 4401,
        closeCategory: "clone-proof-invalid",
        reasonCategory: "clone-proof-invalid",
      }),
    ).rejects.toThrow("Git clone terminal refresh failed");

    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "stable-proof-token",
    );
    expect(screen.queryByTestId("interactive-terminal-git-clone-other")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "").not.toMatch(
      /wrong-proof-token|git-clone-other|cloneProof|clonePath/,
    );
    expect(screen.queryByText(/wrong-proof-token|git-clone-other/)).not.toBeInTheDocument();
  });

  it("includes public clone identifiers when opening Git terminals as standalone pages", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValue({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-open",
        ),
      );
    });

    let pushed = new URL(mockRouterPush.mock.calls.at(-1)?.[0] ?? "", "https://example.test");
    expect(pushed.pathname).toBe("/workspaces/ws-1/terminal");
    expect(pushed.searchParams.get("session")).toBe("git-clone-safe-hive");
    expect(pushed.searchParams.get("clonePath")).toBe("kethalia/hive");
    expect(pushed.searchParams.get("cloneProof")).toBe("proof-token");
    expect(pushed.searchParams.get("cloneSessionKey")).toBe("git-clone:kethalia/hive");
    expect(pushed.searchParams.get("relativePath")).toBe("kethalia/hive");

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    fireEvent.click(
      screen.getByTestId("palette-option-workspace:session:git-clone-safe-hive-open"),
    );

    pushed = new URL(mockRouterPush.mock.calls.at(-1)?.[0] ?? "", "https://example.test");
    expect(pushed.searchParams.get("cloneSessionKey")).toBe("git-clone:kethalia/hive");
    expect(pushed.searchParams.get("relativePath")).toBe("kethalia/hive");
    expect(pushed.searchParams.get("cloneProof")).toBe("proof-token");
  });

  it("opens the workspace palette from the button and registers immediate plain terminal shortcuts", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    expect(
      mockRegister.mock.calls.some(
        ([entry]) => entry.id === "multi-session:ws-1:open-session-search",
      ),
    ).toBe(false);
    expect(mockRegister.mock.calls.some(([entry]) => entry.id === "command-palette")).toBe(false);

    fireEvent.click(screen.getByTestId("open-git-session-search"));
    expect(await screen.findByTestId("multi-session-command-palette")).toBeInTheDocument();
    expect(mockListNavigationFavorites).toHaveBeenCalledWith({ workspaceId: "ws-1", kind: "git" });

    mockCreateSession.mockResolvedValueOnce({ data: { name: "plain-main" } });
    const createBinding = mockRegister.mock.calls
      .filter(([entry]) => entry.id === "multi-session:ws-1:create-terminal-session")
      .at(-1)?.[0];
    expect(createBinding.keys).toEqual(["ctrl+shift+n", "cmd+shift+n"]);
    expect(createBinding.global).toBe(true);
    act(() => {
      expect(createBinding.action(null, null)).toBe(false);
    });
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
  });

  it("registers Ctrl+W as a PWA-only close-active-pane shortcut", async () => {
    mockGetSessions.mockResolvedValueOnce(twoSessionPayload());
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("workspace-pane-main-session");

    const closeBinding = lastRegisteredEntry("multi-session:ws-1:close-active-pane");
    expect(closeBinding).toBeDefined();
    if (!closeBinding) throw new Error("missing close-active-pane binding");
    expect(closeBinding.keys).toEqual(["ctrl+w"]);
    expect(closeBinding.enabledInBrowser).toBe(false);
    expect(closeBinding.global).toBe(true);

    setPwaStandalone(false);
    act(() => {
      expect(closeBinding.action(null, null)).toBe(true);
    });
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();

    setPwaStandalone(true);
    act(() => {
      expect(closeBinding.action(null, null)).toBe(false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("ignores the PWA close-pane shortcut while no pane is available", async () => {
    mockGetSessions.mockResolvedValueOnce({ data: [] });
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    const closeBinding = lastRegisteredEntry("multi-session:ws-1:close-active-pane");
    expect(closeBinding).toBeDefined();
    if (!closeBinding) throw new Error("missing close-active-pane binding");

    setPwaStandalone(true);
    expect(() => {
      act(() => {
        expect(closeBinding.action(null, null)).toBe(false);
      });
    }).not.toThrow();
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("shows Git terminal font size controls that update mounted terminals", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");
    fireEvent.click(screen.getByTestId("open-git-session-search"));
    fireEvent.change(await screen.findByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });

    await act(async () => {
      fireEvent.click(
        await screen.findByTestId(
          "palette-option-workspace:git:git-clone:kethalia/hive:kethalia/hive-add",
        ),
      );
    });

    expect(await screen.findByTestId("git-terminal-font-size-controls")).toHaveTextContent("13px");
    fireEvent.click(screen.getByTestId("increase-git-terminal-font-size"));
    expect(screen.getByTestId("git-terminal-font-size-controls")).toHaveTextContent("14px");
    expect(localStorage.getItem("terminal:font-size")).toBe("14");
  });

  it("pins Git favorites at the top of command palette Git actions", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:kethalia/hive",
            },
            {
              id: "repo-docs",
              kind: "repository",
              label: "docs",
              relativePath: "kethalia/docs",
              relativePathSegments: ["kethalia", "docs"],
              displaySegments: ["Git", "home", "kethalia", "docs"],
              cloneSessionKey: "git-clone:kethalia/docs",
            },
          ],
        },
      },
    });
    mockListNavigationFavorites.mockResolvedValueOnce({
      data: [
        {
          id: "fav-1",
          kind: "git",
          workspaceId: "ws-1",
          targetKey: "git-clone:kethalia/docs",
          label: "Docs repo",
          relativePath: "kethalia/docs",
          createdAt: "2026-06-04T00:00:00.000Z",
        },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);
    await screen.findByTestId("multi-session-empty");

    fireEvent.click(screen.getByTestId("open-git-session-search"));

    await waitFor(() => {
      expect(
        screen.getByTestId(
          "palette-option-workspace:git:git-clone:kethalia/docs:kethalia/docs-add",
        ),
      ).toHaveTextContent("Add");
    });

    fireEvent.change(screen.getByTestId("workspace-command-palette-search"), {
      target: { value: "kethalia" },
    });
    const resultButtons = screen
      .getAllByRole("button")
      .filter((button) => button.dataset.testid?.startsWith("palette-action-workspace:git:"))
      .map((button) => button.textContent);
    expect(resultButtons[0]).toContain("kethalia/docs");
    expect(resultButtons[1]).toContain("kethalia/hive");
  });

  it("restores persisted Git workspace selections by resolving fresh clone proofs", async () => {
    window.localStorage.setItem(
      "multi-session-layout:git:ws-1",
      JSON.stringify({
        version: 1,
        activeSessionName: "git-clone-safe-docs",
        panes: [
          {
            sessionName: "stale-docs-session",
            mode: "tiled",
            order: 0,
            cloneSessionKey: "git-clone:monorepo",
            relativePath: "kethalia/docs",
            label: "kethalia/docs",
            cloneProof: "persisted-proof-should-not-be-read",
            clonePath: "/home/coder/projects/kethalia/docs",
          },
        ],
      }),
    );
    mockListGitClones.mockResolvedValueOnce({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              id: "repo-hive",
              kind: "repository",
              label: "hive",
              relativePath: "kethalia/hive",
              relativePathSegments: ["kethalia", "hive"],
              displaySegments: ["Git", "home", "kethalia", "hive"],
              cloneSessionKey: "git-clone:monorepo",
            },
            {
              id: "repo-docs",
              kind: "repository",
              label: "docs",
              relativePath: "kethalia/docs",
              relativePathSegments: ["kethalia", "docs"],
              displaySegments: ["Git", "home", "kethalia", "docs"],
              cloneSessionKey: "git-clone:monorepo",
            },
          ],
        },
      },
    });
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      data: {
        sessionName: "git-clone-safe-docs",
        clonePath: "kethalia/docs",
        cloneSessionKey: "git-clone:monorepo",
        cloneProof: "fresh-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-docs")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(screen.queryByTestId("interactive-terminal-stale-docs-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("kethalia/docs");
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
      agentId: "agent-1",
      workspaceId: "ws-1",
      cloneSessionKey: "git-clone:monorepo",
      relativePath: "kethalia/docs",
    });
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/persisted-proof|fresh-proof-token|\/home\/coder|stale-docs-session/),
    ).not.toBeInTheDocument();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("surfaces sanitized load and create failures", async () => {
    mockGetSessions.mockRejectedValueOnce(new Error("secret workspace failure"));
    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("session-load-error")).toHaveTextContent(
      "Could not load terminal sessions.",
    );
    expect(screen.queryByText(/secret workspace failure/)).not.toBeInTheDocument();

    cleanup();
    mockGetSessions.mockResolvedValueOnce({ data: [] });
    mockCreateSession.mockRejectedValueOnce(new Error("secret create failure"));
    render(<MultiSessionWorkspace {...defaultProps} />);

    await screen.findByTestId("multi-session-empty");
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-empty-session-button"));
    });

    expect(await screen.findByTestId("session-create-error")).toHaveTextContent(
      "Could not create a terminal session.",
    );
    expect(screen.queryByText(/secret create failure/)).not.toBeInTheDocument();
  });
});
