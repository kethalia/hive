// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowSwipe } from "@/hooks/useWindowSwipe";

function Harness({
  onSwipe,
  enabled = true,
}: {
  onSwipe: (direction: string) => void;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useWindowSwipe(ref, enabled, onSwipe);
  return (
    <>
      <div ref={ref} data-mobile-scroll-allow="true">
        <div data-testid="surface">Terminal output</div>
        <div data-testid="header" data-window-drag-surface="true">
          Window title
        </div>
        <div data-testid="nested" data-mobile-scroll-allow="true">
          Nested scroll
        </div>
        <button type="button">Action</button>
      </div>
      <div data-testid="outside">Outside</div>
    </>
  );
}
const point = (clientX: number, clientY: number, identifier = 1) => ({
  identifier,
  clientX,
  clientY,
});
function touch(target: EventTarget, type: string, touches: ReturnType<typeof point>[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
  return event;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe("window swipe navigation", () => {
  it.each([
    "surface",
    "header",
  ])("navigates both ways on %s without consuming the initial tap", async (id) => {
    const onSwipe = vi.fn();
    const { getByTestId } = render(<Harness onSwipe={onSwipe} />);
    const target = getByTestId(id);
    for (const [x, direction] of [
      [80, "left"],
      [240, "right"],
    ] as const) {
      expect(touch(target, "touchstart", [point(160, 240)]).defaultPrevented).toBe(false);
      expect(touch(target, "touchmove", [point(x, 242)]).defaultPrevented).toBe(true);
      touch(target, "touchend", []);
      await Promise.resolve();
      expect(onSwipe).toHaveBeenLastCalledWith(direction);
    }
    expect(onSwipe).toHaveBeenCalledTimes(2);
  });
  it.each(["nested", "outside", "button"])("preserves %s interactions", async (id) => {
    const onSwipe = vi.fn();
    const { getByTestId, getByRole } = render(<Harness onSwipe={onSwipe} />);
    const target = id === "button" ? getByRole("button") : getByTestId(id);
    touch(target, "touchstart", [point(160, 240)]);
    expect(touch(target, "touchmove", [point(80, 242)]).defaultPrevented).toBe(false);
    touch(target, "touchend", []);
    await Promise.resolve();
    expect(onSwipe).not.toHaveBeenCalled();
  });
  it.each([
    "vertical",
    "short",
    "second finger",
    "cancel",
    "selection",
    "long press",
  ])("does not navigate after %s", async (kind) => {
    const onSwipe = vi.fn();
    const { getByTestId } = render(<Harness onSwipe={onSwipe} />);
    const target = getByTestId("surface");
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    touch(target, "touchstart", [point(160, 240)]);
    if (kind === "selection") window.getSelection()?.selectAllChildren(target);
    if (kind === "long press") now.mockReturnValue(1600);
    if (kind === "second finger")
      touch(target, "touchstart", [point(160, 240), point(220, 240, 2)]);
    if (kind === "vertical") touch(target, "touchmove", [point(162, 270)]);
    touch(target, "touchmove", [point(kind === "short" ? 140 : 80, 242)]);
    if (kind === "cancel") touch(target, "touchcancel", []);
    touch(target, "touchend", []);
    await Promise.resolve();
    expect(onSwipe).not.toHaveBeenCalled();
  });
  it("removes listeners when disabled", async () => {
    const onSwipe = vi.fn();
    const { getByTestId, rerender } = render(<Harness onSwipe={onSwipe} />);
    rerender(<Harness onSwipe={onSwipe} enabled={false} />);
    const target = getByTestId("surface");
    touch(target, "touchstart", [point(160, 240)]);
    expect(touch(target, "touchmove", [point(80, 242)]).defaultPrevented).toBe(false);
    touch(target, "touchend", []);
    await Promise.resolve();
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
