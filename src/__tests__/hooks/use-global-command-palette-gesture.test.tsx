// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGlobalCommandPaletteGesture } from "@/hooks/useGlobalCommandPaletteGesture";

function GestureHarness({ enabled = true, onOpen }: { enabled?: boolean; onOpen: () => void }) {
  useGlobalCommandPaletteGesture({ enabled, onOpen });
  return (
    <main data-testid="content">
      Content
      <div data-testid="pane-header" data-window-drag-surface="true">
        Pane header
      </div>
      <div data-sidebar-gesture-ignore="true" data-testid="terminal-controls">
        Terminal controls
      </div>
      <div data-mobile-scroll-allow="true" data-testid="workspace-tabs">
        Workspace tabs
      </div>
      <div role="dialog" aria-label="Pane actions">
        <button type="button">Modal action</button>
      </div>
    </main>
  );
}

function touch(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY };
}

function dispatchTouch(
  type: "touchstart" | "touchmove" | "touchend",
  touches: ReturnType<typeof touch>[],
  target: EventTarget = window,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
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

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens from anywhere after leftward intent is clear", async () => {
    const onOpen = vi.fn();
    render(<GestureHarness onOpen={onOpen} />);

    const start = dispatchTouch("touchstart", [touch(1, 300, 200)]);
    const move = dispatchTouch("touchmove", [touch(1, 220, 204)]);
    dispatchTouch("touchend", []);
    await Promise.resolve();

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens before xterm-style document touch-end consumption", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<GestureHarness onOpen={onOpen} />);
    const content = getByTestId("content");
    const consumeTouchEnd = (event: Event) => event.stopPropagation();
    document.addEventListener("touchend", consumeTouchEnd);

    try {
      dispatchTouch("touchstart", [touch(1, 300, 200)], content);
      dispatchTouch("touchmove", [touch(1, 220, 204)], content);
      dispatchTouch("touchend", [], content);
      await Promise.resolve();

      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("touchend", consumeTouchEnd);
    }
  });

  it("reserves pane headers for window dragging", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<GestureHarness onOpen={onOpen} />);
    const header = getByTestId("pane-header");

    dispatchTouch("touchstart", [touch(1, 300, 40)], header);
    dispatchTouch("touchmove", [touch(1, 220, 44)], header);
    dispatchTouch("touchend", [], header);
    await Promise.resolve();

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reserves terminal control swipes for the controls carousel", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<GestureHarness onOpen={onOpen} />);
    const controls = getByTestId("terminal-controls");

    const start = dispatchTouch("touchstart", [touch(1, 300, 700)], controls);
    const move = dispatchTouch("touchmove", [touch(1, 220, 704)], controls);
    dispatchTouch("touchend", [], controls);
    await Promise.resolve();

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace-tabs", "horizontal scrollers"],
    ["Modal action", "modal dialogs"],
  ])("reserves %s for %s", async (targetName) => {
    const onOpen = vi.fn();
    const { getByRole, getByTestId } = render(<GestureHarness onOpen={onOpen} />);
    const target =
      targetName === "Modal action"
        ? getByRole("button", { name: targetName })
        : getByTestId(targetName);

    const start = dispatchTouch("touchstart", [touch(1, 300, 200)], target);
    const move = dispatchTouch("touchmove", [touch(1, 220, 204)], target);
    dispatchTouch("touchend", [], target);
    await Promise.resolve();

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
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
