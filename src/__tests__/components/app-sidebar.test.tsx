// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/sidebar", () => {
  const Passthrough = ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  );
  const MenuButton = ({
    children,
    disabled,
    render: _render,
    isActive: _isActive,
    ...rest
  }: React.PropsWithChildren<{
    disabled?: boolean;
    render?: React.ReactElement;
    isActive?: boolean;
    className?: string;
  }>) => (
    <button disabled={disabled} {...rest}>
      {children}
    </button>
  );
  return {
    Sidebar: Passthrough,
    SidebarContent: Passthrough,
    SidebarFooter: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-testid="sidebar-footer" className={className}>{children}</div>
    ),
    SidebarGroup: Passthrough,
    SidebarGroupContent: Passthrough,
    SidebarGroupLabel: Passthrough,
    SidebarHeader: Passthrough,
    SidebarMenu: Passthrough,
    SidebarMenuButton: MenuButton,
    SidebarMenuItem: Passthrough,
    SidebarMenuSub: Passthrough,
    SidebarMenuSubButton: MenuButton,
    SidebarMenuSubItem: Passthrough,
  };
});

vi.mock("@/components/ui/collapsible", () => {
  return {
    Collapsible: ({
      children,
      defaultOpen,
      open,
      onOpenChange,
    }: React.PropsWithChildren<{ defaultOpen?: boolean; open?: boolean; onOpenChange?: (v: boolean) => void }>) => {
      const isOpen = open ?? defaultOpen;
      return (
        <div
          data-testid="collapsible"
          data-open={isOpen}
          data-onchange={onOpenChange ? "true" : undefined}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-testid='collapsible-trigger']") && onOpenChange) {
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
    CollapsibleTrigger: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <button data-testid="collapsible-trigger" className={className}>{children}</button>
    ),
  };
});

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <div role="alert">{children}</div>
  ),
  AlertDescription: ({ children }: React.PropsWithChildren<{ className?: string }>) => (
    <div>{children}</div>
  ),
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

vi.mock("lucide-react", () => ({
  ListTodo: () => <span>ListTodo</span>,
  PlusCircle: () => <span>PlusCircle</span>,
  Settings: () => <span>Settings</span>,
  Hexagon: () => <span>Hexagon</span>,
  LayoutTemplate: () => <span>LayoutTemplate</span>,
  Monitor: () => <span>Monitor</span>,
  LayoutDashboard: () => <span>LayoutDashboard</span>,
  ChevronRight: () => <span>ChevronRight</span>,
  RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
  AlertCircle: () => <span>AlertCircle</span>,
  Terminal: () => <span>Terminal</span>,
  Plus: () => <span>Plus</span>,
  X: () => <span>X</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  Code: () => <span>Code</span>,
  ExternalLink: () => <span>ExternalLink</span>,
}));

const mockListWorkspaces = vi.fn();
const mockListTemplates = vi.fn();
const mockGetWorkspaceAgent = vi.fn();
const mockGetWorkspaceSessions = vi.fn();
const mockCreateSession = vi.fn();
const mockKillSession = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: (...args: unknown[]) => mockListWorkspaces(...args),
  getWorkspaceAgentAction: (...args: unknown[]) => mockGetWorkspaceAgent(...args),
  getWorkspaceSessionsAction: (...args: unknown[]) => mockGetWorkspaceSessions(...args),
  createSessionAction: (...args: unknown[]) => mockCreateSession(...args),
  killSessionAction: (...args: unknown[]) => mockKillSession(...args),
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

import { AppSidebar } from "@/components/app-sidebar";
import type { CoderWorkspace } from "@/lib/coder/types";
import type { TemplateStatus } from "@/lib/templates/staleness";

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

describe("AppSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockListWorkspaces.mockResolvedValue({
      data: [makeWorkspace()],
    });
    mockListTemplates.mockResolvedValue({
      data: [makeTemplate()],
    });
    mockGetWorkspaceAgent.mockResolvedValue({
      data: { agentId: "agent-1", agentName: "main" },
    });
    mockGetWorkspaceSessions.mockResolvedValue({
      data: [{ name: "dev", created: 1000, windows: 1 }],
    });
    mockCreateSession.mockResolvedValue({
      data: { name: "session-123" },
    });
    mockKillSession.mockResolvedValue({
      data: { name: "dev" },
    });
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

  it("renders template names when data loads", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("hive-worker")).toBeInTheDocument();
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

  it("shows last-refreshed timestamp in footer after data loads", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const footer = screen.getByTestId("sidebar-footer");
    expect(footer.textContent).toMatch(/Updated/);
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

  it("expanding a workspace triggers agent and session fetch", async () => {
    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    expect(wsTrigger).not.toBeNull();
    fireEvent.click(wsTrigger!);

    await waitFor(() => {
      expect(mockGetWorkspaceAgent).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      expect(mockGetWorkspaceSessions).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    });
  });

  it("renders sessions as sub-items under expanded workspace", async () => {
    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    fireEvent.click(wsTrigger!);

    await waitFor(() => {
      expect(screen.getByText("dev")).toBeInTheDocument();
    });
  });

  it("renders external link buttons with correct href targets", async () => {
    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    fireEvent.click(wsTrigger!);

    await waitFor(() => {
      expect(mockGetWorkspaceAgent).toHaveBeenCalled();
    });

    await waitFor(() => {
      const fbLink = screen.getByTitle("Filebrowser");
      expect(fbLink).toBeInTheDocument();
      expect(fbLink.getAttribute("href")).toBe("https://filebrowser.test");

      const vncLink = screen.getByTitle("KasmVNC");
      expect(vncLink).toBeInTheDocument();
      expect(vncLink.getAttribute("href")).toBe("https://kasmvnc.test");

      const codeLink = screen.getByTitle("Code Server");
      expect(codeLink).toBeInTheDocument();
      expect(codeLink.getAttribute("href")).toBe("https://code-server.test");
    });
  });

  it("create session button calls createSessionAction and navigates", async () => {
    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    fireEvent.click(wsTrigger!);

    await waitFor(() => {
      expect(screen.getByText("dev")).toBeInTheDocument();
    });

    const createBtn = screen.getByTestId("create-session-ws-1");
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith({ workspaceId: "ws-1" });
      expect(mockPush).toHaveBeenCalledWith("/workspaces/ws-1/terminal?session=session-123");
    });
  });

  it("kill session button calls killSessionAction", async () => {
    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    fireEvent.click(wsTrigger!);

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

    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    fireEvent.click(wsTrigger!);

    await waitFor(() => {
      expect(screen.getByText("Session fetch failed")).toBeInTheDocument();
    });

    const retryButtons = screen.getAllByText("Retry");
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("re-fetches all data when hive:sidebar-refresh event is dispatched", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    mockListWorkspaces.mockClear();
    mockListTemplates.mockClear();

    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));

    await waitFor(() => {
      expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
      expect(mockListTemplates).toHaveBeenCalledTimes(1);
    });
  });

  it("cleans up hive:sidebar-refresh listener on unmount", async () => {
    const { unmount } = render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    unmount();

    mockListWorkspaces.mockClear();
    mockListTemplates.mockClear();

    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh"));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockListWorkspaces).not.toHaveBeenCalled();
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it("hides external links when agent fetch fails", async () => {
    mockGetWorkspaceAgent.mockResolvedValue({
      serverError: "No agents found",
    });

    render(<AppSidebar coderUrl="https://coder.test" />);

    await waitFor(() => {
      expect(screen.getByText("dev-box")).toBeInTheDocument();
    });

    const wsTrigger = screen.getByText("dev-box").closest("[data-testid='collapsible-trigger']");
    fireEvent.click(wsTrigger!);

    await waitFor(() => {
      expect(mockGetWorkspaceAgent).toHaveBeenCalled();
    });

    expect(screen.queryByTitle("Filebrowser")).not.toBeInTheDocument();
    expect(screen.queryByTitle("KasmVNC")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Code Server")).not.toBeInTheDocument();
  });
});
