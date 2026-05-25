// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mockUseSidebar = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: mockUseSidebar,
}));

import { SidebarEdgeHandle } from "@/components/sidebar-edge-handle";

type SidebarState = {
  isMobile: boolean;
  openMobile: boolean;
  setOpenMobile: ReturnType<typeof vi.fn>;
};

let sidebarState: SidebarState;
let originalPointerEvent: typeof window.PointerEvent | undefined;
const originalSetPointerCapture = Element.prototype.setPointerCapture;
const originalReleasePointerCapture = Element.prototype.releasePointerCapture;
const originalHasPointerCapture = Element.prototype.hasPointerCapture;

function renderHandle(overrides: Partial<SidebarState> = {}) {
  sidebarState = {
    isMobile: true,
    openMobile: false,
    setOpenMobile: vi.fn(),
    ...overrides,
  };
  mockUseSidebar.mockReturnValue(sidebarState);
  return render(<SidebarEdgeHandle />);
}

function dragHandle(
  element: HTMLElement,
  {
    start = [16, 200],
    move,
    end = move,
  }: {
    start?: [number, number];
    move: [number, number];
    end?: [number, number];
  },
) {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: start[0],
    clientY: start[1],
    cancelable: true,
  });
  fireEvent.pointerMove(element, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: move[0],
    clientY: move[1],
    cancelable: true,
  });
  fireEvent.pointerUp(element, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 0,
    clientX: end[0],
    clientY: end[1],
    cancelable: true,
  });
}

beforeAll(() => {
  originalPointerEvent = window.PointerEvent;
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => true);
  }
});

afterAll(() => {
  window.PointerEvent = originalPointerEvent as typeof PointerEvent;
  Element.prototype.setPointerCapture = originalSetPointerCapture;
  Element.prototype.releasePointerCapture = originalReleasePointerCapture;
  Element.prototype.hasPointerCapture = originalHasPointerCapture;
});

beforeEach(() => {
  mockUseSidebar.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SidebarEdgeHandle", () => {
  it("hides on desktop", () => {
    renderHandle({ isMobile: false });

    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
  });

  it("hides when the mobile drawer is already open", () => {
    renderHandle({ openMobile: true });

    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
  });

  it("exposes an accessible mobile button with a touch-safe gesture surface", () => {
    renderHandle();

    const handle = screen.getByRole("button", { name: "Open sidebar" });
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("type", "button");
    expect(handle).toHaveClass("h-16");
    expect(handle).toHaveClass("w-11");
    expect(handle).toHaveStyle({ touchAction: "pan-y", userSelect: "none" });
    expect(handle.className).toContain("motion-reduce:transition-none");
    expect(handle.className).toContain("motion-reduce:active:scale-100");
    expect(handle.querySelector("[aria-hidden='true']")).toBeInTheDocument();
  });

  it("opens on click as a keyboard and tap fallback", () => {
    renderHandle();

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));

    expect(sidebarState.setOpenMobile).toHaveBeenCalledTimes(1);
    expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
  });

  it("opens on a rightward horizontal drag beyond the swipe threshold", async () => {
    renderHandle();
    const handle = screen.getByRole("button", { name: "Open sidebar" });

    dragHandle(handle, { move: [54, 204] });

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("ignores mostly vertical movement", () => {
    renderHandle();
    const handle = screen.getByRole("button", { name: "Open sidebar" });

    dragHandle(handle, { move: [26, 260] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("ignores leftward horizontal movement", () => {
    renderHandle();
    const handle = screen.getByRole("button", { name: "Open sidebar" });

    dragHandle(handle, { start: [54, 200], move: [12, 204] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });
});
