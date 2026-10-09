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
const registeredBindings = vi.hoisted(() => new Map<string, KeybindingEntry>());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));

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

vi.mock("@/hooks/useKeybindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useKeybindings")>();
  return {
    ...actual,
    useRegisterKeybinding: (entry: KeybindingEntry) => {
      registeredBindings.set(entry.id, entry);
      actual.useRegisterKeybinding(entry);
    },
  };
});

vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: () => mockListWorkspaces(),
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
import KeybindingProvider from "@/components/terminal/KeybindingProvider";
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

describe("DashboardKeyboardController", () => {
  let fullscreenElement: Element | null;
  const keyboard = { lock: vi.fn(), unlock: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mobileState.isMobile = false;
    mobileState.openMobile = false;
    mobileState.openMobileRight = false;
    registeredBindings.clear();
    fullscreenElement = null;
    keyboard.lock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      }),
    });
    mockListWorkspaces.mockResolvedValue(workspacePayload());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = document.documentElement;
        document.dispatchEvent(new Event("fullscreenchange"));
      }),
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
    expect(registeredBindings.get("dashboard:navigate-workspaces")?.keys).toEqual([
      "ctrl+shift+1",
      "cmd+shift+1",
    ]);
    expect(registeredBindings.get("dashboard:navigate-templates")?.keys).toEqual([
      "ctrl+shift+2",
      "cmd+shift+2",
    ]);
    expect(registeredBindings.get("dashboard:navigate-terminal-status")?.keys).toEqual([
      "ctrl+shift+3",
      "cmd+shift+3",
    ]);
    for (const id of [
      "dashboard:command-palette",
      "dashboard:toggle-sidebar",
      "dashboard:toggle-compose",
      "dashboard:toggle-fullscreen",
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
    });

    expect(await screen.findByText("Launch workspace")).toBeInTheDocument();
    expect(screen.getByText("hive-dev")).toBeInTheDocument();

    fireEvent.click(screen.getByText("hive-dev"));
    expect(mockRouterPush).toHaveBeenCalledWith("/workspaces/workspace-1/terminal/workspace");

    fireEvent.click(screen.getByText("Launch workspace"));
    expect(mockRouterPush).toHaveBeenCalledWith("/workspaces?launch=1");
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

  it("enters browser fullscreen and keeps the app layout on a dispatched Escape", async () => {
    render(<DashboardKeyboardController />);

    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });

    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(escapeEvent);
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");

    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });

    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
  });

  it.each([
    "ctrlKey",
    "metaKey",
  ] as const)("toggles native fullscreen with %s+Enter while a terminal textarea is focused", async (modifier) => {
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
    const receivedKeys = vi.fn();
    render(
      <KeybindingProvider>
        <DashboardKeyboardController />
        <textarea
          className="xterm-helper-textarea"
          aria-label="Terminal"
          onKeyDown={receivedKeys}
        />
      </KeybindingProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Terminal" });
    input.focus();
    fireEvent.keyDown(input, { key: "Enter", [modifier]: true });

    await waitFor(() => expect(keyboard.lock).toHaveBeenCalledWith(["Escape"]));
    expect(document.fullscreenElement).toBe(document.documentElement);
    expect(receivedKeys).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(receivedKeys).toHaveBeenCalledOnce();
    expect(document.exitFullscreen).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", [modifier]: true });
    await waitFor(() => expect(document.fullscreenElement).toBeNull());
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(keyboard.unlock).toHaveBeenCalled();
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("keeps fullscreen when keyboard lock permission is denied", async () => {
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
    keyboard.lock.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    render(<DashboardKeyboardController />);
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(keyboard.lock).toHaveBeenCalledWith(["Escape"]);
    expect(document.fullscreenElement).toBe(document.documentElement);
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");
  });

  it("resets the app layout when the browser forces fullscreen exit", async () => {
    render(<DashboardKeyboardController />);
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    act(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(2);
  });

  it("reports blocked fullscreen and allows the expanded layout to toggle off", async () => {
    vi.mocked(document.documentElement.requestFullscreen).mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    render(<DashboardKeyboardController />);
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(mockToastError).toHaveBeenCalledWith(
      "Browser fullscreen was blocked. The expanded layout is still available.",
    );
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");
    act(() => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("uses the expanded layout when the native API is unavailable", () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
    render(<DashboardKeyboardController />);
    act(() => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");
    act(() => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("ignores duplicate toggles while a fullscreen request is pending", async () => {
    let resolveRequest: (() => void) | undefined;
    vi.mocked(document.documentElement.requestFullscreen).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    render(<DashboardKeyboardController />);
    act(() => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");
    await act(async () => {
      resolveRequest?.();
    });
    act(() => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("releases keyboard lock when the controller unmounts", async () => {
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
    const { unmount } = render(<DashboardKeyboardController />);
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    keyboard.unlock.mockClear();
    unmount();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
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

  it("keeps sidebar replacement enabled until the global drawer is open", () => {
    mobileState.isMobile = true;
    mobileState.openMobile = true;
    const { rerender } = render(<DashboardKeyboardController />);

    expect(mockUseGlobalCommandPaletteGesture).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
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
