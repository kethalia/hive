// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "../helpers/discovery";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeybindingEntry } from "@/hooks/useKeybindings";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockUseGlobalCommandPaletteGesture = vi.hoisted(() => vi.fn());
const mobileState = vi.hoisted(() => ({
  isMobile: false,
}));
const mockListWorkspaces = vi.hoisted(() => vi.fn());
const mockWorkspaceSessions = vi.hoisted(() => vi.fn());
const mockWorkspaceClones = vi.hoisted(() => vi.fn());
const registeredBindings = vi.hoisted(() => new Map<string, KeybindingEntry>());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => "/templates",
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
  getWorkspaceSessionsAction: (...args: unknown[]) => mockWorkspaceSessions(...args),
  createSessionAction: vi.fn(),
}));
vi.mock("@/lib/actions/git-clones", () => ({
  listGitClonesAction: (...args: unknown[]) => mockWorkspaceClones(...args),
  resolveGitCloneTerminalAction: vi.fn(),
}));

vi.mock("@/components/terminal/CommandPalette", () => ({
  CommandPalette: ({
    actions,
    emptyText,
    loadingText,
    onCreateSession,
    onSelectTab,
    open,
    tabs,
    mobileSide,
    searchValue,
    onSearchValueChange,
    onOpenChange,
  }: {
    actions: Array<{
      id: string;
      label: string;
      description?: string;
      onSelect: () => void;
    }>;
    emptyText: string;
    loadingText?: string;
    onCreateSession?: () => void;
    onSelectTab: (tabId: string) => void;
    open: boolean;
    tabs: Array<{ id: string; sessionName: string }>;
    mobileSide?: "bottom" | "right";
    searchValue?: string;
    onSearchValueChange?: (value: string) => void;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div
      data-empty-text={emptyText}
      data-loading-text={loadingText}
      data-mobile-side={mobileSide}
      data-open={open ? "true" : "false"}
      data-testid="palette"
    >
      {open
        ? [
            <input
              key="search"
              aria-label="Search commands"
              value={searchValue ?? ""}
              onChange={(event) => onSearchValueChange?.(event.target.value)}
            />,
            <button key="close" type="button" onClick={() => onOpenChange?.(false)}>
              Close search
            </button>,
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
import { useGeneralWorkspaceCommands } from "@/hooks/useGeneralWorkspaceCommands";
import { useWindowManagerCommands } from "@/hooks/useWindowManagerCommands";
import type { CoderWorkspace } from "@/lib/coder/types";
import {
  openGlobalCommandPalette,
  registerGlobalCommandPaletteSource,
} from "@/lib/terminal/global-command-palette";
import { newWindowManager, type WindowManager } from "@/lib/workspaces/window-manager";

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

    expect(registeredBindings.get("dashboard:command-palette")?.keys).toEqual(["ctrl+k", "cmd+k"]);
    expect(registeredBindings.has("dashboard:toggle-sidebar")).toBe(false);
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

    for (const label of [
      "Agents",
      "Settings",
      "Diagnostics",
      "Logs",
      "Templates",
      "Manage Coder workspaces",
    ])
      expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Settings"));
    expect(mockRouterPush).toHaveBeenCalledWith("/workspaces?panel=settings");
    fireEvent.click(screen.getByText("Launch Coder workspace"));
    expect(mockRouterPush).toHaveBeenCalledWith("/workspaces?panel=workspaces&launch=1");
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
      loadingText: "Loading terminals and repositories…",
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
    await waitFor(() =>
      expect(screen.getByTestId("palette")).toHaveAttribute(
        "data-loading-text",
        "Loading terminals and repositories…",
      ),
    );
    fireEvent.click(screen.getByText("main-session"));
    expect(onSelectTab).toHaveBeenCalledWith("tab-1");
    fireEvent.click(screen.getByText("New Session"));
    expect(onCreateSession).toHaveBeenCalled();

    cleanupSource();
  });

  it("keeps discovery and layout commands together after changing mode or shortcut preset", async () => {
    mockWorkspaceSessions.mockResolvedValue({ data: [{ name: "dev-server" }] });
    mockWorkspaceClones.mockResolvedValue({
      data: {
        ok: true,
        tree: {
          nodes: [
            {
              kind: "repository",
              id: "repo",
              label: "hive",
              cloneSessionKey: "git-clone:projects/kethalia/hive",
              relativePath: "projects/kethalia/hive",
            },
          ],
        },
      },
    });
    const run = vi.fn();
    const workspace = [
      {
        id: "software",
        name: "ai-dev-01",
        template_name: "ai-dev-k8s",
        latest_build: { id: "build-1", status: "running" },
      },
    ] as CoderWorkspace[];
    const callbacks = {
      workspaces: workspace,
      onOpenPane: vi.fn(),
      onError: vi.fn(),
      onStart: vi.fn(),
      onCreate: vi.fn(),
    };
    function WorkspaceCommands({ mode, shortcuts }: Pick<WindowManager, "mode" | "shortcuts">) {
      const additionalActions = useWindowManagerCommands(
        { ...newWindowManager(mode), shortcuts },
        run,
      );
      useGeneralWorkspaceCommands({ ...callbacks, additionalActions });
      return null;
    }
    function App(props: Pick<WindowManager, "mode" | "shortcuts">) {
      return (
        <KeybindingProvider>
          <DashboardKeyboardController />
          <WorkspaceCommands {...props} />
        </KeybindingProvider>
      );
    }
    const { rerender } = render(<App mode="grid" shortcuts="primary+alt" />);
    expect(mockWorkspaceSessions).not.toHaveBeenCalled();
    act(() => openGlobalCommandPalette());
    expect(await screen.findByText("dev-server")).toBeInTheDocument();
    expect(screen.getByText("hive")).toBeInTheDocument();
    expect(screen.getByText("Use Strip layout")).toBeInTheDocument();
    for (const props of [
      { mode: "strip", shortcuts: "primary+alt" },
      { mode: "strip", shortcuts: "off" },
      { mode: "grid", shortcuts: "off" },
    ] as const) {
      rerender(<App {...props} />);
      fireEvent.change(screen.getByLabelText("Search commands"), { target: { value: "hive" } });
      expect(await screen.findByText("hive")).toBeInTheDocument();
      expect(screen.getByText("Use Grid layout")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Search commands"), {
        target: { value: "custom-terminal" },
      });
      expect(await screen.findByText("New session")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Close search"));
      act(() => registeredBindings.get("dashboard:command-palette")?.action(null, null));
      expect(screen.getByLabelText("Search commands")).toHaveValue("");
      expect(await screen.findByText("dev-server")).toBeInTheDocument();
      expect(screen.getByText("Files")).toBeInTheDocument();
    }
    fireEvent.click(screen.getByText("Use Grid layout"));
    expect(run).toHaveBeenLastCalledWith("grid");
    expect(mockWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(mockWorkspaceClones).toHaveBeenCalledTimes(1);
    expect(mockListWorkspaces).not.toHaveBeenCalled();
  });

  it("runs fullscreen without a sidebar", () => {
    render(<DashboardKeyboardController />);

    act(() => {
      expect(registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null)).toBe(false);
    });

    expect(document.documentElement.dataset.dashboardFullscreen).toBe("true");
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

  it("exits native fullscreen and releases keyboard lock when the controller unmounts", async () => {
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
    const { unmount } = render(<DashboardKeyboardController />);
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    keyboard.unlock.mockClear();
    unmount();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBeNull();
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("exits a fullscreen request that completes after the controller unmounts", async () => {
    Object.defineProperty(navigator, "keyboard", { configurable: true, value: keyboard });
    let completeRequest: (() => void) | undefined;
    vi.mocked(document.documentElement.requestFullscreen).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeRequest = () => {
            fullscreenElement = document.documentElement;
            document.dispatchEvent(new Event("fullscreenchange"));
            resolve();
          };
        }),
    );
    const { unmount } = render(<DashboardKeyboardController />);
    act(() => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    unmount();
    expect(document.exitFullscreen).not.toHaveBeenCalled();
    await act(async () => {
      completeRequest?.();
    });
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBeNull();
    expect(keyboard.lock).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("leaves fullscreen owned by another element alone on unmount", () => {
    const { unmount } = render(<DashboardKeyboardController />);
    fullscreenElement = document.createElement("video");
    unmount();
    expect(document.exitFullscreen).not.toHaveBeenCalled();
  });

  it("handles a rejected fullscreen exit during unmount without a stale toast", async () => {
    const { unmount } = render(<DashboardKeyboardController />);
    await act(async () => {
      registeredBindings.get("dashboard:toggle-fullscreen")?.action(null, null);
    });
    vi.mocked(document.exitFullscreen).mockRejectedValueOnce(
      new DOMException("Denied", "NotAllowedError"),
    );
    await act(async () => {
      unmount();
    });
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.dashboardFullscreen).toBeUndefined();
  });

  it("keeps search open across desktop and phone layouts without a sidebar", () => {
    const { rerender } = render(<DashboardKeyboardController />);
    act(() => openGlobalCommandPalette());
    expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");
    mobileState.isMobile = true;
    rerender(<DashboardKeyboardController />);
    expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");
    expect(mockUseGlobalCommandPaletteGesture).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    fireEvent.click(screen.getByText("Close search"));
    expect(mockUseGlobalCommandPaletteGesture).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
  it("navigates to primary dashboard surfaces from global shortcuts", () => {
    render(<DashboardKeyboardController />);

    for (const [id, route] of [
      ["dashboard:navigate-workspaces", "/workspaces"],
      ["dashboard:navigate-templates", "/workspaces?panel=templates"],
      ["dashboard:navigate-terminal-status", "/workspaces?panel=diagnostics"],
    ]) {
      act(() => {
        expect(registeredBindings.get(id)?.action(null, null)).toBe(false);
      });
      expect(mockRouterPush).toHaveBeenLastCalledWith(route);
    }
  });
  it("opens the same palette from the search button event and Cmd+K, clearing the previous query", async () => {
    const onSearchValueChange = vi.fn();
    const unregister = registerGlobalCommandPaletteSource({
      id: "unified",
      handlesWorkspaces: true,
      onSearchValueChange,
    });
    try {
      render(<DashboardKeyboardController />);
      act(() => openGlobalCommandPalette());
      expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");
      expect(onSearchValueChange).toHaveBeenLastCalledWith("");
      act(() => registeredBindings.get("dashboard:command-palette")?.action(null, null));
      expect(onSearchValueChange).toHaveBeenCalledTimes(2);
      expect(mockListWorkspaces).not.toHaveBeenCalled();
      expect(screen.queryByText("hive-dev")).not.toBeInTheDocument();
      expect(screen.getByText("Launch Coder workspace")).toBeInTheDocument();
    } finally {
      act(() => unregister());
    }
  });
  it("opens mobile search from the same event", () => {
    mobileState.isMobile = true;
    render(<DashboardKeyboardController />);
    act(() => openGlobalCommandPalette());
    expect(screen.getByTestId("palette")).toHaveAttribute("data-open", "true");
  });
});

vi.mock(
  "@/lib/discovery/transport",
  async () => (await import("../helpers/discovery-transport")).discoveryTransport,
);
