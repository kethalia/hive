// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalFontStep } from "@/hooks/useTerminalFontStep";
import { EVENT_NAME, STORAGE_KEY, terminalFontSizeScope } from "@/lib/terminal/font-size";

const scope = terminalFontSizeScope("workspace-a", "main");

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
    const { result } = renderHook(() => useTerminalFontStep(scope));

    expect(result.current.size).toBe(13);
    expect(result.current.canIncrease).toBe(true);
    expect(result.current.canDecrease).toBe(true);

    act(() => result.current.increase());
    expect(result.current.size).toBe(14);
    expect(window.localStorage.getItem(scope)).toBe("14");

    act(() => result.current.increase());
    expect(result.current.size).toBe(16);

    act(() => result.current.decrease());
    expect(result.current.size).toBe(14);
  });

  it("clamps decreases at 8", () => {
    window.localStorage.setItem(STORAGE_KEY, "8");
    const { result } = renderHook(() => useTerminalFontStep(scope));

    expect(result.current.size).toBe(8);
    expect(result.current.canDecrease).toBe(false);

    act(() => result.current.decrease());

    expect(result.current.size).toBe(8);
    expect(window.localStorage.getItem(scope)).toBe("8");
  });

  it("clamps increases at 28", () => {
    window.localStorage.setItem(STORAGE_KEY, "28");
    const { result } = renderHook(() => useTerminalFontStep(scope));

    expect(result.current.size).toBe(28);
    expect(result.current.canIncrease).toBe(false);

    act(() => result.current.increase());

    expect(result.current.size).toBe(28);
    expect(window.localStorage.getItem(scope)).toBe("28");
  });

  it("dispatches the terminal font-size event when stepping", () => {
    const listener = vi.fn();
    window.addEventListener(EVENT_NAME, listener);
    const { result } = renderHook(() => useTerminalFontStep(scope));

    act(() => result.current.increase());

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ scope, size: 14 });
    window.removeEventListener(EVENT_NAME, listener);
  });

  it("keeps views of the same session in sync", () => {
    const first = renderHook(() => useTerminalFontStep(scope));
    const second = renderHook(() => useTerminalFontStep(scope));

    act(() => first.result.current.increase());

    expect(first.result.current.size).toBe(14);
    expect(second.result.current.size).toBe(14);

    act(() => second.result.current.increase());

    expect(first.result.current.size).toBe(16);
    expect(second.result.current.size).toBe(16);
  });
});

describe("session font-size isolation", () => {
  it("isolates other sessions and same-named sessions in other workspaces", () => {
    localStorage.setItem(STORAGE_KEY, "10");
    const first = renderHook(() => useTerminalFontStep(scope));
    const otherSession = renderHook(() =>
      useTerminalFontStep(terminalFontSizeScope("workspace-a", "other")),
    );
    const otherWorkspace = renderHook(() =>
      useTerminalFontStep(terminalFontSizeScope("workspace-b", "main")),
    );
    act(() => first.result.current.increase());
    expect(first.result.current.size).toBe(12);
    expect(otherSession.result.current.size).toBe(10);
    expect(otherWorkspace.result.current.size).toBe(10);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("10");
    first.unmount();
    const reopened = renderHook(() => useTerminalFontStep(scope));
    expect(reopened.result.current.size).toBe(12);
  });

  it("uses the new target immediately when switching the menu between sessions", () => {
    const other = terminalFontSizeScope("workspace-a", "other");
    localStorage.setItem(scope, "20");
    localStorage.setItem(other, "10");
    const { result, rerender } = renderHook(({ target }) => useTerminalFontStep(target), {
      initialProps: { target: scope },
    });
    rerender({ target: other });
    expect(result.current.size).toBe(10);
    act(() => result.current.increase());
    expect(result.current.size).toBe(12);
    expect(localStorage.getItem(scope)).toBe("20");
    rerender({ target: scope });
    expect(result.current.size).toBe(20);
  });

  it("continues stepping only the selected session when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const first = renderHook(() => useTerminalFontStep(scope));
    const second = renderHook(() =>
      useTerminalFontStep(terminalFontSizeScope("workspace-a", "other")),
    );
    act(() => {
      first.result.current.increase();
      first.result.current.increase();
    });
    expect(first.result.current.size).toBe(16);
    expect(second.result.current.size).toBe(13);
  });

  it("updates only the matching session when another tab changes its preference", () => {
    const first = renderHook(() => useTerminalFontStep(scope));
    const other = renderHook(() =>
      useTerminalFontStep(terminalFontSizeScope("workspace-b", "main")),
    );
    act(() => {
      localStorage.setItem(scope, "22");
      window.dispatchEvent(new StorageEvent("storage", { key: scope }));
    });
    expect(first.result.current.size).toBe(22);
    expect(other.result.current.size).toBe(13);
  });

  it("disables font changes without a selected terminal", () => {
    const { result } = renderHook(() => useTerminalFontStep(null));
    expect(result.current.canIncrease).toBe(false);
    expect(result.current.canDecrease).toBe(false);
    act(() => result.current.increase());
    expect(localStorage.length).toBe(0);
  });
});
