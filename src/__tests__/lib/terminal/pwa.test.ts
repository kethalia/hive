// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let changeHandler: (() => void) | null = null;
let matchesValue = false;

beforeEach(() => {
  changeHandler = null;
  matchesValue = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: matchesValue,
      media: query,
      addEventListener: vi.fn(
        (event: string, handler: () => void) => {
          if (event === "change") changeHandler = handler;
        },
      ),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPwaStandalone", () => {
  it("returns true when display-mode is standalone", async () => {
    matchesValue = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    const { isPwaStandalone } = await import("@/lib/terminal/pwa");
    expect(isPwaStandalone()).toBe(true);
  });

  it("returns false when not standalone", async () => {
    matchesValue = false;

    const { isPwaStandalone } = await import("@/lib/terminal/pwa");
    expect(isPwaStandalone()).toBe(false);
  });
});

describe("usePwaStandalone", () => {
  it("returns initial value based on matchMedia", async () => {
    matchesValue = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(
          (event: string, handler: () => void) => {
            if (event === "change") changeHandler = handler;
          },
        ),
        removeEventListener: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    const { usePwaStandalone } = await import("@/lib/terminal/pwa");
    const { result } = renderHook(() => usePwaStandalone());
    expect(result.current).toBe(true);
  });

  it("returns false when not standalone", async () => {
    const { usePwaStandalone } = await import("@/lib/terminal/pwa");
    const { result } = renderHook(() => usePwaStandalone());
    expect(result.current).toBe(false);
  });
});
