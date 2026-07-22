// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalCommandPaletteGesture } from "@/hooks/useGlobalCommandPaletteGesture";

function GestureHarness({ enabled = true, onOpen }: { enabled?: boolean; onOpen: () => void }) {
  useGlobalCommandPaletteGesture({ enabled, onOpen });
  return <main data-testid="content">Content</main>;
}

function touch(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY };
}

function dispatchTouch(
  type: "touchstart" | "touchmove" | "touchend",
  touches: ReturnType<typeof touch>[],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  window.dispatchEvent(event);
  return event;
}

describe("useGlobalCommandPaletteGesture", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 390,
    });
  });

  afterEach(cleanup);

  it("opens after a deliberate left swipe from the right browser edge", async () => {
    const onOpen = vi.fn();
    render(<GestureHarness onOpen={onOpen} />);

    const start = dispatchTouch("touchstart", [touch(1, 388, 200)]);
    const move = dispatchTouch("touchmove", [touch(1, 310, 204)]);
    dispatchTouch("touchend", []);
    await Promise.resolve();

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("ignores swipes that do not start at the right edge", async () => {
    const onOpen = vi.fn();
    render(<GestureHarness onOpen={onOpen} />);

    dispatchTouch("touchstart", [touch(1, 300, 200)]);
    dispatchTouch("touchmove", [touch(1, 220, 204)]);
    dispatchTouch("touchend", []);
    await Promise.resolve();

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cancels when a second finger joins", async () => {
    const onOpen = vi.fn();
    render(<GestureHarness onOpen={onOpen} />);

    dispatchTouch("touchstart", [touch(1, 388, 200)]);
    dispatchTouch("touchstart", [touch(1, 388, 200), touch(2, 360, 240)]);
    dispatchTouch("touchmove", [touch(1, 300, 204), touch(2, 272, 244)]);
    dispatchTouch("touchend", []);
    await Promise.resolve();

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not bind the gesture when disabled", async () => {
    const onOpen = vi.fn();
    render(<GestureHarness enabled={false} onOpen={onOpen} />);

    const start = dispatchTouch("touchstart", [touch(1, 388, 200)]);
    dispatchTouch("touchmove", [touch(1, 300, 204)]);
    dispatchTouch("touchend", []);
    await Promise.resolve();

    expect(start.defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
