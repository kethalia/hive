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
vi.mock("@/components/workspaces/AgentToolsDialog", async () => {
  await loading.agents.promise;
  return {
    AgentToolsDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: () => void }) => (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Agent tools and sessions</DialogTitle>
          <DialogDescription>Loaded agent controls</DialogDescription>
        </DialogContent>
      </Dialog>
    ),
  };
});
vi.mock("@/app/(dashboard)/workspaces/workspace-list-content", async () => {
  await loading.management.promise;
  return { WorkspaceListContent: () => <p>Loaded workspace controls</p> };
});
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
  WorkspaceSidebarButton: () => null,
}));
vi.mock("@/components/workspaces/GeneralWorkspacePane", () => ({
  GeneralWorkspacePane: () => {
    // React cleans up layout effects when a mounted subtree is hidden by Suspense,
    // even if it preserves the DOM and component state for later.
    useLayoutEffect(() => {
      loading.mount();
      return loading.hide;
    }, []);
    return <textarea aria-label="Terminal input" />;
  },
}));

import { HelpOverlay } from "@/components/terminal/HelpOverlay";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { GeneralWorkspace } from "@/components/workspaces/GeneralWorkspace";
import type { CoderWorkspace } from "@/lib/coder/types";
import {
  emptyGeneralWorkspace,
  generalWorkspaceStorageKey,
} from "@/lib/workspaces/general-workspace";

const workspaces = [
  { id: "software", name: "ai-dev-01", latest_build: { id: "build-1", status: "running" } },
] as CoderWorkspace[];

beforeEach(() => {
  vi.clearAllMocks();
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

describe("workspace dialog loading", () => {
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
    expect(modifier).toHaveValue("primary+alt");
    expect(within(help).getByText("Focus window left")).toBeVisible();
    expect(within(help).getByText("Toggle pin left")).toBeVisible();
    modifier.focus();
    fireEvent.change(modifier, { target: { value: "off" } });
    expect(within(help).queryByText("Focus window left")).toBeNull();
    fireEvent.change(modifier, { target: { value: "primary+alt" } });
    expect(modifier).toHaveFocus();
    expect(modifier).toHaveValue("primary+alt");
    const focusRow = within(help).getByText("Focus window left").parentElement!;
    expect(focusRow).toHaveTextContent("Ctrl + Alt + Arrowleft");
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
    fireEvent.change(within(reopened).getByLabelText("Layout shortcuts"), {
      target: { value: "off" },
    });
    expect(within(reopened).queryByText("Focus window left")).toBeNull();
    expect(within(reopened).getByLabelText("Layout shortcuts")).toHaveValue("off");
    fireEvent.change(within(reopened).getByLabelText("Layout shortcuts"), {
      target: { value: "primary+alt" },
    });
    expect(within(reopened).getByText("Focus window left")).toBeVisible();
    view.rerender(tree(false));
    expect(screen.queryByLabelText("Layout shortcuts")).toBeNull();
    expect(screen.queryByText("Focus window left")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
  });

  it.each([
    {
      button: "Agent tools",
      title: "Agent tools and sessions",
      status: "Loading agent tools…",
      loaded: "Loaded agent controls",
      gate: loading.agents,
    },
    {
      button: "Manage Coder workspaces",
      title: "Coder workspaces",
      status: "Loading workspace controls…",
      loaded: "Loaded workspace controls",
      gate: loading.management,
    },
  ])("keeps the canvas visible while $title loads, including dismissal", async (dialog) => {
    render(
      <Suspense fallback={<p role="status">Loading workspace…</p>}>
        <GeneralWorkspace userId="user" initialWorkspaces={workspaces} />
      </Suspense>,
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
    fireEvent.click(screen.getByRole("button", { name: dialog.button }));
    const pending = await screen.findByRole("dialog", { name: dialog.title });
    expect(within(pending).getByRole("status")).toHaveTextContent(dialog.status);
    assertCanvasPreserved();

    fireEvent.click(within(pending).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    assertCanvasPreserved();
    await act(async () => dialog.gate.resolve());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: dialog.button }));
    expect(await screen.findByText(dialog.loaded)).toBeVisible();
    assertCanvasPreserved();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    assertCanvasPreserved();
  });
});

vi.mock(
  "@/lib/discovery/transport",
  async () => (await import("../helpers/discovery-transport")).discoveryTransport,
);
