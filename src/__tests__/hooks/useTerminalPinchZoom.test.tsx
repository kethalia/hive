// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const pinchState = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  handler: undefined as ((state: Record<string, unknown>) => void) | undefined,
  bindCallCount: 0,
}));

const fontState = vi.hoisted(() => ({
  current: 14,
  setTerminalFontSize: vi.fn((size: number) => {
    fontState.current = size;
    return size;
  }),
}));

vi.mock("@use-gesture/react", () => ({
  usePinch: vi.fn((handler, config) => {
    pinchState.handler = handler;
    pinchState.config = config;

    return () => {
      pinchState.bindCallCount += 1;
      return { "data-use-pinch-bound": "true" };
    };
  }),
}));

vi.mock("@/lib/terminal/font-size", async () => {
  const actual = await vi.importActual<typeof import("@/lib/terminal/font-size")>(
    "@/lib/terminal/font-size",
  );

  return {
    ...actual,
    getTerminalFontSize: vi.fn(() => fontState.current),
    setTerminalFontSize: fontState.setTerminalFontSize,
  };
});

import { useTerminalPinchZoom } from "@/hooks/useTerminalPinchZoom";

function Harness() {
  const bindPinchZoom = useTerminalPinchZoom();
  return <div data-testid="pinch-target" {...bindPinchZoom()} />;
}

function pinchEvent(
  scale: number,
  options: { first?: boolean; last?: boolean; cancelable?: boolean } = {},
) {
  const event = {
    cancelable: options.cancelable ?? true,
    preventDefault: vi.fn(),
  };

  act(() => {
    pinchState.handler?.({
      first: options.first ?? false,
      last: options.last ?? false,
      active: !(options.last ?? false),
      offset: [scale, 0],
      event,
    });
  });

  return event;
}

describe("useTerminalPinchZoom", () => {
  beforeEach(() => {
    pinchState.config = undefined;
    pinchState.handler = undefined;
    pinchState.bindCallCount = 0;
    fontState.current = 14;
    fontState.setTerminalFontSize.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("binds a touch-only pinch gesture with passive=false and wheel pinch disabled", () => {
    render(<Harness />);

    expect(screen.getByTestId("pinch-target")).toHaveAttribute("data-use-pinch-bound", "true");
    expect(pinchState.config).toMatchObject({
      eventOptions: { passive: false },
      pointer: { touch: true },
      pinchOnWheel: false,
    });
    expect(pinchState.config?.from).toBeTypeOf("function");
    expect((pinchState.config?.from as () => [number, number])()).toEqual([1, 0]);
  });

  it("bounds pinch scale to the existing terminal font ladder around the current base size", () => {
    render(<Harness />);

    expect(pinchState.config?.scaleBounds).toBeTypeOf("function");
    const bounds = (pinchState.config?.scaleBounds as () => { min: number; max: number })();
    expect(bounds.min).toBeCloseTo(8 / 14);
    expect(bounds.max).toBeCloseTo(28 / 14);
  });

  it("dispatches font changes only when the snapped ladder value changes", () => {
    render(<Harness />);

    const firstEvent = pinchEvent(1.25, { first: true });
    pinchEvent(1.26);
    pinchEvent(0.85);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fontState.setTerminalFontSize).toHaveBeenCalledTimes(2);
    expect(fontState.setTerminalFontSize).toHaveBeenNthCalledWith(1, 18);
    expect(fontState.setTerminalFontSize).toHaveBeenNthCalledWith(2, 12);
  });

  it("does not call preventDefault for non-cancelable pinch events", () => {
    render(<Harness />);

    const event = pinchEvent(1.25, { first: true, cancelable: false });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fontState.setTerminalFontSize).toHaveBeenCalledWith(18);
  });

  it("ignores a gesture callback with no event object", () => {
    render(<Harness />);

    act(() => {
      pinchState.handler?.({ first: true, active: true, offset: [1.25, 0] });
    });

    expect(fontState.setTerminalFontSize).not.toHaveBeenCalled();
  });
});
