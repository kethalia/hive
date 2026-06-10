// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsComposeSheet } from "@/hooks/use-compose-sheet";
import { MOBILE_VIEWPORT_QUERY, TOUCH_TABLET_VIEWPORT_QUERY } from "@/hooks/use-mobile";

type Listener = () => void;

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function createMediaQueryList(media: string, matches: boolean): MediaQueryList {
  const listeners = new Set<Listener>();
  return {
    media,
    matches,
    onchange: null,
    addEventListener: vi.fn((_type: string, cb: Listener) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: Listener) => listeners.delete(cb)),
    addListener: vi.fn((cb: Listener) => listeners.add(cb)),
    removeListener: vi.fn((cb: Listener) => listeners.delete(cb)),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

function installMatchMedia({ coarsePointer = false }: { coarsePointer?: boolean } = {}) {
  const stubs: Record<string, MediaQueryList> = {
    [MOBILE_VIEWPORT_QUERY]: createMediaQueryList(MOBILE_VIEWPORT_QUERY, window.innerWidth <= 1024),
    [TOUCH_TABLET_VIEWPORT_QUERY]: createMediaQueryList(
      TOUCH_TABLET_VIEWPORT_QUERY,
      coarsePointer && window.innerWidth <= 1366,
    ),
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => stubs[query] ?? createMediaQueryList(query, false)),
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

describe("useIsComposeSheet", () => {
  it("uses compose sheet mode for phone widths", async () => {
    setInnerWidth(390);
    installMatchMedia();

    const { result } = renderHook(() => useIsComposeSheet());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("uses compose sheet mode for wide coarse-pointer iPads", async () => {
    setInnerWidth(1366);
    installMatchMedia({ coarsePointer: true });

    const { result } = renderHook(() => useIsComposeSheet());

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("keeps non-touch desktop widths on the desktop terminal path", async () => {
    setInnerWidth(1366);
    installMatchMedia({ coarsePointer: false });

    const { result } = renderHook(() => useIsComposeSheet());

    await waitFor(() => expect(result.current).toBe(false));
  });
});
