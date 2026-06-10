// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import { MultiSessionWorkspace } from "@/components/workspaces/MultiSessionWorkspace";

const mockCreateSession = vi.fn();
const mockGetSessions = vi.fn();
const mockKillSession = vi.fn();
const mockListGitClones = vi.fn();
const mockResolveGitCloneTerminal = vi.fn();
const mockCloseGitCloneTerminal = vi.fn();
const mockListNavigationFavorites = vi.fn();
const mockRouterPush = vi.fn();
const mockToastInfo = vi.hoisted(() => vi.fn());
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

vi.mock("sonner", () => ({
  toast: {
    info: mockToastInfo,
  },
}));

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<{ InteractiveTerminal: React.ComponentType<unknown> }>) => {
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

vi.mock("@/lib/terminal/actions", () => ({
  copyTerminalSelection: vi.fn(() => false),
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

function twoSessionPayload() {
  return {
    data: [
      { name: "main-session", created: 1, windows: 1 },
      { name: "dev-server", created: 2, windows: 1 },
    ],
  };
}

function emptyGitDiscoveryPayload() {
  return { data: { ok: true, tree: { nodes: [] } } };
}

function hiveGitDiscoveryPayload() {
  return {
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
            displaySegments: ["Git", "projects", "kethalia", "hive"],
            cloneSessionKey: "git-clone:kethalia/hive",
          },
        ],
      },
    },
  };
}

function gitIdentityPayload(sessionName: string, cloneProof: string) {
  return {
    data: {
      sessionName,
      clonePath: "kethalia/hive",
      cloneSessionKey: "git-clone:kethalia/hive",
      cloneProof,
    },
  };
}

function seedTwoBoardState() {
  window.localStorage.setItem(
    "workspace-board-state:git:ws-1",
    JSON.stringify({
      version: 1,
      activeBoardKey: "main",
      boards: [
        {
          key: "main",
          name: "Main",
          order: 0,
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
          key: "review",
          name: "Review",
          order: 1,
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
}

function seedHostileGitBoardState() {
  window.localStorage.setItem(
    "workspace-board-state:git:ws-1",
    JSON.stringify({
      version: 1,
      activeBoardKey: "main",
      boards: [
        {
          key: "main",
          name: "Main",
          order: 0,
          activePaneKey: "terminal:main-session",
          panes: [
            {
              kind: "terminal",
              key: "terminal:main-session",
              sessionName: "main-session",
              label: "Main Board Pane",
              terminalContents: "Bearer persisted-terminal-token",
              cwd: "/home/coder/projects/kethalia/hive",
              order: 0,
            },
          ],
        },
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
              token: "secret-token-should-not-persist",
              terminalBuffer: "terminal output should not persist",
              nested: { cloneProof: "nested-proof", clonePath: "C:\\Users\\repo" },
              order: 0,
            },
          ],
        },
      ],
    }),
  );
}

function readStoredActiveBoardKey() {
  return readStoredBoardState().activeBoardKey;
}

function readStoredBoardState() {
  return JSON.parse(window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "{}");
}

function readStoredBoardJson() {
  return window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "";
}

function expectStoredBoardJsonSanitized(stored = readStoredBoardJson()) {
  expect(stored).not.toMatch(
    /cloneProof|clonePath|persisted-proof|fresh-proof|stale-session-name|terminalContents|terminalBuffer|Bearer|token|secret|cwd|\/home\/coder|\/Users|C:\\\\Users/,
  );
}

function expectResolverCalledWithSafeGitIdentity(callIndex = 0) {
  expect(mockResolveGitCloneTerminal.mock.calls[callIndex]).toEqual([
    {
      agentId: "agent-1",
      workspaceId: "ws-1",
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
    },
  ]);
}

function makeKeyEvent(opts: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", opts);
}

function dispatchFromTerminalInput(target: HTMLElement, event: KeyboardEvent) {
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

  act(() => {
    target.dispatchEvent(event);
  });

  return { stopImmediatePropagation, stopPropagation };
}

function mockStandaloneDisplayMode(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
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

describe("workspace board shortcut integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalProps.clear();
    window.localStorage.clear();
    mockGetSessions.mockResolvedValue(twoSessionPayload());
    mockListGitClones.mockResolvedValue(emptyGitDiscoveryPayload());
    mockKillSession.mockResolvedValue({ data: { name: "main-session" } });
    mockCloseGitCloneTerminal.mockResolvedValue({ data: { sessionName: "git-clone-safe-hive" } });
    mockResolveGitCloneTerminal.mockResolvedValue({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneProof: "proof-token",
      },
    });
    mockCreateSession.mockResolvedValue({ data: { name: "new-session" } });
    mockListNavigationFavorites.mockResolvedValue({ data: [] });
    mockRouterPush.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("captures real provider board shortcuts from terminal focus while nearby input passes through", async () => {
    seedTwoBoardState();
    mockStandaloneDisplayMode(false);

    render(
      <KeybindingProvider>
        <MultiSessionWorkspace agentId="agent-1" workspaceId="ws-1" source="unified" />
      </KeybindingProvider>,
    );

    expect(await screen.findByTestId("workspace-board-tab-main")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Main Board Pane");
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "main:terminal:main-session:1:1:1 / 1 / span 1 / span 1:viewport:0:0",
    );
    expect(screen.queryByTestId("board-persistence-status")).not.toBeInTheDocument();
    expect(readStoredActiveBoardKey()).toBe("main");

    const mainInput = screen.getByTestId("terminal-input-main-session");
    const ctrlNext = makeKeyEvent({
      key: "ArrowRight",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const ctrlSpies = dispatchFromTerminalInput(mainInput, ctrlNext);

    expect(ctrlNext.defaultPrevented).toBe(true);
    expect(ctrlSpies.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ctrlSpies.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Review Board Pane");
    expect(screen.getByTestId("interactive-terminal-dev-server")).toHaveAttribute(
      "data-layout-signal",
      "review:terminal:dev-server:1:1:1 / 1 / span 1 / span 1:viewport:0:0",
    );
    expect(readStoredActiveBoardKey()).toBe("review");

    const reviewInput = screen.getByTestId("terminal-input-dev-server");
    const metaNext = makeKeyEvent({
      key: "ArrowRight",
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const metaSpies = dispatchFromTerminalInput(reviewInput, metaNext);

    expect(metaNext.defaultPrevented).toBe(true);
    expect(metaSpies.stopPropagation).toHaveBeenCalledTimes(1);
    expect(metaSpies.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Main Board Pane");
    expect(screen.getByTestId("interactive-terminal-main-session")).toHaveAttribute(
      "data-layout-signal",
      "main:terminal:main-session:1:1:1 / 1 / span 1 / span 1:viewport:0:0",
    );
    expect(readStoredActiveBoardKey()).toBe("main");

    await act(async () => {});
    const directSecond = makeKeyEvent({
      key: "2",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const directSecondSpies = dispatchFromTerminalInput(
      await screen.findByTestId("terminal-input-main-session"),
      directSecond,
    );

    expect(directSecond.defaultPrevented).toBe(true);
    expect(directSecondSpies.stopPropagation).toHaveBeenCalledTimes(1);
    expect(directSecondSpies.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(readStoredActiveBoardKey()).toBe("review");

    const directMissing = makeKeyEvent({
      key: "3",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const directMissingSpies = dispatchFromTerminalInput(
      await screen.findByTestId("terminal-input-dev-server"),
      directMissing,
    );

    expect(directMissing.defaultPrevented).toBe(true);
    expect(directMissingSpies.stopPropagation).toHaveBeenCalledTimes(1);
    expect(directMissingSpies.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(mockToastInfo).toHaveBeenCalledWith("Workspace 3 does not exist.");
    expect(readStoredActiveBoardKey()).toBe("review");

    const directFirst = makeKeyEvent({
      key: "1",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    dispatchFromTerminalInput(await screen.findByTestId("terminal-input-dev-server"), directFirst);
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAttribute("aria-selected", "true");
    expect(readStoredActiveBoardKey()).toBe("main");

    const activeInput = await screen.findByTestId("terminal-input-main-session");
    const unmatchedEvents = [
      makeKeyEvent({ key: "ArrowRight", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowLeft", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "a", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "v", ctrlKey: true, bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "v", metaKey: true, bubbles: true, cancelable: true }),
    ];

    for (const event of unmatchedEvents) {
      const spies = dispatchFromTerminalInput(activeInput, event);

      expect(event.defaultPrevented).toBe(false);
      expect(spies.stopPropagation).not.toHaveBeenCalled();
      expect(spies.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(screen.getByTestId("workspace-board-tab-main")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(readStoredActiveBoardKey()).toBe("main");
    }

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("refreshes persisted Git board identity on reload while keeping board storage and removal non-destructive", async () => {
    seedHostileGitBoardState();
    mockListGitClones.mockResolvedValue(hiveGitDiscoveryPayload());
    mockResolveGitCloneTerminal.mockResolvedValue(
      gitIdentityPayload("git-clone-safe-hive-fresh-a", "fresh-proof-token-a"),
    );

    const { unmount } = render(
      <KeybindingProvider>
        <MultiSessionWorkspace agentId="agent-1" workspaceId="ws-1" source="unified" />
      </KeybindingProvider>,
    );

    expect(await screen.findByTestId("workspace-board-tab-main")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1));
    expectResolverCalledWithSafeGitIdentity(0);
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("cloneProof");
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("clonePath");
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("sessionName");

    fireEvent.click(screen.getByTestId("workspace-board-tab-review"));

    expect(
      await screen.findByTestId("interactive-terminal-git-clone-safe-hive-fresh-a"),
    ).toHaveAttribute("data-clone-proof", "fresh-proof-token-a");
    expect(screen.getByTestId("interactive-terminal-git-clone-safe-hive-fresh-a")).toHaveAttribute(
      "data-clone-path",
      "kethalia/hive",
    );
    expect(screen.queryByTestId("interactive-terminal-stale-session-name")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Hive Review");
    expect(
      screen.queryByText(/persisted-proof|fresh-proof|stale-session-name|\/home\/coder|token/),
    ).not.toBeInTheDocument();

    const storedAfterSelection = readStoredBoardState();
    expect(storedAfterSelection.activeBoardKey).toBe("review");
    expect(
      storedAfterSelection.boards.find((board: { key: string }) => board.key === "review").panes[0],
    ).toMatchObject({
      kind: "git",
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
      sessionName: "git-clone-safe-hive-fresh-a",
      label: "Hive Review",
    });
    expectStoredBoardJsonSanitized();

    unmount();
    terminalProps.clear();
    mockGetSessions.mockClear();
    mockListGitClones.mockClear();
    mockResolveGitCloneTerminal.mockClear();
    mockKillSession.mockClear();
    mockCloseGitCloneTerminal.mockClear();
    mockCreateSession.mockClear();
    mockRouterPush.mockClear();
    mockResolveGitCloneTerminal.mockResolvedValue(
      gitIdentityPayload("git-clone-safe-hive-fresh-b", "fresh-proof-token-b"),
    );

    render(
      <KeybindingProvider>
        <MultiSessionWorkspace agentId="agent-1" workspaceId="ws-1" source="unified" />
      </KeybindingProvider>,
    );

    expect(
      await screen.findByTestId("interactive-terminal-git-clone-safe-hive-fresh-b"),
    ).toHaveAttribute("data-clone-proof", "fresh-proof-token-b");
    expect(
      screen.queryByTestId("interactive-terminal-git-clone-safe-hive-fresh-a"),
    ).not.toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);
    expectResolverCalledWithSafeGitIdentity(0);
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("cloneProof");
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("clonePath");
    expect(mockResolveGitCloneTerminal.mock.calls[0][0]).not.toHaveProperty("sessionName");

    fireEvent.click(screen.getByTestId("workspace-board-tab-main"));
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("Main Board Pane");
    const storedAfterRemountSelection = readStoredBoardState();
    expect(storedAfterRemountSelection.activeBoardKey).toBe("main");
    expect(
      storedAfterRemountSelection.boards.find((board: { key: string }) => board.key === "review")
        .panes[0],
    ).toMatchObject({
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
      sessionName: "git-clone-safe-hive-fresh-b",
    });
    expectStoredBoardJsonSanitized();

    fireEvent.click(screen.getByTestId("workspace-board-tab-review"));
    expect(
      await screen.findByTestId("workspace-pane-git-clone-safe-hive-fresh-b"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("remove-pane-pane-git-clone-safe-hive-fresh-b"));

    expect(
      screen.queryByTestId("workspace-pane-git-clone-safe-hive-fresh-b"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("active-board-empty")).toBeInTheDocument();
    const storedAfterRemoval = readStoredBoardState();
    expect(
      storedAfterRemoval.boards.find((board: { key: string }) => board.key === "main").panes,
    ).toEqual([
      expect.objectContaining({
        kind: "terminal",
        sessionName: "main-session",
        label: "Main Board Pane",
      }),
    ]);
    expect(
      storedAfterRemoval.boards.find((board: { key: string }) => board.key === "review").panes,
    ).toEqual([]);
    expectStoredBoardJsonSanitized();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();

    fireEvent.mouseEnter(screen.getByTestId("workspace-board-tab-review"));
    fireEvent.click(screen.getByTestId("workspace-board-tab-review"));

    expect(screen.queryByTestId("workspace-board-tab-review")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAttribute("aria-selected", "true");
    const storedAfterDeletion = readStoredBoardState();
    expect(storedAfterDeletion.boards).toHaveLength(1);
    expect(storedAfterDeletion.boards[0]).toMatchObject({ key: "main", name: "Main" });
    expectStoredBoardJsonSanitized();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockKillSession).not.toHaveBeenCalled();
    expect(mockCloseGitCloneTerminal).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
