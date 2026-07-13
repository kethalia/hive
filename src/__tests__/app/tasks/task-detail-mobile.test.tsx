// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskWithRelations } from "@/lib/types/tasks";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) =>
    React.createElement("a", props, children),
}));

vi.mock("next-safe-action/hooks", () => ({
  useAction: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) =>
    React.createElement(
      "button",
      { type: "button", className, "data-testid": "dashboard-page-sidebar-trigger" },
      "Toggle sidebar",
    ),
}));

import { TaskDetail } from "@/app/(dashboard)/tasks/[id]/task-detail";

const longRepoUrl =
  "https://github.com/kethalia/hive-with-an-extremely-long-repository-name-that-must-wrap-on-phone-screens";
const longPrUrl =
  "https://github.com/kethalia/hive-with-an-extremely-long-repository-name-that-must-wrap-on-phone-screens/pull/1234567890";
const longBranch = "feature/mobile-task-detail-layout-with-a-very-long-branch-name";
const longAttachmentName =
  "screenshots/mobile-task-detail-overflow-regression-with-a-long-unbroken-filename.png";

function makeTask(): TaskWithRelations {
  return {
    id: "task-mobile-layout-1234567890",
    prompt:
      "Make the task detail page readable on phone screens without creating a separate mobile render path.",
    repoUrl: longRepoUrl,
    status: "done",
    branch: longBranch,
    prUrl: longPrUrl,
    errorMessage: null,
    createdAt: "2026-05-25T10:00:00Z",
    updatedAt: "2026-05-25T11:00:00Z",
    attachments: [
      {
        name: longAttachmentName,
        type: "image/png",
        data: "data:image/png;base64,AAAA",
      },
    ],
    workspaces: [
      {
        id: "workspace-mobile-layout-abcdef123456",
        taskId: "task-mobile-layout-1234567890",
        coderWorkspaceId: "coder-workspace-mobile-layout-abcdef123456",
        templateType: "nextjs-template-with-a-long-name",
        status: "running",
        createdAt: "2026-05-25T10:05:00Z",
      },
    ],
    logs: [
      {
        id: "log-mobile-layout-1",
        taskId: "task-mobile-layout-1234567890",
        level: "info",
        message:
          "Cloning repository with a long path and streaming enough text to verify wrapping on narrow screens.",
        createdAt: "2026-05-25T10:10:00Z",
      },
    ],
    verificationReport: null,
    councilReport: null,
    councilSize: 0,
  };
}

function classTokens(element: Element): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

describe("TaskDetail mobile layout contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses safe-area spacing and a phone-friendly back target", () => {
    const { container } = render(React.createElement(TaskDetail, { initialTask: makeTask() }));

    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(classTokens(root as Element)).toEqual(
      expect.arrayContaining(["space-y-4", "pb-safe", "sm:space-y-6"]),
    );

    const backTarget = screen.getByText("Back to Tasks").closest("a,button");
    expect(backTarget).not.toBeNull();
    expect(classTokens(backTarget as Element)).toEqual(
      expect.arrayContaining(["min-h-11", "touch-manipulation", "sm:min-h-7"]),
    );
  });

  it("uses a compact one-line page header with an operator-style title", () => {
    render(React.createElement(TaskDetail, { initialTask: makeTask() }));

    const title = screen.getByRole("heading", { name: /task task-mob/i });
    expect(classTokens(title)).toEqual(
      expect.arrayContaining(["truncate", "text-sm", "font-medium", "uppercase"]),
    );
    expect(classTokens(title)).not.toEqual(expect.arrayContaining(["font-bold", "text-xl"]));

    const header = title.closest("[data-dashboard-page-nav]");
    expect(header).not.toBeNull();
    expect(classTokens(header as Element)).toEqual(
      expect.arrayContaining(["flex", "items-center", "gap-3", "border-b"]),
    );
  });

  it("keeps task metadata in a responsive grid without an unconditional two-column class", () => {
    render(React.createElement(TaskDetail, { initialTask: makeTask() }));

    const grid = screen.getByTestId("task-metadata-grid");
    const tokens = classTokens(grid);
    expect(tokens).toEqual(expect.arrayContaining(["grid", "gap-3", "sm:grid-cols-2"]));
    expect(tokens).not.toContain("grid-cols-2");

    expect(grid.textContent).toContain(longRepoUrl);
    expect(grid.textContent).toContain(longPrUrl);
    expect(grid.textContent).toContain(longBranch);
    expect(grid.textContent).toContain("Created");
    expect(grid.textContent).toContain("Last Updated");
  });

  it("makes repository and pull request links shrink-safe, breakable, and external-safe", () => {
    render(React.createElement(TaskDetail, { initialTask: makeTask() }));

    const repoLink = screen.getByTestId("task-repo-link");
    expect(repoLink.getAttribute("href")).toBe(longRepoUrl);
    expect(repoLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(classTokens(repoLink)).toEqual(
      expect.arrayContaining(["inline-flex", "max-w-full", "min-w-0", "break-all"]),
    );

    const prLink = screen.getByTestId("task-pr-link");
    expect(prLink.getAttribute("href")).toBe(longPrUrl);
    expect(prLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(classTokens(prLink)).toEqual(
      expect.arrayContaining(["inline-flex", "max-w-full", "min-w-0", "break-all"]),
    );
  });

  it("lets attachments and workspace rows wrap on phones while preserving desktop row classes", () => {
    render(React.createElement(TaskDetail, { initialTask: makeTask() }));

    const attachment = screen.getByText(longAttachmentName).closest("li");
    expect(attachment).not.toBeNull();
    expect(classTokens(attachment as Element)).toEqual(
      expect.arrayContaining(["flex", "flex-wrap", "items-center", "gap-2", "sm:gap-3"]),
    );
    expect(classTokens(screen.getByText(longAttachmentName))).toEqual(
      expect.arrayContaining(["break-all"]),
    );

    const row = screen.getByTestId("task-workspace-row");
    expect(classTokens(row)).toEqual(
      expect.arrayContaining([
        "flex",
        "flex-col",
        "gap-2",
        "rounded-lg",
        "border",
        "p-3",
        "sm:flex-row",
        "sm:items-center",
        "sm:justify-between",
      ]),
    );
    expect(classTokens(row.firstElementChild as Element)).toEqual(
      expect.arrayContaining(["flex", "min-w-0", "flex-wrap", "items-center", "gap-2"]),
    );
  });

  it("stacks log rows on mobile and keeps timestamp width desktop-only", () => {
    render(React.createElement(TaskDetail, { initialTask: makeTask() }));

    const row = screen.getByTestId("task-log-row");
    const tokens = classTokens(row);
    expect(tokens).toEqual(
      expect.arrayContaining([
        "flex",
        "flex-col",
        "gap-1",
        "py-1.5",
        "text-sm",
        "sm:flex-row",
        "sm:items-start",
        "sm:gap-3",
      ]),
    );

    const timestamp = row.querySelector("span");
    expect(timestamp).not.toBeNull();
    const timestampTokens = classTokens(timestamp as Element);
    expect(timestampTokens).toContain("sm:min-w-[140px]");
    expect(timestampTokens).not.toContain("min-w-[140px]");
  });

  it("does not use tiny text in the task detail source", () => {
    const taskDetailPath = join(process.cwd(), "src/app/(dashboard)/tasks/[id]/task-detail.tsx");
    expect(readFileSync(taskDetailPath, "utf8")).not.toContain("text-[10px]");
  });
});
