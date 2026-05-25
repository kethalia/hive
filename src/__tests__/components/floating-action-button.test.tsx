// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as React from "react";

const { mockActiveSend } = vi.hoisted(() => ({ mockActiveSend: vi.fn() }));

vi.mock("@/hooks/useKeybindings", () => ({
  useKeybindings: vi.fn(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
    getAll: vi.fn(() => []),
    handleKeyEvent: vi.fn(() => false),
    activeTerminal: null,
    activeSend: mockActiveSend,
    setActiveTerminal: vi.fn(),
  })),
}));

vi.mock("@/hooks/useFabPosition", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/useFabPosition")>("@/hooks/useFabPosition");
  return {
    ...actual,
    useFabPosition: vi.fn((opts?: { onArmed?: () => void }) => {
      capturedOnArmed = opts?.onArmed;
      return mockFabState;
    }),
  };
});

let capturedOnArmed: (() => void) | undefined;

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: vi.fn(() => true) }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: mockIsMobile,
}));

vi.mock("@/hooks/useFabKeyboardOffset", () => ({
  useFabKeyboardOffset: vi.fn(() => ({ liftPx: 0 })),
}));

import { FloatingActionButton } from "@/components/terminal/FloatingActionButton";

let mockFabState: ReturnType<typeof import("@/hooks/useFabPosition").useFabPosition>;

function resetFabState() {
  const dragDist = { current: 0 };
  mockFabState = {
    corner: "bottom-right" as const,
    position: { x: 320, y: 700 },
    isDragging: false,
    isSnapping: false,
    isArmed: false,
    dragDist: dragDist as React.MutableRefObject<number>,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => false),
  };
  capturedOnArmed = undefined;
}

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", {
    value: h,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  setViewport(375, 812);
  localStorage.clear();
  mockActiveSend.mockClear();
  mockIsMobile.mockReturnValue(true);
  resetFabState();
});

describe("FloatingActionButton (mobile)", () => {
  it("renders the FAB and persistent quick-action bar in collapsed state", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", { name: "Open virtual keyboard" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    // No expanded menu, but persistent toolbar is always visible on mobile.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Quick keys" })).toBeInTheDocument();
  });

  it("persistent quick bar contains Enter, Tab and Ctrl+C with >=44px targets", () => {
    render(<FloatingActionButton />);
    const toolbar = screen.getByRole("toolbar", { name: "Quick keys" });
    const buttons = toolbar.querySelectorAll("button");
    expect(buttons).toHaveLength(3);

    const labels = Array.from(buttons).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Enter", "Tab", "Ctrl+C"]);

    for (const b of Array.from(buttons)) {
      expect(b.className).toContain("h-11");
      expect(b.className).toContain("w-11");
    }
  });

  it("sends sequences when persistent quick bar buttons are clicked", () => {
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+C" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("expands on tap and shows 2-col grid with >=44px direction/modifier keys", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));

    const menu = screen.getByRole("menu", { name: "Virtual keys" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close virtual keyboard" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Grid container with 2 columns
    const grid = menu.querySelector(".grid-cols-2");
    expect(grid).not.toBeNull();

    // Up, Down, Left, Right, Esc, Ctrl+C — all menuitems, all >=44px.
    const gridNames = ["Up", "Down", "Left", "Right", "Esc", "Ctrl+C"];
    for (const name of gridNames) {
      const item = screen.getByRole("menuitem", { name });
      expect(item.className).toContain("h-11");
      expect(item.className).toContain("w-11");
    }
  });

  it("expanded menu exposes font stepper menuitems with >=44px targets", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));

    const decrease = screen.getByRole("menuitem", { name: "Decrease font size" });
    const increase = screen.getByRole("menuitem", { name: "Increase font size" });
    expect(decrease.className).toContain("h-11");
    expect(increase.className).toContain("h-11");
  });

  it("collapses on second tap", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", { name: "Open virtual keyboard" });
    fireEvent.pointerUp(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerUp(screen.getByRole("button", { name: "Close virtual keyboard" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not expand when pointer up was a drag", () => {
    (mockFabState.onPointerUp as ReturnType<typeof vi.fn>).mockReturnValue(true);
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("sends arrow key sequences from grid", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Up" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");

    fireEvent.click(screen.getByRole("menuitem", { name: "Down" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[B");

    fireEvent.click(screen.getByRole("menuitem", { name: "Right" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[C");

    fireEvent.click(screen.getByRole("menuitem", { name: "Left" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[D");
  });

  it("sends Esc and Ctrl+C from grid", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Esc" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ctrl+C" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("increases font size when + menuitem clicked", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Increase font size" }));
    expect(localStorage.getItem("terminal:font-size")).toBe("14");
    expect(screen.getByText("14")).toBeInTheDocument();
  });

  it("decreases font size when - menuitem clicked", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Decrease font size" }));
    expect(localStorage.getItem("terminal:font-size")).toBe("12");
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("disables decrease at minimum font size", () => {
    localStorage.setItem("terminal:font-size", "10");
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.getByRole("menuitem", { name: "Decrease font size" })).toBeDisabled();
  });

  it("disables increase at maximum font size", () => {
    localStorage.setItem("terminal:font-size", "24");
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.getByRole("menuitem", { name: "Increase font size" })).toBeDisabled();
  });

  it("calls onHapticFeedback when a persistent quick-bar key is pressed", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
  });

  it("calls onHapticFeedback when a grid menuitem is pressed", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    onHapticFeedback.mockClear();
    fireEvent.click(screen.getByRole("menuitem", { name: "Up" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");
  });

  it("forwards an onArmed callback to useFabPosition that invokes onHapticFeedback", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    expect(typeof capturedOnArmed).toBe("function");
    capturedOnArmed?.();
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
  });

  it("defaults onHapticFeedback to a no-op (no throw when arming fires with no prop)", () => {
    render(<FloatingActionButton />);
    expect(typeof capturedOnArmed).toBe("function");
    expect(() => capturedOnArmed?.()).not.toThrow();
  });

  it("collapses when clicking outside, treating persistent bar as inside", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <FloatingActionButton />
      </div>,
    );
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click inside the persistent quick bar — should NOT collapse the menu.
    const toolbarBtn = screen.getByRole("button", { name: "Enter" });
    fireEvent.pointerDown(toolbarBtn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click truly outside — should collapse.
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("FloatingActionButton (desktop)", () => {
  beforeEach(() => {
    mockIsMobile.mockReturnValue(false);
    setViewport(1024, 768);
  });

  it("does not render persistent quick-action toolbar on desktop", () => {
    render(<FloatingActionButton />);
    expect(screen.queryByRole("toolbar", { name: "Quick keys" })).not.toBeInTheDocument();
  });

  it("renders legacy row-based popover when expanded on desktop", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    const menu = screen.getByRole("menu", { name: "Virtual keys" });
    expect(menu).toBeInTheDocument();
    // Desktop popover has the original Tab/Up/.../Enter list (10 menuitems).
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBe(10);
    expect(screen.getByRole("menuitem", { name: /Enter/ })).toBeInTheDocument();
  });
});
