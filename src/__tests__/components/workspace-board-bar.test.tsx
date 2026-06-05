// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type * as React from "react";
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren<{ open?: boolean }>) => <>{children}</>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
}));

function board(key: string, name: string, order: number): WorkspaceBoard {
  return { key, name, order, panes: [] };
}

describe("WorkspaceBoardBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders ordered accessible board tabs and guards already-active selection", () => {
    const onSelect = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("planning", "Planning", 1), board("main", "Main", 0)]}
        activeBoardKey="main"
        onSelect={onSelect}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Main", "Planning"]);
    expect(screen.getByTestId("workspace-board-tab-main")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("workspace-board-tab-planning")).toHaveAttribute(
      "aria-selected",
      "false",
    );

    fireEvent.click(screen.getByTestId("workspace-board-tab-main"));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("workspace-board-tab-planning"));
    expect(onSelect).toHaveBeenCalledWith("planning");
  });

  it("supports keyboard selection across visible board tabs", () => {
    const onSelect = vi.fn();

    const boards = [board("main", "Main", 0), board("planning", "Planning", 1)];
    const { rerender } = render(
      <WorkspaceBoardBar boards={boards} activeBoardKey="main" onSelect={onSelect} />,
    );

    fireEvent.keyDown(screen.getByTestId("workspace-board-tab-main"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("planning");

    rerender(<WorkspaceBoardBar boards={boards} activeBoardKey="planning" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByTestId("workspace-board-tab-planning"), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("main");
  });

  it("submits and cancels the create-board dialog without prompt APIs", () => {
    const onCreate = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0)]}
        activeBoardKey="main"
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-board-new"));
    fireEvent.change(screen.getByTestId("workspace-board-create-input"), {
      target: { value: " Planning " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    expect(onCreate).toHaveBeenCalledWith("Planning");
    expect(screen.queryByTestId("workspace-board-create-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-new"));
    fireEvent.change(screen.getByTestId("workspace-board-create-input"), {
      target: { value: "Cancelled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("workspace-board-create-dialog")).not.toBeInTheDocument();
  });

  it("keeps create and rename dialogs open on blank names without firing callbacks", () => {
    const onCreate = vi.fn();
    const onRename = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0)]}
        activeBoardKey="main"
        onCreate={onCreate}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-board-new"));
    fireEvent.change(screen.getByTestId("workspace-board-create-input"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create board" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-board-create-dialog")).toBeInTheDocument();
    expect(screen.getByText("Enter a board name.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("workspace-board-rename"));
    fireEvent.change(screen.getByTestId("workspace-board-rename-input"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save board name" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-board-rename-dialog")).toBeInTheDocument();
    expect(screen.getByText("Enter a board name.")).toBeInTheDocument();
  });

  it("renames the active board by stable key and cancels without callback", () => {
    const onRename = vi.fn();

    render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("planning", "Planning", 1)]}
        activeBoardKey="planning"
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-board-rename"));
    expect(screen.getByTestId("workspace-board-rename-input")).toHaveValue("Planning");
    fireEvent.change(screen.getByTestId("workspace-board-rename-input"), {
      target: { value: " Delivery " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-board-rename-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("workspace-board-rename"));
    fireEvent.change(screen.getByTestId("workspace-board-rename-input"), {
      target: { value: " Delivery " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save board name" }));

    expect(onRename).toHaveBeenCalledWith("planning", "Delivery");
    expect(screen.queryByTestId("workspace-board-rename-dialog")).not.toBeInTheDocument();
  });

  it("deletes only when a non-final active board exists", () => {
    const onDelete = vi.fn();

    const { rerender } = render(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0), board("planning", "Planning", 1)]}
        activeBoardKey="main"
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-board-delete"));
    expect(onDelete).toHaveBeenCalledWith("main");

    rerender(
      <WorkspaceBoardBar
        boards={[board("main", "Main", 0)]}
        activeBoardKey="main"
        onDelete={onDelete}
      />,
    );

    expect(screen.getByTestId("workspace-board-delete")).toBeDisabled();
    fireEvent.click(screen.getByTestId("workspace-board-delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("does not throw for an empty board list and keeps controls guarded", () => {
    expect(() => render(<WorkspaceBoardBar boards={[]} />)).not.toThrow();

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("workspace-board-rename")).toBeDisabled();
    expect(screen.getByTestId("workspace-board-delete")).toBeDisabled();
  });
});
