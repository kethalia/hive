// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePwaMode } from "@/hooks/use-pwa-mode";

type Listener = (e: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean) {
  const listeners: Listener[] = [];
  const mql = {
    matches,
    media: "(display-mode: standalone)",
    onchange: null,
    addEventListener: (_: string, cb: Listener) => {
      listeners.push(cb);
    },
    removeEventListener: (_: string, cb: Listener) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return { mql, listeners };
}

afterEach(() => {
  // Reset matchMedia and navigator.standalone between tests.
  // jsdom does not provide matchMedia by default, so delete to restore that.
  (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
});

describe("usePwaMode", () => {
  it("defaults to 'browser' when matchMedia is unavailable / unmocked", () => {
    // jsdom has no matchMedia by default; ensure it is absent.
    expect((window as unknown as { matchMedia?: unknown }).matchMedia).toBeUndefined();
    const { result } = renderHook(() => usePwaMode());
    expect(result.current).toBe("browser");
  });

  it("returns 'standalone' when matchMedia('(display-mode: standalone)').matches is true", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => usePwaMode());
    expect(result.current).toBe("standalone");
  });

  it("returns 'standalone' when navigator.standalone === true (iOS) even if matchMedia is false", () => {
    installMatchMedia(false);
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
    const { result } = renderHook(() => usePwaMode());
    expect(result.current).toBe("standalone");
  });

  it("updates when the matchMedia change event fires", () => {
    const { mql, listeners } = installMatchMedia(false);
    const { result } = renderHook(() => usePwaMode());
    expect(result.current).toBe("browser");

    act(() => {
      (mql as unknown as { matches: boolean }).matches = true;
      for (const cb of listeners) {
        cb({ matches: true, media: mql.media } as MediaQueryListEvent);
      }
    });
    expect(result.current).toBe("standalone");
  });
});
