// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockUseIsMobile = vi.hoisted(() => vi.fn(() => false));
const mockPush = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());
const mockNavigationState = vi.hoisted(() => ({ pathname: "/tasks", searchParams: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => mockNavigationState.pathname,
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  useSearchParams: () => new URLSearchParams(mockNavigationState.searchParams),
}));

const mockRefreshInstalledApp = vi.hoisted(() => vi.fn());

vi.mock("@/lib/app-update", () => ({
  refreshInstalledApp: mockRefreshInstalledApp,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

vi.mock("@/components/ui/sidebar", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    className,
    ...rest
  }: React.PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>) => (
    <div className={className} {...rest}>
      {children}
    </div>
  );
  const Composable = ({
    children,
    disabled,
    render,
    isActive,
    ...rest
  }: React.PropsWithChildren<{
    disabled?: boolean;
    render?: React.ReactElement;
    isActive?: boolean;
    className?: string;
  }>) => {
    const activeProps = { ...rest, "data-active": isActive ? "true" : "false" };
    if (render) {
      return React.cloneElement(render, activeProps, children);
    }
    return (
      <button disabled={disabled} {...activeProps}>
        {children}
      </button>
    );
  };
  return {
    Sidebar: Passthrough,
    SidebarContent: Passthrough,
    SidebarFooter: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-testid="sidebar-footer" className={className}>
        {children}
      </div>
    ),
    SidebarGroup: Passthrough,
    SidebarGroupContent: Passthrough,
    SidebarGroupLabel: ({
      children,
      render,
      ...rest
    }: React.PropsWithChildren<{ render?: React.ReactElement; className?: string }>) => {
      if (render) {
        return React.cloneElement(render, rest, children);
      }
      return <div {...rest}>{children}</div>;
    },
    SidebarHeader: Passthrough,
    SidebarMenu: Passthrough,
    SidebarMenuButton: Composable,
    SidebarMenuItem: Passthrough,
    SidebarMenuSub: Passthrough,
    SidebarMenuSubButton: Composable,
    SidebarMenuSubItem: Passthrough,
    SidebarTrigger: () => <button data-testid="sidebar-trigger">Toggle</button>,
  };
});

vi.mock("@/components/ui/collapsible", () => {
  return {
    Collapsible: ({
      children,
      defaultOpen,
      open,
      onOpenChange,
      "data-testid": dataTestId,
      className: _className,
    }: React.PropsWithChildren<{
      defaultOpen?: boolean;
      open?: boolean;
      onOpenChange?: (v: boolean) => void;
      "data-testid"?: string;
      className?: string;
    }>) => {
      const isOpen = open ?? defaultOpen;
      return (
        <div
          data-testid={dataTestId ?? "collapsible"}
          data-open={isOpen}
          data-onchange={onOpenChange ? "true" : undefined}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-collapsible-trigger]") && onOpenChange) {
              onOpenChange(!isOpen);
            }
          }}
        >
          {children}
        </div>
      );
    },
    CollapsibleContent: ({ children }: React.PropsWithChildren) => (
      <div data-testid="collapsible-content">{children}</div>
    ),
    CollapsibleTrigger: ({
      children,
      className,
      render: _render,
      "data-testid": dataTestId,
      ...rest
    }: React.PropsWithChildren<
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        render?: React.ReactElement;
        "data-testid"?: string;
      }
    >) => (
      <button
        data-collapsible-trigger=""
        data-testid={dataTestId ?? "collapsible-trigger"}
        className={className}
        {...rest}
      >
        {children}
      </button>
    ),
  };
});

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({
    children,
    className,
  }: React.PropsWithChildren<{ size?: string; className?: string }>) => (
    <span data-testid="avatar" className={className}>
      {children}
    </span>
  ),
  AvatarFallback: ({ children }: React.PropsWithChildren) => (
    <span data-testid="avatar-fallback">{children}</span>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => {
  const React = require("react");
  return {
    DropdownMenu: ({ children }: React.PropsWithChildren) => (
      <div data-testid="dropdown-menu">{children}</div>
    ),
    DropdownMenuTrigger: ({
      children,
      className,
    }: React.PropsWithChildren<{ className?: string }>) => (
      <button data-testid="user-menu-trigger" className={className}>
        {children}
      </button>
    ),
    DropdownMenuContent: ({
      children,
    }: React.PropsWithChildren<{ side?: string; align?: string; className?: string }>) => (
      <div data-testid="user-menu-content">{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      onClick,
      disabled,
    }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => (
      <button data-testid="dropdown-menu-item" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-testid="dropdown-menu-label">{children}</div>
    ),
    DropdownMenuGroup: ({ children }: React.PropsWithChildren) => (
      <div data-testid="dropdown-menu-group">{children}</div>
    ),
    DropdownMenuSeparator: () => <hr data-testid="dropdown-menu-separator" />,
  };
});

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    children,
    ...rest
  }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <div role="alert" {...rest}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren<{ className?: string }>) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/input", async () => {
  const React = await import("react");
  return {
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
      (props, ref) => <input ref={ref} {...props} />,
    ),
  };
});

vi.mock("@/lib/constants", () => ({
  SAFE_IDENTIFIER_RE: /^[a-zA-Z0-9._-]+$/,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    className,
  }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <span data-testid="badge" className={className}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    id,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    id?: string;
    onCheckedChange?: (v: boolean) => void;
    size?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
    "aria-labelledby"?: string;
    "data-testid"?: string;
  }) => (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={rest["aria-describedby"]}
      aria-invalid={rest["aria-invalid"]}
      aria-labelledby={rest["aria-labelledby"]}
      data-testid={rest["data-testid"]}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {checked ? "On" : "Off"}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  ListTodo: () => <span>ListTodo</span>,
  PlusCircle: () => <span>PlusCircle</span>,
  Settings: () => <span>Settings</span>,
  Hexagon: () => <span>Hexagon</span>,
  LayoutTemplate: () => <span>LayoutTemplate</span>,
  Monitor: () => <span>Monitor</span>,
  LayoutDashboard: () => <span>LayoutDashboard</span>,
  ChevronRight: ({ className, ...props }: { className?: string; "data-testid"?: string }) => (
    <span className={className} data-testid={props["data-testid"]}>
      ChevronRight
    </span>
  ),
  RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
  AlertCircle: () => <span>AlertCircle</span>,
  Terminal: () => <span>Terminal</span>,
  Plus: () => <span>Plus</span>,
  X: () => <span>X</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  Folder: () => <span>Folder</span>,
  GitBranch: () => <span>GitBranch</span>,
  GripVertical: () => <span>GripVertical</span>,
  Code: () => <span>Code</span>,
  ExternalLink: () => <span>ExternalLink</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  Pencil: () => <span>Pencil</span>,
  Star: () => <span>Star</span>,
  Stethoscope: () => <span>Stethoscope</span>,
  Loader2: () => <span data-testid="loader-icon">Loader2</span>,
  LogOut: () => <span data-testid="logout-icon">LogOut</span>,
}));

const mockListWorkspaces = vi.fn();
const mockListTemplates = vi.fn();
const mockListGitClones = vi.fn();
const mockResolveGitCloneTerminal = vi.fn();
const mockGetWorkspaceAgent = vi.fn();
const mockGetWorkspaceSessions = vi.fn();
const mockRestartWorkspace = vi.fn();
const mockCreateSession = vi.fn();
const mockKillSession = vi.fn();
const mockRenameSession = vi.fn();
const mockListNavigationFavorites = vi.fn();
const mockUpsertNavigationFavorite = vi.fn();
const mockRemoveNavigationFavorite = vi.fn();
const mockReorderNavigationFavorites = vi.fn();
const mockGetTerminalSettings = vi.fn();
const mockUpdateTerminalSettings = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: (...args: unknown[]) => mockListWorkspaces(...args),
  getWorkspaceAgentAction: (...args: unknown[]) => mockGetWorkspaceAgent(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetWorkspaceSessions(...args),
  restartWorkspaceAction: (...args: unknown[]) => mockRestartWorkspace(...args),
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
  renameSessionAction: (...args: unknown[]) => mockRenameSession(...args),
}));

vi.mock("@/lib/workspaces/urls", () => ({
  buildWorkspaceUrls: (_ws: unknown, _agent: string, _url: string) => ({
    filebrowser: "https://filebrowser.test",
    kasmvnc: "https://kasmvnc.test",
    codeServer: "https://code-server.test",
    dashboard: "https://dashboard.test",
  }),
}));

vi.mock("@/lib/actions/templates", () => ({
  listTemplateStatusesAction: (...args: unknown[]) => mockListTemplates(...args),
}));

vi.mock("@/lib/actions/git-clones", () => ({
  listGitClonesAction: (...args: unknown[]) => mockListGitClones(...args),
  resolveGitCloneTerminalAction: (...args: unknown[]) => mockResolveGitCloneTerminal(...args),
}));

vi.mock("@/lib/actions/navigation-favorites", () => ({
  listNavigationFavoritesAction: (...args: unknown[]) => mockListNavigationFavorites(...args),
  upsertNavigationFavoriteAction: (...args: unknown[]) => mockUpsertNavigationFavorite(...args),
  removeNavigationFavoriteAction: (...args: unknown[]) => mockRemoveNavigationFavorite(...args),
  reorderNavigationFavoritesAction: (...args: unknown[]) => mockReorderNavigationFavorites(...args),
}));

vi.mock("@/lib/actions/user-settings", () => ({
  getTerminalSettingsAction: (...args: unknown[]) => mockGetTerminalSettings(...args),
  updateTerminalSettingsAction: (...args: unknown[]) => mockUpdateTerminalSettings(...args),
}));

const mockGetSessionAction = vi.fn();
const mockLogoutAction = vi.fn();

vi.mock("@/lib/auth/actions", () => ({
  getSessionAction: (...args: unknown[]) => mockGetSessionAction(...args),
  logoutAction: (...args: unknown[]) => mockLogoutAction(...args),
}));

import { AppSidebar } from "@/components/app-sidebar";
import type { CoderWorkspace } from "@/lib/coder/types";
import type {
  GitCloneDiscoveryActionResult,
  PublicCloneTree,
} from "@/lib/git/clone-actions-contract";
import type { CloneTreeDiagnostics } from "@/lib/git/clone-tree";
import type { TemplateStatus } from "@/lib/templates/staleness";
import { TERMINAL_SETTINGS_CHANGED_EVENT } from "@/lib/terminal/settings-events";

const PRIVATE_ROOT = "/home/coder/SUPER_SECRET_TOKEN";

const gitRepositoryNode = {
  id: "git-repository:Git/home/kethalia/hive",
  kind: "repository",
  label: "hive",
  relativePath: "kethalia/hive",
  relativePathSegments: ["kethalia", "hive"],
  displaySegments: ["Git", "home", "kethalia", "hive"],
  cloneSessionKey: "git-clone:kethalia/hive",
} as const;

function makeGitDiagnostics(overrides: Partial<CloneTreeDiagnostics> = {}): CloneTreeDiagnostics {
  return {
    rootLabel: "Git",
    repoCount: 1,
    directoryCount: 1,
    skippedPaths: [],
    truncated: false,
    durationMs: 12,
    ...overrides,
  };
}

function makeGitCloneTree(overrides: Partial<PublicCloneTree> = {}): PublicCloneTree {
  return {
    root: {
      id: "git-directory:Git/home",
      label: "Git",
      projectsLabel: "home",
      displaySegments: ["Git", "home"],
    },
    nodes: [
      {
        id: "git-directory:Git/home/kethalia",
        kind: "directory",
        label: "kethalia",
        relativePath: "kethalia",
        relativePathSegments: ["kethalia"],
        displaySegments: ["Git", "home", "kethalia"],
        children: [gitRepositoryNode],
      },
    ],
    diagnostics: makeGitDiagnostics(),
    ...overrides,
  };
}

function makeGitSuccessResult(tree = makeGitCloneTree()): GitCloneDiscoveryActionResult {
  return {
    ok: true,
    status: "success",
    message: "Git clones discovered.",
    tree,
    diagnostics: tree.diagnostics,
    error: null,
  };
}

function makeGitEmptyResult(): GitCloneDiscoveryActionResult {
  const tree = makeGitCloneTree({
    nodes: [],
    diagnostics: makeGitDiagnostics({ repoCount: 0, directoryCount: 0, durationMs: 4 }),
  });

  return {
    ok: true,
    status: "empty",
    message: "No Git clones found under the configured home root.",
    tree,
    diagnostics: tree.diagnostics,
    error: null,
  };
}

function makeGitErrorResult(
  status: "missing-root" | "scan-failed",
  diagnostics: CloneTreeDiagnostics | null,
): GitCloneDiscoveryActionResult {
  const message =
    status === "missing-root"
      ? "Configured home folder is not available. Mount the home root, then refresh."
      : "We couldn't scan the home folder for Git clones. Refresh and try again.";

  return {
    ok: false,
    status,
    message,
    tree: null,
    diagnostics,
    error: { code: status, message },
  };
}

function makeWorkspace(overrides: Partial<CoderWorkspace> = {}): CoderWorkspace {
  return {
    id: "ws-1",
    name: "dev-box",
    template_id: "tpl-1",
    template_name: "hive-worker",
    owner_name: "alice",
    latest_build: {
      id: "build-1",
      status: "running",
      job: { status: "succeeded", error: "" },
    },
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<TemplateStatus> = {}): TemplateStatus {
  return {
    name: "hive-worker",
    stale: false,
    ...overrides,
  } as TemplateStatus;
}

function makeSession(name = "dev") {
  return { name, created: 1000, windows: 1 };
}

function makeFavorite(overrides: Record<string, unknown> = {}) {
  return {
    id: "fav-1",
    kind: "terminal",
    workspaceId: "ws-1",
    targetKey: "dev",
    label: "dev",
    relativePath: null,
    createdAt: "2026-06-02T00:00:00.000Z",
    position: 0,
    ...overrides,
  };
}

async function expandWorkspaceAndTerminalSessions(workspaceId = "ws-1") {
  render(<AppSidebar />);

  await waitFor(() => {
    expect(screen.getByText("dev-box")).toBeInTheDocument();
  });

  fireEvent.click(screen.getByTestId(`workspace-disclosure-${workspaceId}`));

  await waitFor(() => {
    expect(screen.getByTestId(`terminal-section-${workspaceId}`)).toBeInTheDocument();
  });

  const terminalSection = screen.getByTestId(`terminal-section-${workspaceId}`);
  const terminalTrigger = terminalSection.querySelector("[data-testid='collapsible-trigger']");
  expect(terminalTrigger).not.toBeNull();
  fireEvent.click(terminalTrigger!);

  await waitFor(() => {
    expect(screen.getByTestId(`session-list-scroll-${workspaceId}`)).toBeInTheDocument();
  });

  return {
    scrollContainer: screen.getByTestId(`session-list-scroll-${workspaceId}`),
    terminalSection,
  };
}

describe("AppSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationState.pathname = "/tasks";
    mockNavigationState.searchParams = "";
    mockUseIsMobile.mockReturnValue(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockListWorkspaces.mockResolvedValue({
      data: [makeWorkspace()],
    });
    mockListTemplates.mockResolvedValue({
      data: [makeTemplate()],
    });
    mockListGitClones.mockResolvedValue({
      data: makeGitSuccessResult(),
    });
    mockListNavigationFavorites.mockResolvedValue({
      data: [],
    });
    mockUpsertNavigationFavorite.mockImplementation((input) =>
      Promise.resolve({
        data: makeFavorite({
          id: `${input.kind}-${input.targetKey}`,
          kind: input.kind,
          workspaceId: input.workspaceId,
          targetKey: input.targetKey,
          label: input.label ?? input.targetKey,
          relativePath: input.kind === "git" ? input.relativePath : null,
        }),
      }),
    );
    mockRemoveNavigationFavorite.mockResolvedValue({
      data: { success: true },
    });
    mockReorderNavigationFavorites.mockResolvedValue({ data: { success: true } });
    mockGetTerminalSettings.mockResolvedValue({
      data: { terminalControlsBeyondMobile: false },
    });
    mockUpdateTerminalSettings.mockImplementation((input) =>
      Promise.resolve({
        data: { terminalControlsBeyondMobile: input.terminalControlsBeyondMobile },
      }),
    );
    mockResolveGitCloneTerminal.mockResolvedValue({
      data: {
        sessionName: "git-clone-safe-hive",
        clonePath: "kethalia/hive",
        cloneSessionKey: gitRepositoryNode.cloneSessionKey,
        cloneProof: "proof-token",
      },
    });
    mockGetWorkspaceAgent.mockResolvedValue({
      data: { agentId: "agent-1", agentName: "main", agentStatus: "connected" },
    });
    mockRestartWorkspace.mockResolvedValue({ data: { workspaceId: "ws-1", status: "running" } });
    mockGetWorkspaceSessions.mockResolvedValue({
      data: [makeSession("dev")],
    });
    mockCreateSession.mockResolvedValue({
      data: { name: "session-123" },
    });
    mockKillSession.mockResolvedValue({
      data: { name: "dev" },
    });
    mockGetSessionAction.mockResolvedValue({
      data: { user: { id: "u1", email: "test@example.com", coderUrl: "https://coder.test" } },
    });
    mockLogoutAction.mockResolvedValue({ data: { success: true } });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders workspace names when data loads", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });
  });

  it("loads the synced terminal controls setting once per sidebar mount", async () => {
    mockGetTerminalSettings.mockResolvedValueOnce({
      data: { terminalControlsBeyondMobile: true },
    });

    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });

    await waitFor(() => {
      expect(switchControl).toHaveAttribute("aria-checked", "true");
      expect(switchControl).not.toBeDisabled();
    });
    expect(mockGetTerminalSettings).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default-off terminal controls setting when read data is missing", async () => {
    mockGetTerminalSettings.mockResolvedValueOnce({});

    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading terminal controls setting…")).not.toBeInTheDocument();
    });
    expect(switchControl).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("terminal-settings-error")).not.toBeInTheDocument();
  });

  it("shows redacted retry UI when reading terminal controls setting fails", async () => {
    mockGetTerminalSettings.mockResolvedValueOnce({
      serverError: "database path /home/coder/secret failed",
    });

    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-settings-error")).toHaveTextContent(
        "Terminal controls setting unavailable.",
      );
    });
    expect(switchControl).toHaveAttribute("aria-checked", "false");
    expect(document.body.innerHTML).not.toContain("/home/coder/secret");

    mockGetTerminalSettings.mockResolvedValueOnce({
      data: { terminalControlsBeyondMobile: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(switchControl).toHaveAttribute("aria-checked", "true");
      expect(screen.queryByTestId("terminal-settings-error")).not.toBeInTheDocument();
    });
  });

  it("optimistically updates terminal controls, dispatches the setting event, and refreshes", async () => {
    const events: boolean[] = [];
    window.addEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, (event) => {
      events.push(
        (event as CustomEvent<{ terminalControlsBeyondMobile: boolean }>).detail
          .terminalControlsBeyondMobile,
      );
    });

    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });
    await waitFor(() => expect(switchControl).not.toBeDisabled());
    fireEvent.click(switchControl);

    await waitFor(() => {
      expect(mockUpdateTerminalSettings).toHaveBeenCalledWith({
        terminalControlsBeyondMobile: true,
      });
      expect(switchControl).toHaveAttribute("aria-checked", "true");
      expect(events).toEqual([true]);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("rolls back terminal controls and skips the success event when updating fails", async () => {
    const eventSpy = vi.fn();
    window.addEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, eventSpy);
    mockUpdateTerminalSettings.mockResolvedValueOnce({
      serverError: "write failed with terminal text redacted",
    });

    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });
    await waitFor(() => expect(switchControl).not.toBeDisabled());
    fireEvent.click(switchControl);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-settings-error")).toHaveTextContent(
        "Terminal controls setting unavailable.",
      );
      expect(switchControl).toHaveAttribute("aria-checked", "false");
    });
    expect(eventSpy).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("leaves terminal controls unchanged when update returns malformed data", async () => {
    mockGetTerminalSettings.mockResolvedValueOnce({
      data: { terminalControlsBeyondMobile: true },
    });
    mockUpdateTerminalSettings.mockResolvedValueOnce({ data: {} });

    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });
    await waitFor(() => {
      expect(switchControl).toHaveAttribute("aria-checked", "true");
      expect(switchControl).not.toBeDisabled();
    });

    fireEvent.click(switchControl);

    await waitFor(() => {
      expect(switchControl).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("terminal-settings-error")).toBeInTheDocument();
    });
  });

  it("renders accessible thumb-friendly terminal controls setting without removed sidebar mode UI", async () => {
    render(<AppSidebar />);

    const switchControl = await screen.findByRole("switch", {
      name: "Show terminal controls beyond phone",
    });
    expect(switchControl).toHaveAccessibleDescription(
      "Use mobile-style terminal controls on tablet, laptop, and desktop.",
    );
    expect(screen.getByTestId("terminal-controls-beyond-mobile-setting")).toHaveClass("min-h-11");
    expect(screen.queryByTestId("sidebar-mode-toggle")).not.toBeInTheDocument();
    expect(screen.queryByText("Float sidebar")).not.toBeInTheDocument();
  });

  it("offers an app update action from settings", async () => {
    render(<AppSidebar />);

    const updateButton = await screen.findByTestId("update-installed-app");
    expect(updateButton).toHaveTextContent("Update");

    fireEvent.click(updateButton);

    expect(mockRefreshInstalledApp).toHaveBeenCalledTimes(1);
  });

  it("renders template names when data loads", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("hive-worker")).toBeInTheDocument();
    });
  });

  it("loads persisted favorites for the signed-in workspace and renders terminal and Git rows", async () => {
    mockListNavigationFavorites.mockResolvedValueOnce({
      data: [
        makeFavorite({ id: "fav-terminal", label: "Main shell" }),
        makeFavorite({
          id: "fav-git",
          kind: "git",
          targetKey: "git-clone:kethalia/hive",
          label: "Hive repo",
          relativePath: "kethalia/hive",
        }),
      ],
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(mockListNavigationFavorites).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      expect(screen.getByText("Main shell")).toBeInTheDocument();
      expect(screen.getByText("Hive repo")).toBeInTheDocument();
    });

    const terminalLink = screen.getByText("Main shell").closest("a");
    expect(terminalLink).toHaveAttribute("href", "/workspaces/ws-1/terminal?session=dev");
    expect(document.body.innerHTML).not.toContain("userId");
  });

  it("uses sortable drag handles for pinned actions", async () => {
    mockListNavigationFavorites.mockResolvedValueOnce({
      data: [
        makeFavorite({ id: "fav-first", label: "First", position: 0 }),
        makeFavorite({ id: "fav-second", label: "Second", targetKey: "second", position: 1 }),
      ],
    });
    render(<AppSidebar />);

    const firstHandle = await screen.findByRole("button", { name: "Reorder First" });
    expect(screen.getByRole("button", { name: "Reorder Second" })).toBeInTheDocument();
    expect(firstHandle).not.toHaveAttribute("draggable");
    expect(firstHandle).toHaveAttribute("aria-roledescription", "sortable");
    expect(screen.getByTestId("sortable-favorite-fav-first")).toBeInTheDocument();
    firstHandle.focus();
    fireEvent.keyDown(firstHandle, { key: " ", code: "Space" });
    await waitFor(() => expect(firstHandle).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("sortable-favorite-fav-first")).toHaveClass("shadow-lg");
    fireEvent.keyDown(firstHandle, { key: "Escape", code: "Escape" });
  });

  it("hides Pinned when no favorites are returned", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(mockListNavigationFavorites).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
    expect(screen.queryByTestId("favorites-section")).not.toBeInTheDocument();
  });

  it("places Pinned before Workspaces in the primary navigation", async () => {
    mockListNavigationFavorites.mockResolvedValueOnce({
      data: [makeFavorite({ id: "fav-terminal", label: "Main shell" })],
    });
    render(<AppSidebar />);

    const pinned = await screen.findByTestId("favorites-section");
    const workspaces = screen.getByTestId("workspaces-disclosure");

    expect(pinned.compareDocumentPosition(workspaces)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("separates the Tasks and New Task actions", async () => {
    render(<AppSidebar />);

    expect(await screen.findByTestId("automation-menu")).toHaveClass("gap-1");
  });

  it("upserts and removes terminal favorites without user-scoped payload fields", async () => {
    await expandWorkspaceAndTerminalSessions();

    fireEvent.click(screen.getByRole("button", { name: "Add terminal session dev to favorites" }));

    await waitFor(() => {
      expect(mockUpsertNavigationFavorite).toHaveBeenCalledWith({
        kind: "terminal",
        workspaceId: "ws-1",
        targetKey: "dev",
        label: "dev",
      });
      expect(
        screen.getByRole("button", { name: "Remove terminal session dev from favorites" }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(JSON.stringify(mockUpsertNavigationFavorite.mock.calls[0][0])).not.toContain("userId");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove terminal session dev from favorites" }),
    );

    await waitFor(() => {
      expect(mockRemoveNavigationFavorite).toHaveBeenCalledWith({
        kind: "terminal",
        workspaceId: "ws-1",
        targetKey: "dev",
      });
      expect(
        screen.getByRole("button", { name: "Add terminal session dev to favorites" }),
      ).toHaveAttribute("aria-pressed", "false");
    });
    expect(JSON.stringify(mockRemoveNavigationFavorite.mock.calls[0][0])).not.toContain("userId");
  }, 10_000);

  it("upserts and removes Git repository favorites with sanitized clone identifiers", async () => {
    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add Git repository kethalia / hive to favorites",
      }),
    );

    await waitFor(() => {
      expect(mockUpsertNavigationFavorite).toHaveBeenCalledWith({
        kind: "git",
        workspaceId: "ws-1",
        targetKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
        label: "hive",
      });
      expect(
        screen.getByRole("button", {
          name: "Remove Git repository kethalia / hive from favorites",
        }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(JSON.stringify(mockUpsertNavigationFavorite.mock.calls[0][0])).not.toContain(
      "/home/coder",
    );
    expect(JSON.stringify(mockUpsertNavigationFavorite.mock.calls[0][0])).not.toContain(
      "cloneProof",
    );
    expect(JSON.stringify(mockUpsertNavigationFavorite.mock.calls[0][0])).not.toContain("userId");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Git repository kethalia / hive from favorites",
      }),
    );

    await waitFor(() => {
      expect(mockRemoveNavigationFavorite).toHaveBeenCalledWith({
        kind: "git",
        workspaceId: "ws-1",
        targetKey: "git-clone:kethalia/hive",
      });
    });
  });

  it("launches a Git favorite through the existing clone terminal resolver", async () => {
    mockListNavigationFavorites.mockResolvedValueOnce({
      data: [
        makeFavorite({
          id: "fav-git",
          kind: "git",
          targetKey: "git-clone:kethalia/hive",
          label: "Hive repo",
          relativePath: "kethalia/hive",
        }),
      ],
    });

    render(<AppSidebar />);

    const favoriteButton = await screen.findByText("Hive repo");
    fireEvent.click(favoriteButton.closest("button")!);

    await waitFor(() => {
      expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
        cloneSessionKey: "git-clone:kethalia/hive",
        workspaceId: "ws-1",
        agentId: "agent-1",
        relativePath: "kethalia/hive",
      });
      expect(mockPush).toHaveBeenCalledWith(
        "/workspaces/ws-1/terminal?session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneSessionKey=git-clone%3Akethalia%2Fhive&cloneProof=proof-token&relativePath=kethalia%2Fhive",
      );
    });
  });

  it("renders malformed Git favorites without a relative path as disabled and does not launch", async () => {
    mockListNavigationFavorites.mockResolvedValueOnce({
      data: [
        makeFavorite({
          id: "fav-git-bad",
          kind: "git",
          targetKey: "git-clone:kethalia/hive",
          label: "Hive repo",
          relativePath: null,
        }),
      ],
    });

    render(<AppSidebar />);

    const favoriteButton = (await screen.findByText("Hive repo")).closest("button");
    expect(favoriteButton).toBeDisabled();
    fireEvent.click(favoriteButton!);

    expect(mockResolveGitCloneTerminal).not.toHaveBeenCalled();
  });

  it("reloads favorites from the action on remount", async () => {
    mockListNavigationFavorites.mockResolvedValue({
      data: [makeFavorite({ id: "fav-terminal", label: "Main shell" })],
    });

    const first = render(<AppSidebar />);
    await screen.findByText("Main shell");
    first.unmount();

    render(<AppSidebar />);

    await waitFor(() => {
      expect(mockListNavigationFavorites).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Main shell")).toBeInTheDocument();
    });
  });

  it("shows sanitized favorite load and mutation failures while workspace and Git access remain usable", async () => {
    mockListNavigationFavorites.mockResolvedValueOnce({
      serverError: `db exploded at ${PRIVATE_ROOT} with cloneProof=secret`,
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("favorites-error")).toHaveTextContent(
        "Favorites unavailable. Terminal access is still available.",
      );
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });
    expect(document.body.innerHTML).not.toContain(PRIVATE_ROOT);
    expect(document.body.innerHTML).not.toContain("cloneProof=secret");

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));
    expect(
      await screen.findByRole("button", { name: "Open Git repository kethalia / hive" }),
    ).toBeInTheDocument();

    mockUpsertNavigationFavorite.mockResolvedValueOnce({
      serverError: `write failed at ${PRIVATE_ROOT}`,
    });
    const terminalSection = await screen.findByTestId("terminal-section-ws-1");
    const terminalTrigger = terminalSection.querySelector("[data-testid='collapsible-trigger']");
    fireEvent.click(terminalTrigger!);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add terminal session dev to favorites" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("favorites-error")).toHaveTextContent(
        "Favorites unavailable. Terminal access is still available.",
      );
      expect(
        screen.getByRole("button", { name: "Add terminal session dev to favorites" }),
      ).toHaveAttribute("aria-pressed", "false");
    });
    expect(document.body.innerHTML).not.toContain(PRIVATE_ROOT);
  });

  it("renders Git clone hierarchy under the expanded workspace with clone metadata and without absolute paths", async () => {
    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    const repoButton = await screen.findByRole("button", {
      name: "Open Git repository kethalia / hive",
    });

    expect(mockListGitClones).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    expect(screen.getByTestId("git-section-ws-1")).toBeInTheDocument();
    expect(repoButton).toHaveAttribute("data-clone-session-key", "git-clone:kethalia/hive");
    expect(repoButton).toHaveAttribute("data-relative-path", "kethalia/hive");
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByText("home")).toBeInTheDocument();
    expect(screen.getByText("kethalia")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Git clone scan diagnostics" })).toHaveTextContent(
      "Repos 1",
    );
    expect(document.body).not.toHaveTextContent(PRIVATE_ROOT);
    expect(document.body.innerHTML).not.toContain("/home/coder");
  });

  it("keeps the Git section closed by default and rotates its chevron when opened", async () => {
    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    const gitSection = await screen.findByTestId("git-section-ws-1");
    expect(gitSection).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("git-section-chevron-ws-1")).not.toHaveClass("rotate-90");

    const gitTrigger = gitSection.querySelector("[data-testid='collapsible-trigger']");
    expect(gitTrigger).not.toBeNull();
    fireEvent.click(gitTrigger!);

    await waitFor(() => {
      expect(screen.getByTestId("git-section-ws-1")).toHaveAttribute("data-open", "true");
      expect(screen.getByTestId("git-section-chevron-ws-1")).toHaveClass("rotate-90");
    });
  });

  it("opens a Git repository in the workspace that owns the Git tree", async () => {
    mockListWorkspaces.mockResolvedValueOnce({
      data: [
        makeWorkspace({
          id: "ws-stopped",
          name: "stopped-box",
          latest_build: {
            id: "build-stopped",
            status: "stopped",
            job: { status: "succeeded", error: "" },
          },
        }),
        makeWorkspace({ id: "ws-running", name: "running-box" }),
      ],
    });

    render(<AppSidebar />);

    await screen.findByText("running-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-running"));

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Git repository kethalia / hive" }),
    );

    await waitFor(() => {
      expect(mockListGitClones).toHaveBeenCalledWith({ workspaceId: "ws-running" });
      expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
        cloneSessionKey: "git-clone:kethalia/hive",
        workspaceId: "ws-running",
        agentId: "agent-1",
        relativePath: "kethalia/hive",
      });
      expect(mockPush).toHaveBeenCalledWith(
        "/workspaces/ws-running/terminal?session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneSessionKey=git-clone%3Akethalia%2Fhive&cloneProof=proof-token&relativePath=kethalia%2Fhive",
      );
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("uses the active workspace route when auto-expanding scoped Git and preserves debugViewport=1", async () => {
    mockNavigationState.pathname = "/workspaces/ws-active/terminal";
    mockNavigationState.searchParams = "session=dev&debugViewport=1";
    mockListWorkspaces.mockResolvedValueOnce({
      data: [makeWorkspace({ id: "ws-active", name: "active-box" })],
    });

    render(<AppSidebar />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Git repository kethalia / hive" }),
    );

    await waitFor(() => {
      expect(mockListGitClones).toHaveBeenCalledWith({ workspaceId: "ws-active" });
      expect(mockResolveGitCloneTerminal).toHaveBeenCalledWith({
        cloneSessionKey: "git-clone:kethalia/hive",
        workspaceId: "ws-active",
        agentId: "agent-1",
        relativePath: "kethalia/hive",
      });
      expect(mockPush).toHaveBeenCalledWith(
        "/workspaces/ws-active/terminal?session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneSessionKey=git-clone%3Akethalia%2Fhive&cloneProof=proof-token&relativePath=kethalia%2Fhive&debugViewport=1",
      );
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("does not auto-select a fallback workspace for Git discovery before a workspace is expanded", async () => {
    mockListWorkspaces.mockResolvedValueOnce({
      data: [
        makeWorkspace({
          id: "ws-stopped",
          name: "stopped-box",
          latest_build: {
            id: "build-stopped",
            status: "stopped",
            job: { status: "succeeded", error: "" },
          },
        }),
      ],
    });

    render(<AppSidebar />);

    await screen.findByText("stopped-box");

    expect(mockListGitClones).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open Git repository kethalia / hive" }),
    ).not.toBeInTheDocument();
  });

  it("shows a sanitized Git terminal error when the resolve action fails", async () => {
    mockResolveGitCloneTerminal.mockResolvedValueOnce({
      serverError: `Cannot scan ${PRIVATE_ROOT}`,
    });

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Git repository kethalia / hive" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-terminal-open-error-ws-1")).toHaveTextContent(
        "We couldn't open that Git repository. Refresh and try again.",
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(PRIVATE_ROOT);
    expect(document.body.innerHTML).not.toContain("/home/coder");
  });

  it("treats a missing resolve action payload as a sanitized Git terminal failure", async () => {
    mockResolveGitCloneTerminal.mockResolvedValueOnce({});

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Git repository kethalia / hive" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("git-terminal-open-error-ws-1")).toHaveTextContent(
        "We couldn't open that Git repository. Refresh and try again.",
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("shows a Git discovery loading state while the action is pending", async () => {
    let resolveGit: (value: { data: GitCloneDiscoveryActionResult }) => void = () => {};
    mockListGitClones.mockReturnValue(
      new Promise((resolve) => {
        resolveGit = resolve;
      }),
    );

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    expect(screen.getByText("Loading Git repositories…")).toBeInTheDocument();

    resolveGit({ data: makeGitSuccessResult() });
    await screen.findByRole("button", { name: "Open Git repository kethalia / hive" });
  });

  it("renders the Git empty state with retry and diagnostics", async () => {
    mockListGitClones.mockResolvedValueOnce({ data: makeGitEmptyResult() });

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("git-discovery-empty-state")).toBeInTheDocument();
    });

    expect(
      screen.getByText("No Git clones found under the configured home root."),
    ).toBeInTheDocument();
    expect(screen.getByText("No Git repositories found.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Git clone scan diagnostics" })).toHaveTextContent(
      "Repos 0",
    );

    mockListGitClones.mockResolvedValueOnce({ data: makeGitSuccessResult() });
    fireEvent.click(screen.getByTestId("git-discovery-retry"));

    await waitFor(() => {
      expect(mockListGitClones).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("button", { name: "Open Git repository kethalia / hive" }),
      ).toBeInTheDocument();
    });
  });

  it("renders missing-root and scan-failed Git states with sanitized diagnostics", async () => {
    mockListGitClones.mockResolvedValueOnce({
      data: makeGitErrorResult(
        "missing-root",
        makeGitDiagnostics({
          repoCount: 0,
          directoryCount: 0,
          skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
          durationMs: 9,
        }),
      ),
    });

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("git-discovery-missing-root")).toBeInTheDocument();
    });

    expect(screen.getByText("Home root unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Configured home folder is not available/)).toBeInTheDocument();
    expect(
      screen.getByText(/Repos 0 .* Directories 0 .* Skipped 1 .* Complete .* 9ms/),
    ).toBeInTheDocument();

    mockListGitClones.mockResolvedValueOnce({
      data: makeGitErrorResult(
        "scan-failed",
        makeGitDiagnostics({
          repoCount: 2,
          directoryCount: 3,
          skippedPaths: [{ relativePath: "phlox-labs/platform", reason: "too-deep" }],
          truncated: true,
          durationMs: 44,
        }),
      ),
    });
    fireEvent.click(screen.getByTestId("git-discovery-retry"));

    await waitFor(() => {
      expect(screen.getByTestId("git-discovery-scan-failed")).toBeInTheDocument();
    });

    expect(screen.getByText("Git scan failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Repos 2 .* Directories 3 .* Skipped 1 .* Truncated .* 44ms/),
    ).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("/home/coder");
  });

  it("maps thrown Git discovery failures to a sanitized server-error state", async () => {
    mockListGitClones.mockRejectedValueOnce(
      new Error(`scan exploded at ${PRIVATE_ROOT} with SUPER_SECRET_TOKEN`),
    );

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("git-discovery-server-error")).toBeInTheDocument();
    });

    expect(screen.getByText("Git scan unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Git clone discovery is unavailable. Refresh and try again."),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("SUPER_SECRET_TOKEN");
    expect(document.body.innerHTML).not.toContain("/home/coder");
  });

  it("does not scan Git clones on initial load or workspace/template polling", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });
    expect(mockListGitClones).not.toHaveBeenCalled();

    mockListWorkspaces.mockClear();
    mockListTemplates.mockClear();
    mockListGitClones.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    await waitFor(() => {
      expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
      expect(mockListTemplates).toHaveBeenCalledTimes(1);
    });
    expect(mockListGitClones).not.toHaveBeenCalled();
  });

  it("includes open workspace Git discovery in the explicit footer refresh", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(mockListGitClones).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
    const gitSection = await screen.findByTestId("git-section-ws-1");
    const gitTrigger = gitSection.querySelector("[data-testid='collapsible-trigger']");
    expect(gitTrigger).not.toBeNull();
    fireEvent.click(gitTrigger!);
    await waitFor(() => {
      expect(screen.getByTestId("git-section-ws-1")).toHaveAttribute("data-open", "true");
    });

    mockListWorkspaces.mockClear();
    mockListTemplates.mockClear();
    mockListGitClones.mockClear();

    const footer = screen.getByTestId("sidebar-footer");
    const refreshButton = footer.querySelector("button[title='Refresh']");
    expect(refreshButton).not.toBeNull();
    fireEvent.click(refreshButton!);

    await waitFor(() => {
      expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
      expect(mockListTemplates).toHaveBeenCalledTimes(1);
      expect(mockListGitClones).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
  });

  it("renders error alert with retry button on workspace fetch failure", async () => {
    mockListWorkspaces.mockResolvedValue({
      serverError: "Connection refused",
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(1);

    const retryButtons = screen.getAllByText("Retry");
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("renders error alert with retry button on template fetch failure", async () => {
    mockListTemplates.mockResolvedValue({
      serverError: "Template service down",
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("Template service down")).toBeInTheDocument();
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it("retries workspace fetch when retry button is clicked", async () => {
    mockListWorkspaces.mockResolvedValueOnce({
      serverError: "Connection refused",
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });

    mockListWorkspaces.mockResolvedValueOnce({
      data: [makeWorkspace({ name: "recovered-box" })],
    });

    const retryButtons = screen.getAllByText("Retry");
    fireEvent.click(retryButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("recovered-box")).toBeInTheDocument();
    });
  });

  it("renders refresh button in footer", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const footer = screen.getByTestId("sidebar-footer");
    const refreshIcon = footer.querySelector('[data-testid="refresh-icon"]');
    expect(refreshIcon).toBeInTheDocument();
  });

  it("shows relative last-refreshed time in footer after data loads", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const lastRefreshed = screen.getByTestId("last-refreshed");
    expect(lastRefreshed.textContent).toMatch(/Just now|ago/);
  });

  it("calls both fetch actions when refresh button is clicked", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    mockListWorkspaces.mockClear();
    mockListTemplates.mockClear();

    const footer = screen.getByTestId("sidebar-footer");
    const refreshButton = footer.querySelector("button[title='Refresh']");
    expect(refreshButton).not.toBeNull();
    fireEvent.click(refreshButton!);

    await waitFor(() => {
      expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
      expect(mockListTemplates).toHaveBeenCalledTimes(1);
    });
  });

  it("expanding a workspace triggers agent, session, and scoped Git fetches", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(mockGetWorkspaceAgent).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      expect(mockGetWorkspaceSessions).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      expect(mockListGitClones).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
  });

  it("renders sessions under Terminal collapsible in expanded workspace", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-section-ws-1")).toBeInTheDocument();
    });

    const terminalSection = screen.getByTestId("terminal-section-ws-1");
    const terminalTrigger = terminalSection.querySelector("[data-testid='collapsible-trigger']");
    fireEvent.click(terminalTrigger!);

    await waitFor(() => {
      expect(screen.getByText("dev")).toBeInTheDocument();
    });
  });

  it("hides reserved clone sessions from generic terminal rows and cleanup controls", async () => {
    mockGetWorkspaceSessions.mockResolvedValue({
      data: [makeSession("dev"), makeSession("git-clone-abc123")],
    });

    await expandWorkspaceAndTerminalSessions();

    await waitFor(() => {
      expect(screen.getByText("dev")).toBeInTheDocument();
    });
    expect(screen.queryByText("git-clone-abc123")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rename-session-git-clone-abc123")).not.toBeInTheDocument();
    expect(screen.queryByTestId("kill-session-git-clone-abc123")).not.toBeInTheDocument();
  });

  it("keeps desktop sessions capped and hover-gated", async () => {
    mockUseIsMobile.mockReturnValue(false);

    const { scrollContainer } = await expandWorkspaceAndTerminalSessions();

    expect(scrollContainer).toHaveStyle("max-height: 160px");

    const row = screen.getByText("dev").closest("a");
    expect(row).not.toBeNull();
    expect(row).toHaveClass("pr-24");
    expect(row).not.toHaveClass("min-h-11");
    expect(row?.parentElement).toHaveClass("group/session-row");
    expect(row).not.toContainElement(screen.getByTestId("rename-session-dev"));
    expect(row).not.toContainElement(screen.getByTestId("kill-session-dev"));

    const actions = screen.getByTestId("rename-session-dev").parentElement;
    expect(actions).not.toBeNull();
    expect(actions).toHaveClass("opacity-0");
    expect(actions).toHaveClass("group-hover/session-row:opacity-100");
    expect(actions).toHaveClass("focus-within:opacity-100");

    expect(screen.getByTestId("rename-session-dev")).toHaveClass("p-0.5");
    expect(screen.getByTestId("rename-session-dev")).not.toHaveClass("h-11");
    expect(screen.getByTestId("kill-session-dev")).toHaveClass("p-0.5");
    expect(screen.getByTestId("kill-session-dev")).not.toHaveClass("h-11");
  });

  it("makes mobile session rows and actions thumb-friendly without the desktop cap", async () => {
    mockUseIsMobile.mockReturnValue(true);
    mockGetWorkspaceSessions.mockResolvedValue({
      data: [makeSession("dev"), makeSession("build")],
    });

    const { scrollContainer } = await expandWorkspaceAndTerminalSessions();

    expect(scrollContainer).not.toHaveStyle("max-height: 160px");

    const row = screen.getByText("dev").closest("a");
    expect(row).not.toBeNull();
    expect(row).toHaveClass("min-h-11");
    expect(row).toHaveClass("py-2");
    expect(row).toHaveClass("text-sm");

    const actions = screen.getByTestId("rename-session-dev").parentElement;
    expect(actions).not.toBeNull();
    expect(actions).toHaveClass("opacity-100");
    expect(actions).not.toHaveClass("opacity-0");
    expect(actions).not.toHaveClass("group-hover/session:opacity-100");

    for (const testId of ["rename-session-dev", "kill-session-dev"]) {
      const button = screen.getByTestId(testId);
      expect(button).toHaveClass("flex");
      expect(button).toHaveClass("h-11");
      expect(button).toHaveClass("w-11");
      expect(button).toHaveClass("items-center");
      expect(button).toHaveClass("justify-center");
      expect(button).toHaveClass("p-0");
      expect(button).not.toHaveClass("p-0.5");
    }

    fireEvent.click(screen.getByTestId("rename-session-dev"));

    await waitFor(() => {
      expect(screen.getByTestId("rename-session-input-dev")).toBeInTheDocument();
    });

    const editingRow = screen.getByTestId("rename-session-input-dev").closest("button");
    expect(editingRow).not.toBeNull();
    expect(editingRow).toHaveClass("min-h-11");
    expect(editingRow).toHaveClass("py-2");
    expect(editingRow).toHaveClass("text-sm");
  });

  it("renders external tools as links that open in a new tab", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(mockGetWorkspaceAgent).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText("Files")).toBeInTheDocument();
    });

    const sessionsSection = screen.getByText("Sessions");
    const repositoriesSection = screen.getByText("Repositories");
    const toolsSection = screen.getByText("Tools");
    expect(
      sessionsSection.compareDocumentPosition(repositoriesSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      repositoriesSection.compareDocumentPosition(toolsSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(screen.getByText("Files").closest("a")).toHaveAttribute(
      "href",
      "https://filebrowser.test",
    );
    expect(screen.getByText("Files").closest("a")).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Files").closest("a")).toHaveAccessibleName(
      "Files (opens in a new tab)",
    );
    expect(screen.getByText("Desktop").closest("a")).toHaveAttribute(
      "href",
      "https://kasmvnc.test",
    );
    expect(screen.getByText("Desktop").closest("a")).toHaveAttribute("target", "_blank");
    expect(screen.getByText("VS Code").closest("a")).toHaveAttribute(
      "href",
      "https://code-server.test",
    );
    expect(screen.getByText("VS Code").closest("a")).toHaveAttribute("target", "_blank");
  });

  it("uses the workspace name as the unified workspace link without a redundant child", async () => {
    await expandWorkspaceAndTerminalSessions();

    const workspaceLink = screen.getByTestId("workspace-link-ws-1");
    expect(workspaceLink).toHaveAttribute("href", "/workspaces/ws-1/terminal/workspace");
    expect(workspaceLink).toHaveTextContent("dev-box");
    expect(workspaceLink).toHaveAttribute("data-active", "false");

    expect(screen.queryByTestId("git-workspace-link-ws-1")).not.toBeInTheDocument();

    const sessionLink = screen.getByText("dev").closest("a");
    expect(sessionLink).toHaveAttribute("href", "/workspaces/ws-1/terminal?session=dev");
    expect(screen.getByTestId("create-session-ws-1")).toBeInTheDocument();
  });

  it("separates collection navigation from disclosure controls", async () => {
    render(<AppSidebar />);

    const workspacesLink = await screen.findByRole("link", { name: /Workspaces/ });
    const workspacesDisclosure = screen.getByTestId("workspaces-disclosure");
    const workspacesCollapsible = workspacesDisclosure.closest("[data-testid='collapsible']");
    const initialWorkspacesOpen = workspacesCollapsible?.getAttribute("data-open");

    expect(workspacesLink).toHaveAttribute("href", "/workspaces");
    expect(workspacesDisclosure).toHaveAccessibleName(
      initialWorkspacesOpen === "true"
        ? "Collapse workspace navigation"
        : "Expand workspace navigation",
    );

    fireEvent.click(workspacesLink);
    expect(workspacesCollapsible).toHaveAttribute("data-open", initialWorkspacesOpen);

    fireEvent.click(workspacesDisclosure);
    expect(workspacesCollapsible).toHaveAttribute(
      "data-open",
      initialWorkspacesOpen === "true" ? "false" : "true",
    );

    const templatesLink = screen.getByRole("link", { name: /Templates/ });
    const templatesDisclosure = screen.getByTestId("templates-disclosure");
    expect(templatesLink).toHaveAttribute("href", "/templates");
    expect(templatesDisclosure).toHaveAccessibleName(/^(Expand|Collapse) template navigation$/);

    expect(screen.getByRole("link", { name: /Diagnostics/ })).toHaveAttribute(
      "href",
      "/terminal/status",
    );
  });

  it("uses one disclosure size contract throughout the workspace tree", async () => {
    render(<AppSidebar />);

    await screen.findByText("dev-box");
    const workspaceDisclosure = screen.getByTestId("workspace-disclosure-ws-1");
    expect(screen.getByTestId("workspaces-disclosure")).toHaveClass("size-8", "max-md:size-11");
    expect(workspaceDisclosure).toHaveClass("size-8", "max-md:size-11");

    fireEvent.click(workspaceDisclosure);
    expect(await screen.findByTestId("terminal-section-chevron-ws-1")).toHaveClass("size-4");
    expect(screen.getByTestId("git-section-chevron-ws-1")).toHaveClass("size-4");
  });

  it("marks the workspace-name link active on workspace routes", async () => {
    mockNavigationState.pathname = "/workspaces/ws-1/terminal/workspace";

    render(<AppSidebar />);

    const workspaceLink = await screen.findByTestId("workspace-link-ws-1");
    expect(workspaceLink).toHaveAttribute("href", "/workspaces/ws-1/terminal/workspace");
    expect(workspaceLink).toHaveAttribute("data-active", "true");

    await waitFor(() => {
      expect(screen.getByText("dev")).toBeInTheDocument();
    });
    expect(screen.getByText("dev").closest("a")).toHaveAttribute("data-active", "false");

    cleanup();
    mockNavigationState.pathname = "/workspaces/ws-1/terminal/git-workspace";
    render(<AppSidebar />);
    expect(await screen.findByTestId("workspace-link-ws-1")).toHaveAttribute("data-active", "true");
  });

  it("leaves internal sidebar links to Next navigation on full-bleed workspace routes", async () => {
    mockNavigationState.pathname = "/workspaces/ws-1/terminal/workspace";

    render(<AppSidebar />);

    const tasksLink = await screen.findByRole("link", { name: /tasks/i });
    const clickAllowed = fireEvent.click(tasksLink);

    expect(clickAllowed).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("leaves internal sidebar links to Next navigation on normal routes", async () => {
    render(<AppSidebar />);

    const tasksLink = await screen.findByRole("link", { name: /tasks/i });
    const clickAllowed = fireEvent.click(tasksLink);

    expect(clickAllowed).toBe(true);
  });

  it("keeps the multi-session workspace link reachable when session loading fails", async () => {
    mockGetWorkspaceSessions.mockResolvedValue({
      serverError: "Session fetch failed",
    });

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    expect(screen.getByTestId("workspace-link-ws-1")).toHaveAttribute(
      "href",
      "/workspaces/ws-1/terminal/workspace",
    );
    await waitFor(() => {
      expect(screen.getByText("Session fetch failed")).toBeInTheDocument();
    });
  });

  it("keeps the parent workspace active on clone terminal URLs without creating reserved sessions", async () => {
    mockNavigationState.pathname = "/workspaces/ws-1/terminal";
    mockNavigationState.searchParams =
      "session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneProof=proof-token";

    render(<AppSidebar />);

    const workspaceLink = await screen.findByTestId("workspace-link-ws-1");
    expect(workspaceLink).toHaveAttribute("data-active", "true");
    expect(workspaceLink).toHaveAttribute("href", "/workspaces/ws-1/terminal/workspace");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("create session button calls createSessionAction and navigates", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-section-ws-1")).toBeInTheDocument();
    });

    const terminalSection = screen.getByTestId("terminal-section-ws-1");
    const terminalTrigger = terminalSection.querySelector("[data-testid='collapsible-trigger']");
    fireEvent.click(terminalTrigger!);

    await waitFor(() => {
      expect(screen.getByTestId("create-session-ws-1")).toBeInTheDocument();
    });

    const createBtn = screen.getByTestId("create-session-ws-1");
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      expect(mockPush).toHaveBeenCalledWith("/workspaces/ws-1/terminal?session=session-123");
    });
  });

  it("kill session button calls killSessionAction", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-section-ws-1")).toBeInTheDocument();
    });

    const terminalSection = screen.getByTestId("terminal-section-ws-1");
    const terminalTrigger = terminalSection.querySelector("[data-testid='collapsible-trigger']");
    fireEvent.click(terminalTrigger!);

    await waitFor(() => {
      expect(screen.getByText("dev")).toBeInTheDocument();
    });

    const killBtn = screen.getByTestId("kill-session-dev");
    fireEvent.click(killBtn);

    await waitFor(() => {
      expect(mockKillSession).toHaveBeenCalledWith({ workspaceId: "ws-1", sessionName: "dev" });
    });
  });

  it("shows inline alert with retry when session fetch fails", async () => {
    mockGetWorkspaceSessions.mockResolvedValue({
      serverError: "Session fetch failed",
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-section-ws-1")).toBeInTheDocument();
    });

    const terminalSection = screen.getByTestId("terminal-section-ws-1");
    const terminalTrigger = terminalSection.querySelector("[data-testid='collapsible-trigger']");
    fireEvent.click(terminalTrigger!);

    await waitFor(() => {
      expect(screen.getByText("Session fetch failed")).toBeInTheDocument();
    });

    const retryButtons = screen.getAllByText("Retry");
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("refreshes only sessions (not workspaces/templates) on hive:sidebar-refresh", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    // Expand workspace to register it for session refresh
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(mockGetWorkspaceSessions).toHaveBeenCalled();
    });

    mockListWorkspaces.mockClear();
    mockListTemplates.mockClear();
    mockGetWorkspaceSessions.mockClear();

    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));

    await waitFor(() => {
      expect(mockGetWorkspaceSessions).toHaveBeenCalledTimes(1);
    });
    // Workspaces and templates should NOT be re-fetched on session refresh
    expect(mockListWorkspaces).not.toHaveBeenCalled();
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("cleans up hive:sidebar-refresh listener on unmount", async () => {
    const { unmount } = render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    unmount();

    mockGetWorkspaceSessions.mockClear();

    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockGetWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("hides external tool buttons when agent fetch fails", async () => {
    mockGetWorkspaceAgent.mockResolvedValue({
      serverError: "No agents found",
    });

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    await waitFor(() => {
      expect(mockGetWorkspaceAgent).toHaveBeenCalled();
    });

    expect(screen.queryByText("Files")).not.toBeInTheDocument();
    expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
    expect(screen.queryByText("VS Code")).not.toBeInTheDocument();
  });
});
