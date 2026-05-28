// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
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

const { mockUseTerminalFontStep, mockIncreaseFontSize, mockDecreaseFontSize } = vi.hoisted(() => ({
  mockUseTerminalFontStep: vi.fn(),
  mockIncreaseFontSize: vi.fn(),
  mockDecreaseFontSize: vi.fn(),
}));

vi.mock("@/hooks/useTerminalFontStep", () => ({
  useTerminalFontStep: mockUseTerminalFontStep,
}));

import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";

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
});

describe("MobileTerminalControls", () => {
  it("renders a compact default row with Enter, Tab, Ctrl+C and More", () => {
    render(<MobileTerminalControls />);

    const controls = screen.getByRole("region", { name: "Terminal mobile controls" });
    expect(controls).toHaveClass("shrink-0", "border-t", "px-2", "pb-1");
    expect(controls).not.toHaveClass("fixed", "absolute", "rounded-2xl");
    expect(controls.className).not.toContain("0_-12px_32px");

    const quickActions = screen.getByRole("group", { name: "Terminal quick actions" });
    expect(quickActions).toHaveClass("grid", "w-full", "grid-cols-4", "gap-1");
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

  it("sends sequences from the always-visible quick row", () => {
    render(<MobileTerminalControls />);
    const quickActions = screen.getByRole("group", { name: "Terminal quick actions" });

    fireEvent.click(within(quickActions).getByRole("button", { name: "Enter" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Tab" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Ctrl+C" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("expands More into compose, navigation and font controls above the default row", () => {
    render(<MobileTerminalControls />);
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);

    expect(more).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "More terminal actions" });
    expect(panel).toHaveAttribute("data-slot", "collapsible-content");
    expect(panel).toHaveClass("overflow-hidden");
    expect(panel).not.toHaveClass("fixed", "absolute", "rounded-xl", "border");
    expect(panel.firstElementChild).toHaveClass("max-h-[min(42dvh,22rem)]", "overflow-y-auto");
    expect(within(panel).getByRole("button", { name: "Compose" })).toBeInTheDocument();
    expect(
      within(panel).getByRole("group", { name: "Terminal navigation keys" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("group", { name: "Terminal font size controls" }),
    ).toBeInTheDocument();
    expect(screen.getByText("12px")).toBeInTheDocument();
  });

  it("dispatches the compose event from More actions and leaves the collapsible open", () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
    render(<MobileTerminalControls />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Compose" }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();
    window.removeEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
  });

  it("sends arrow key and Esc sequences from More actions", () => {
    render(<MobileTerminalControls />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const panel = screen.getByRole("region", { name: "More terminal actions" });

    fireEvent.click(within(panel).getByRole("button", { name: "Up" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");
    fireEvent.click(within(panel).getByRole("button", { name: "Down" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[B");
    fireEvent.click(within(panel).getByRole("button", { name: "Right" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[C");
    fireEvent.click(within(panel).getByRole("button", { name: "Left" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[D");
    fireEvent.click(within(panel).getByRole("button", { name: "Esc" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
  });

  it("mobile font stepper is reachable inside More actions", () => {
    render(<MobileTerminalControls />);
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

  it("disables font stepper bounds", () => {
    mockUseTerminalFontStep.mockReturnValue({
      size: 8,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: true,
      canDecrease: false,
    });
    render(<MobileTerminalControls />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();

    cleanup();
    mockUseTerminalFontStep.mockReturnValue({
      size: 28,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: false,
      canDecrease: true,
    });
    render(<MobileTerminalControls />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
  });

  it("calls onHapticFeedback for quick keys, More, and expanded actions", () => {
    const onHapticFeedback = vi.fn();
    render(<MobileTerminalControls onHapticFeedback={onHapticFeedback} />);

    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\r");

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(3);
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");
  });

  it("keeps the More panel open until the More toggle is clicked again", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <MobileTerminalControls />
      </div>,
    );
    const more = screen.getByRole("button", { name: "More" });

    fireEvent.click(more);
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Compose" }));
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.getByRole("region", { name: "More terminal actions" })).toBeInTheDocument();

    fireEvent.click(more);
    expect(screen.queryByRole("region", { name: "More terminal actions" })).not.toBeInTheDocument();
  });

  it("prevents pointer focus changes on controls so the terminal keyboard stays open", () => {
    render(<MobileTerminalControls />);
    const more = screen.getByRole("button", { name: "More" });
    const pointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });

    fireEvent(more, pointerEvent);

    expect(pointerEvent.defaultPrevented).toBe(true);
  });
});
