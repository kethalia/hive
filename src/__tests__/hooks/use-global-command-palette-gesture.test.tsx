// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGlobalCommandPaletteGesture } from "@/hooks/useGlobalCommandPaletteGesture";

function Harness({ enabled = true, onOpen }: { enabled?: boolean; onOpen: () => void }) {
  useGlobalCommandPaletteGesture({ enabled, onOpen });
  return (
    <main>
      <div data-testid="canvas" data-mobile-scroll-allow="true">
        Canvas
      </div>
      <div data-testid="controls" data-launcher-gesture-ignore="true">
        Controls
      </div>
      <div data-testid="dialog" role="dialog" aria-label="Options">
        Options
      </div>
      <input aria-label="Input" />
    </main>
  );
}
const point = (identifier: number, clientX: number, clientY: number) => ({
  identifier,
  clientX,
  clientY,
});
function touch(type: string, touches: ReturnType<typeof point>[], target: EventTarget = window) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
  return event;
}
const start = [point(1, 140, 300), point(2, 220, 300)];
const up = [point(1, 142, 220), point(2, 222, 220)];
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe("two-finger search shortcut", () => {
  it("claims movement while the second finger catches up and cancels compatibility clicks", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const target = getByTestId("canvas");
    touch("touchstart", [start[0]], target);
    touch("touchstart", start, target);
    expect(touch("touchmove", [point(1, 140, 294), start[1]], target).defaultPrevented).toBe(true);
    touch("touchmove", [point(1, 160, 235), point(2, 238, 255)], target);
    // Minor recoil before release should not undo a completed upward swipe.
    touch("touchmove", [point(1, 160, 255), point(2, 238, 275)], target);
    expect(touch("touchend", [point(2, 238, 275)], target).defaultPrevented).toBe(true);
    expect(touch("touchend", [], target).defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it("claims early upward movement and the remaining finger without scrolling the underlying window", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const target = getByTestId("canvas");
    const scroll = vi.fn();
    target.addEventListener("touchmove", scroll);
    touch("touchstart", start, target);
    expect(
      touch("touchmove", [point(1, 140, 296), point(2, 220, 296)], target).defaultPrevented,
    ).toBe(true);
    touch("touchmove", [point(1, 140, 230), point(2, 220, 255)], target);
    touch("touchend", [point(2, 220, 255)], target);
    expect(touch("touchmove", [point(2, 220, 245)], target).defaultPrevented).toBe(true);
    touch("touchend", [], target);
    await Promise.resolve();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("allows native scrolling and pinch before an upward gesture is claimed", () => {
    const { getByTestId } = render(<Harness onOpen={vi.fn()} />);
    const target = getByTestId("canvas");
    const scroll = vi.fn();
    target.addEventListener("touchmove", scroll);
    touch("touchstart", [start[0]], target);
    expect(touch("touchmove", [up[0]], target).defaultPrevented).toBe(false);
    touch("touchend", [], target);
    touch("touchstart", start, target);
    expect(
      touch("touchmove", [point(1, 90, 300), point(2, 270, 300)], target).defaultPrevented,
    ).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("opens from the canvas after both fingers lift, even when touchend is consumed by a terminal", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const target = getByTestId("canvas");
    const consume = (event: Event) => event.stopPropagation();
    document.addEventListener("touchend", consume);
    try {
      touch("touchstart", [start[0]], target);
      touch("touchstart", start, target);
      expect(touch("touchmove", up, target).defaultPrevented).toBe(true);
      touch("touchend", [up[1]], target);
      await Promise.resolve();
      expect(onOpen).not.toHaveBeenCalled();
      touch("touchend", [], target);
      await Promise.resolve();
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("touchend", consume);
    }
  });

  it.each([
    ["one finger", [start[0]], [up[0]]],
    ["horizontal", start, [point(1, 60, 302), point(2, 140, 302)]],
    ["downward", start, [point(1, 140, 380), point(2, 220, 380)]],
    ["short", start, [point(1, 140, 275), point(2, 220, 275)]],
    ["pinch", start, [point(1, 90, 220), point(2, 270, 220)]],
    ["one stationary finger", start, [up[0], start[1]]],
    ["three fingers", [...start, point(3, 260, 300)], [...up, point(3, 262, 220)]],
  ])("does not open for %s", async (_label, initial, moved) => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    touch("touchstart", initial);
    touch("touchmove", moved);
    touch("touchend", []);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(["controls", "dialog", "input"])("leaves %s interactions alone", async (name) => {
    const onOpen = vi.fn();
    const { getByTestId, getByRole } = render(<Harness onOpen={onOpen} />);
    const target = name === "input" ? getByRole("textbox") : getByTestId(name);
    touch("touchstart", start, target);
    expect(touch("touchmove", up, target).defaultPrevented).toBe(false);
    touch("touchend", [], target);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cancels pinch sequences even if the fingers later travel upward together", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    touch("touchstart", start);
    touch("touchmove", [point(1, 90, 300), point(2, 270, 300)]);
    touch("touchmove", up);
    touch("touchend", []);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(["touchcancel", "third finger"])("abandons a qualified gesture on %s", async (reason) => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    touch("touchstart", start);
    touch("touchmove", up);
    if (reason === "touchcancel") touch("touchcancel", []);
    else touch("touchstart", [...up, point(3, 260, 220)]);
    touch("touchend", []);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("preserves selected text and removes listeners when disabled", async () => {
    const onOpen = vi.fn();
    const { getByTestId, rerender } = render(<Harness onOpen={onOpen} />);
    const target = getByTestId("canvas");
    window.getSelection()?.selectAllChildren(target);
    touch("touchstart", start, target);
    expect(touch("touchmove", up, target).defaultPrevented).toBe(false);
    touch("touchend", [], target);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    rerender(<Harness onOpen={onOpen} enabled={false} />);
    touch("touchstart", start, target);
    expect(touch("touchmove", up, target).defaultPrevented).toBe(false);
    touch("touchend", [], target);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
