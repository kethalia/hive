// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "../helpers/discovery";

const loading = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  return { agents: deferred(), management: deferred(), mount: vi.fn(), hide: vi.fn() };
});

// Next aliases next/dynamic to this implementation for the App Router. Without a
// loading option it relies on an ancestor Suspense boundary. Delay the imported
// modules to reproduce a cold load.
vi.mock("next/dynamic", async () => ({
  default: (await import("next/dist/shared/lib/app-dynamic")).default,
}));
vi.mock("@/components/workspaces/AgentToolsPanel", async () => {
  await loading.agents.promise;
  return {
    AgentToolsPanel: () => <p>Loaded agent controls</p>,
  };
});
vi.mock("@/app/(dashboard)/workspaces/workspace-list-content", async () => {
  await loading.management.promise;
  return { WorkspaceListContent: () => <p>Loaded workspace controls</p> };
});
vi.mock("@/lib/actions/clone-project", () => ({ cloneProjectAction: vi.fn() }));
vi.mock("@/lib/actions/settings-window", () => ({
  getSettingsWindowAction: vi.fn(async () => ({
    data: { connectedWorkspaceIds: [], pendingWorkspaceIds: [], workspaces: [] },
  })),
}));
vi.mock("@/components/settings-content", () => ({
  SettingsContent: () => <p>Loaded settings controls</p>,
}));
vi.mock("@/components/workspaces/TerminalSessionStatusClient", () => ({
  TerminalSessionStatusClient: () => <p>Loaded diagnostics controls</p>,
}));
vi.mock("@/hooks/useGeneralWorkspaceCommands", () => ({ useGeneralWorkspaceCommands: vi.fn() }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/actions/workspaces", () => ({
  listWorkspacesAction: vi.fn(),
  startWorkspaceAction: vi.fn(),
}));
vi.mock("next/navigation", () => {
  const search = new URLSearchParams();
  const router = { replace: vi.fn() };
  return { useRouter: () => router, useSearchParams: () => search };
});
vi.mock("@/components/workspaces/WorkspaceHeaderButton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspaces/WorkspaceHeaderButton")>()),
  WorkspaceSearchButton: () => null,
}));
vi.mock("@/components/workspaces/GeneralWorkspacePane", () => ({
  GeneralWorkspacePane: () => {
    // React cleans up layout effects when a mounted subtree is hidden by Suspense,
    // even if it preserves the DOM and component state for later.
    useLayoutEffect(() => {
      loading.mount();
      return loading.hide;
    }, []);
    return <textarea aria-label="Terminal input" className="xterm-helper-textarea" />;
  },
}));

import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import { GeneralWorkspace } from "@/components/workspaces/GeneralWorkspace";
import { useGeneralWorkspaceCommands } from "@/hooks/useGeneralWorkspaceCommands";
import type { CoderWorkspace } from "@/lib/coder/types";
import {
  emptyGeneralWorkspace,
  generalWorkspaceStorageKey,
  requestHiveWindow,
} from "@/lib/workspaces/general-workspace";

const workspaces = [
  { id: "software", name: "ai-dev-01", latest_build: { id: "build-1", status: "running" } },
] as CoderWorkspace[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const state = emptyGeneralWorkspace();
  state.boards[0].activeWindowId = "terminal";
  state.boards[0].windows = [
    {
      id: "terminal",
      kind: "terminal",
      workspaceId: "software",
      sessionName: "hive",
      label: "hive",
    },
  ];
  localStorage.setItem(generalWorkspaceStorageKey("user"), JSON.stringify(state));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("workspace navigation commands", () => {
  const saved = () => JSON.parse(localStorage.getItem(generalWorkspaceStorageKey("user"))!);
  const mountWorkspace = () =>
    render(
      <KeybindingProvider>
        <GeneralWorkspace userId="user" initialWorkspaces={workspaces} />
      </KeybindingProvider>,
    );
  it.each([
    "Macintosh",
    "Windows",
  ])("moves in both directions and closes from terminal focus on %s", async (platform) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
    const modifier = platform === "Macintosh" ? { metaKey: true } : { ctrlKey: true };
    try {
      mountWorkspace();
      const terminal = await screen.findByLabelText("Terminal input");
      terminal.focus();
      fireEvent.keyDown(terminal, { key: "n", code: "KeyN", altKey: true, ...modifier });
      await waitFor(() => expect(saved().boards).toHaveLength(2));
      const destination = saved().activeBoardKey;
      expect(destination).not.toBe("board-1");
      fireEvent.keyDown(terminal, {
        key: "N",
        code: "KeyN",
        altKey: true,
        shiftKey: true,
        ...modifier,
      });
      await waitFor(() => expect(saved().activeBoardKey).toBe("board-1"));
      expect(saved().boards[0].windows[0].id).toBe("terminal");
      expect(screen.getByLabelText("Terminal input")).toBe(terminal);
      expect(loading.mount).toHaveBeenCalledOnce();
      expect(loading.hide).not.toHaveBeenCalled();
      const commands = vi.mocked(useGeneralWorkspaceCommands).mock.lastCall![0].additionalActions!;
      expect(commands.find((a) => a.label === "Move window to previous workspace")).toBeDefined();
      expect(commands.find((a) => a.label === "Close current workspace")).toBeDefined();

      const close = new KeyboardEvent("keydown", {
        key: "w",
        code: "KeyW",
        bubbles: true,
        cancelable: true,
        ...modifier,
      });
      fireEvent(terminal, close);
      expect(close.defaultPrevented).toBe(true);
      await waitFor(() => expect(saved().boards).toHaveLength(1));
      expect(saved().activeBoardKey).toBe(destination);
      expect(screen.queryByLabelText("Terminal input")).toBeNull();
      expect(loading.hide).toHaveBeenCalledOnce();
      fireEvent.keyDown(window, { key: "w", repeat: true, ...modifier });
      expect(saved().activeBoardKey).toBe(destination);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each([
    { key: "w", code: "KeyW", ctrlKey: true },
    { key: "w", code: "KeyW", metaKey: true },
    { key: "Backspace", ctrlKey: true, altKey: true },
  ])("closing the last workspace leaves an empty workspace: %j", async (chord) => {
    mountWorkspace();
    fireEvent.keyDown(await screen.findByLabelText("Terminal input"), chord);
    await waitFor(() => expect(saved().boards[0].windows).toEqual([]));
    expect(saved().boards).toHaveLength(1);
    expect(loading.hide).toHaveBeenCalledOnce();
  });
  it("does not close behind a modal or while editing an ordinary text field", async () => {
    mountWorkspace();
    await screen.findByLabelText("Terminal input");
    const input = document.createElement("input");
    document.body.append(input);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    try {
      fireEvent.keyDown(input, { key: "w", ctrlKey: true });
      expect(saved().boards[0].windows).toHaveLength(1);
      document.body.append(dialog);
      fireEvent.keyDown(window, { key: "w", metaKey: true });
      expect(saved().boards[0].windows).toHaveLength(1);
      expect(loading.hide).not.toHaveBeenCalled();
    } finally {
      input.remove();
      dialog.remove();
    }
  });
});

describe("workspace tool windows", () => {
  it("moves layout settings into Cmd+? help and updates active bindings without remounting panes", async () => {
    const tree = (workspace: boolean) => (
      <KeybindingProvider>
        {workspace ? <GeneralWorkspace userId="user" initialWorkspaces={workspaces} /> : null}
        <HelpOverlay />
      </KeybindingProvider>
    );
    const view = render(tree(true));
    const terminal = await screen.findByRole("textbox", { name: "Terminal input" });
    expect(screen.queryByRole("button", { name: "Arrange windows and shortcuts" })).toBeNull();
    fireEvent.keyDown(window, { key: "?", code: "Slash", metaKey: true, shiftKey: true });
    const help = await screen.findByRole("dialog", { name: "Keyboard Shortcuts" });
    const modifier = within(help).getByLabelText("Layout shortcuts");
    const choose = async (label: string) => {
      const option = await screen.findByRole("option", { name: label });
      fireEvent.mouseMove(option);
      fireEvent.click(option);
    };
    expect(modifier).toHaveTextContent("On — platform shortcuts");
    expect(within(help).getByText("Focus window left")).toBeVisible();
    expect(within(help).getByText("Toggle pin left")).toBeVisible();
    modifier.focus();
    fireEvent.click(modifier);
    await choose("Off — use buttons and search");
    expect(within(help).queryByText("Focus window left")).toBeNull();
    fireEvent.click(modifier);
    await choose("On — platform shortcuts");
    expect(modifier).toHaveFocus();
    expect(modifier).toHaveTextContent("On — platform shortcuts");
    const focusRow = within(help).getByText("Focus window left").parentElement!;
    expect(focusRow).toHaveTextContent("Ctrl + Arrowleft");
    fireEvent.keyDown(window, { key: "?", code: "Slash", metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(window, { key: "t", code: "KeyT", ctrlKey: true, altKey: true });
    const saved = () => JSON.parse(localStorage.getItem(generalWorkspaceStorageKey("user"))!);
    await waitFor(() => expect(saved().boards[0].manager.floating.terminal).toBeDefined());
    expect(saved().boards[0].manager.shortcuts).toBe("primary+alt");
    expect(screen.getByLabelText("Terminal input")).toBe(terminal);
    expect(loading.mount).toHaveBeenCalledOnce();
    expect(loading.hide).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "?", code: "Slash", ctrlKey: true, shiftKey: true });
    const reopened = await screen.findByRole("dialog", { name: "Keyboard Shortcuts" });
    fireEvent.click(within(reopened).getByLabelText("Layout shortcuts"));
    await choose("Off — use buttons and search");
    expect(within(reopened).queryByText("Focus window left")).toBeNull();
    expect(within(reopened).getByLabelText("Layout shortcuts")).toHaveTextContent(
      "Off — use buttons and search",
    );
    fireEvent.click(within(reopened).getByLabelText("Layout shortcuts"));
    await choose("On — platform shortcuts");
    expect(within(reopened).getByText("Focus window left")).toBeVisible();
    view.rerender(tree(false));
    expect(screen.queryByLabelText("Layout shortcuts")).toBeNull();
    expect(screen.queryByText("Focus window left")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
  });

  it.each([
    {
      button: "Agents",
      title: "Agents",
      tool: "agents",
      status: "Loading agents…",
      loaded: "Loaded agent controls",
      gate: loading.agents,
    },
    {
      button: "Manage Coder workspaces",
      title: "Coder workspaces",
      tool: "workspaces",
      status: "Loading coder workspaces…",
      loaded: "Loaded workspace controls",
      gate: loading.management,
    },
  ])("keeps the canvas visible while $title loads, including dismissal", async (dialog) => {
    render(
      <KeybindingProvider>
        <Suspense fallback={<p role="status">Loading workspace…</p>}>
          <GeneralWorkspace userId="user" initialWorkspaces={workspaces} />
        </Suspense>
      </KeybindingProvider>,
    );
    const terminal = await screen.findByRole("textbox", { name: "Terminal input" });
    fireEvent.change(terminal, { target: { value: "unsent command" } });
    const assertCanvasPreserved = () => {
      expect(screen.queryByText("Loading workspace…")).not.toBeInTheDocument();
      expect(screen.getByTestId("general-workspace")).toBeVisible();
      expect(screen.getByLabelText("Terminal input")).toBe(terminal);
      expect(terminal).toBeVisible();
      expect(terminal).toHaveValue("unsent command");
      expect(loading.mount).toHaveBeenCalledOnce();
      expect(loading.hide).not.toHaveBeenCalled();
    };
    if (dialog.button === "Manage Coder workspaces") {
      expect(screen.queryByRole("button", { name: dialog.button })).toBeNull();
      act(() => requestHiveWindow({ tool: "workspaces" }));
    } else act(() => requestHiveWindow({ tool: "agents" }));
    const pending = await screen.findByTestId(`hive-window-${dialog.tool}`);
    expect(within(pending).getByRole("status")).toHaveTextContent(dialog.status);
    assertCanvasPreserved();

    fireEvent.click(within(pending).getByRole("button", { name: `Close ${dialog.title}` }));
    await waitFor(() =>
      expect(screen.queryByTestId(`hive-window-${dialog.tool}`)).not.toBeInTheDocument(),
    );
    assertCanvasPreserved();
    await act(async () => dialog.gate.resolve());
    expect(screen.queryByTestId(`hive-window-${dialog.tool}`)).not.toBeInTheDocument();

    if (dialog.button === "Manage Coder workspaces")
      fireEvent.keyDown(window, { key: "g", code: "KeyG", ctrlKey: true, altKey: true });
    else act(() => requestHiveWindow({ tool: "agents" }));
    expect(await screen.findByText(dialog.loaded)).toBeVisible();
    assertCanvasPreserved();
    fireEvent.click(screen.getByRole("button", { name: `Close ${dialog.title}` }));
    await waitFor(() =>
      expect(screen.queryByTestId(`hive-window-${dialog.tool}`)).not.toBeInTheDocument(),
    );
    assertCanvasPreserved();
  });
  it("opens all built-in tools without navigation, restores them, and reuses a window across workspaces", async () => {
    await act(async () => {
      loading.agents.resolve();
      loading.management.resolve();
    });
    const tree = (
      <KeybindingProvider>
        <GeneralWorkspace userId="user" initialWorkspaces={workspaces} />
      </KeybindingProvider>
    );
    const view = render(tree);
    const terminal = await screen.findByLabelText("Terminal input");
    fireEvent.change(terminal, { target: { value: "unsent" } });
    for (const tool of ["agents", "settings", "diagnostics", "workspaces"] as const) {
      act(() => requestHiveWindow({ tool }));
      expect(await screen.findByTestId(`hive-window-${tool}`)).toBeVisible();
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(terminal).toHaveValue("unsent");
    expect(loading.mount).toHaveBeenCalledOnce();
    expect(loading.hide).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, altKey: true });
    const saved = () => JSON.parse(localStorage.getItem(generalWorkspaceStorageKey("user"))!);
    await waitFor(() => expect(saved().boards).toHaveLength(2));
    act(() => requestHiveWindow({ tool: "settings" }));
    await waitFor(() => expect(saved().activeBoardKey).toBe("board-1"));
    expect(screen.getAllByTestId("hive-window-settings")).toHaveLength(1);
    await waitFor(() => expect(saved().boards[0].windows).toHaveLength(5));
    view.unmount();
    render(tree);
    for (const tool of ["agents", "settings", "diagnostics", "workspaces"])
      expect(await screen.findByTestId(`hive-window-${tool}`)).toBeVisible();
  });
});

vi.mock(
  "@/lib/discovery/transport",
  async () => (await import("../helpers/discovery-transport")).discoveryTransport,
);
