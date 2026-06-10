// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { WorkspaceListContent } from "@/app/(dashboard)/workspaces/workspace-list-content";
import { WorkspaceListPoller } from "@/app/(dashboard)/workspaces/workspace-list-poller";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import type { CoderWorkspace, WorkspaceBuildStatus } from "@/lib/coder/types";
import { PULL_REFRESH_TRIGGER_PX } from "@/lib/gestures/conventions";

const mocks = vi.hoisted(() => ({
  createWorkspaceAction: vi.fn(),
  listWorkspaceTemplatesAction: vi.fn(),
  listWorkspacesAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createWorkspaceAction: mocks.createWorkspaceAction,
  listWorkspaceTemplatesAction: mocks.listWorkspaceTemplatesAction,
  listWorkspacesAction: mocks.listWorkspacesAction,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="dashboard-page-sidebar-trigger">
      Toggle sidebar
    </button>
  ),
}));

let originalPointerEvent: typeof window.PointerEvent | undefined;
const originalSetPointerCapture = Element.prototype.setPointerCapture;
const originalReleasePointerCapture = Element.prototype.releasePointerCapture;
const originalHasPointerCapture = Element.prototype.hasPointerCapture;

type WorkspaceFixture = React.ComponentProps<typeof WorkspaceListContent>["workspaces"][number];

function latestBuild(
  status: WorkspaceBuildStatus,
  id = `build-${status}`,
): CoderWorkspace["latest_build"] {
  return {
    id,
    status,
    job: { status: "succeeded", error: "" },
  };
}

function makeWorkspace(overrides: Partial<WorkspaceFixture> = {}): WorkspaceFixture {
  return {
    id: "workspace-1",
    name: "mobile-dev",
    template_id: "template-1",
    template_name: "hive-template",
    template_display_name: "Hive Template",
    owner_name: "alice",
    last_used_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    health: { healthy: true, failing_agents: [] },
    latest_build: latestBuild("running", "build-1"),
    ...overrides,
  };
}

function pointerDown(target: HTMLElement, { x = 20, y = 10 } = {}) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function pointerMove(target: HTMLElement, { x = 20, y }: { x?: number; y: number }) {
  fireEvent.pointerMove(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function pointerUp(target: HTMLElement, { x = 20, y }: { x?: number; y: number }) {
  fireEvent.pointerUp(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 0,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function dragPull(target: HTMLElement, moveY: number, moveX = 20) {
  pointerDown(target);
  pointerMove(target, { x: moveX, y: 10 + moveY });
  pointerUp(target, { x: moveX, y: 10 + moveY });
}

beforeAll(() => {
  originalPointerEvent = window.PointerEvent;
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => true);
  }
});

afterAll(() => {
  window.PointerEvent = originalPointerEvent as typeof PointerEvent;
  Element.prototype.setPointerCapture = originalSetPointerCapture;
  Element.prototype.releasePointerCapture = originalReleasePointerCapture;
  Element.prototype.hasPointerCapture = originalHasPointerCapture;
});

afterEach(() => {
  cleanup();
  mocks.createWorkspaceAction.mockReset();
  mocks.listWorkspaceTemplatesAction.mockReset();
  mocks.refresh.mockReset();
  mocks.listWorkspacesAction.mockReset();
});

describe("workspaces mobile list", () => {
  it("renders mobile workspace cards beside desktop table columns with 44px terminal actions", () => {
    render(
      <WorkspaceListContent
        workspaces={[
          makeWorkspace(),
          makeWorkspace({
            id: "workspace-2",
            name: "stopped-dev",
            latest_build: latestBuild("stopped", "build-2"),
          }),
        ]}
      />,
    );

    const stack = screen.getByTestId("workspaces-mobile-card-stack");
    expect(stack).toHaveAttribute("role", "list");
    expect(stack).toHaveClass("md:hidden", "text-sm", "pb-safe");

    const cards = screen.getAllByTestId("workspace-mobile-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("mobile-dev")).toBeInTheDocument();
    expect(within(cards[0]).getByText("running")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Hive Template")).toBeInTheDocument();
    expect(within(cards[0]).getByText("alice")).toBeInTheDocument();

    const terminalLink = within(cards[0]).getByRole("link", {
      name: "Open workspace for mobile-dev",
    });
    expect(terminalLink).toHaveAttribute("href", "/workspaces/workspace-1/terminal/workspace");
    expect(terminalLink).toHaveClass("min-h-11", "touch-manipulation", "text-sm");

    const desktopTable = screen.getByTestId("workspaces-desktop-table");
    expect(desktopTable).toHaveClass("hidden", "md:block");
    expect(within(desktopTable).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(
      within(desktopTable).getByRole("columnheader", { name: "Workspace" }),
    ).toBeInTheDocument();
    expect(
      within(desktopTable).getByRole("columnheader", { name: "Template" }),
    ).toBeInTheDocument();
    expect(within(desktopTable).getByRole("columnheader", { name: "Owner" })).toBeInTheDocument();
    expect(
      within(desktopTable).getByRole("columnheader", { name: "Last used" }),
    ).toBeInTheDocument();
    expect(within(desktopTable).getByRole("columnheader", { name: "Action" })).toBeInTheDocument();
  });

  it("opens the add workspace modal from the button and Cmd/Ctrl+Alt+N", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValue({
      data: [
        {
          id: "template-1",
          name: "hive-template",
          activeVersionId: "version-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    render(
      <KeybindingProvider>
        <WorkspaceListContent workspaces={[makeWorkspace()]} />
      </KeybindingProvider>,
    );

    fireEvent.click(screen.getByTestId("open-create-workspace-modal"));
    expect(await screen.findByTestId("create-workspace-modal")).toHaveTextContent("Add workspace");
    expect(mocks.listWorkspaceTemplatesAction).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("create-workspace-modal")).not.toBeInTheDocument();
    });

    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(screen.queryByTestId("create-workspace-modal")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "n", metaKey: true, altKey: true });
    expect(await screen.findByTestId("create-workspace-modal")).toBeInTheDocument();
  });

  it("shows create workspace validation errors from the action response", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValue({
      data: [
        {
          id: "template-1",
          name: "hive-template",
          activeVersionId: "version-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mocks.createWorkspaceAction.mockResolvedValue({
      validationErrors: {
        name: {
          _errors: [
            "Workspace names can contain only letters, numbers, dots, underscores, and hyphens.",
          ],
        },
      },
    });

    render(<WorkspaceListContent workspaces={[makeWorkspace()]} />);

    fireEvent.click(screen.getByTestId("open-create-workspace-modal"));
    await screen.findByTestId("create-workspace-modal");
    await waitFor(() => {
      expect(screen.getByTestId("create-workspace-template")).toHaveValue("template-1");
    });
    fireEvent.change(screen.getByTestId("create-workspace-name"), {
      target: { value: "bad workspace" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-create-workspace"));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Workspace names can contain only letters, numbers, dots, underscores, and hyphens.",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("creates a workspace from the modal and refreshes the list", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValue({
      data: [
        {
          id: "template-1",
          name: "hive-template",
          activeVersionId: "version-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mocks.createWorkspaceAction.mockResolvedValue({
      data: makeWorkspace({ id: "workspace-new", name: "new-dev" }),
    });

    render(<WorkspaceListContent workspaces={[makeWorkspace()]} />);

    fireEvent.click(screen.getByTestId("open-create-workspace-modal"));
    await screen.findByTestId("create-workspace-modal");
    await waitFor(() => {
      expect(screen.getByTestId("create-workspace-template")).toHaveValue("template-1");
    });
    fireEvent.change(screen.getByTestId("create-workspace-name"), {
      target: { value: "new-dev" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-create-workspace"));
    });

    expect(mocks.createWorkspaceAction).toHaveBeenCalledWith({
      templateId: "template-1",
      name: "new-dev",
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("create-workspace-modal")).not.toBeInTheDocument();
  });

  it("keeps the empty state inside the pull-to-refresh surface", () => {
    render(
      <WorkspaceListPoller>
        <WorkspaceListContent workspaces={[]} />
      </WorkspaceListPoller>,
    );

    const refreshSurface = screen.getByTestId("pull-to-refresh");
    expect(refreshSurface).toHaveAttribute("data-pull-state", "idle");
    expect(within(refreshSurface).getByTestId("workspaces-empty-state")).toHaveTextContent(
      "No workspaces found.",
    );
  });

  it("renders listWorkspacesAction serverError as an in-page alert", async () => {
    mocks.listWorkspacesAction.mockResolvedValueOnce({ serverError: "Not authenticated" });
    const { default: WorkspacesPage } = await import("@/app/(dashboard)/workspaces/page");

    render(await WorkspacesPage());

    expect(mocks.listWorkspacesAction).toHaveBeenCalledTimes(1);
    const refreshSurface = screen.getByTestId("pull-to-refresh");
    expect(within(refreshSurface).getByRole("alert")).toHaveTextContent(
      "Unable to load workspaces",
    );
    expect(within(refreshSurface).getByRole("alert")).toHaveTextContent("Not authenticated");
    expect(screen.queryByTestId("workspaces-empty-state")).not.toBeInTheDocument();
  });

  it("maps running, stopped, and failed statuses to distinct badge variants", () => {
    render(
      <WorkspaceListContent
        workspaces={[
          makeWorkspace({
            id: "running-ws",
            name: "running-ws",
            latest_build: latestBuild("running"),
          }),
          makeWorkspace({
            id: "stopped-ws",
            name: "stopped-ws",
            latest_build: latestBuild("stopped"),
          }),
          makeWorkspace({
            id: "failed-ws",
            name: "failed-ws",
            latest_build: latestBuild("failed"),
          }),
        ]}
      />,
    );

    const cards = screen.getAllByTestId("workspace-mobile-card");
    expect(within(cards[0]).getByText("running")).toHaveClass("bg-primary");
    expect(within(cards[1]).getByText("stopped")).toHaveClass("border-border");
    expect(within(cards[2]).getByText("failed")).toHaveClass("text-destructive");
  });

  it("falls back for missing optional template, owner, last-used, and health fields", () => {
    render(
      <WorkspaceListContent
        workspaces={[
          makeWorkspace({
            id: "fallback-ws",
            name: "fallback-ws",
            template_id: "template-id-fallback",
            template_display_name: undefined,
            template_name: undefined,
            owner_name: "",
            last_used_at: undefined,
            health: undefined,
          }),
        ]}
      />,
    );

    const card = screen.getByTestId("workspace-mobile-card");
    expect(within(card).getByText("template-id-fallback")).toBeInTheDocument();
    expect(within(card).getAllByText("Unknown")).toHaveLength(2);
    expect(within(card).getAllByText("Never").length).toBeGreaterThanOrEqual(1);
  });

  it("calls router.refresh once on a valid pull and suppresses in-flight duplicate pulls", async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    mocks.refresh.mockReturnValue(refreshPromise);

    render(
      <WorkspaceListPoller>
        <WorkspaceListContent workspaces={[makeWorkspace()]} />
      </WorkspaceListPoller>,
    );
    const surface = screen.getByTestId("pull-to-refresh");

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    await waitFor(() => {
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(surface).toHaveAttribute("data-pull-state", "refreshing");
    });

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh();
      await refreshPromise;
    });
    await waitFor(() => {
      expect(surface).toHaveAttribute("data-pull-state", "idle");
    });
  });

  it("does not introduce tiny type in S05-owned workspace markup", () => {
    const sourceFiles = [
      "src/app/(dashboard)/workspaces/page.tsx",
      "src/app/(dashboard)/workspaces/workspace-list-content.tsx",
      "src/app/(dashboard)/workspaces/workspace-list-poller.tsx",
      "src/components/workspaces/WorkspaceToolPanel.tsx",
    ];

    for (const sourceFile of sourceFiles) {
      expect(readFileSync(sourceFile, "utf8")).not.toContain("text-[10px]");
    }
  });
});
