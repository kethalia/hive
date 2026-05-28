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

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function installObserverMocks() {
  class IntersectionObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn(() => []);
  }

  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }

  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  setViewport(375, 812);
  installMatchMedia();
  installObserverMocks();
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
  it("renders connected carousel pages with key controls first and dots underneath", () => {
    render(<MobileTerminalControls />);

    const controls = screen.getByRole("region", { name: "Terminal mobile controls" });
    expect(controls).toHaveClass("shrink-0", "border-t", "px-2", "pb-0");
    expect(controls).toHaveAttribute("data-sidebar-gesture-ignore", "true");
    expect(controls).not.toHaveClass("fixed", "absolute", "rounded-2xl");
    expect(controls.className).not.toContain("0_-12px_32px");

    const carousel = screen.getByRole("region", { name: "Terminal controls carousel" });
    expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
    expect(carousel).toHaveAttribute("data-sidebar-gesture-ignore", "true");
    expect(carousel).toHaveClass("mt-0");
    expect(
      Array.from(carousel.querySelectorAll("[data-slot='carousel-item']")).map((item) =>
        item.getAttribute("aria-label"),
      ),
    ).toEqual(["Key controls", "Navigation controls", "Compose controls", "Font size controls"]);

    const quickActions = within(carousel).getByRole("group", { name: "Terminal quick actions" });
    expect(quickActions).toHaveClass("grid", "w-full", "grid-cols-3", "rounded-none");
    expect(quickActions).not.toHaveClass("gap-1");
    expect(within(quickActions).getByRole("button", { name: "Enter" })).toHaveClass(
      "min-h-12",
      "min-w-0",
    );
    expect(within(quickActions).getByRole("button", { name: "Tab" })).toBeInTheDocument();
    expect(within(quickActions).getByRole("button", { name: "Ctrl+C" })).toBeInTheDocument();
    expect(within(quickActions).queryByRole("button", { name: "More" })).not.toBeInTheDocument();

    const navigationControls = within(carousel).getByRole("group", {
      name: "Terminal navigation keys",
    });
    expect(navigationControls).toHaveClass("grid", "w-full", "grid-cols-5", "rounded-none");
    expect(within(navigationControls).getByRole("button", { name: "Up" })).toHaveClass(
      "min-h-12",
      "min-w-0",
    );

    const composeControls = within(carousel).getByRole("group", {
      name: "Terminal compose controls",
    });
    expect(composeControls).toHaveClass("w-full", "rounded-none");
    expect(within(composeControls).getByRole("button", { name: "Compose" })).toHaveClass(
      "min-h-12",
    );
    expect(
      within(carousel).getByRole("group", { name: "Terminal font size controls" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "More terminal actions" })).not.toBeInTheDocument();

    const pageDots = screen.getByLabelText("Terminal control pages");
    expect(pageDots).toHaveClass("mt-0.5", "h-4");
    expect(within(pageDots).getByRole("button", { name: "Show Keys controls" })).toHaveClass(
      "h-4",
      "w-5",
    );
    expect(within(pageDots).getByRole("button", { name: "Show Keys controls" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(pageDots).getByRole("button", { name: "Show Compose controls" }),
    ).not.toHaveAttribute("aria-current");
    expect(Array.from(controls.children)).toEqual([carousel, pageDots]);
  });

  it("sends sequences from the first carousel page", () => {
    render(<MobileTerminalControls />);
    const carousel = screen.getByRole("region", { name: "Terminal controls carousel" });
    const quickActions = within(carousel).getByRole("group", { name: "Terminal quick actions" });

    fireEvent.click(within(quickActions).getByRole("button", { name: "Enter" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Tab" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Ctrl+C" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("uses Apple-style dots to page secondary controls", () => {
    const onHapticFeedback = vi.fn();
    render(<MobileTerminalControls onHapticFeedback={onHapticFeedback} />);
    const pageDots = screen.getByLabelText("Terminal control pages");
    const keys = within(pageDots).getByRole("button", { name: "Show Keys controls" });
    const compose = within(pageDots).getByRole("button", { name: "Show Compose controls" });
    const navigation = within(pageDots).getByRole("button", { name: "Show Navigation controls" });
    const fontSize = within(pageDots).getByRole("button", { name: "Show Font size controls" });

    expect(keys).toHaveAttribute("aria-current", "page");
    fireEvent.click(navigation);
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(navigation).toHaveAttribute("aria-current", "page");
    expect(keys).not.toHaveAttribute("aria-current");

    fireEvent.click(fontSize);
    expect(onHapticFeedback).toHaveBeenCalledTimes(2);
    expect(fontSize).toHaveAttribute("aria-current", "page");

    fireEvent.click(compose);
    expect(onHapticFeedback).toHaveBeenCalledTimes(3);
    expect(compose).toHaveAttribute("aria-current", "page");
  });

  it("dispatches the compose event from the compose page", () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
    render(<MobileTerminalControls />);

    fireEvent.click(screen.getByRole("button", { name: "Compose" }));

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
  });

  it("sends arrow key and Esc sequences from the navigation page", () => {
    render(<MobileTerminalControls />);
    const navigation = screen.getByRole("group", { name: "Terminal navigation keys" });

    fireEvent.click(within(navigation).getByRole("button", { name: "Up" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");
    fireEvent.click(within(navigation).getByRole("button", { name: "Down" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[B");
    fireEvent.click(within(navigation).getByRole("button", { name: "Right" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[C");
    fireEvent.click(within(navigation).getByRole("button", { name: "Left" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[D");
    fireEvent.click(within(navigation).getByRole("button", { name: "Esc" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
  });

  it("mobile font stepper is reachable inside the font page", () => {
    render(<MobileTerminalControls />);

    const fontControls = screen.getByRole("group", { name: "Terminal font size controls" });
    const decrease = within(fontControls).getByRole("button", { name: "Decrease font size" });
    const increase = within(fontControls).getByRole("button", { name: "Increase font size" });

    expect(decrease).toHaveClass("min-h-12", "min-w-0");
    expect(screen.getByText("12px")).toHaveClass("min-h-12");
    expect(increase).toHaveClass("min-h-12", "min-w-0");
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
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();

    cleanup();
    installMatchMedia();
    installObserverMocks();
    mockUseTerminalFontStep.mockReturnValue({
      size: 28,
      increase: mockIncreaseFontSize,
      decrease: mockDecreaseFontSize,
      canIncrease: false,
      canDecrease: true,
    });
    render(<MobileTerminalControls />);
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeDisabled();
  });

  it("calls onHapticFeedback for quick keys, page dots and secondary actions", () => {
    const onHapticFeedback = vi.fn();
    render(<MobileTerminalControls onHapticFeedback={onHapticFeedback} />);

    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\r");

    fireEvent.click(screen.getByRole("button", { name: "Show Navigation controls" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(onHapticFeedback).toHaveBeenCalledTimes(3);
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");
  });

  it("keeps secondary controls in flow when interacting outside the carousel", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <MobileTerminalControls />
      </div>,
    );

    expect(screen.getByRole("region", { name: "Terminal controls carousel" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.getByRole("region", { name: "Terminal controls carousel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("prevents pointer focus changes on controls so the terminal keyboard stays open", () => {
    render(<MobileTerminalControls />);
    const enter = screen.getByRole("button", { name: "Enter" });
    const dot = screen.getByRole("button", { name: "Show Navigation controls" });
    const pointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    const dotPointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });

    fireEvent(enter, pointerEvent);
    fireEvent(dot, dotPointerEvent);

    expect(pointerEvent.defaultPrevented).toBe(true);
    expect(dotPointerEvent.defaultPrevented).toBe(true);
  });
});
