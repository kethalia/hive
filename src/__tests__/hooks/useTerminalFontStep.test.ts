// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_NAME, STORAGE_KEY } from "@/lib/terminal/font-size";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useTerminalFontStep", () => {
  it("steps up and down through the font-size ladder", () => {
    const { result } = renderHook(() => useTerminalFontStep());

    expect(result.current.size).toBe(13);
    expect(result.current.canIncrease).toBe(true);
    expect(result.current.canDecrease).toBe(true);

    act(() => result.current.increase());
    expect(result.current.size).toBe(14);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("14");

    act(() => result.current.increase());
    expect(result.current.size).toBe(16);

    act(() => result.current.decrease());
    expect(result.current.size).toBe(14);
  });

  it("clamps decreases at 8", () => {
    window.localStorage.setItem(STORAGE_KEY, "8");
    const { result } = renderHook(() => useTerminalFontStep());

    expect(result.current.size).toBe(8);
    expect(result.current.canDecrease).toBe(false);

    act(() => result.current.decrease());

    expect(result.current.size).toBe(8);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("8");
  });

  it("clamps increases at 28", () => {
    window.localStorage.setItem(STORAGE_KEY, "28");
    const { result } = renderHook(() => useTerminalFontStep());

    expect(result.current.size).toBe(28);
    expect(result.current.canIncrease).toBe(false);

    act(() => result.current.increase());

    expect(result.current.size).toBe(28);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("28");
  });

  it("dispatches the terminal font-size event when stepping", () => {
    const listener = vi.fn();
    window.addEventListener(EVENT_NAME, listener);
    const { result } = renderHook(() => useTerminalFontStep());

    act(() => result.current.increase());

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent<number>).detail).toBe(14);
    window.removeEventListener(EVENT_NAME, listener);
  });

  it("keeps multiple mounted hook instances in sync", () => {
    const first = renderHook(() => useTerminalFontStep());
    const second = renderHook(() => useTerminalFontStep());

    act(() => first.result.current.increase());

    expect(first.result.current.size).toBe(14);
    expect(second.result.current.size).toBe(14);

    act(() => second.result.current.increase());

    expect(first.result.current.size).toBe(16);
    expect(second.result.current.size).toBe(16);
  });
});
