// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { useSidebarMode } from "@/hooks/use-sidebar-mode";

const originalInnerWidth = window.innerWidth;

describe("useSidebarMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to floating when localStorage is empty", () => {
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");
  });

  it("reads floating mode from localStorage", () => {
    localStorage.setItem("sidebar_variant", "floating");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");
  });

  it("setSidebarMode(true) stays floating", () => {
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");

    act(() => {
      result.current[1](true);
    });

    expect(result.current[0]).toBe("floating");
  });

  it("setSidebarMode(false) still forces floating", () => {
    localStorage.setItem("sidebar_variant", "floating");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");

    act(() => {
      result.current[1](false);
    });

    expect(result.current[0]).toBe("floating");
    expect(localStorage.getItem("sidebar_variant")).toBe("floating");
  });

  it("persists only floating mode to localStorage", () => {
    const { result } = renderHook(() => useSidebarMode());

    act(() => {
      result.current[1](true);
    });

    expect(localStorage.getItem("sidebar_variant")).toBe("floating");

    act(() => {
      result.current[1](false);
    });

    expect(localStorage.getItem("sidebar_variant")).toBe("floating");
  });

  it("migrates unknown localStorage value to floating", () => {
    localStorage.setItem("sidebar_variant", "bogus");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");
    expect(localStorage.getItem("sidebar_variant")).toBe("floating");
  });

  it("migrates stale sidebar localStorage value to floating", () => {
    localStorage.setItem("sidebar_variant", "sidebar");
    const { result } = renderHook(() => useSidebarMode());
    expect(result.current[0]).toBe("floating");
    expect(localStorage.getItem("sidebar_variant")).toBe("floating");
  });
});

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/sidebar", () => {
  const Passthrough = ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
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
    Sidebar: ({
      children,
      className,
      variant,
    }: React.PropsWithChildren<{ className?: string; variant?: string }>) => (
      <div data-testid="app-sidebar-root" data-variant={variant} className={className}>
        {children}
      </div>
    ),
    SidebarContent: Passthrough,
    SidebarFooter: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-testid="sidebar-footer" className={className}>
        {children}
      </div>
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
  GitBranch: () => <span>GitBranch</span>,
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
  PanelLeftIcon: () => <span>PanelLeftIcon</span>,
  Plus: () => <span>Plus</span>,
  X: () => <span>X</span>,
  XIcon: () => <span>XIcon</span>,
  FolderOpen: () => <span>FolderOpen</span>,
  Code: () => <span>Code</span>,
  ExternalLink: () => <span>ExternalLink</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  Pencil: () => <span>Pencil</span>,
  Star: () => <span>Star</span>,
  Loader2: () => <span>Loader2</span>,
  LogOut: () => <span>LogOut</span>,
}));

const mockListWorkspaces = vi.fn();
const mockListTemplates = vi.fn();
const mockGetWorkspaceAgent = vi.fn();
const mockGetWorkspaceSessions = vi.fn();
const mockCreateSession = vi.fn();
const mockKillSession = vi.fn();
const mockListGitClones = vi.fn();
const mockResolveGitCloneTerminal = vi.fn();
const mockListNavigationFavorites = vi.fn();
const mockUpsertNavigationFavorite = vi.fn();
const mockRemoveNavigationFavorite = vi.fn();
const mockGetTerminalSettings = vi.fn();
const mockUpdateTerminalSettings = vi.fn();
const mockGetSessionAction = vi.fn();

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

vi.mock("@/lib/actions/git-clones", () => ({
  listGitClonesAction: (...args: unknown[]) => mockListGitClones(...args),
  resolveGitCloneTerminalAction: (...args: unknown[]) => mockResolveGitCloneTerminal(...args),
}));

vi.mock("@/lib/actions/navigation-favorites", () => ({
  listNavigationFavoritesAction: (...args: unknown[]) => mockListNavigationFavorites(...args),
  upsertNavigationFavoriteAction: (...args: unknown[]) => mockUpsertNavigationFavorite(...args),
  removeNavigationFavoriteAction: (...args: unknown[]) => mockRemoveNavigationFavorite(...args),
}));

vi.mock("@/lib/actions/user-settings", () => ({
  getTerminalSettingsAction: (...args: unknown[]) => mockGetTerminalSettings(...args),
  updateTerminalSettingsAction: (...args: unknown[]) => mockUpdateTerminalSettings(...args),
}));

vi.mock("@/lib/auth/actions", () => ({
  getSessionAction: (...args: unknown[]) => mockGetSessionAction(...args),
}));

describe("Sidebar primitive layout contract", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it("reserves the widened desktop width for the floating sidebar", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });

    const { Sidebar: ActualSidebar, SidebarProvider: ActualSidebarProvider } =
      await vi.importActual<typeof import("@/components/ui/sidebar")>("@/components/ui/sidebar");

    const { container } = render(
      <ActualSidebarProvider>
        <ActualSidebar variant="floating">
          <nav aria-label="Workspace navigation">Navigation</nav>
        </ActualSidebar>
      </ActualSidebarProvider>,
    );

    const wrapper = container.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
    const root = container.querySelector<HTMLElement>('[data-slot="sidebar"]');
    const gap = container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]');
    const sidebarContainer = container.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"]',
    );

    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("18rem");
    expect(wrapper?.style.getPropertyValue("--sidebar-width-icon")).toBe("3rem");
    expect(root).toHaveAttribute("data-variant", "floating");
    expect(gap?.className).toContain("group-data-[collapsible=offcanvas]:w-0");
    expect(gap?.className).toContain("w-(--sidebar-width)");
    expect(sidebarContainer?.className).toContain("w-(--sidebar-width)");
  });

  it("preserves the mobile drawer width token", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    const {
      Sidebar: ActualSidebar,
      SidebarProvider: ActualSidebarProvider,
      SidebarTrigger: ActualSidebarTrigger,
    } = await vi.importActual<typeof import("@/components/ui/sidebar")>("@/components/ui/sidebar");

    render(
      <ActualSidebarProvider>
        <ActualSidebarTrigger />
        <ActualSidebar variant="floating">
          <nav aria-label="Mobile workspace navigation">Navigation</nav>
        </ActualSidebar>
      </ActualSidebarProvider>,
    );

    const trigger = document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    fireEvent.click(trigger!);

    await waitFor(() => {
      const drawer = document.querySelector<HTMLElement>('[data-mobile="true"]');
      expect(drawer).not.toBeNull();
      expect(drawer?.style.getPropertyValue("--sidebar-width")).toBe("18rem");
    });
  });
});

import { AppSidebar } from "@/components/app-sidebar";

describe("AppSidebar floating-only mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockListWorkspaces.mockResolvedValue({ data: [] });
    mockListTemplates.mockResolvedValue({ data: [] });
    mockGetTerminalSettings.mockResolvedValue({
      data: { terminalControlsBeyondMobile: false },
    });
    mockUpdateTerminalSettings.mockResolvedValue({
      data: { terminalControlsBeyondMobile: false },
    });
    mockGetSessionAction.mockResolvedValue({ data: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render a sidebar mode toggle in settings", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("app-sidebar-root")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("sidebar-mode-toggle")).not.toBeInTheDocument();
    expect(screen.queryByText("Float sidebar")).not.toBeInTheDocument();
  });

  it("uses floating sidebar variant by default", async () => {
    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("app-sidebar-root")).toHaveAttribute("data-variant", "floating");
    });
  });

  it("ignores and migrates stale non-floating storage", async () => {
    localStorage.setItem("sidebar_variant", "sidebar");

    render(<AppSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId("app-sidebar-root")).toHaveAttribute("data-variant", "floating");
    });
    expect(localStorage.getItem("sidebar_variant")).toBe("floating");
    expect(screen.queryByTestId("sidebar-mode-toggle")).not.toBeInTheDocument();
  });
});
