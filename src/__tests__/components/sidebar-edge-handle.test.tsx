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

function renderHandle(overrides: Partial<SidebarState> = {}) {
  sidebarState = {
    isMobile: true,
    openMobile: false,
    setOpenMobile: vi.fn(),
    ...overrides,
  };
  mockUseSidebar.mockReturnValue(sidebarState);
  return render(
    <div>
      <button type="button">Interactive child</button>
      <main data-testid="page-content">
        <SidebarEdgeHandle />
      </main>
    </div>,
  );
}

function swipePage({
  target,
  start = [24, 200],
  move,
  end = move,
}: {
  target?: HTMLElement;
  start?: [number, number];
  move: [number, number];
  end?: [number, number];
}) {
  const eventTarget = target ?? window;
  fireEvent.pointerDown(eventTarget, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: start[0],
    clientY: start[1],
    cancelable: true,
  });
  fireEvent.pointerMove(window, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: move[0],
    clientY: move[1],
    cancelable: true,
  });
  fireEvent.pointerUp(window, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 0,
    clientX: end[0],
    clientY: end[1],
    cancelable: true,
  });
}

function touchPoint(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY };
}

function touchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: Array<{ identifier: number; clientX: number; clientY: number }>,
  target: EventTarget = window,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: touches });
  target.dispatchEvent(event);
  return event;
}

beforeAll(() => {
  originalPointerEvent = window.PointerEvent;
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
  }
});

afterAll(() => {
  window.PointerEvent = originalPointerEvent as typeof PointerEvent;
});

beforeEach(() => {
  mockUseSidebar.mockReset();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 390,
  });
});

afterEach(() => {
  cleanup();
});

describe("SidebarEdgeHandle", () => {
  it("renders no visible edge button on desktop", () => {
    renderHandle({ isMobile: false });

    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
  });

  it("renders no visible edge button when the mobile drawer is already open", () => {
    renderHandle({ openMobile: true });

    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
  });

  it("keeps the old intrusive left-side handle out of the DOM on mobile", () => {
    renderHandle();

    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-edge-handle")).not.toBeInTheDocument();
  });

  it("opens on a rightward page swipe from content", async () => {
    renderHandle();

    swipePage({ target: screen.getByTestId("page-content"), move: [310, 206] });

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("ignores mostly vertical movement", () => {
    renderHandle();

    swipePage({ target: screen.getByTestId("page-content"), move: [40, 280] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("ignores leftward horizontal movement", () => {
    renderHandle();

    swipePage({ target: screen.getByTestId("page-content"), start: [64, 200], move: [20, 204] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("ignores broad page swipes that do not start near the left edge", () => {
    renderHandle();

    swipePage({
      target: screen.getByTestId("page-content"),
      start: [180, 200],
      move: [260, 204],
    });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("claims the operating-system edge before browser history navigation can start", async () => {
    renderHandle();

    const content = screen.getByTestId("page-content");
    const start = touchEvent("touchstart", [touchPoint(1, 4, 200)], content);
    const move = touchEvent("touchmove", [touchPoint(1, 80, 204)]);
    touchEvent("touchend", [touchPoint(1, 80, 204)]);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("does not suppress an ordinary touch inside the wider recognition band", () => {
    renderHandle();

    const start = touchEvent(
      "touchstart",
      [touchPoint(1, 40, 200)],
      screen.getByTestId("page-content"),
    );
    touchEvent("touchend", [touchPoint(1, 40, 200)]);

    expect(start.defaultPrevented).toBe(false);
    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("ignores swipes that start on interactive controls", () => {
    renderHandle();

    swipePage({
      target: screen.getByRole("button", { name: "Interactive child" }),
      move: [310, 206],
    });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("ignores swipes that start on ordinary role buttons", () => {
    sidebarState = {
      isMobile: true,
      openMobile: false,
      setOpenMobile: vi.fn(),
    };
    mockUseSidebar.mockReturnValue(sidebarState);
    const interactiveRole = "button";

    render(
      <main data-testid="page-content">
        <div role={interactiveRole} tabIndex={0} data-testid="custom-button">
          Custom action
        </div>
        <SidebarEdgeHandle />
      </main>,
    );

    swipePage({ target: screen.getByTestId("custom-button"), move: [310, 206] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("opens from multi-session terminal pane frames", async () => {
    sidebarState = {
      isMobile: true,
      openMobile: false,
      setOpenMobile: vi.fn(),
    };
    mockUseSidebar.mockReturnValue(sidebarState);
    const interactiveRole = "button";

    render(
      <main data-testid="page-content">
        <div role={interactiveRole} tabIndex={0} data-pane-mode="tiled" data-testid="terminal-pane">
          <div data-testid="terminal-surface">Terminal output</div>
        </div>
        <SidebarEdgeHandle />
      </main>,
    );

    swipePage({ target: screen.getByTestId("terminal-surface"), move: [310, 206] });

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("opens from terminal panes with capture-phase touch events for iPad Safari", async () => {
    sidebarState = {
      isMobile: true,
      openMobile: false,
      setOpenMobile: vi.fn(),
    };
    mockUseSidebar.mockReturnValue(sidebarState);
    const interactiveRole = "button";

    render(
      <main data-testid="page-content">
        <div role={interactiveRole} tabIndex={0} data-pane-mode="tiled" data-testid="terminal-pane">
          <div data-testid="terminal-surface">Terminal output</div>
        </div>
        <SidebarEdgeHandle />
      </main>,
    );

    const surface = screen.getByTestId("terminal-surface");
    const start = touchEvent("touchstart", [touchPoint(1, 24, 200)], surface);
    const move = touchEvent("touchmove", [touchPoint(1, 96, 204)]);
    touchEvent("touchend", [touchPoint(1, 96, 204)]);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("ignores swipes that start inside gesture-ignored regions such as carousels", () => {
    sidebarState = {
      isMobile: true,
      openMobile: false,
      setOpenMobile: vi.fn(),
    };
    mockUseSidebar.mockReturnValue(sidebarState);

    render(
      <main data-testid="page-content">
        <div data-sidebar-gesture-ignore="true" data-testid="carousel-region">
          Carousel
        </div>
        <SidebarEdgeHandle />
      </main>,
    );

    swipePage({ target: screen.getByTestId("carousel-region"), move: [310, 206] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("does not bind the page gesture when the drawer is already open", () => {
    renderHandle({ openMobile: true });

    swipePage({ target: screen.getByTestId("page-content"), move: [310, 206] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });
});
