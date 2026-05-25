// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { TaskListContent } from "@/app/(dashboard)/tasks/task-list-content";
import { TaskListPoller } from "@/app/(dashboard)/tasks/task-list-poller";
import { PULL_REFRESH_TRIGGER_PX } from "@/lib/gestures/conventions";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

let originalPointerEvent: typeof window.PointerEvent | undefined;
const originalSetPointerCapture = Element.prototype.setPointerCapture;
const originalReleasePointerCapture = Element.prototype.releasePointerCapture;
const originalHasPointerCapture = Element.prototype.hasPointerCapture;

type TaskFixture = React.ComponentProps<typeof TaskListContent>["taskList"][number];

const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

function makeTask(overrides: Partial<TaskFixture> = {}): TaskFixture {
  return {
    id: "task-1",
    prompt: "Ship a mobile-friendly agent task list",
    repoUrl: "https://github.com/kethalia/hive",
    status: "queued",
    createdAt,
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
  refresh.mockReset();
});

describe("tasks mobile list", () => {
  it("renders mobile cards beside the unchanged desktop table columns", () => {
    render(
      <TaskListContent taskList={[makeTask(), makeTask({ id: "task-2", status: "running" })]} />,
    );

    const stack = screen.getByTestId("tasks-mobile-card-stack");
    expect(stack).toHaveAttribute("role", "list");
    expect(stack).toHaveClass("md:hidden", "text-sm", "pb-safe");
    expect(screen.getAllByTestId("task-mobile-card")).toHaveLength(2);

    const firstCard = screen.getAllByTestId("task-mobile-card")[0];
    expect(within(firstCard).getByText("queued")).toBeInTheDocument();
    expect(within(firstCard).getByText("kethalia/hive")).toBeInTheDocument();

    const mobileLink = within(firstCard).getByRole("link", {
      name: "Ship a mobile-friendly agent task list",
    });
    expect(mobileLink).toHaveAttribute("href", "/tasks/task-1");
    expect(mobileLink).toHaveClass("min-h-11", "text-foreground");

    const desktopTable = screen.getByTestId("tasks-desktop-table");
    expect(desktopTable).toHaveClass("hidden", "md:block");
    expect(within(desktopTable).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(within(desktopTable).getByRole("columnheader", { name: "Prompt" })).toBeInTheDocument();
    expect(
      within(desktopTable).getByRole("columnheader", { name: "Repository" }),
    ).toBeInTheDocument();
    expect(within(desktopTable).getByRole("columnheader", { name: "Created" })).toBeInTheDocument();
  });

  it("keeps the empty state inside the pull-to-refresh surface", () => {
    render(
      <TaskListPoller>
        <TaskListContent taskList={[]} />
      </TaskListPoller>,
    );

    const refreshSurface = screen.getByTestId("pull-to-refresh");
    expect(refreshSurface).toHaveAttribute("data-pull-state", "idle");
    expect(within(refreshSurface).getByTestId("tasks-empty-state")).toHaveTextContent(
      "No tasks yet.",
    );
    expect(
      within(refreshSurface).getByRole("link", { name: "Create your first task" }),
    ).toHaveAttribute("href", "/tasks/new");
  });

  it("truncates long prompts in both the mobile card and desktop table", () => {
    const longPrompt = "Refactor the task queue mobile layout ".repeat(8);
    render(<TaskListContent taskList={[makeTask({ prompt: longPrompt })]} />);

    expect(screen.getByRole("link", { name: `${longPrompt.slice(0, 120)}…` })).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByRole("link", { name: `${longPrompt.slice(0, 80)}…` })).toHaveAttribute(
      "href",
      "/tasks/task-1",
    );
  });

  it("calls router.refresh once on a valid pull and suppresses in-flight duplicate pulls", async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    refresh.mockReturnValue(refreshPromise);

    render(
      <TaskListPoller>
        <TaskListContent taskList={[makeTask()]} />
      </TaskListPoller>,
    );
    const surface = screen.getByTestId("pull-to-refresh");

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(surface).toHaveAttribute("data-pull-state", "refreshing");
    });

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh();
      await refreshPromise;
    });
    await waitFor(() => {
      expect(surface).toHaveAttribute("data-pull-state", "idle");
    });
  });

  it("ignores non-top pull attempts", () => {
    render(
      <TaskListPoller>
        <TaskListContent taskList={[makeTask()]} />
      </TaskListPoller>,
    );
    const surface = screen.getByTestId("pull-to-refresh");

    surface.scrollTop = 24;
    dragPull(surface, PULL_REFRESH_TRIGGER_PX);

    expect(refresh).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute("data-pull-state", "idle");
  });

  it("does not introduce tiny type in the S05-owned task markup", () => {
    const source = readFileSync("src/app/(dashboard)/tasks/task-list-content.tsx", "utf8");
    expect(source).not.toContain("text-[10px]");
  });
});
