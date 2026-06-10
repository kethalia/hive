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
  start = [240, 200],
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

    swipePage({ target: screen.getByTestId("page-content"), move: [256, 280] });

    expect(sidebarState.setOpenMobile).not.toHaveBeenCalled();
  });

  it("ignores leftward horizontal movement", () => {
    renderHandle();

    swipePage({ target: screen.getByTestId("page-content"), start: [300, 200], move: [230, 204] });

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
