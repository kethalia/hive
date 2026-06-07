// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";

type Listener = () => void;

interface StubVisualViewport {
  height: number;
  listeners: Map<string, Set<Listener>>;
  addEventListener: (type: string, cb: Listener) => void;
  removeEventListener: (type: string, cb: Listener) => void;
  dispatch: (type: string) => void;
}

function installVisualViewport(height: number): StubVisualViewport {
  const listeners = new Map<string, Set<Listener>>();
  const stub: StubVisualViewport = {
    height,
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

afterEach(() => {
  (window as unknown as { visualViewport?: unknown }).visualViewport = undefined;
  vi.restoreAllMocks();
});

describe("useVisualViewportHeight", () => {
  it("returns height: null when visualViewport is unavailable", () => {
    expect((window as unknown as { visualViewport?: unknown }).visualViewport).toBeUndefined();
    const { result } = renderHook(() => useVisualViewportHeight());
    expect(result.current.height).toBeNull();
  });

  it("captures the initial visualViewport height when supported", () => {
    installVisualViewport(640);
    const { result } = renderHook(() => useVisualViewportHeight());
    expect(result.current.height).toBe(640);
  });

  it("updates height on visualViewport resize", () => {
    const vv = installVisualViewport(640);
    const { result } = renderHook(() => useVisualViewportHeight());

    act(() => {
      vv.height = 512;
      vv.dispatch("resize");
    });

    expect(result.current.height).toBe(512);
  });

  it("updates height on visualViewport scroll", () => {
    const vv = installVisualViewport(640);
    const { result } = renderHook(() => useVisualViewportHeight());

    act(() => {
      vv.height = 480;
      vv.dispatch("scroll");
    });

    expect(result.current.height).toBe(480);
  });

  it("does not duplicate listeners on rerender and removes both listeners on unmount", () => {
    const vv = installVisualViewport(640);
    const { rerender, unmount } = renderHook(() => useVisualViewportHeight());

    expect(vv.listeners.get("resize")?.size).toBe(1);
    expect(vv.listeners.get("scroll")?.size).toBe(1);

    rerender();

    expect(vv.listeners.get("resize")?.size).toBe(1);
    expect(vv.listeners.get("scroll")?.size).toBe(1);

    unmount();

    expect(vv.listeners.get("resize")?.size).toBe(0);
    expect(vv.listeners.get("scroll")?.size).toBe(0);
  });

  it("preserves zero-height and unusual visualViewport values without throwing", () => {
    const vv = installVisualViewport(0);
    const { result } = renderHook(() => useVisualViewportHeight());

    expect(result.current.height).toBe(0);

    act(() => {
      vv.height = 1234.5;
      vv.dispatch("resize");
    });

    expect(result.current.height).toBe(1234.5);
  });
});
