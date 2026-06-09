// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalGestureLayer } from "@/components/terminal/TerminalGestureLayer";
import { DRAG_LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from "@/lib/gestures/conventions";

function renderLayer(
  onLongPress = vi.fn(),
  props: Partial<ComponentProps<typeof TerminalGestureLayer>> = {},
) {
  render(
    <TerminalGestureLayer onLongPress={onLongPress} {...props}>
      <div data-testid="terminal-child">terminal</div>
    </TerminalGestureLayer>,
  );
  const child = screen.getByTestId("terminal-child");
  return {
    child,
    layer: child.parentElement as HTMLElement,
    onLongPress,
  };
}

function pointerDown(target: Element, x = 120, y = 240, pointerType = "touch") {
  fireEvent.pointerDown(target, {
    buttons: 1,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType,
  });
}

function pointerMove(target: Element, x: number, y: number, pointerType = "touch") {
  fireEvent.pointerMove(target, {
    buttons: 1,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType,
  });
}

function pointerUp(target: Element, x = 120, y = 240, pointerType = "touch") {
  fireEvent.pointerUp(target, {
    buttons: 0,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType,
  });
}

describe("TerminalGestureLayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fires onLongPress with client coordinates after a held press", () => {
    const { child, layer, onLongPress } = renderLayer();

    expect(layer.style.userSelect).toBe("");
    expect(layer.style.touchAction).toBe("pan-x pan-y");

    pointerDown(child, 123, 456);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(123, 456);
  });

  it("does not start long-press handling for mouse drags", () => {
    const { child, onLongPress } = renderLayer();

    pointerDown(child, 123, 456, "mouse");
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    pointerMove(child, 124, 457, "mouse");
    pointerUp(child, 124, 457, "mouse");

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does not fire onLongPress for a tap released before the hold timer", () => {
    const { child, onLongPress } = renderLayer();

    pointerDown(child, 30, 40);
    pointerUp(child, 30, 40);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does not fire onLongPress when movement crosses the drag threshold before the timer", () => {
    const { child, onLongPress } = renderLayer();

    pointerDown(child, 10, 20);
    pointerMove(child, 10 + DRAG_LONG_PRESS_MOVE_PX + 1, 20);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    pointerUp(child, 10 + DRAG_LONG_PRESS_MOVE_PX + 1, 20);

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("allows native selection and context menu behavior when selection mode is enabled", () => {
    const parentContextMenu = vi.fn();
    const onLongPress = vi.fn();
    render(
      <div onContextMenu={parentContextMenu}>
        <TerminalGestureLayer onLongPress={onLongPress} selectionModeEnabled>
          <div data-testid="terminal-child">terminal</div>
        </TerminalGestureLayer>
      </div>,
    );
    const child = screen.getByTestId("terminal-child");
    const layer = child.parentElement as HTMLElement;

    expect(layer.style.userSelect).toBe("");
    expect(layer.style.touchAction).toBe("auto");

    pointerDown(child, 50, 60);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    const nativeContextMenu = createEvent.contextMenu(child, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(child, nativeContextMenu);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(nativeContextMenu.defaultPrevented).toBe(false);
    expect(parentContextMenu).toHaveBeenCalledTimes(1);
  });

  it("suppresses the native context menu immediately after a successful long press", () => {
    const parentContextMenu = vi.fn();
    const onLongPress = vi.fn();
    render(
      <div onContextMenu={parentContextMenu}>
        <TerminalGestureLayer onLongPress={onLongPress}>
          <div data-testid="terminal-child">terminal</div>
        </TerminalGestureLayer>
      </div>,
    );
    const child = screen.getByTestId("terminal-child");

    pointerDown(child, 50, 60);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    const suppressedContextMenu = createEvent.contextMenu(child, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(child, suppressedContextMenu);

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(suppressedContextMenu.defaultPrevented).toBe(true);
    expect(parentContextMenu).not.toHaveBeenCalled();

    const desktopContextMenu = createEvent.contextMenu(child, {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(child, desktopContextMenu);

    expect(desktopContextMenu.defaultPrevented).toBe(false);
    expect(parentContextMenu).toHaveBeenCalledTimes(1);
  });

  it("allows native desktop context menus by default", () => {
    const parentContextMenu = vi.fn();
    render(
      <div onContextMenu={parentContextMenu}>
        <TerminalGestureLayer onLongPress={vi.fn()}>
          <div data-testid="terminal-child">terminal</div>
        </TerminalGestureLayer>
      </div>,
    );
    const child = screen.getByTestId("terminal-child");

    const desktopContextMenu = createEvent.contextMenu(child, {
      bubbles: true,
      cancelable: true,
      clientX: 70,
      clientY: 90,
    });
    fireEvent(child, desktopContextMenu);

    expect(desktopContextMenu.defaultPrevented).toBe(false);
    expect(parentContextMenu).toHaveBeenCalledTimes(1);
  });
});
