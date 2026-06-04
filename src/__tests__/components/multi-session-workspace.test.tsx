// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { KeybindingContextValue } from "@/hooks/useKeybindings";

const mockCreateSession = vi.fn();
const mockGetSessions = vi.fn();
const mockListGitClones = vi.fn();
const mockResolveGitCloneTerminal = vi.fn();
const mockSetActiveTerminal = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();
const terminalProps = new Map<
  string,
  {
    agentId: string;
    workspaceId: string;
    sessionName: string;
    clonePath?: string;
    cloneProof?: string;
    layoutSignal?: unknown;
    onTerminalReady?: (term: Terminal, send: (data: string) => void) => void;
    onTerminalDestroy?: () => void;
  }
>();

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
      layoutSignal,
      onTerminalReady,
      onTerminalDestroy,
    }: {
      agentId: string;
      workspaceId: string;
      sessionName: string;
      clonePath?: string;
      cloneProof?: string;
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
          data-clone-path={clonePath}
          data-clone-proof={cloneProof}
        >
          Terminal: {sessionName}
        </div>
      );
    };
    Stub.displayName = "InteractiveTerminal";
    return Stub;
  },
}));

vi.mock("@/lib/actions/git-clones", () => ({
  listGitClonesAction: (...args: unknown[]) => mockListGitClones(...args),
  resolveGitCloneTerminalAction: (...args: unknown[]) => mockResolveGitCloneTerminal(...args),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetSessions(...args),
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

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    onMouseEnter,
    disabled,
    className,
    ...rest
  }: React.PropsWithChildren<{
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    className?: string;
    variant?: string;
    size?: string;
    "data-testid"?: string;
    "aria-label"?: string;
  }>) => (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      disabled={disabled}
      className={className}
      data-testid={rest["data-testid"]}
      aria-label={rest["aria-label"]}
    >
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

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Plus: () => <span data-testid="icon-plus" />,
  Search: () => <span data-testid="icon-search" />,
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

describe("MultiSessionWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalProps.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders tiled real panes with InteractiveTerminal props and active diagnostics", async () => {
    await renderTwoSessionWorkspace();

    expect(screen.getByTestId("multi-session-pane-count")).toHaveTextContent("2");
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
    expect(screen.queryByTestId("copy-active-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("paste-active-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("float-pane-pane-main-session")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByTestId("workspace-pane-main-session"));

    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("main-session");
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

    const nextBinding = mockRegister.mock.calls
      .filter(([entry]) => entry.id === "multi-session:ws-1:next-pane")
      .at(-1)?.[0];
    act(() => {
      expect(nextBinding.action(null, null)).toBe(false);
    });
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("moves panes with compact controls and persists order without terminal contents", async () => {
    await renderTwoSessionWorkspace();

    fireEvent.click(screen.getByTestId("move-pane-left-pane-dev-server"));

    const labels = within(screen.getByLabelText("Select terminal pane"))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["dev-server", "main-session"]);
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");

    const stored = window.localStorage.getItem("multi-session-layout:workspace:ws-1");
    expect(stored).toContain("dev-server");
    expect(stored).not.toMatch(/selection|clipboard|terminalBuffer|cloneProof/);
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

    const labels = within(screen.getByLabelText("Select terminal pane"))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["dev-server", "main-session"]);
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("dev-server");
  });

  it("creates generic workspace sessions but hides creation for Git source", async () => {
    await renderTwoSessionWorkspace();
    mockCreateSession.mockResolvedValueOnce({ data: { name: "created-main" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-session-button"));
    });

    expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(await screen.findByTestId("workspace-pane-created-main")).toBeInTheDocument();

    cleanup();
    terminalProps.clear();
    mockListGitClones.mockResolvedValueOnce({ data: { ok: true, tree: { nodes: [] } } });

    render(<MultiSessionWorkspace {...defaultProps} source="git" />);
    await screen.findByTestId("multi-session-empty");

    expect(screen.queryByTestId("create-session-button")).not.toBeInTheDocument();
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

    render(<MultiSessionWorkspace {...defaultProps} source="git" />);

    expect(await screen.findByTestId("multi-session-empty")).toBeInTheDocument();
    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("git-session-search"), { target: { value: "hive" } });
    expect(screen.getByTestId("git-session-results")).toHaveTextContent("kethalia/hive");

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-git-session-git-clone:kethalia/hive"));
    });

    expect(await screen.findByTestId("multi-session-workspace")).toHaveAttribute(
      "data-session-source",
      "git",
    );
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

    const stored = window.localStorage.getItem("multi-session-layout:git:ws-1");
    expect(stored).toContain("git-clone:kethalia/hive");
    expect(stored).toContain("kethalia/hive");
    expect(stored).not.toContain("proof-token");

    fireEvent.click(screen.getByTestId("remove-pane-pane-git-clone-safe-hive"));
    expect(await screen.findByTestId("multi-session-empty")).toBeInTheDocument();
    expect(window.localStorage.getItem("multi-session-layout:git:ws-1")).not.toContain(
      "git-clone:kethalia/hive",
    );
  });

  it("restores persisted Git workspace selections by resolving fresh clone proofs", async () => {
    window.localStorage.setItem(
      "multi-session-layout:git:ws-1",
      JSON.stringify({
        version: 1,
        activeSessionName: "git-clone-safe-hive",
        panes: [
          {
            sessionName: "git-clone-safe-hive",
            mode: "tiled",
            order: 0,
            cloneSessionKey: "git-clone:kethalia/hive",
            relativePath: "kethalia/hive",
            label: "kethalia/hive",
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
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: "git-clone:kethalia/hive",
        cloneProof: "fresh-proof-token",
      },
    });

    render(<MultiSessionWorkspace {...defaultProps} source="git" />);

    expect(await screen.findByTestId("interactive-terminal-git-clone-safe-hive")).toHaveAttribute(
      "data-clone-proof",
      "fresh-proof-token",
    );
    expect(screen.getByTestId("active-pane-label")).toHaveTextContent("kethalia/hive");
    expect(mockResolveGitCloneTerminal).toHaveBeenCalledTimes(1);
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
