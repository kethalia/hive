// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_COMPOSE_OPEN_EVENT } from "@/lib/terminal/events";

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
  it("renders a compact default row with Enter, Tab, Ctrl+C and More", () => {
    render(<FloatingActionButton />);

    const quickActions = screen.getByRole("group", { name: "Terminal quick actions" });
    expect(quickActions).toHaveClass("grid", "w-full", "grid-cols-4");
    expect(within(quickActions).getByRole("button", { name: "Enter" })).toHaveClass(
      "min-h-12",
      "min-w-0",
    );
    expect(within(quickActions).getByRole("button", { name: "Tab" })).toBeInTheDocument();
    expect(within(quickActions).getByRole("button", { name: "Ctrl+C" })).toBeInTheDocument();
    expect(within(quickActions).getByRole("button", { name: "More" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("region", { name: "More terminal actions" })).not.toBeInTheDocument();
  });

  it("renders the mobile controls in normal flow instead of a fixed draggable FAB", () => {
    render(<FloatingActionButton />);

    const container = screen.getByRole("group", { name: "Terminal quick actions" }).parentElement
      ?.parentElement;
    expect(container).toHaveClass("w-full");
    expect(container).not.toHaveClass("fixed");
    expect(container).not.toHaveClass("pb-[calc(var(--safe-area-inset-bottom)+0.5rem)]");
    expect(container).toHaveClass("pb-2");
    expect(container?.getAttribute("style")).not.toContain("translate3d");
  });

  it("exposes reduced-motion class contracts on mobile controls", () => {
    render(<FloatingActionButton />);

    const quickActions = screen.getByRole("group", { name: "Terminal quick actions" });
    const enter = within(quickActions).getByRole("button", { name: "Enter" });
    expect(enter.className).toContain("min-h-12");

    fireEvent.click(within(quickActions).getByRole("button", { name: "More" }));
    const menu = screen.getByRole("region", { name: "More terminal actions" });
    const up = within(menu).getByRole("menuitem", { name: "Up" });
    expect(up.className).toContain("min-h-11");
  });

  it("does not expose the 200ms snap transition on mobile because mobile controls are not draggable", () => {
    mockFabState.isSnapping = true;
    mockPrefersReducedMotion.mockReturnValue(true);

    render(<FloatingActionButton />);

    const container = screen.getByRole("group", { name: "Terminal quick actions" }).parentElement
      ?.parentElement;
    expect(container?.getAttribute("style")).not.toContain("transform 200ms ease-out");
  });

  it("sends sequences from the always-visible quick row", () => {
    render(<FloatingActionButton />);
    const quickActions = screen.getByRole("group", { name: "Terminal quick actions" });

    fireEvent.click(within(quickActions).getByRole("button", { name: "Enter" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Tab" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Ctrl+C" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("expands More into compose, navigation and font controls above the default row", () => {
    render(<FloatingActionButton />);
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);

    expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("region", { name: "More terminal actions" });
    expect(menu).toHaveClass("max-h-[min(42dvh,22rem)]");
    expect(within(menu).getByRole("menuitem", { name: "Compose" })).toBeInTheDocument();
    expect(
      within(menu).getByRole("group", { name: "Terminal navigation keys" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("group", { name: "Terminal font size controls" }),
    ).toBeInTheDocument();
    expect(screen.getByText("12px")).toBeInTheDocument();
  });

  it("dispatches the compose event from More actions and leaves the collapsible open", () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
    render(<FloatingActionButton />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compose" }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();
    window.removeEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
  });

  it("does not wire mobile More to the draggable desktop pointer handlers", () => {
    render(<FloatingActionButton />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(mockFabState.onPointerDown).not.toHaveBeenCalled();
    expect(mockFabState.onPointerMove).not.toHaveBeenCalled();
    expect(mockFabState.onPointerUp).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();
  });

  it("sends arrow key and Esc sequences from More actions", () => {
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("region", { name: "More terminal actions" });

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Up" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Down" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[B");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Right" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[C");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Left" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[D");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Esc" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
  });

  it("mobile font stepper is reachable inside More actions", () => {
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    const fontControls = screen.getByRole("group", { name: "Terminal font size controls" });
    const decrease = within(fontControls).getByRole("button", { name: "Decrease font size" });
    const increase = within(fontControls).getByRole("button", { name: "Increase font size" });

    expect(decrease).toHaveClass("min-h-11", "min-w-11");
    expect(increase).toHaveClass("min-h-11", "min-w-11");
    fireEvent.click(increase);
    expect(mockIncreaseFontSize).toHaveBeenCalledTimes(1);
    fireEvent.click(decrease);
    expect(mockDecreaseFontSize).toHaveBeenCalledTimes(1);
  });

  it("disables decrease at minimum font size", () => {
    mockUseTerminalFontStep.mockReturnValue({
      size: 8,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: true,
      canDecrease: false,
    });
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();
  });

  it("disables increase at maximum font size", () => {
    mockUseTerminalFontStep.mockReturnValue({
      size: 28,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: false,
      canDecrease: true,
    });
    render(<FloatingActionButton />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
  });

  it("calls onHapticFeedback when a quick key is pressed", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
  });

  it("calls onHapticFeedback when a More menuitem is pressed", () => {
    const onHapticFeedback = vi.fn();
    render(<FloatingActionButton onHapticFeedback={onHapticFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
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

  it("defaults onHapticFeedback to a no-op", () => {
    render(<FloatingActionButton />);
    expect(typeof capturedOnArmed).toBe("function");
    expect(() => capturedOnArmed?.()).not.toThrow();
  });

  it("keeps the mobile More panel open until the More toggle is clicked again", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <FloatingActionButton />
      </div>,
    );
    const more = screen.getByRole("button", { name: "More" });

    fireEvent.click(more);
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Compose" }));
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();

    fireEvent.click(more);
    expect(screen.queryByRole("region", { name: "More terminal actions" })).not.toBeInTheDocument();
  });

  it("prevents pointer focus changes on mobile controls so the terminal keyboard stays open", () => {
    render(<FloatingActionButton />);
    const more = screen.getByRole("button", { name: "More" });
    const pointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });

    fireEvent(more, pointerEvent);

    expect(pointerEvent.defaultPrevented).toBe(true);
  });
});

describe("FloatingActionButton (desktop)", () => {
  beforeEach(() => {
    mockIsMobile.mockReturnValue(false);
    setViewport(1024, 768);
  });

  it("does not render the mobile quick-action row on desktop", () => {
    render(<FloatingActionButton />);
    expect(screen.queryByRole("group", { name: "Terminal quick actions" })).not.toBeInTheDocument();
  });

  it("renders legacy row-based popover when expanded on desktop", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Open virtual keyboard" }));
    const menu = screen.getByRole("menu", { name: "Virtual keys" });
    expect(menu).toBeInTheDocument();
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
