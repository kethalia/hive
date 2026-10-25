// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockUseIsMobile = vi.hoisted(() => vi.fn(() => false));
const mockSetOpenMobile = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());
const mockNavigationState = vi.hoisted(() => ({ pathname: "/terminal/status", searchParams: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => mockNavigationState.pathname,
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  useSearchParams: () => new URLSearchParams(mockNavigationState.searchParams),
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
    useSidebar: () => ({ setOpenMobile: mockSetOpenMobile }),
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
  Bell: () => <span>Bell</span>,
  Ellipsis: () => <span>Ellipsis</span>,
  Settings: () => <span aria-hidden="true">Settings</span>,
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

function makeWorkspace(overrides: Partial<CoderWorkspace> = {}): CoderWorkspace {
  return {
    id: "ws-1",
    name: "dev-box",
    template_id: "tpl-1",
    template_name: "game-dev",
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
    name: "browser-testing",
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

describe("AppSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigationState.pathname = "/terminal/status";
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

  it("does not offer or fetch the removed desktop terminal controls setting", async () => {
    render(<AppSidebar />);
    await screen.findByRole("link", { name: "Settings" });
    expect(
      screen.queryByRole("switch", { name: "Show terminal controls beyond phone" }),
    ).toBeNull();
    expect(mockGetTerminalSettings).not.toHaveBeenCalled();
  });

  it("links directly to settings without notifications, refresh, or update controls", async () => {
    render(<AppSidebar />);
    const settings = await screen.findByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/settings");
    const footer = screen.getByTestId("sidebar-footer");
    expect(footer.querySelector("button[title='Refresh']")).toBeNull();
    expect(screen.queryByText("Notifications")).toBeNull();
    expect(screen.queryByTestId("update-installed-app")).toBeNull();
    expect(screen.queryByTestId("last-refreshed")).toBeNull();
  });

  it("marks the settings link active on the settings page", async () => {
    mockNavigationState.pathname = "/settings";
    render(<AppSidebar />);
    expect(await screen.findByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders template names when data loads", async () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByTestId("templates-disclosure"));

    await waitFor(() => {
      expect(screen.getByText("browser-testing")).toBeInTheDocument();
    });
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
    fireEvent.click(screen.getByTestId("templates-disclosure"));

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

  it("opens provisioned apps in the general workspace", async () => {
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

    expect(screen.getByText("Files").closest("a")).toHaveAttribute(
      "href",
      "/workspaces?workspace=ws-1&tool=files",
    );
    expect(screen.getByText("Files").closest("a")).not.toHaveAttribute("target");
    expect(screen.getByText("Files").closest("a")).toHaveAccessibleName("Open Files in workspace");
    expect(screen.getByText("Desktop").closest("a")).toHaveAttribute(
      "href",
      "/workspaces?workspace=ws-1&tool=desktop",
    );
    expect(screen.getByText("Desktop").closest("a")).not.toHaveAttribute("target");
    expect(screen.getByText("VS Code").closest("a")).toHaveAttribute(
      "href",
      "/workspaces?workspace=ws-1&tool=code",
    );
    expect(screen.getByText("VS Code").closest("a")).not.toHaveAttribute("target");
  });

  it("shows only provisioned apps for headless workspace profiles", async () => {
    mockListWorkspaces.mockResolvedValue({
      data: [makeWorkspace({ template_name: "ai-dev-k8s" })],
    });

    render(<AppSidebar />);
    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));
    await screen.findByText("Files");

    expect(screen.getByText("VS Code")).toBeInTheDocument();
    expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
  });

  it("does not render a web-app section for the terminal-only orchestrator", async () => {
    mockListWorkspaces.mockResolvedValue({
      data: [makeWorkspace({ template_name: "orchestrator" })],
    });

    render(<AppSidebar />);
    await screen.findByText("dev-box");
    expect(screen.queryByTestId("workspace-disclosure-ws-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-link-ws-1")).toHaveAttribute(
      "href",
      "/workspaces?workspace=ws-1",
    );
    expect(mockGetWorkspaceAgent).not.toHaveBeenCalled();

    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
    expect(screen.queryByText("VS Code")).not.toBeInTheDocument();
    expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
  });

  it("toggles apps from one workspace row without navigating or closing the mobile sidebar", async () => {
    mockNavigationState.pathname = "/workspaces";
    render(<AppSidebar />);
    const row = await screen.findByRole("button", { name: "Expand dev-box apps" });
    expect(row).not.toHaveAttribute("href");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("workspace-link-ws-1")).not.toBeInTheDocument();
    expect(row.querySelectorAll("button, a")).toHaveLength(0);

    fireEvent.click(within(row).getByText("dev-box"));
    await screen.findByRole("link", { name: "Open Files in workspace" });
    expect(row).toHaveAttribute("aria-expanded", "true");
    const panelId = row.getAttribute("aria-controls");
    expect(document.getElementById(panelId!)).toContainElement(screen.getByText("Files"));

    fireEvent.click(within(row).getByText("running"));
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Open Files in workspace" })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByText("ChevronRight"));
    expect(row).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("link", { name: "Open Files in workspace" });
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSetOpenMobile).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("marks the workspace row active and expands apps on workspace routes", async () => {
    mockNavigationState.pathname = "/workspaces/ws-1/terminal/workspace";
    render(<AppSidebar />);
    const row = await screen.findByRole("button", { name: "Collapse dev-box apps" });
    expect(row).toHaveAttribute("data-active", "true");
    expect(row).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("link", { name: "Open Files in workspace" });

    cleanup();
    mockNavigationState.pathname = "/workspaces/ws-1/terminal/git-workspace";
    render(<AppSidebar />);
    expect(await screen.findByRole("button", { name: "Collapse dev-box apps" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("keeps an open-workspace link inside stopped workspace disclosures", async () => {
    mockListWorkspaces.mockResolvedValue({
      data: [
        makeWorkspace({ latest_build: { ...makeWorkspace().latest_build, status: "stopped" } }),
      ],
    });
    render(<AppSidebar />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand dev-box apps" }));
    expect(screen.getByRole("link", { name: /Open workspace/ })).toHaveAttribute(
      "href",
      "/workspaces?workspace=ws-1",
    );
    expect(mockGetWorkspaceAgent).not.toHaveBeenCalled();
  });

  it("leaves internal sidebar links to Next navigation on full-bleed workspace routes", async () => {
    mockNavigationState.pathname = "/workspaces/ws-1/terminal/workspace";

    render(<AppSidebar />);

    const templatesLink = await screen.findByRole("link", { name: /templates/i });
    const clickAllowed = fireEvent.click(templatesLink);

    expect(clickAllowed).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("leaves internal sidebar links to Next navigation on normal routes", async () => {
    render(<AppSidebar />);

    const templatesLink = await screen.findByRole("link", { name: /templates/i });
    const clickAllowed = fireEvent.click(templatesLink);

    expect(clickAllowed).toBe(true);
  });

  it("keeps workspace apps reachable without depending on session discovery", async () => {
    mockGetWorkspaceSessions.mockResolvedValue({
      serverError: "Session fetch failed",
    });

    render(<AppSidebar />);

    await screen.findByText("dev-box");
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));

    expect(await screen.findByRole("link", { name: "Open Files in workspace" })).toHaveAttribute(
      "href",
      "/workspaces?workspace=ws-1&tool=files",
    );
    expect(mockGetWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("keeps the parent workspace active on clone terminal URLs without creating reserved sessions", async () => {
    mockNavigationState.pathname = "/workspaces/ws-1/terminal";
    mockNavigationState.searchParams =
      "session=git-clone-safe-hive&clonePath=kethalia%2Fhive&cloneProof=proof-token";

    render(<AppSidebar />);

    const row = await screen.findByRole("button", { name: "Collapse dev-box apps" });
    expect(row).toHaveAttribute("data-active", "true");
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(mockCreateSession).not.toHaveBeenCalled();
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
  it("separates authoring workspaces from browser and infrastructure helpers", async () => {
    mockListWorkspaces.mockResolvedValue({
      data: [
        makeWorkspace({ id: "software", name: "ai-dev-01", template_name: "ai-dev-k8s" }),
        makeWorkspace({ id: "browser", name: "browser-helper", template_name: "browser-testing" }),
        makeWorkspace({ id: "infra", name: "infra-helper", template_name: "infrastructure" }),
        makeWorkspace({ id: "game", name: "game-studio", template_name: "game-dev" }),
        makeWorkspace({ id: "external", name: "external-project", template_name: "custom" }),
      ],
    });
    render(<AppSidebar />);
    await waitFor(() => expect(screen.getByText("ai-dev-01")).toBeInTheDocument());
    const work = screen.getByTestId("workspace-group-development");
    const helpers = screen.getByTestId("workspace-group-helper");
    expect(work).toHaveTextContent("ai-dev-01");
    expect(work).toHaveTextContent("game-studio");
    expect(work).toHaveTextContent("external-project");
    expect(work).not.toHaveTextContent("browser-helper");
    expect(helpers).toHaveTextContent("browser-helper");
    expect(helpers).toHaveTextContent("infra-helper");
  });

  it("opens workspace tools without discovering repositories, favorites, or sessions", async () => {
    render(<AppSidebar />);
    await waitFor(() => expect(screen.getByText("dev-box")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("workspace-disclosure-ws-1"));
    await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument());
    expect(screen.queryByText("Repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("favorites-section")).not.toBeInTheDocument();
    expect(mockListGitClones).not.toHaveBeenCalled();
    expect(mockListNavigationFavorites).not.toHaveBeenCalled();
    expect(mockGetWorkspaceSessions).not.toHaveBeenCalled();
  });
});
