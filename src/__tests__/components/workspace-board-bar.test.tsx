// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { WorkspaceBoardBar } from "@/components/workspaces/WorkspaceBoardBar";
import type { WorkspaceBoard } from "@/lib/workspaces/workspace-board-state";

vi.mock("@/lib/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

function board(key: string, name: string, order: number): WorkspaceBoard {
  return { key, name, order, panes: [] };
}

describe("WorkspaceBoardBar", () => {
  it("constrains the tab list so overflowing phone boards remain scrollable", () => {
    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("review", "Review", 1)]}
        activeBoardKey="review"
      />,
    );

    const tablist = screen.getByTestId("workspace-board-tablist");
    expect(tablist).toHaveClass("min-w-0", "flex-1", "overflow-x-auto");
    expect(tablist).toHaveAttribute("data-mobile-scroll-allow", "true");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders ordered square workspace tabs using numeric labels", () => {
    const onSelect = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("planning", "Planning", 1), board("main", "Main", 0)]}
        activeBoardKey="main"
        onSelect={onSelect}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["1", "2"]);
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAccessibleName("Open workspace 1");
    expect(screen.getByTestId("workspace-board-tab-planning")).toHaveAttribute(
      "aria-selected",
      "false",
    );

    fireEvent.click(screen.getByTestId("workspace-board-tab-main"));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("workspace-board-tab-planning"));
    expect(onSelect).toHaveBeenCalledWith("planning");
  });

  it("supports keyboard selection across visible workspace tabs and moves focus", () => {
    const onSelect = vi.fn();

    const boards = [board("main", "Main", 0), board("planning", "Planning", 1)];
    const { rerender } = render(
      <WorkspaceBoardBar boards={boards} activeBoardKey="main" onSelect={onSelect} />,
    );

    fireEvent.keyDown(screen.getByTestId("workspace-board-tab-main"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("planning");
    expect(screen.getByTestId("workspace-board-tab-planning")).toHaveFocus();

    rerender(<WorkspaceBoardBar boards={boards} activeBoardKey="planning" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByTestId("workspace-board-tab-planning"), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("main");
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveFocus();
  });

  it("creates a workspace immediately from the plus button", () => {
    const onCreate = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0)]}
        activeBoardKey="main"
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-board-new"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("workspace-board-new")).toHaveAccessibleName("Create workspace");
  });

  it("turns the active workspace into a danger delete control on hover", () => {
    const onDelete = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("planning", "Planning", 1)]}
        activeBoardKey="main"
        onDelete={onDelete}
      />,
    );

    const activeTab = screen.getByTestId("workspace-board-tab-main");
    expect(activeTab).toHaveTextContent("1");
    expect(activeTab).toHaveAccessibleName("Open workspace 1");

    fireEvent.mouseEnter(activeTab);
    expect(screen.getByTestId("workspace-board-delete")).toBeInTheDocument();
    expect(activeTab).toHaveAccessibleName("Delete workspace 1");

    fireEvent.focus(activeTab);
    expect(screen.getByTestId("workspace-board-delete")).toBeInTheDocument();

    fireEvent.click(activeTab);

    expect(onDelete).toHaveBeenCalledWith("main");
  });

  it("arms a selected workspace for deletion without requiring the pointer to leave and re-enter", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();

    const boards = [board("main", "Main", 0), board("planning", "Planning", 1)];
    const { rerender } = render(
      <WorkspaceBoardBar
        boards={boards}
        activeBoardKey="main"
        onDelete={onDelete}
        onSelect={onSelect}
      />,
    );

    const inactiveTab = screen.getByTestId("workspace-board-tab-planning");
    fireEvent.click(inactiveTab);

    expect(onSelect).toHaveBeenCalledWith("planning");

    rerender(
      <WorkspaceBoardBar
        boards={boards}
        activeBoardKey="planning"
        onDelete={onDelete}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId("workspace-board-delete")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-tab-planning"));

    expect(onDelete).toHaveBeenCalledWith("planning");
  });

  it("does not arm delete from keyboard focus alone", () => {
    const onDelete = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("planning", "Planning", 1)]}
        activeBoardKey="main"
        onDelete={onDelete}
      />,
    );

    const activeTab = screen.getByTestId("workspace-board-tab-main");
    fireEvent.focus(activeTab);
    expect(screen.queryByTestId("workspace-board-delete")).not.toBeInTheDocument();
    fireEvent.click(activeTab);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does not expose delete when only one workspace exists", () => {
    const onDelete = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0)]}
        activeBoardKey="main"
        onDelete={onDelete}
      />,
    );

    const activeTab = screen.getByTestId("workspace-board-tab-main");
    fireEvent.mouseEnter(activeTab);
    fireEvent.click(activeTab);

    expect(screen.queryByTestId("workspace-board-delete")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("clears armed delete state when the armed workspace is removed", () => {
    const boards = [board("main", "Main", 0), board("planning", "Planning", 1)];
    const { rerender } = render(
      <WorkspaceBoardBar boards={boards} activeBoardKey="planning" onDelete={vi.fn()} />,
    );

    fireEvent.mouseEnter(screen.getByTestId("workspace-board-tab-planning"));
    expect(screen.getByTestId("workspace-board-delete")).toBeInTheDocument();

    rerender(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("review", "Review", 1)]}
        activeBoardKey="review"
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("workspace-board-delete")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-review")).toHaveAccessibleName(
      "Open workspace 2",
    );
  });

  it("clears armed delete state when only one workspace remains", () => {
    const { rerender } = render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("planning", "Planning", 1)]}
        activeBoardKey="main"
        onDelete={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("workspace-board-tab-main"));
    expect(screen.getByTestId("workspace-board-delete")).toBeInTheDocument();

    rerender(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0)]}
        activeBoardKey="main"
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("workspace-board-delete")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAccessibleName("Open workspace 1");
  });

  it("does not throw for an empty board list and keeps create available", () => {
    const onCreate = vi.fn();

    expect(() => render(<WorkspaceBoardBar boards={[]} onCreate={onCreate} />)).not.toThrow();

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("workspace-board-new"));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
