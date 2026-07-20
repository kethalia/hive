// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  WorkspaceWindow,
  WorkspaceWindowDropPlaceholder,
} from "@/components/workspaces/WorkspaceWindow";

const draggableState = vi.hoisted(() => ({ isDragging: false }));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: draggableState.isDragging ? { x: 48, y: 32, scaleX: 1, scaleY: 1 } : null,
    isDragging: draggableState.isDragging,
  }),
  useDroppable: () => ({ setNodeRef: vi.fn() }),
}));

describe("WorkspaceWindow", () => {
  afterEach(() => {
    draggableState.isDragging = false;
    cleanup();
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
        style={{ left: "50%", top: "50%", width: "25%", height: "50%" }}
      />,
    );

    const placeholder = screen.getByTestId("workspace-window-drop-placeholder");
    expect(placeholder).toHaveClass("absolute", "p-0.5", "pointer-events-none");
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
});
