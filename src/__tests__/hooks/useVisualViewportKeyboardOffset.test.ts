// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";

type Listener = () => void;

interface StubVisualViewport {
  height: number;
  offsetTop: number;
  listeners: Map<string, Set<Listener>>;
  addEventListener: (type: string, cb: Listener) => void;
  removeEventListener: (type: string, cb: Listener) => void;
  dispatch: (type: string) => void;
}

function installVisualViewport(height: number, offsetTop = 0): StubVisualViewport {
  const listeners = new Map<string, Set<Listener>>();
  const stub: StubVisualViewport = {
    height,
    offsetTop,
    listeners,
    addEventListener: (type, cb) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type, cb) => {
      listeners.get(type)?.delete(cb);
    },
    dispatch: (type) => {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: stub,
  });
  return stub;
}

const ORIGINAL_INNER_HEIGHT = window.innerHeight;

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: 800,
  });
});

afterEach(() => {
  (window as unknown as { visualViewport?: unknown }).visualViewport = undefined;
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: ORIGINAL_INNER_HEIGHT,
  });
  vi.restoreAllMocks();
});

describe("useVisualViewportKeyboardOffset", () => {
  it("defaults to no keyboard when visualViewport is unavailable", () => {
    expect((window as unknown as { visualViewport?: unknown }).visualViewport).toBeUndefined();
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current).toEqual({
      liftPx: 0,
      isKeyboardVisible: false,
      visualViewportHeightPx: 0,
    });
  });

  it("returns 0 when the keyboard is closed", () => {
    installVisualViewport(800);
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current).toEqual({
      liftPx: 0,
      isKeyboardVisible: false,
      visualViewportHeightPx: 800,
    });
  });

  it("computes lift and keyboard visibility when the keyboard opens", () => {
    const vv = installVisualViewport(800);
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current.liftPx).toBe(0);

    act(() => {
      vv.height = 500;
      vv.dispatch("resize");
    });
    expect(result.current).toEqual({
      liftPx: 300,
      isKeyboardVisible: true,
      visualViewportHeightPx: 500,
    });
  });

  it("keeps keyboard visibility when visualViewport.offsetTop cancels floating lift", () => {
    installVisualViewport(500, 300);
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current).toEqual({
      liftPx: 0,
      isKeyboardVisible: true,
      visualViewportHeightPx: 500,
    });
  });

  it("returns to 0 when the keyboard closes", () => {
    const vv = installVisualViewport(500);
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current.liftPx).toBe(300);

    act(() => {
      vv.height = 800;
      vv.dispatch("resize");
    });
    expect(result.current).toEqual({
      liftPx: 0,
      isKeyboardVisible: false,
      visualViewportHeightPx: 800,
    });
  });

  it("accounts for visualViewport.offsetTop", () => {
    const vv = installVisualViewport(500, 50);
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current.liftPx).toBe(250);
    expect(result.current.isKeyboardVisible).toBe(true);

    act(() => {
      vv.offsetTop = 0;
      vv.dispatch("scroll");
    });
    expect(result.current.liftPx).toBe(300);
    expect(result.current.isKeyboardVisible).toBe(true);
  });

  it("clamps negative deltas to 0", () => {
    installVisualViewport(900);
    const { result } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(result.current).toEqual({
      liftPx: 0,
      isKeyboardVisible: false,
      visualViewportHeightPx: 900,
    });
  });

  it("removes listeners on unmount", () => {
    const vv = installVisualViewport(800);
    const { unmount } = renderHook(() => useVisualViewportKeyboardOffset());
    expect(vv.listeners.get("resize")?.size).toBe(1);
    expect(vv.listeners.get("scroll")?.size).toBe(1);
    unmount();
    expect(vv.listeners.get("resize")?.size).toBe(0);
    expect(vv.listeners.get("scroll")?.size).toBe(0);
  });
});
