// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
