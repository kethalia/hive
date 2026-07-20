// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  WorkspaceWindow,
  WorkspaceWindowDropPlaceholder,
} from "@/components/workspaces/WorkspaceWindow";

const draggableState = vi.hoisted(() => ({
  draggableDisabled: false,
  droppableDisabled: false,
  isDragging: false,
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: ({ disabled = false }: { disabled?: boolean }) => {
    draggableState.draggableDisabled = disabled;
    return {
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: draggableState.isDragging ? { x: 48, y: 32, scaleX: 1, scaleY: 1 } : null,
      isDragging: draggableState.isDragging,
    };
  },
  useDroppable: ({ disabled = false }: { disabled?: boolean }) => {
    draggableState.droppableDisabled = disabled;
    return { setNodeRef: vi.fn() };
  },
}));

describe("WorkspaceWindow", () => {
  afterEach(() => {
    draggableState.draggableDisabled = false;
    draggableState.droppableDisabled = false;
    draggableState.isDragging = false;
    cleanup();
  });

  it("disables both drag and drop behavior for a compose-locked pane", () => {
    render(
      <WorkspaceWindow
        disabled
        id="locked"
        style={{ left: "0%", top: "0%", width: "50%", height: "50%" }}
      >
        {() => <div>Locked terminal</div>}
      </WorkspaceWindow>,
    );

    expect(draggableState.draggableDisabled).toBe(true);
    expect(draggableState.droppableDisabled).toBe(true);
    expect(screen.getByText("Locked terminal").parentElement).toHaveAttribute(
      "data-workspace-window-disabled",
      "true",
    );
  });

  it("removes the pane from its slot while a translucent copy follows the pointer", () => {
    draggableState.isDragging = true;
    render(
      <WorkspaceWindow id="code" style={{ left: "0%", top: "0%", width: "50%", height: "50%" }}>
        {() => <div>VS Code</div>}
      </WorkspaceWindow>,
    );

    const window = screen.getByText("VS Code").parentElement;
    expect(window).toHaveAttribute("data-workspace-window-dragging", "true");
    expect(window).toHaveClass("pointer-events-none", "opacity-60");
    expect(window).not.toHaveClass("opacity-0");
    expect(window).toHaveStyle({ transform: "translate3d(48px, 32px, 0)" });
  });
});

describe("WorkspaceWindowDropPlaceholder", () => {
  afterEach(cleanup);

  it("renders a standalone empty destination slot with the predicted geometry", () => {
    render(
      <WorkspaceWindowDropPlaceholder
        kind="destination"
        position="left"
        style={{ left: "50%", top: "50%", width: "25%", height: "50%" }}
      />,
    );

    const placeholder = screen.getByTestId("workspace-window-drop-placeholder");
    expect(placeholder).toHaveClass("absolute", "p-0.5", "pointer-events-none");
    expect(placeholder).toHaveAttribute("data-workspace-window-drop-kind", "destination");
    expect(placeholder).toHaveAttribute("data-workspace-window-drop-position", "left");
    expect(placeholder).toHaveStyle({ left: "50%", top: "50%", width: "25%", height: "50%" });
    expect(placeholder).not.toHaveAttribute("data-workspace-window-id");
    expect(placeholder.firstElementChild).toHaveClass(
      "h-full",
      "w-full",
      "rounded-md",
      "border-primary/80",
    );
    expect(placeholder.firstElementChild).toBeEmptyDOMElement();
  });

  it("renders the same green slot at the drag origin before a destination is selected", () => {
    render(
      <WorkspaceWindowDropPlaceholder
        kind="origin"
        style={{ left: "0%", top: "0%", width: "50%", height: "100%" }}
      />,
    );

    const placeholder = screen.getByTestId("workspace-window-drop-placeholder");
    expect(placeholder).toHaveAttribute("data-workspace-window-drop-kind", "origin");
    expect(placeholder).not.toHaveAttribute("data-workspace-window-drop-position");
    expect(placeholder).toHaveStyle({ left: "0%", top: "0%", width: "50%", height: "100%" });
    expect(placeholder.firstElementChild).toHaveClass(
      "rounded-md",
      "border-primary/80",
      "bg-primary/10",
    );
  });
});
