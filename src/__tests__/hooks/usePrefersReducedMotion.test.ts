// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREFERS_REDUCED_MOTION_QUERY,
  usePrefersReducedMotion,
} from "@/hooks/usePrefersReducedMotion";

type Listener = () => void;

interface StubMediaQueryList extends Partial<MediaQueryList> {
  dispatch: (matches?: boolean) => void;
  listeners: Set<Listener>;
}

function installMatchMedia(
  matches: boolean,
  options: { legacy?: boolean } = {},
): StubMediaQueryList {
  const listeners = new Set<Listener>();
  let currentMatches = matches;
  const stub: StubMediaQueryList = {
    get matches() {
      return currentMatches;
    },
    media: PREFERS_REDUCED_MOTION_QUERY,
    onchange: null,
    listeners,
    addListener: vi.fn((cb: Listener) => listeners.add(cb)),
    removeListener: vi.fn((cb: Listener) => listeners.delete(cb)),
    dispatch: (nextMatches = currentMatches) => {
      currentMatches = nextMatches;
      for (const cb of listeners) cb();
    },
    dispatchEvent: vi.fn(),
  };

  if (!options.legacy) {
    stub.addEventListener = vi.fn((_type: string, cb: Listener) => listeners.add(cb));
    stub.removeEventListener = vi.fn((_type: string, cb: Listener) => listeners.delete(cb));
  }

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
  clearMatchMedia();
  vi.restoreAllMocks();
});

describe("usePrefersReducedMotion", () => {
  it("defaults to false without matchMedia and does not throw", () => {
    clearMatchMedia();

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it("reads an initial reduced-motion preference", async () => {
    installMatchMedia(true);

    const { result } = renderHook(() => usePrefersReducedMotion());

    await waitFor(() => expect(result.current).toBe(true));
    expect(window.matchMedia).toHaveBeenCalledWith(PREFERS_REDUCED_MOTION_QUERY);
  });

  it("updates when the modern change listener fires and cleans up on unmount", async () => {
    const mediaQuery = installMatchMedia(false);

    const { result, unmount } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
    expect(mediaQuery.listeners.size).toBe(1);

    act(() => mediaQuery.dispatch(true));
    expect(result.current).toBe(true);

    unmount();
    expect(mediaQuery.listeners.size).toBe(0);
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("falls back to legacy addListener/removeListener and cleans up", () => {
    const mediaQuery = installMatchMedia(true, { legacy: true });

    const { result, unmount } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(true);
    expect(mediaQuery.addListener).toHaveBeenCalledWith(expect.any(Function));
    expect(mediaQuery.listeners.size).toBe(1);

    act(() => mediaQuery.dispatch(false));
    expect(result.current).toBe(false);

    unmount();
    expect(mediaQuery.listeners.size).toBe(0);
    expect(mediaQuery.removeListener).toHaveBeenCalledWith(expect.any(Function));
  });
});
