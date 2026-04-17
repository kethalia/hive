// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
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

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    defaultOpen,
  }: React.PropsWithChildren<{ defaultOpen?: boolean; onOpenChange?: (v: boolean) => void }>) => (
    <div data-testid="collapsible" data-open={defaultOpen}>
      {children}
    </div>
  ),
  CollapsibleContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
  CollapsibleTrigger: ({ children }: React.PropsWithChildren<{ className?: string }>) => (
    <button data-testid="collapsible-trigger">{children}</button>
  ),
}));

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
}));

const mockListWorkspaces = vi.fn();
const mockListTemplates = vi.fn();

vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: (...args: unknown[]) => mockListWorkspaces(...args),
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
});
