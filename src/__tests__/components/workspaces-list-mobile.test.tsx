// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type * as React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "../helpers/discovery";
import "@testing-library/jest-dom/vitest";

import { WorkspaceListContent } from "@/app/(dashboard)/workspaces/workspace-list-content";
import { WorkspaceListPoller } from "@/app/(dashboard)/workspaces/workspace-list-poller";
import { KeybindingProvider } from "@/components/terminal/KeybindingProvider";
import type { CoderWorkspace, WorkspaceBuildStatus } from "@/lib/coder/types";
import { useDiscovery } from "@/lib/discovery/queries";
import { PULL_REFRESH_TRIGGER_PX } from "@/lib/gestures/conventions";

const mocks = vi.hoisted(() => ({
  createWorkspaceAction: vi.fn(),
  deleteWorkspaceAction: vi.fn(),
  listWorkspaceTemplatesAction: vi.fn(),
  listWorkspacesAction: vi.fn(),
  startWorkspaceAction: vi.fn(),
  stopWorkspaceAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/lib/actions/workspaces", () => ({
  createWorkspaceAction: mocks.createWorkspaceAction,
  deleteWorkspaceAction: mocks.deleteWorkspaceAction,
  listWorkspaceTemplatesAction: mocks.listWorkspaceTemplatesAction,
  listWorkspacesAction: mocks.listWorkspacesAction,
  startWorkspaceAction: mocks.startWorkspaceAction,
  stopWorkspaceAction: mocks.stopWorkspaceAction,
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
    template_name: "ai-dev-k8s",
    template_display_name: "AI Dev",
    owner_name: "alice",
    last_used_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    health: { healthy: true, failing_agents: [] },
    latest_build: latestBuild("running", "build-1"),
    ...overrides,
  };
}

// Like GeneralWorkspace, the visible list observes the shared query. No poll or prop
// replacement is involved, so mutation refreshes must update this cache themselves.
function CachedWorkspaceList({ initialWorkspaces }: { initialWorkspaces: CoderWorkspace[] }) {
  const query = useDiscovery("workspaces", {}, { initialData: initialWorkspaces });
  return <WorkspaceListContent workspaces={query.data ?? []} />;
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
  vi.useRealTimers();
  mocks.createWorkspaceAction.mockReset();
  mocks.deleteWorkspaceAction.mockReset();
  mocks.listWorkspaceTemplatesAction.mockReset();
  mocks.refresh.mockReset();
  mocks.listWorkspacesAction.mockReset();
  mocks.startWorkspaceAction.mockReset();
  mocks.stopWorkspaceAction.mockReset();
});

describe("workspace card grid", () => {
  it("omits the page navigation when embedded, while keeping launch and lifecycle controls", () => {
    render(<WorkspaceListContent workspaces={[makeWorkspace()]} embedded />);
    expect(screen.queryByTestId("dashboard-page-sidebar-trigger")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Launch workspace/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop workspace mobile-dev" })).toBeInTheDocument();
  });
  it("renders a single responsive workspace card grid with accessible terminal actions", () => {
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

    const stack = screen.getByTestId("workspaces-card-grid");
    expect(screen.getByRole("list", { name: "Workspaces" })).toBe(stack);

    const cards = screen.getAllByTestId("workspace-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("mobile-dev")).toBeInTheDocument();
    expect(within(cards[0]).getByText("running")).toBeInTheDocument();
    expect(within(cards[0]).getByText("AI Dev")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Development & orchestration")).toBeInTheDocument();
    expect(within(cards[0]).getByText("alice")).toBeInTheDocument();

    const terminalLink = within(cards[0]).getByRole("link", {
      name: "Open workspace for mobile-dev",
    });
    expect(terminalLink).toHaveAttribute("href", "/workspaces?workspace=workspace-1&tool=terminal");
    expect(terminalLink).toHaveClass("min-h-11", "touch-manipulation", "text-sm");

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("opens the launch workspace modal from the button and Cmd/Ctrl+Alt+N", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValue({
      data: [
        {
          id: "template-1",
          name: "ai-dev-k8s",
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
    expect(await screen.findByTestId("create-workspace-modal")).toHaveTextContent(
      "Launch workspace",
    );
    expect(await screen.findByTestId("selected-workspace-profile")).toHaveTextContent(
      "Development & orchestration",
    );
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

  it("keeps non-retired orchestration-named external templates launchable", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValue({
      data: [
        {
          id: "template-external",
          name: "orchestrator-v2",
          activeVersionId: "version-external",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mocks.createWorkspaceAction.mockResolvedValue({
      data: makeWorkspace({
        id: "workspace-external",
        name: "external-command-center",
        template_id: "template-external",
        template_name: "orchestrator-v2",
      }),
    });

    render(<WorkspaceListContent workspaces={[makeWorkspace()]} />);

    fireEvent.click(screen.getByTestId("open-create-workspace-modal"));
    await waitFor(() => {
      expect(screen.getByTestId("create-workspace-template")).toHaveValue("template-external");
    });
    expect(screen.getByRole("option", { name: "orchestrator-v2" })).toBeInTheDocument();
    expect(screen.getByTestId("selected-workspace-profile")).toHaveTextContent("Custom");

    fireEvent.change(screen.getByTestId("create-workspace-name"), {
      target: { value: "external-command-center" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-create-workspace"));
    });

    expect(mocks.createWorkspaceAction).toHaveBeenCalledWith({
      templateId: "template-external",
      name: "external-command-center",
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows create workspace validation errors from the action response", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValue({
      data: [
        {
          id: "template-1",
          name: "ai-dev-k8s",
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
          name: "ai-dev-k8s",
          activeVersionId: "version-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mocks.createWorkspaceAction.mockResolvedValue({
      data: makeWorkspace({ id: "workspace-new", name: "new-dev" }),
    });
    mocks.listWorkspacesAction.mockResolvedValue({
      data: [makeWorkspace(), makeWorkspace({ id: "workspace-new", name: "new-dev" })],
    });

    render(<CachedWorkspaceList initialWorkspaces={[makeWorkspace()]} />);

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
    expect(await screen.findByText("new-dev")).toBeInTheDocument();
    expect(mocks.listWorkspacesAction).toHaveBeenCalledOnce();
  });

  it("starts and stops workspaces through explicit lifecycle actions", async () => {
    mocks.startWorkspaceAction.mockResolvedValue({
      data: { workspaceId: "stopped-ws", status: "running" },
    });
    mocks.stopWorkspaceAction.mockResolvedValue({
      data: { workspaceId: "running-ws", status: "stopped" },
    });
    const runningWorkspace = makeWorkspace({ id: "running-ws", name: "running-dev" });
    const stoppedWorkspace = makeWorkspace({
      id: "stopped-ws",
      name: "stopped-dev",
      latest_build: latestBuild("stopped"),
    });
    const startedWorkspace = {
      ...stoppedWorkspace,
      latest_build: latestBuild("running", "new-started-build"),
    };
    mocks.listWorkspacesAction
      .mockResolvedValueOnce({ data: [runningWorkspace, startedWorkspace] })
      .mockResolvedValueOnce({
        data: [
          { ...runningWorkspace, latest_build: latestBuild("stopped", "new-stopped-build") },
          startedWorkspace,
        ],
      });

    render(<CachedWorkspaceList initialWorkspaces={[runningWorkspace, stoppedWorkspace]} />);

    const [runningCard, stoppedCard] = screen.getAllByTestId("workspace-card");
    fireEvent.click(
      within(stoppedCard).getByRole("button", { name: "Start workspace stopped-dev" }),
    );
    await waitFor(() => {
      expect(mocks.startWorkspaceAction).toHaveBeenCalledWith({ workspaceId: "stopped-ws" });
    });
    expect(await within(stoppedCard).findByText("running")).toBeInTheDocument();

    fireEvent.click(
      within(runningCard).getByRole("button", { name: "Stop workspace running-dev" }),
    );
    await waitFor(() => {
      expect(mocks.stopWorkspaceAction).toHaveBeenCalledWith({ workspaceId: "running-ws" });
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(await within(runningCard).findByText("stopped")).toBeInTheDocument();
    expect(mocks.listWorkspacesAction).toHaveBeenCalledTimes(2);
  });

  it("requires the exact workspace name before deletion", async () => {
    mocks.deleteWorkspaceAction.mockResolvedValue({
      data: { workspaceId: "workspace-1", status: "deleting" },
    });
    mocks.listWorkspacesAction.mockResolvedValue({ data: [] });
    render(<CachedWorkspaceList initialWorkspaces={[makeWorkspace()]} />);

    const card = screen.getByTestId("workspace-card");
    fireEvent.click(within(card).getByRole("button", { name: "Delete workspace mobile-dev" }));

    const confirmation = await screen.findByTestId("delete-workspace-confirmation");
    const deleteButton = screen.getByTestId("confirm-delete-workspace");
    expect(deleteButton).toBeDisabled();

    fireEvent.change(confirmation, { target: { value: "mobile" } });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "mobile-dev" } });
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(mocks.deleteWorkspaceAction).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        confirmationName: "mobile-dev",
      });
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("delete-workspace-modal")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("workspace-card")).not.toBeInTheDocument());
    expect(mocks.listWorkspacesAction).toHaveBeenCalledOnce();
  });

  it("auto-opens the launch flow in the management dialog", async () => {
    mocks.listWorkspaceTemplatesAction.mockResolvedValueOnce({ data: [] });
    render(<WorkspaceListContent workspaces={[makeWorkspace()]} launchOnMount />);
    expect(await screen.findByTestId("create-workspace-modal")).toBeInTheDocument();
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

  it("renders management errors as an in-page alert", () => {
    render(<WorkspaceListContent workspaces={[]} error="Not authenticated" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not authenticated");
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

    const cards = screen.getAllByTestId("workspace-card");
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

    const card = screen.getByTestId("workspace-card");
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

  it("polls while a Coder workspace is transitioning", () => {
    vi.useFakeTimers();

    render(
      <WorkspaceListPoller shouldPoll>
        <WorkspaceListContent workspaces={[makeWorkspace()]} />
      </WorkspaceListPoller>,
    );

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
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

vi.mock(
  "@/lib/discovery/transport",
  async () => (await import("../helpers/discovery-transport")).discoveryTransport,
);
