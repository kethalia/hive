// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";

const mockCreateSession = vi.fn();
const mockGetSessions = vi.fn();
const mockKillSession = vi.fn();
const mockListGitClones = vi.fn();
const mockResolveGitCloneTerminal = vi.fn();
const mockCloseGitCloneTerminal = vi.fn();
const mockListNavigationFavorites = vi.fn();
const mockSetActiveTerminal = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();
const mockRouterPush = vi.fn();
const terminalProps = new Map<
  string,
  {
    agentId: string;
    workspaceId: string;
    sessionName: string;
    clonePath?: string;
    cloneProof?: string;
    className?: string;
    layoutSignal?: unknown;
    onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
    onTerminalDestroy?: () => void;
  }
>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
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
      className,
      layoutSignal,
      onTerminalReady,
      onTerminalDestroy,
    }: {
      agentId: string;
      workspaceId: string;
      sessionName: string;
      clonePath?: string;
      cloneProof?: string;
      className?: string;
      layoutSignal?: unknown;
      onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
      onTerminalDestroy?: () => void;
    }) => {
      terminalProps.set(sessionName, {
        agentId,
        workspaceId,
        sessionName,
        clonePath,
        cloneProof,
        className,
        layoutSignal,
        onTerminalReady,
        onTerminalDestroy,
      });
      return (
        <div
          data-testid={`interactive-terminal-${sessionName}`}
          data-agent-id={agentId}
          data-workspace-id={workspaceId}
          data-session-name={sessionName}
          className={className}
          data-clone-path={clonePath}
          data-clone-proof={cloneProof}
          data-layout-signal={String(layoutSignal ?? "")}
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
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
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

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
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
      onSelect: () => void;
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
          <button
            key={action.id}
            type="button"
            data-testid={`palette-action-${action.id}`}
            onClick={() => {
              action.onSelect();
              onOpenChange?.(false);
            }}
          >
            <span>{action.label}</span>
            {action.description ? <span>{action.description}</span> : null}
            {action.rightLabel ? <span>{action.rightLabel}</span> : null}
          </button>
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Minus: () => <span data-testid="icon-minus" />,
  Plus: () => <span data-testid="icon-plus" />,
  Search: () => <span data-testid="icon-search" />,
  TerminalSquare: () => <span data-testid="icon-terminal-square" />,
  X: () => <span data-testid="icon-x" />,
}));

import { MultiSessionWorkspace } from "@/components/workspaces/MultiSessionWorkspace";

const defaultProps = {
  agentId: "agent-1",
  workspaceId: "ws-1",
};

function makeTerminal(name: string): Terminal {
  return {
    name,
    focus: vi.fn(),
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

async function renderTwoSessionWorkspace() {
  mockGetSessions.mockResolvedValue(twoSessionPayload());
  render(<MultiSessionWorkspace {...defaultProps} />);

  await waitFor(() => {
    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
  });
}

function lastRegisteredEntry(id: string) {
  return mockRegister.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.id === id)
    .at(-1);
}

describe("MultiSessionWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalProps.clear();
    window.localStorage.clear();
    mockGetSessions.mockResolvedValue({ data: [] });
    mockKillSession.mockResolvedValue({ data: { name: "main-session" } });
    mockCloseGitCloneTerminal.mockResolvedValue({ data: { sessionName: "git-clone-safe-hive" } });
    mockListNavigationFavorites.mockResolvedValue({ data: [] });
    mockRouterPush.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
    expect(screen.getByTestId("multi-session-body")).toHaveClass("p-1");
    expect(screen.getByTestId("multi-session-grid")).toHaveClass("gap-1");
    expect(screen.queryByTestId("copy-active-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("paste-active-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("float-pane-pane-main-session")).not.toBeInTheDocument();
  });

  it("gives the primary pane full height when three sessions are open", async () => {
    mockGetSessions.mockResolvedValue({
      data: [
        { name: "main-session", created: 1, windows: 1 },
        { name: "dev-server", created: 2, windows: 1 },
        { name: "shell", created: 3, windows: 1 },
      ],
    });

    render(<MultiSessionWorkspace {...defaultProps} />);

    expect(await screen.findByTestId("workspace-pane-main-session")).toHaveStyle({
      gridArea: "1 / 1 / span 2 / span 1",
    });
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveStyle({
      gridArea: "1 / 2 / span 1 / span 1",
    });
    expect(screen.getByTestId("workspace-pane-shell")).toHaveStyle({
      gridArea: "2 / 2 / span 1 / span 1",
    });
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "default:terminal:main-session:2:2:1 / 1 / span 2 / span 1",
    );
    expect(screen.getByTestId("workspace-pane-dev-server")).toHaveClass(
      "flex",
      "flex-col",
      "min-h-0",
    );
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveClass("min-h-0", "flex-1");
    expect(screen.getByTestId("interactive-terminal-dev-server").className).not.toContain(
      "calc(100%-2rem)",
    );
  });

  it("changes focus on hover and click while preserving terminal ownership", async () => {
    await renderTwoSessionWorkspace();
    const devTerm = makeTerminal("dev-server");
    const devSend = makeSender("dev-server");

    act(() => {
      terminalProps.get("dev-server")?.onTerminalReady?.(devTerm, devSend);
    });

    fireEvent.mouseEnter(screen.getByTestId("workspace-pane-dev-server"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(devTerm, devSend);
    expect(
      JSON.parse(window.localStorage.getItem("workspace-board-state:workspace:ws-1") ?? "{}")
        .boards[0].activePaneKey,
    ).toBe("terminal:dev-server");

    fireEvent.click(screen.getByTestId("workspace-pane-main-session"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
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

  it("switches active pane with Ctrl/Cmd arrow keys and focuses xterm", async () => {
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

    const nextBinding = lastRegisteredEntry("multi-session:ws-1:next-pane");
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
      "later:terminal:main-session:1:1:1 / 1 / span 1 / span 1",
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
      "earlier:terminal:dev-server:1:1:1 / 1 / span 1 / span 1",
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

    const firstBoard = lastRegisteredEntry("multi-session:ws-1:board-1");
    const thirdBoard = lastRegisteredEntry("multi-session:ws-1:board-3");
    expect(firstBoard).toMatchObject({
      id: "multi-session:ws-1:board-1",
      keys: ["cmd+1", "ctrl+1"],
      enabledInBrowser: false,
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
    expect(screen.getByTestId("workspace-shortcut-toast")).toHaveTextContent(
      "Workspace 3 does not exist.",
    );
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

  it("keeps pane headers compact without reorder controls or status badges", async () => {
    await renderTwoSessionWorkspace();

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

    fireEvent.click(screen.getByTestId("workspace-board-tab-default"));

    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(window.localStorage.getItem("workspace-board-state:workspace:ws-1")).toContain(
      "stale-session",
    );
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

    expect(
      screen.queryByTestId("palette-action-workspace:focus-session:dev-server"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("palette-action-workspace:add-session:dev-server")).toHaveTextContent(
      "Add this terminal to Workspace 2",
    );

    fireEvent.click(screen.getByTestId("palette-action-workspace:add-session:dev-server"));

    expect(screen.getByTestId("workspace-pane-dev-server")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-pane-main-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    const storedState = JSON.parse(
      window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "{}",
    );
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "default").panes,
    ).toEqual([
      expect.objectContaining({ kind: "terminal", sessionName: "main-session" }),
      expect.objectContaining({ kind: "terminal", sessionName: "dev-server" }),
    ]);
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "workspace-2").panes,
    ).toEqual([expect.objectContaining({ kind: "terminal", sessionName: "dev-server" })]);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
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

  it("keeps Git discovery failures as sanitized retryable load failures", async () => {
    mockListGitClones.mockRejectedValueOnce(
      new Error("secret discovery failure /home/coder/projects/kethalia/hive token-123"),
    );

    render(<MultiSessionWorkspace {...defaultProps} source="unified" />);

    expect(await screen.findByTestId("session-load-error")).toHaveTextContent(
      "Could not load terminal sessions.",
    );
    expect(screen.getByTestId("retry-load-sessions")).toHaveTextContent("Retry");
    expect(screen.queryByText(/secret discovery|\/home\/coder|token-123/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-session-restore-error")).not.toBeInTheDocument();
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

    const labels = Array.from(screen.getByTestId("multi-session-grid").children).map((pane) =>
      pane.getAttribute("aria-label")?.replace("Terminal pane ", ""),
    );
    expect(labels).toEqual(["dev-server", "main-session"]);
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

    expect(
      screen.getByTestId("palette-action-workspace:focus-session:dev-server"),
    ).toHaveTextContent("Focus in this board");
    expect(
      screen.getByTestId("palette-action-workspace:open-session:dev-server"),
    ).toHaveTextContent("Open as a single terminal page");

    fireEvent.change(screen.getByTestId("workspace-command-palette-search"), {
      target: { value: "hive" },
    });
    expect(
      screen.getByTestId("palette-action-workspace:add-git:git-clone:kethalia/hive"),
    ).toHaveTextContent("Open this Git repository as a workspace pane");
    expect(
      screen.getByTestId("palette-action-workspace:open-git:git-clone:kethalia/hive"),
    ).toHaveTextContent("Open this Git repository as a single terminal page");

    fireEvent.click(screen.getByTestId("palette-action-workspace:focus-session:dev-server"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
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
    fireEvent.click(screen.getByTestId("palette-action-workspace:add-session:main-session"));

    expect(screen.getByTestId("workspace-pane-main-session")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
    expect(mockSetActiveTerminal).toHaveBeenLastCalledWith(mainTerm, mainSend);
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("includes board pane identity in layout signals for shared terminal sessions", async () => {
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

    expect(await screen.findByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "default:terminal:main-session:1:1:1 / 1 / span 1 / span 1",
    );

    fireEvent.click(screen.getByTestId("workspace-board-tab-review"));

    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "review:terminal:main-session-review:1:1:1 / 1 / span 1 / span 1",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
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
      fireEvent.click(screen.getByRole("button", { name: /Add kethalia\/hive/ }));
    });

    expect(screen.getByTestId("workspace-pane-git-clone-safe-hive")).toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("kethalia/hive");
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);

    const stored = window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "";
    const storedState = JSON.parse(stored);
    expect(
      storedState.boards.find((board: { key: string }) => board.key === "default").panes,
    ).toEqual([
      expect.objectContaining({
        cloneSessionKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
      }),
    ]);
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

    expect(screen.queryByRole("button", { name: /Add kethalia\/hive/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add kethalia\/docs/ })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /Add kethalia\/docs/ })).toBeInTheDocument();
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
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
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
      fireEvent.click(screen.getByRole("button", { name: /Add kethalia\/hive/ }));
    });

    expect(await screen.findByTestId("git-session-add-error")).toHaveTextContent(
      "Could not add Git terminal. No terminal contents or clone proof were logged.",
    );
    expect(screen.getByTestId("git-session-add-error").textContent).not.toMatch(
      /secret-proof|\/home\/coder/,
    );
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
      screen.getByTestId("palette-action-workspace:add-git:git-clone:kethalia/hive"),
    ).toHaveTextContent("kethalia/hive");

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("palette-action-workspace:add-git:git-clone:kethalia/hive"),
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

  it("registers command palette and immediate plain terminal shortcuts", async () => {
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

    const paletteBinding = mockRegister.mock.calls
      .filter(([entry]) => entry.id === "command-palette")
      .at(-1)?.[0];
    expect(paletteBinding.keys).toEqual(["ctrl+k", "cmd+k"]);
    expect(paletteBinding.global).toBe(true);

    expect(
      mockRegister.mock.calls.some(
        ([entry]) => entry.id === "multi-session:ws-1:open-session-search",
      ),
    ).toBe(false);
    act(() => {
      expect(paletteBinding.action(null, null)).toBe(false);
    });

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
        await screen.findByTestId("palette-action-workspace:add-git:git-clone:kethalia/hive"),
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
        screen.getByTestId("palette-action-workspace:add-git:git-clone:kethalia/docs"),
      ).toHaveTextContent("kethalia/docs");
    });

    fireEvent.change(screen.getByTestId("workspace-command-palette-search"), {
      target: { value: "kethalia" },
    });
    const resultButtons = screen
      .getAllByRole("button")
      .filter((button) => button.dataset.testid?.startsWith("palette-action-workspace:add-git:"))
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
