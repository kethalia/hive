// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TerminalSessionFrame } from "@/components/workspaces/TerminalSessionFrame";

describe("TerminalSessionFrame", () => {
  afterEach(cleanup);

  it("uses the titlebar as a drag surface without capturing header controls", () => {
    const onHeaderPointerDown = vi.fn();
    const onGripPointerDown = vi.fn();

    render(
      <TerminalSessionFrame
        label="VS Code"
        dataTestId="tool-frame"
        layoutMode="tiled"
        dragHandleAttributes={{ "aria-describedby": "drag-instructions" }}
        dragHandleListeners={{ onPointerDown: onGripPointerDown }}
        onHeaderPointerDown={onHeaderPointerDown}
        headerActions={<button type="button">Pop out</button>}
        onClose={vi.fn()}
      >
        <div>Editor</div>
      </TerminalSessionFrame>,
    );

    const header = screen.getByTestId("tool-frame-header");
    const grip = screen.getByRole("button", { name: "Drag VS Code" });
    const close = screen.getByRole("button", { name: "Close VS Code" });

    expect(header).toHaveAttribute("data-window-drag-surface", "true");
    expect(header).toHaveClass("cursor-grab", "touch-none", "select-none");
    expect(grip).toHaveClass("size-6");
    expect(close).toHaveClass("h-6");

    fireEvent.pointerDown(screen.getByText("VS Code"));
    expect(onHeaderPointerDown).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Pop out" }));
    fireEvent.pointerDown(close);
    expect(onHeaderPointerDown).toHaveBeenCalledOnce();

    fireEvent.pointerDown(grip);
    expect(onGripPointerDown).toHaveBeenCalledOnce();
    expect(onHeaderPointerDown).toHaveBeenCalledOnce();
  });
});
