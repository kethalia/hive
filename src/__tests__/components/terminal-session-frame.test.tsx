// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TerminalSessionFrame } from "@/components/workspaces/TerminalSessionFrame";

describe("TerminalSessionFrame", () => {
  afterEach(cleanup);

  it("uses the titlebar as a drag surface without capturing header controls", () => {
    const onHeaderPointerDown = vi.fn();

    render(
      <TerminalSessionFrame
        label="VS Code"
        subtitle="projects/kethalia/hive"
        dataTestId="tool-frame"
        layoutMode="tiled"
        onHeaderPointerDown={onHeaderPointerDown}
        onActivate={vi.fn()}
        headerActions={<button type="button">Pop out</button>}
        onClose={vi.fn()}
      >
        <div>Editor</div>
      </TerminalSessionFrame>,
    );

    const header = screen.getByTestId("tool-frame-header");
    const grip = screen.getByTestId("tool-frame-drag-icon");
    const title = screen.getByTestId("tool-frame-title");
    const subtitle = screen.getByTestId("tool-frame-subtitle");
    const close = screen.getByRole("button", { name: "Close VS Code" });

    expect(header).toHaveAttribute("data-window-drag-surface", "true");
    expect(header).toHaveClass("cursor-grab", "touch-none", "select-none");
    expect(screen.queryByRole("button", { name: "Drag VS Code" })).not.toBeInTheDocument();
    expect(grip).toHaveClass("size-3", "shrink-0");
    expect(grip).toHaveAttribute("aria-hidden", "true");
    expect(grip.closest("button")).toBeNull();
    expect(title).toHaveTextContent("VS Code");
    expect(subtitle).toHaveTextContent("projects/kethalia/hive");
    expect(title.parentElement?.parentElement).toHaveClass("items-center");
    expect(close).toHaveClass("h-6");

    fireEvent.pointerDown(title);
    expect(onHeaderPointerDown).toHaveBeenCalledOnce();

    fireEvent.pointerDown(grip);
    expect(onHeaderPointerDown).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Pop out" }));
    fireEvent.pointerDown(close);
    expect(onHeaderPointerDown).toHaveBeenCalledTimes(2);
  });
});
