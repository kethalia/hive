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
const { mockPrefersReducedMotion } = vi.hoisted(() => ({
  mockPrefersReducedMotion: vi.fn(() => false),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: mockIsMobile,
}));

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: mockPrefersReducedMotion,
}));

vi.mock("@/hooks/useFabKeyboardOffset", () => ({
  useFabKeyboardOffset: vi.fn(() => ({ liftPx: 0 })),
}));

const { mockUseTerminalFontStep, mockIncreaseFontSize, mockDecreaseFontSize } = vi.hoisted(() => ({
  mockUseTerminalFontStep: vi.fn(),
  mockIncreaseFontSize: vi.fn(),
  mockDecreaseFontSize: vi.fn(),
}));

vi.mock("@/hooks/useTerminalFontStep", () => ({
  useTerminalFontStep: mockUseTerminalFontStep,
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
    onPointerCancel: vi.fn(),
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
  mockPrefersReducedMotion.mockReset();
  mockPrefersReducedMotion.mockReturnValue(false);
  mockIncreaseFontSize.mockClear();
  mockDecreaseFontSize.mockClear();
  mockUseTerminalFontStep.mockReset();
  mockUseTerminalFontStep.mockReturnValue({
    size: 12,
    increase: mockIncreaseFontSize,
    decrease: mockDecreaseFontSize,
    canIncrease: true,
    canDecrease: true,
  });
  resetFabState();
});

describe("FloatingActionButton (mobile)", () => {
  it("renders only the movable FAB in collapsed mobile state", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", { name: "Open virtual keyboard" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Quick keys" })).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Terminal font size" })).not.toBeInTheDocument();
  });

  it("exposes reduced-motion class contracts on FAB controls", () => {
    render(<FloatingActionButton />);

    const fab = screen.getByRole("button", { name: "Open virtual keyboard" });
    expect(fab.className).toContain("motion-reduce:transition-none");
    expect(fab.className).toContain("motion-reduce:active:scale-100");

    fireEvent.pointerUp(fab);
    const quickKey = screen.getByRole("menuitem", { name: "Enter" });
    expect(quickKey.className).toContain("motion-reduce:transition-none");
    expect(screen.getByRole("menuitem", { name: "Up" }).className).toContain(
      "motion-reduce:transition-none",
    );
  });

  it("does not expose the 200ms snap transition when reduced motion is preferred", () => {
    mockFabState.isSnapping = true;
    mockPrefersReducedMotion.mockReturnValue(true);

    render(<FloatingActionButton />);

    const container = screen.getByRole("button", { name: "Open virtual keyboard" }).parentElement;
    expect(container).toHaveStyle({ transition: "none" });
    expect(container?.getAttribute("style")).not.toContain("transform 200ms ease-out");
  });

  it("expanded quick keys contain Enter, Tab and Ctrl+C with >=44px targets", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    const quickSection = screen.getByLabelText("Quick keys");
    const buttons = quickSection.querySelectorAll("button");
    expect(buttons).toHaveLength(3);

    const labels = Array.from(buttons).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Enter", "Tab", "Ctrl+C"]);

    for (const b of Array.from(buttons)) {
      expect(b.className).toContain("min-h-11");
    }
  });

  it("sends sequences when expanded quick key buttons are clicked", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Enter" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
    fireEvent.click(screen.getByRole("menuitem", { name: "Tab" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ctrl+C" }));
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

    // Labeled panel with bounded placement and 3-column navigation grid.
    expect(menu.className).toContain("fixed");
    expect(menu.className).toContain(
      "max-h-[calc(100dvh-var(--safe-area-inset-top)-var(--safe-area-inset-bottom)-2rem)]",
    );
    const grids = menu.querySelectorAll(".grid-cols-3");
    expect(grids.length).toBeGreaterThanOrEqual(2);

    // Up, Down, Left, Right, Esc — all menuitems, all >=44px.
    const gridNames = ["Up", "Down", "Left", "Right", "Esc"];
    for (const name of gridNames) {
      const item = screen.getByRole("menuitem", { name });
      expect(item.className).toContain("min-h-11");
    }
  });

  it("mobile font stepper is reachable inside the expanded FAB menu", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    const fontSection = screen.getByLabelText("Terminal font size");
    const decrease = screen.getByRole("button", { name: "Decrease font size" });
    const increase = screen.getByRole("button", { name: "Increase font size" });

    expect(fontSection).toContainElement(decrease);
    expect(fontSection).toContainElement(increase);
    expect(decrease.className).toContain("h-11");
    expect(decrease.className).toContain("w-11");
    expect(increase.className).toContain("h-11");
    expect(increase.className).toContain("w-11");
    expect(screen.getByText("12px")).toBeInTheDocument();
  });

  it("expanded mobile font stepper invokes the terminal font hook", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));

    fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(mockIncreaseFontSize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Decrease font size" }));
    expect(mockDecreaseFontSize).toHaveBeenCalledTimes(1);
  });

  it("mobile expanded menu keeps the directional/modifier grid separate from the stepper", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));

    expect(screen.getByRole("menu", { name: "Virtual keys" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Decrease font size" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Increase font size" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeInTheDocument();
  });

  it("collapses on second tap", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", { name: "Open virtual keyboard" });
    fireEvent.pointerUp(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerUp(screen.getByRole("button", { name: "Close virtual keyboard" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("passes the pointerup event through so drag finalization can commit the FAB position", () => {
    render(<FloatingActionButton />);
    const fab = screen.getByRole("button", { name: "Open virtual keyboard" });

    fireEvent.pointerUp(fab, { pointerId: 7, pointerType: "touch" });

    expect(mockFabState.onPointerUp).toHaveBeenCalledWith(
      expect.objectContaining({ pointerId: 7 }),
    );
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

  it("sends Esc from navigation and Ctrl+C from quick keys", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Esc" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
    fireEvent.click(screen.getByRole("menuitem", { name: "Ctrl+C" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("increases font size from the expanded mobile stepper", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(mockIncreaseFontSize).toHaveBeenCalledTimes(1);
  });

  it("decreases font size from the expanded mobile stepper", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease font size" }));
    expect(mockDecreaseFontSize).toHaveBeenCalledTimes(1);
  });

  it("disables decrease at minimum font size", () => {
    mockUseTerminalFontStep.mockReturnValue({
      size: 10,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: true,
      canDecrease: false,
    });
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();
  });

  it("disables increase at maximum font size", () => {
    mockUseTerminalFontStep.mockReturnValue({
      size: 20,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: false,
      canDecrease: true,
    });
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
  });

  it("calls onHapticFeedback when an expanded quick key is pressed", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    onHapticFeedback.mockClear();
    fireEvent.click(screen.getByRole("menuitem", { name: "Enter" }));
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

  it("collapses when clicking outside, treating the expanded panel as inside", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <FloatingActionButton />
      </div>,
    );
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Click inside the expanded quick-key panel — should NOT collapse the menu.
    const toolbarBtn = screen.getByRole("menuitem", { name: "Enter" });
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

  it("calls onHapticFeedback when a desktop menu key is pressed", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    onHapticFeedback.mockClear();

    fireEvent.click(screen.getByRole("menuitem", { name: /Tab/ }));

    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
  });
});
