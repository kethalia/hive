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

  it("defaults to sidebar when localStorage is empty", () => {
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("sidebar");
  });

  it("reads floating mode from localStorage", () => {
    localStorage.setItem("sidebar_variant", "floating");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");
  });

  it("setSidebarMode(true) changes to floating", () => {
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("sidebar");

    act(() => {
      result.current[1](true);
    });

    expect(result.current[0]).toBe("floating");
  });

  it("setSidebarMode(false) changes to sidebar", () => {
    localStorage.setItem("sidebar_variant", "floating");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");

    act(() => {
      result.current[1](false);
    });

    expect(result.current[0]).toBe("sidebar");
  });

  it("persists mode change to localStorage", () => {
    const { result } = renderHook(() => useSidebarMode());

    act(() => {
      result.current[1](true);
    });

    expect(localStorage.getItem("sidebar_variant")).toBe("floating");

    act(() => {
      result.current[1](false);
    });

    expect(localStorage.getItem("sidebar_variant")).toBe("sidebar");
  });

  it("treats unknown localStorage value as sidebar", () => {
    localStorage.setItem("sidebar_variant", "bogus");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("sidebar");
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
    SidebarTrigger: () => <button data-testid="sidebar-trigger">Toggle</button>,
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
  Badge: ({ children, className }: React.PropsWithChildren<{ variant?: string; className?: string }>) => (
    <span data-testid="badge" className={className}>{children}</span>
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    id?: string;
    size?: string;
    "data-testid"?: string;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      data-testid={rest["data-testid"]}
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
  ChevronRight: () => <span>ChevronRight</span>,
  RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
  AlertCircle: () => <span>AlertCircle</span>,
  Terminal: () => <span>Terminal</span>,
  Plus: () => <span>Plus</span>,
  X: () => <span>X</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  Code: () => <span>Code</span>,
  ExternalLink: () => <span>ExternalLink</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  Pencil: () => <span>Pencil</span>,
  Loader2: () => <span>Loader2</span>,
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
  renameSessionAction: vi.fn().mockResolvedValue({ data: null }),
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

  it("renders mode toggle switch in settings", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      const toggle = screen.getByTestId("sidebar-mode-toggle");
      expect(toggle).toBeInTheDocument();
    });
  });

  it("switch is off in sidebar mode (default)", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      const toggle = screen.getByTestId("sidebar-mode-toggle");
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });
  });

  it("clicking switch enables floating mode", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-mode-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));

    await waitFor(() => {
      const toggle = screen.getByTestId("sidebar-mode-toggle");
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
  });

  it("clicking switch persists mode to localStorage", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-mode-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));

    expect(localStorage.getItem("sidebar_variant")).toBe("floating");
  });

  it("clicking switch twice returns to sidebar mode", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-mode-toggle")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-mode-toggle"));

    await waitFor(() => {
      const toggle = screen.getByTestId("sidebar-mode-toggle");
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });
    expect(localStorage.getItem("sidebar_variant")).toBe("sidebar");
  });
});
