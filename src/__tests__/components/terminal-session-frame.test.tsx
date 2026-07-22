// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TerminalSessionFrame } from "@/components/workspaces/TerminalSessionFrame";

describe("TerminalSessionFrame", () => {
  afterEach(cleanup);

  it("uses the titlebar as a drag surface without capturing header controls", () => {
    const onHeaderMouseDown = vi.fn();
    const onHeaderPointerDown = vi.fn();

    render(
      <TerminalSessionFrame
        label="VS Code"
        subtitle="projects/kethalia/hive"
        dataTestId="tool-frame"
        layoutMode="tiled"
        dragHandleListeners={{
          onMouseDown: onHeaderMouseDown,
          onPointerDown: onHeaderPointerDown,
        }}
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

    fireEvent.mouseDown(title);
    expect(onHeaderMouseDown).toHaveBeenCalledOnce();

    fireEvent.mouseDown(grip);
    expect(onHeaderMouseDown).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(title);
    expect(onHeaderPointerDown).toHaveBeenCalledOnce();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Pop out" }));
    fireEvent.mouseDown(close);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Pop out" }));
    fireEvent.pointerDown(close);
    expect(onHeaderMouseDown).toHaveBeenCalledTimes(2);
    expect(onHeaderPointerDown).toHaveBeenCalledOnce();
  });

  it("provides visible, context-menu, and long-press access to pane actions", () => {
    vi.useFakeTimers();
    const onOpenActions = vi.fn();

    render(
      <TerminalSessionFrame
        label="Terminal one"
        dataTestId="terminal-one"
        layoutMode="tiled"
        onOpenActions={onOpenActions}
        touchOptimizedActions
      >
        <div>Terminal</div>
      </TerminalSessionFrame>,
    );

    const more = screen.getByRole("button", { name: "Open actions for Terminal one" });
    expect(more).toHaveClass("size-11", "min-h-11");
    fireEvent.click(more);
    expect(onOpenActions).toHaveBeenCalledTimes(1);

    const header = screen.getByTestId("terminal-one-header");
    fireEvent.contextMenu(header);
    expect(onOpenActions).toHaveBeenCalledTimes(2);

    fireEvent.touchStart(header, {
      touches: [{ identifier: 7, clientX: 40, clientY: 20 }],
    });
    vi.advanceTimersByTime(500);
    expect(onOpenActions).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it("shows only the More action while keeping touch header dragging", () => {
    const onHeaderTouchStart = vi.fn();

    render(
      <TerminalSessionFrame
        label="Terminal one"
        dataTestId="terminal-one"
        layoutMode="tiled"
        dragHandleListeners={{ onTouchStart: onHeaderTouchStart }}
        onOpenActions={vi.fn()}
        touchOptimizedActions
        headerActions={<button type="button">Files</button>}
        onClose={vi.fn()}
      >
        <div>Terminal</div>
      </TerminalSessionFrame>,
    );

    const header = screen.getByTestId("terminal-one-header");
    expect(header.querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open actions for Terminal one" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close Terminal one" })).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-one-drag-icon")).toBeInTheDocument();
    expect(header).toHaveAttribute("data-window-drag-surface", "true");
    expect(header).toHaveClass("touch-none");

    fireEvent.touchStart(screen.getByTestId("terminal-one-title"), {
      touches: [{ identifier: 7, clientX: 40, clientY: 20 }],
    });
    expect(onHeaderTouchStart).toHaveBeenCalledOnce();
  });

  it("cancels a header long press when touch movement exceeds the drag threshold", () => {
    vi.useFakeTimers();
    const onOpenActions = vi.fn();

    render(
      <TerminalSessionFrame
        label="Terminal one"
        dataTestId="terminal-one"
        layoutMode="tiled"
        onOpenActions={onOpenActions}
      >
        <div>Terminal</div>
      </TerminalSessionFrame>,
    );

    const header = screen.getByTestId("terminal-one-header");
    fireEvent.touchStart(header, {
      touches: [{ identifier: 7, clientX: 40, clientY: 20 }],
    });
    fireEvent.touchMove(header, {
      touches: [{ identifier: 7, clientX: 52, clientY: 20 }],
    });
    vi.advanceTimersByTime(500);
    expect(onOpenActions).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("cancels a header long press when a second finger joins", () => {
    vi.useFakeTimers();
    const onOpenActions = vi.fn();

    render(
      <TerminalSessionFrame
        label="Terminal one"
        dataTestId="terminal-one"
        layoutMode="tiled"
        onOpenActions={onOpenActions}
      >
        <div>Terminal</div>
      </TerminalSessionFrame>,
    );

    const header = screen.getByTestId("terminal-one-header");
    fireEvent.touchStart(header, {
      touches: [{ identifier: 7, clientX: 40, clientY: 20 }],
    });
    fireEvent.touchStart(header, {
      touches: [
        { identifier: 7, clientX: 40, clientY: 20 },
        { identifier: 8, clientX: 80, clientY: 20 },
      ],
    });
    vi.advanceTimersByTime(500);
    expect(onOpenActions).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
