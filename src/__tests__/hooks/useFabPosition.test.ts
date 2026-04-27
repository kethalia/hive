// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  nearestCorner,
  cornerToPosition,
  useFabPosition,
  type Corner,
} from "@/hooks/useFabPosition";

const OFFSET = 16;
const FAB_SIZE = 56;

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", {
    value: h,
    configurable: true,
  });
}

beforeEach(() => {
  setViewport(1024, 768);
  localStorage.clear();
});

describe("cornerToPosition", () => {
  it("returns top-left offset", () => {
    const pos = cornerToPosition("top-left");
    expect(pos).toEqual({ x: OFFSET, y: OFFSET });
  });

  it("returns top-right offset", () => {
    const pos = cornerToPosition("top-right");
    expect(pos).toEqual({ x: 1024 - FAB_SIZE - OFFSET, y: OFFSET });
  });

  it("returns bottom-left offset", () => {
    const pos = cornerToPosition("bottom-left");
    expect(pos).toEqual({ x: OFFSET, y: 768 - FAB_SIZE - OFFSET });
  });

  it("returns bottom-right offset", () => {
    const pos = cornerToPosition("bottom-right");
    expect(pos).toEqual({
      x: 1024 - FAB_SIZE - OFFSET,
      y: 768 - FAB_SIZE - OFFSET,
    });
  });
});

describe("nearestCorner", () => {
  it("returns top-left for upper-left quadrant", () => {
    expect(nearestCorner(100, 100)).toBe("top-left");
  });

  it("returns top-right for upper-right quadrant", () => {
    expect(nearestCorner(900, 100)).toBe("top-right");
  });

  it("returns bottom-left for lower-left quadrant", () => {
    expect(nearestCorner(100, 600)).toBe("bottom-left");
  });

  it("returns bottom-right for lower-right quadrant", () => {
    expect(nearestCorner(900, 600)).toBe("bottom-right");
  });

  it("returns nearest corner at viewport center", () => {
    const result = nearestCorner(512, 384);
    expect(["top-left", "top-right", "bottom-left", "bottom-right"]).toContain(
      result,
    );
  });

  it("returns top-left when positioned exactly at top-left offset", () => {
    expect(nearestCorner(OFFSET, OFFSET)).toBe("top-left");
  });

  it("returns bottom-right when positioned exactly at bottom-right offset", () => {
    expect(
      nearestCorner(1024 - FAB_SIZE - OFFSET, 768 - FAB_SIZE - OFFSET),
    ).toBe("bottom-right");
  });
});

describe("useFabPosition — localStorage", () => {
  it("defaults to bottom-right when nothing stored", () => {
    const { result } = renderHook(() => useFabPosition());
    expect(result.current.corner).toBe("bottom-right");
  });

  it("reads a valid corner from localStorage", () => {
    localStorage.setItem("fab_position", "top-left");
    const { result } = renderHook(() => useFabPosition());
    expect(result.current.corner).toBe("top-left");
  });

  it("falls back to default for invalid stored value", () => {
    localStorage.setItem("fab_position", "garbage");
    const { result } = renderHook(() => useFabPosition());
    expect(result.current.corner).toBe("bottom-right");
  });

  it("falls back to default for empty string", () => {
    localStorage.setItem("fab_position", "");
    const { result } = renderHook(() => useFabPosition());
    expect(result.current.corner).toBe("bottom-right");
  });
});

describe("useFabPosition — viewport resize", () => {
  it("recalculates position on window resize", () => {
    const { result } = renderHook(() => useFabPosition());
    const initialPos = { ...result.current.position };

    act(() => {
      setViewport(800, 600);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current.position).not.toEqual(initialPos);
  });
});
