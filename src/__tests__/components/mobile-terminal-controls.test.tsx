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

import {
  MobileTerminalControls,
  type MobileTerminalWindowNavigation,
} from "@/components/terminal/MobileTerminalControls";

function expectStackedLabelThenIcon(button: HTMLElement, label: string) {
  expect(button).toHaveClass("flex-col", "text-xs", "leading-none");
  const labelNode = within(button).getByText(label);
  expect(labelNode.tagName.toLowerCase()).toBe("span");
  expect(button.firstElementChild).toBe(labelNode);
  expect(button.lastElementChild?.tagName.toLowerCase()).toBe("svg");
}

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

function makeWindowNavigation(
  overrides: Partial<MobileTerminalWindowNavigation> = {},
): MobileTerminalWindowNavigation {
  const sessions = [{ name: "window-one" }, { name: "window-two" }, { name: "window-three" }];

  return {
    sessions,
    current: sessions[1],
    previous: sessions[0],
    next: sessions[2],
    canGoPrevious: true,
    canGoNext: true,
    loading: false,
    error: null,
    select: vi.fn(() => true),
    reload: vi.fn(),
    onOpenSwitcher: vi.fn(),
    ...overrides,
  };
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
    expect(controls).toHaveClass(
      "shrink-0",
      "border-t",
      "px-2",
      "pb-[max(1rem,var(--safe-area-inset-bottom))]",
    );
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
    ).toEqual([
      "Key controls",
      "Navigation controls",
      "Windows controls",
      "Compose controls",
      "Font size controls",
    ]);

    const quickActions = within(carousel).getByRole("group", { name: "Terminal quick actions" });
    expect(quickActions).toHaveClass("grid", "w-full", "grid-cols-4", "rounded-none");
    expect(quickActions).not.toHaveClass("gap-1");
    const enterButton = within(quickActions).getByRole("button", { name: "Enter" });
    const tabButton = within(quickActions).getByRole("button", { name: "Tab" });
    const escButton = within(quickActions).getByRole("button", { name: "Esc" });
    const ctrlCButton = within(quickActions).getByRole("button", { name: "Ctrl+C" });
    expect(enterButton).toHaveClass("min-h-14", "min-w-0");
    expectStackedLabelThenIcon(enterButton, "Enter");
    expectStackedLabelThenIcon(tabButton, "Tab");
    expectStackedLabelThenIcon(escButton, "Esc");
    expectStackedLabelThenIcon(ctrlCButton, "Ctrl+C");
    expect(within(quickActions).queryByRole("button", { name: "More" })).not.toBeInTheDocument();

    const navigationControls = within(carousel).getByRole("group", {
      name: "Terminal navigation keys",
    });
    expect(navigationControls).toHaveClass("grid", "w-full", "grid-cols-4", "rounded-none");
    const upButton = within(navigationControls).getByRole("button", { name: "Up" });
    expect(upButton).toHaveClass("min-h-14", "min-w-0");
    expectStackedLabelThenIcon(upButton, "Up");

    const windowControls = within(carousel).getByRole("group", {
      name: "Terminal window controls",
    });
    expect(windowControls).toHaveClass("grid", "w-full", "grid-cols-4", "rounded-none");
    expect(
      within(windowControls).getByRole("button", { name: "Switch to previous terminal window" }),
    ).toHaveClass("min-h-14", "min-w-0");
    expect(
      within(windowControls).getByRole("button", { name: "Open terminal window switcher" }),
    ).toHaveClass("min-h-14", "min-w-0");
    expect(
      within(windowControls).getByRole("button", { name: "Switch to next terminal window" }),
    ).toHaveClass("min-h-14", "min-w-0");
    expect(
      within(windowControls).getByRole("button", { name: "Reload terminal window list" }),
    ).toHaveClass("min-h-14", "min-w-0");
    expect(screen.getByText("Window navigation unavailable")).toBeInTheDocument();

    const composeControls = within(carousel).getByRole("group", {
      name: "Terminal compose controls",
    });
    expect(composeControls).toHaveClass("w-full", "rounded-none");
    const composeButton = within(composeControls).getByRole("button", { name: "Compose" });
    expect(composeButton).toHaveClass("min-h-14", "flex-col");
    expectStackedLabelThenIcon(composeButton, "Compose");
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
      within(pageDots).getByRole("button", { name: "Show Windows controls" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(pageDots).getByRole("button", { name: "Show Compose controls" }),
    ).not.toHaveAttribute("aria-current");
    expect(Array.from(controls.children)).toEqual([carousel, pageDots]);
  });

  it("moves controls closer to the keyboard when the keyboard is visible", () => {
    render(<MobileTerminalControls isKeyboardVisible />);

    const controls = screen.getByRole("region", { name: "Terminal mobile controls" });
    expect(controls).toHaveClass("pb-0", "flex", "flex-col");
    expect(controls).not.toHaveClass("pb-[max(1rem,var(--safe-area-inset-bottom))]");
    expect(screen.getByRole("region", { name: "Terminal controls carousel" })).toHaveClass(
      "order-2",
    );
    expect(screen.getByLabelText("Terminal control pages")).toHaveClass("order-1", "mb-1");
  });

  it("sends sequences from the first carousel page", () => {
    render(<MobileTerminalControls />);
    const carousel = screen.getByRole("region", { name: "Terminal controls carousel" });
    const quickActions = within(carousel).getByRole("group", { name: "Terminal quick actions" });

    fireEvent.click(within(quickActions).getByRole("button", { name: "Enter" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Tab" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
    fireEvent.click(within(quickActions).getByRole("button", { name: "Esc" }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
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
    const windows = within(pageDots).getByRole("button", { name: "Show Windows controls" });
    const fontSize = within(pageDots).getByRole("button", { name: "Show Font size controls" });

    expect(keys).toHaveAttribute("aria-current", "page");
    fireEvent.click(navigation);
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
    expect(navigation).toHaveAttribute("aria-current", "page");
    expect(keys).not.toHaveAttribute("aria-current");

    fireEvent.click(windows);
    expect(onHapticFeedback).toHaveBeenCalledTimes(2);
    expect(windows).toHaveAttribute("aria-current", "page");

    fireEvent.click(fontSize);
    expect(onHapticFeedback).toHaveBeenCalledTimes(3);
    expect(fontSize).toHaveAttribute("aria-current", "page");

    fireEvent.click(compose);
    expect(onHapticFeedback).toHaveBeenCalledTimes(4);
    expect(compose).toHaveAttribute("aria-current", "page");
  });

  it("renders loading window navigation as visible disabled controls with a live status", () => {
    render(
      <MobileTerminalControls
        windowNavigation={makeWindowNavigation({
          sessions: [],
          current: null,
          previous: null,
          next: null,
          canGoPrevious: false,
          canGoNext: false,
          loading: true,
        })}
      />,
    );

    const windowControls = screen.getByRole("group", { name: "Terminal window controls" });
    const previous = within(windowControls).getByRole("button", {
      name: "Switch to previous terminal window",
    });
    const switcher = within(windowControls).getByRole("button", {
      name: "Open terminal window switcher",
    });
    const next = within(windowControls).getByRole("button", {
      name: "Switch to next terminal window",
    });
    const reload = within(windowControls).getByRole("button", {
      name: "Reload terminal window list",
    });

    expect(previous).toBeDisabled();
    expect(previous).toHaveAttribute("title", "Loading terminal windows");
    expect(switcher).toBeDisabled();
    expect(switcher).toHaveAttribute("title", "Loading terminal windows");
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute("title", "Loading terminal windows");
    expect(reload).toBeDisabled();
    expect(screen.getByText("Loading terminal windows")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps one-window navigation visible but explains why previous and next are disabled", () => {
    const sessions = [{ name: "window-one" }];
    render(
      <MobileTerminalControls
        windowNavigation={makeWindowNavigation({
          sessions,
          current: sessions[0],
          previous: null,
          next: null,
          canGoPrevious: false,
          canGoNext: false,
        })}
      />,
    );

    const windowControls = screen.getByRole("group", { name: "Terminal window controls" });
    const previous = within(windowControls).getByRole("button", {
      name: "Switch to previous terminal window",
    });
    const next = within(windowControls).getByRole("button", {
      name: "Switch to next terminal window",
    });

    expect(previous).toBeDisabled();
    expect(previous).toHaveAttribute("title", "Only one terminal window is available");
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute("title", "Only one terminal window is available");
    expect(screen.getByText("Only one terminal window is available")).toBeInTheDocument();
    expect(
      within(windowControls).getByRole("button", { name: "Open terminal window switcher" }),
    ).toBeEnabled();
  });

  it("switches previous and next terminal windows and opens the switcher with haptics", () => {
    const onHapticFeedback = vi.fn();
    const windowNavigation = makeWindowNavigation();
    render(
      <MobileTerminalControls
        onHapticFeedback={onHapticFeedback}
        windowNavigation={windowNavigation}
      />,
    );

    const windowControls = screen.getByRole("group", { name: "Terminal window controls" });
    const previous = within(windowControls).getByRole("button", {
      name: "Switch to previous terminal window",
    });
    const switcher = within(windowControls).getByRole("button", {
      name: "Open terminal window switcher",
    });
    const next = within(windowControls).getByRole("button", {
      name: "Switch to next terminal window",
    });

    expect(previous).toBeEnabled();
    expect(next).toBeEnabled();
    expect(
      screen.getByText("Current terminal window: window-two. 3 windows available."),
    ).toHaveAttribute("aria-live", "polite");

    fireEvent.click(previous);
    expect(windowNavigation.select).toHaveBeenCalledWith("window-one");
    fireEvent.click(next);
    expect(windowNavigation.select).toHaveBeenCalledWith("window-three");
    fireEvent.click(switcher);
    expect(windowNavigation.onOpenSwitcher).toHaveBeenCalledTimes(1);
    expect(onHapticFeedback).toHaveBeenCalledTimes(3);
  });

  it("exposes error retry without enabling stale previous or next navigation", () => {
    const onHapticFeedback = vi.fn();
    const windowNavigation = makeWindowNavigation({
      error: "Failed to load terminal sessions",
      previous: null,
      next: null,
      canGoPrevious: false,
      canGoNext: false,
    });
    render(
      <MobileTerminalControls
        onHapticFeedback={onHapticFeedback}
        windowNavigation={windowNavigation}
      />,
    );

    const windowControls = screen.getByRole("group", { name: "Terminal window controls" });
    expect(
      within(windowControls).getByRole("button", { name: "Switch to previous terminal window" }),
    ).toBeDisabled();
    expect(
      within(windowControls).getByRole("button", { name: "Switch to next terminal window" }),
    ).toBeDisabled();
    expect(screen.getByText("Terminal window navigation error: Failed to load terminal sessions"))
      .toBeInTheDocument();

    fireEvent.click(
      within(windowControls).getByRole("button", { name: "Retry loading terminal windows" }),
    );

    expect(windowNavigation.reload).toHaveBeenCalledTimes(1);
    expect(onHapticFeedback).toHaveBeenCalledTimes(1);
  });

  it("does not throw or fire haptics when optional window callbacks are omitted", () => {
    const onHapticFeedback = vi.fn();
    const sessions = [{ name: "window-one" }, { name: "window-two" }];
    render(
      <MobileTerminalControls
        onHapticFeedback={onHapticFeedback}
        windowNavigation={{
          sessions,
          current: sessions[0],
          previous: null,
          next: sessions[1],
          canGoPrevious: false,
          canGoNext: true,
          loading: false,
          error: null,
        }}
      />,
    );

    const windowControls = screen.getByRole("group", { name: "Terminal window controls" });
    expect(
      within(windowControls).getByRole("button", { name: "Switch to next terminal window" }),
    ).toBeDisabled();
    expect(
      within(windowControls).getByRole("button", { name: "Switch to next terminal window" }),
    ).toHaveAttribute("title", "Window switching unavailable");
    expect(
      within(windowControls).getByRole("button", { name: "Open terminal window switcher" }),
    ).toBeDisabled();
    expect(
      within(windowControls).getByRole("button", { name: "Reload terminal window list" }),
    ).toBeDisabled();
    expect(onHapticFeedback).not.toHaveBeenCalled();
  });

  it("dispatches the compose event from the compose page", () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
    render(<MobileTerminalControls />);

    fireEvent.click(screen.getByRole("button", { name: "Compose" }));

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(TERMINAL_COMPOSE_OPEN_EVENT, listener);
  });

  it("sends arrow key sequences from the navigation page", () => {
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
  });

  it("mobile font stepper is reachable inside the font page", () => {
    render(<MobileTerminalControls />);

    const fontControls = screen.getByRole("group", { name: "Terminal font size controls" });
    const decrease = within(fontControls).getByRole("button", { name: "Decrease font size" });
    const increase = within(fontControls).getByRole("button", { name: "Increase font size" });

    expect(decrease).toHaveClass("min-h-14", "min-w-0", "flex-col");
    expectStackedLabelThenIcon(decrease, "Smaller");
    expect(screen.getByText("12px")).toHaveClass("min-h-14");
    expect(increase).toHaveClass("min-h-14", "min-w-0", "flex-col");
    expectStackedLabelThenIcon(increase, "Larger");
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

  it("prevents pointer and mouse focus changes on controls so the terminal keyboard stays open", () => {
    render(<MobileTerminalControls windowNavigation={makeWindowNavigation()} />);
    const enter = screen.getByRole("button", { name: "Enter" });
    const dot = screen.getByRole("button", { name: "Show Navigation controls" });
    const switcher = screen.getByRole("button", { name: "Open terminal window switcher" });
    const pointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    const dotPointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    const switcherPointerEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    const mouseEvent = new Event("mousedown", { bubbles: true, cancelable: true });
    const dotMouseEvent = new Event("mousedown", { bubbles: true, cancelable: true });
    const switcherMouseEvent = new Event("mousedown", { bubbles: true, cancelable: true });

    fireEvent(enter, pointerEvent);
    fireEvent(dot, dotPointerEvent);
    fireEvent(switcher, switcherPointerEvent);
    fireEvent(enter, mouseEvent);
    fireEvent(dot, dotMouseEvent);
    fireEvent(switcher, switcherMouseEvent);

    expect(pointerEvent.defaultPrevented).toBe(true);
    expect(dotPointerEvent.defaultPrevented).toBe(true);
    expect(switcherPointerEvent.defaultPrevented).toBe(true);
    expect(mouseEvent.defaultPrevented).toBe(true);
    expect(dotMouseEvent.defaultPrevented).toBe(true);
    expect(switcherMouseEvent.defaultPrevented).toBe(true);
  });
});
