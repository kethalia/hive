// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
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

function readStoredActiveBoardKey() {
  return JSON.parse(window.localStorage.getItem("workspace-board-state:git:ws-1") ?? "{}")
    .activeBoardKey;
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
      "main:terminal:main-session:1:1:1 / 1 / span 1 / span 1",
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
      "review:terminal:dev-server:1:1:1 / 1 / span 1 / span 1",
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
      "main:terminal:main-session:1:1:1 / 1 / span 1 / span 1",
    );
    expect(readStoredActiveBoardKey()).toBe("main");

    const activeInput = await screen.findByTestId("terminal-input-main-session");
    const unmatchedEvents = [
      makeKeyEvent({ key: "ArrowRight", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowLeft", bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }),
      makeKeyEvent({ key: "ArrowRight", metaKey: true, bubbles: true, cancelable: true }),
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
});
