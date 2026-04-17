// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { useSidebarMode } from "@/hooks/use-sidebar-mode";

describe("useSidebarMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to offcanvas when localStorage is empty", () => {
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("offcanvas");
  });

  it("reads icon mode from localStorage", () => {
    localStorage.setItem("sidebar_mode", "icon");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("icon");
  });

  it("toggle changes mode from offcanvas to icon", () => {
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("offcanvas");

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe("icon");
  });

  it("toggle changes mode from icon back to offcanvas", () => {
    localStorage.setItem("sidebar_mode", "icon");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("icon");

    act(() => {
      result.current[1]();
    });

    expect(result.current[0]).toBe("offcanvas");
  });

  it("persists mode change to localStorage", () => {
    const { result } = renderHook(() => useSidebarMode());

    act(() => {
      result.current[1]();
    });

    expect(localStorage.getItem("sidebar_mode")).toBe("icon");

    act(() => {
      result.current[1]();
    });

    expect(localStorage.getItem("sidebar_mode")).toBe("offcanvas");
  });

  it("treats unknown localStorage value as offcanvas", () => {
    localStorage.setItem("sidebar_mode", "bogus");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("offcanvas");
  });
});

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

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CollapsibleContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: React.PropsWithChildren) => <div role="alert">{children}</div>,
  AlertDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <span data-testid="badge" className={className}>{children}</span>
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
  Pin: () => <span data-testid="pin-icon">Pin</span>,
  PinOff: () => <span data-testid="pinoff-icon">PinOff</span>,
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
  buildWorkspaceUrls: () => ({
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

describe("AppSidebar mode toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockListWorkspaces.mockResolvedValue({ data: [] });
    mockListTemplates.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders mode toggle button in footer", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      const toggle = screen.getByTestId("sidebar-mode-toggle");
      expect(toggle).toBeInTheDocument();
    });
  });

  it("shows PinOff icon in offcanvas mode (default)", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("pinoff-icon")).toBeInTheDocument();
    });
  });

  it("clicking toggle switches to icon mode and shows Pin icon", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-mode-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("pin-icon")).toBeInTheDocument();
    });
  });

  it("clicking toggle persists mode to localStorage", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-mode-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));

    expect(localStorage.getItem("sidebar_mode")).toBe("icon");
  });

  it("clicking toggle twice returns to offcanvas mode", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-mode-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("pinoff-icon")).toBeInTheDocument();
    });
    expect(localStorage.getItem("sidebar_mode")).toBe("offcanvas");
  });
});
