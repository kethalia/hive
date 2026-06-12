// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeybindingEntry } from "@/hooks/useKeybindings";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockToggleSidebar = vi.hoisted(() => vi.fn());
const mockSetOpen = vi.hoisted(() => vi.fn());
const mockSetOpenMobile = vi.hoisted(() => vi.fn());
const mockListWorkspaces = vi.hoisted(() => vi.fn());
const mockListTasks = vi.hoisted(() => vi.fn());
const registeredBindings = vi.hoisted(() => new Map<string, KeybindingEntry>());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({
    setOpen: mockSetOpen,
    setOpenMobile: mockSetOpenMobile,
    toggleSidebar: mockToggleSidebar,
  }),
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
    open,
  }: {
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      onSelect: () => void;
    }>;
    emptyText: string;
    open: boolean;
  }) => (
    <div data-empty-text={emptyText} data-open={open ? "true" : "false"} data-testid="palette">
      {open
        ? actions.map((action) => (
            <button key={action.id} type="button" onClick={action.onSelect}>
              <span>{action.label}</span>
              {action.description ? <small>{action.description}</small> : null}
            </button>
          ))
        : null}
    </div>
  ),
}));

import { DashboardKeyboardController } from "@/components/dashboard-keyboard-controller";
import { TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";

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

    expect(registeredBindings.get("dashboard:command-palette")?.keys).toEqual(["ctrl+k", "cmd+k"]);
    expect(registeredBindings.get("dashboard:toggle-sidebar")?.keys).toEqual(["ctrl+b", "cmd+b"]);
    expect(registeredBindings.get("dashboard:toggle-compose")?.keys).toEqual(["ctrl+`", "cmd+`"]);
    expect(registeredBindings.get("dashboard:toggle-fullscreen")?.keys).toEqual([
      "ctrl+enter",
      "cmd+enter",
    ]);
    for (const id of [
      "dashboard:command-palette",
      "dashboard:toggle-sidebar",
      "dashboard:toggle-compose",
      "dashboard:toggle-fullscreen",
    ]) {
      expect(registeredBindings.get(id)?.allowTextEntry).toBe(true);
      expect(registeredBindings.get(id)?.global).toBe(true);
    }
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
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");

    window.removeEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, composeListener);
  });
});
