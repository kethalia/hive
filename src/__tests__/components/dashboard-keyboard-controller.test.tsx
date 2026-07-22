// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeybindingEntry } from "@/hooks/useKeybindings";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockToggleSidebar = vi.hoisted(() => vi.fn());
const mockSetOpen = vi.hoisted(() => vi.fn());
const mockSetOpenMobile = vi.hoisted(() => vi.fn());
const mockSetOpenMobileRight = vi.hoisted(() => vi.fn());
const mockUseGlobalCommandPaletteGesture = vi.hoisted(() => vi.fn());
const mobileState = vi.hoisted(() => ({
  isMobile: false,
  openMobile: false,
  openMobileRight: false,
}));
const mockListWorkspaces = vi.hoisted(() => vi.fn());
const mockListTasks = vi.hoisted(() => vi.fn());
const registeredBindings = vi.hoisted(() => new Map<string, KeybindingEntry>());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({
    openMobile: mobileState.openMobile,
    setOpen: mockSetOpen,
    setOpenMobile: mockSetOpenMobile,
    openMobileRight: mobileState.openMobileRight,
    setOpenMobileRight: mockSetOpenMobileRight,
    toggleSidebar: mockToggleSidebar,
  }),
}));

vi.mock("@/hooks/useGlobalCommandPaletteGesture", () => ({
  useGlobalCommandPaletteGesture: mockUseGlobalCommandPaletteGesture,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileState.isMobile,
}));

vi.mock("@/hooks/useKeybindings", () => ({
  useRegisterKeybinding: (entry: KeybindingEntry) => {
    registeredBindings.set(entry.id, entry);
  },
}));

vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: () => mockListWorkspaces(),
}));

vi.mock("@/lib/actions/tasks", () => ({
  listTasksAction: () => mockListTasks(),
}));

vi.mock("@/components/terminal/CommandPalette", () => ({
  CommandPalette: ({
    actions,
    emptyText,
    onCreateSession,
    onSelectTab,
    open,
    tabs,
    mobileSide,
  }: {
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      onSelect: () => void;
    }>;
    emptyText: string;
    onCreateSession?: () => void;
    onSelectTab: (tabId: string) => void;
    open: boolean;
    tabs: Array<{ id: string; sessionName: string }>;
    mobileSide?: "bottom" | "right";
  }) => (
    <div
      data-empty-text={emptyText}
      data-mobile-side={mobileSide}
      data-open={open ? "true" : "false"}
      data-testid="palette"
    >
      {open
        ? [
            ...actions.map((action) => (
              <button key={action.id} type="button" onClick={action.onSelect}>
                <span>{action.label}</span>
                {action.description ? <small>{action.description}</small> : null}
              </button>
            )),
            ...tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  onSelectTab(tab.id);
                }}
              >
                {tab.sessionName}
              </button>
            )),
            onCreateSession ? (
              <button key="create-session" type="button" onClick={onCreateSession}>
                New Session
              </button>
            ) : null,
          ]
        : null}
    </div>
  ),
}));

import { DashboardKeyboardController } from "@/components/dashboard-keyboard-controller";
import { TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";
import { registerGlobalCommandPaletteSource } from "@/lib/terminal/global-command-palette";

function workspacePayload() {
  return {
    data: [
      {
        id: "workspace-1",
        name: "hive-dev",
        last_used_at: new Date().toISOString(),
        latest_build: { status: "running" },
      },
    ],
  };
}

function tasksPayload() {
  return {
    data: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        prompt: "Fix terminal keyboard shortcuts",
        status: "running",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        prompt: "Ship completed work",
        status: "done",
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}

describe("DashboardKeyboardController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileState.isMobile = false;
    mobileState.openMobile = false;
    mobileState.openMobileRight = false;
    registeredBindings.clear();
    mockListWorkspaces.mockResolvedValue(workspacePayload());
    mockListTasks.mockResolvedValue(tasksPayload());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.dashboardFullscreen;
  });

  it("registers global dashboard keybindings", () => {
    render(<DashboardKeyboardController />);

    expect(screen.getByTestId("palette")).toHaveAttribute("data-mobile-side", "right");

    expect(registeredBindings.get("dashboard:command-palette")?.keys).toEqual(["ctrl+k", "cmd+k"]);
    expect(registeredBindings.get("dashboard:toggle-sidebar")?.keys).toEqual(["ctrl+b", "cmd+b"]);
    expect(registeredBindings.get("dashboard:toggle-compose")?.keys).toEqual(["ctrl+`", "cmd+`"]);
    expect(registeredBindings.get("dashboard:toggle-fullscreen")?.keys).toEqual([
      "ctrl+enter",
      "cmd+enter",
    ]);
    expect(registeredBindings.get("dashboard:navigate-tasks")?.keys).toEqual([
      "ctrl+shift+2",
      "cmd+shift+2",
    ]);
    expect(registeredBindings.get("dashboard:navigate-workspaces")?.keys).toEqual([
      "ctrl+shift+1",
      "cmd+shift+1",
    ]);
    expect(registeredBindings.get("dashboard:navigate-templates")?.keys).toEqual([
      "ctrl+shift+3",
      "cmd+shift+3",
    ]);
    expect(registeredBindings.get("dashboard:navigate-terminal-status")?.keys).toEqual([
      "ctrl+shift+4",
      "cmd+shift+4",
    ]);
    for (const id of [
      "dashboard:command-palette",
      "dashboard:toggle-sidebar",
      "dashboard:toggle-compose",
      "dashboard:toggle-fullscreen",
      "dashboard:navigate-tasks",
      "dashboard:navigate-workspaces",
      "dashboard:navigate-templates",
      "dashboard:navigate-terminal-status",
    ]) {
      expect(registeredBindings.get(id)?.allowTextEntry).toBe(true);
      expect(registeredBindings.get(id)?.global).toBe(true);
    }
  });

  it("publishes keybinding readiness only while the controller is mounted", () => {
    const { unmount } = render(<DashboardKeyboardController />);

    expect(document.documentElement.dataset.dashboardKeybindingsReady).toBe("true");
    unmount();
    expect(document.documentElement.dataset.dashboardKeybindingsReady).toBeUndefined();
  });

  it("loads dashboard commands and navigates from the global palette", async () => {
    render(<DashboardKeyboardController />);

    act(() => {
      expect(registeredBindings.get("dashboard:command-palette")?.action(null, null)).toBe(false);
    });

    await waitFor(() => {
      expect(mockListWorkspaces).toHaveBeenCalled();
      expect(mockListTasks).toHaveBeenCalled();
    });

    expect(await screen.findByText("New task")).toBeInTheDocument();
    expect(screen.getByText("Check task progress (1)")).toBeInTheDocument();
    expect(screen.getByText("hive-dev")).toBeInTheDocument();

    fireEvent.click(screen.getByText("hive-dev"));
    expect(mockRouterPush).toHaveBeenCalledWith("/workspaces/workspace-1/terminal/workspace");

    fireEvent.click(screen.getByText("New task"));
    expect(mockRouterPush).toHaveBeenCalledWith("/tasks/new");

    fireEvent.click(screen.getByText("Check task progress (1)"));
    expect(mockRouterPush).toHaveBeenCalledWith("/tasks");
  });

  it("includes commands from the active workspace palette source", async () => {
    const onSelectTab = vi.fn();
    const onCreateSession = vi.fn();
    const onSearchValueChange = vi.fn();
    const cleanupSource = registerGlobalCommandPaletteSource({
      id: "test-workspace-source",
      tabs: [{ id: "tab-1", sessionName: "main-session" }],
      onSelectTab,
      onCreateSession,
      searchValue: "stale terminal query",
      onSearchValueChange,
      actions: [
        {
          id: "workspace:add-terminal",
          label: "Add dev-server",
          description: "Add this terminal to the board",
          group: "Terminal sessions",
          onSelect: vi.fn(),
        },
      ],
    });

    render(<DashboardKeyboardController />);

    act(() => {
      expect(registeredBindings.get("dashboard:command-palette")?.action(null, null)).toBe(false);
    });

    expect(onSearchValueChange).toHaveBeenCalledWith("");
    expect(await screen.findByText("Add dev-server")).toBeInTheDocument();
    fireEvent.click(screen.getByText("main-session"));
    expect(onSelectTab).toHaveBeenCalledWith("tab-1");
    fireEvent.click(screen.getByText("New Session"));
    expect(onCreateSession).toHaveBeenCalled();

    cleanupSource();
  });

  it("runs sidebar, compose, and fullscreen actions globally", () => {
    const composeListener = vi.fn();
    window.addEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, composeListener);
    render(<DashboardKeyboardController />);

    act(() => {
      expect(registeredBindings.get("dashboard:toggle-sidebar")?.action(null, null)).toBe(false);
      expect(registeredBindings.get("dashboard:toggle-compose")?.action(null, null)).toBe(false);
      expect(registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null)).toBe(false);
    });

    expect(mockToggleSidebar).toHaveBeenCalled();
    expect(composeListener).toHaveBeenCalled();
    expect(mockSetOpen).toHaveBeenCalledWith(false);
    expect(mockSetOpenMobile).toHaveBeenCalledWith(false);
    expect(mockSetOpenMobileRight).toHaveBeenCalledWith(false);
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");

    window.removeEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, composeListener);
  });

  it("opens the coordinated right sidebar on mobile", () => {
    mobileState.isMobile = true;
    render(<DashboardKeyboardController />);

    act(() => {
      expect(registeredBindings.get("dashboard:command-palette")?.action(null, null)).toBe(false);
    });

    expect(mockSetOpenMobileRight).toHaveBeenCalledWith(true);
    expect(mockSetOpenMobile).not.toHaveBeenCalledWith(false);
  });

  it("disables the global swipe while either mobile sidebar is open", () => {
    mobileState.isMobile = true;
    mobileState.openMobile = true;
    const { rerender } = render(<DashboardKeyboardController />);

    expect(mockUseGlobalCommandPaletteGesture).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    mobileState.openMobile = false;
    mobileState.openMobileRight = true;
    rerender(<DashboardKeyboardController />);

    expect(mockUseGlobalCommandPaletteGesture).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("moves an open desktop palette into the mobile right sidebar", async () => {
    const { rerender } = render(<DashboardKeyboardController />);
    act(() => {
      expect(registeredBindings.get("dashboard:command-palette")?.action(null, null)).toBe(false);
    });
    expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");

    mobileState.isMobile = true;
    rerender(<DashboardKeyboardController />);

    await waitFor(() => {
      expect(mockSetOpenMobileRight).toHaveBeenCalledWith(true);
    });
    expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "false");
  });

  it("moves an open mobile drawer into the desktop palette", async () => {
    mobileState.isMobile = true;
    mobileState.openMobileRight = true;
    const { rerender } = render(<DashboardKeyboardController />);
    expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");

    mobileState.isMobile = false;
    rerender(<DashboardKeyboardController />);

    await waitFor(() => {
      expect(mockSetOpenMobileRight).toHaveBeenCalledWith(false);
      expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");
    });
  });

  it("navigates to primary dashboard surfaces from global shortcuts", () => {
    render(<DashboardKeyboardController />);

    for (const [id, route] of [
      ["dashboard:navigate-tasks", "/tasks"],
      ["dashboard:navigate-workspaces", "/workspaces"],
      ["dashboard:navigate-templates", "/templates"],
      ["dashboard:navigate-terminal-status", "/terminal/status"],
    ]) {
      act(() => {
        expect(registeredBindings.get(id)?.action(null, null)).toBe(false);
      });
      expect(mockRouterPush).toHaveBeenLastCalledWith(route);
    }
  });
});
