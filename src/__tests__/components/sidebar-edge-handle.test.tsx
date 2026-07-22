// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}: {
  target?: HTMLElement;
  start?: [number, number];
  move: [number, number];
}) {
  const eventTarget = target ?? window;
  touchEvent("touchstart", [touchPoint(1, start[0], start[1])], eventTarget);
  touchEvent("touchmove", [touchPoint(1, move[0], move[1])]);
  touchEvent("touchend", []);
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

  it("opens on a rightward one-finger swipe from anywhere on the page", async () => {
    renderHandle();

    swipePage({
      target: screen.getByTestId("page-content"),
      start: [180, 200],
      move: [260, 204],
    });

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("claims the operating-system edge before browser history navigation can start", async () => {
    renderHandle();

    const content = screen.getByTestId("page-content");
    const start = touchEvent("touchstart", [touchPoint(1, 4, 200)], content);
    const move = touchEvent("touchmove", [touchPoint(1, 80, 204)]);
    touchEvent("touchend", []);

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

  it("opens when a deliberate swipe starts on an interactive control", async () => {
    renderHandle();

    swipePage({
      target: screen.getByRole("button", { name: "Interactive child" }),
      move: [310, 206],
    });

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("opens when a deliberate swipe starts on an ordinary role button", async () => {
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

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
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
    touchEvent("touchend", []);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("opens before xterm-style document touch-end consumption", async () => {
    renderHandle();
    const surface = screen.getByTestId("page-content");
    const consumeTouchEnd = (event: Event) => event.stopPropagation();
    document.addEventListener("touchend", consumeTouchEnd);

    try {
      touchEvent("touchstart", [touchPoint(1, 180, 200)], surface);
      touchEvent("touchmove", [touchPoint(1, 280, 204)], surface);
      touchEvent("touchend", [], surface);

      await waitFor(() => {
        expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
      });
    } finally {
      document.removeEventListener("touchend", consumeTouchEnd);
    }
  });

  it("reserves pane headers for drag and long-press gestures", () => {
    sidebarState = {
      isMobile: true,
      openMobile: false,
      setOpenMobile: vi.fn(),
    };
    mockUseSidebar.mockReturnValue(sidebarState);

    render(
      <main data-testid="page-content">
        <div data-window-drag-surface="true" data-testid="pane-header">
          Terminal header
        </div>
        <SidebarEdgeHandle />
      </main>,
    );

    swipePage({ target: screen.getByTestId("pane-header"), start: [80, 40], move: [180, 44] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("opens from gesture-marked carousel regions after horizontal intent", async () => {
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

    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("cancels the one-finger drawer gesture as soon as a second finger joins", () => {
    renderHandle();

    const content = screen.getByTestId("page-content");
    touchEvent("touchstart", [touchPoint(1, 24, 200)], content);
    touchEvent("touchstart", [touchPoint(1, 24, 200), touchPoint(2, 64, 240)], content);
    touchEvent("touchmove", [touchPoint(1, 124, 202), touchPoint(2, 164, 242)]);
    touchEvent("touchend", []);

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("commits the drawer action only after the gesture ends with one finger", async () => {
    renderHandle();

    const content = screen.getByTestId("page-content");
    touchEvent("touchstart", [touchPoint(1, 180, 200)], content);
    touchEvent("touchmove", [touchPoint(1, 280, 202)]);
    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();

    touchEvent("touchend", []);
    await waitFor(() => {
      expect(sidebarState.setOpenMobile).toHaveBeenCalledWith(true);
    });
  });

  it("does not open when a rightward swipe is reversed before release", () => {
    renderHandle();

    const content = screen.getByTestId("page-content");
    touchEvent("touchstart", [touchPoint(1, 180, 200)], content);
    touchEvent("touchmove", [touchPoint(1, 280, 202)]);
    touchEvent("touchmove", [touchPoint(1, 190, 202)]);
    touchEvent("touchend", []);

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("does not bind the page gesture when the drawer is already open", () => {
    renderHandle({ openMobile: true });

    swipePage({ target: screen.getByTestId("page-content"), move: [310, 206] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });
});
