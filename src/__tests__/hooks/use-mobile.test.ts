// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "@/hooks/use-mobile";

type Listener = () => void;

interface StubMediaQueryList extends Partial<MediaQueryList> {
  dispatch: () => void;
  listeners: Set<Listener>;
}

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function installMatchMedia(): StubMediaQueryList {
  const listeners = new Set<Listener>();
  const stub: StubMediaQueryList = {
    media: "(max-width: 1024px)",
    matches: window.innerWidth <= 1024,
    onchange: null,
    listeners,
    addEventListener: vi.fn((_type: string, cb: Listener) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: Listener) => listeners.delete(cb)),
    addListener: vi.fn((cb: Listener) => listeners.add(cb)),
    removeListener: vi.fn((cb: Listener) => listeners.delete(cb)),
    dispatch: () => {
      for (const cb of listeners) cb();
    },
    dispatchEvent: vi.fn(),
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => stub),
  });

  return stub;
}

function clearMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

describe("useIsMobile", () => {
  it.each([
    { width: 767, expected: true, label: "phone width" },
    { width: 768, expected: true, label: "tablet width" },
    { width: 1024, expected: true, label: "iPad breakpoint" },
    { width: 1025, expected: false, label: "desktop width" },
  ])("returns $expected when viewport is $label", async ({ width, expected }) => {
    setInnerWidth(width);
    installMatchMedia();

    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => expect(result.current).toBe(expected));
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 1024px)");
  });

  it("falls back to window.innerWidth when matchMedia is unavailable", async () => {
    setInnerWidth(375);
    clearMatchMedia();

    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("subscribes with the modern change listener and cleans up on unmount", async () => {
    setInnerWidth(1200);
    const mediaQuery = installMatchMedia();

    const { result, unmount } = renderHook(() => useIsMobile());

    await waitFor(() => expect(result.current).toBe(false));
    expect(mediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(mediaQuery.listeners.size).toBe(1);

    act(() => {
      setInnerWidth(900);
      mediaQuery.dispatch();
    });

    expect(result.current).toBe(true);

    unmount();

    expect(mediaQuery.listeners.size).toBe(0);
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
