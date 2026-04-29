// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as React from "react";

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

const mockActiveSend = vi.fn();

vi.mock("@/hooks/useFabPosition", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/useFabPosition")
  >("@/hooks/useFabPosition");
  return {
    ...actual,
    useFabPosition: vi.fn(() => mockFabState),
  };
});

import { FloatingActionButton } from "@/components/terminal/FloatingActionButton";
import { useFabPosition } from "@/hooks/useFabPosition";

let mockFabState: ReturnType<typeof import("@/hooks/useFabPosition").useFabPosition>;

function resetFabState() {
  const dragDist = { current: 0 };
  mockFabState = {
    corner: "bottom-right" as const,
    position: { x: 952, y: 696 },
    isDragging: false,
    isSnapping: false,
    dragDist: dragDist as React.MutableRefObject<number>,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => false),
  };
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
  setViewport(1024, 768);
  localStorage.clear();
  mockActiveSend.mockClear();
  resetFabState();
});

describe("FloatingActionButton", () => {
  it("renders in collapsed state by default", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", {
      name: "Open virtual keyboard",
    });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("expands on tap (pointerUp returns false = not a drag)", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", {
      name: "Open virtual keyboard",
    });
    fireEvent.pointerUp(btn);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close virtual keyboard" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses on second tap", () => {
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", {
      name: "Open virtual keyboard",
    });
    fireEvent.pointerUp(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Close virtual keyboard" }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not expand when pointer up was a drag", () => {
    (mockFabState.onPointerUp as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    render(<FloatingActionButton />);
    const btn = screen.getByRole("button", {
      name: "Open virtual keyboard",
    });
    fireEvent.pointerUp(btn);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders all virtual key buttons and send when expanded", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Open virtual keyboard" }),
    );

    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems).toHaveLength(8);

    const labels = menuItems.map((el) => el.textContent);
    expect(labels).toEqual([
      "Tab",
      "Up",
      "Down",
      "Right",
      "Left",
      "Ctrl+C",
      "Esc",
      "Send",
    ]);
  });

  it("calls activeSend with Tab sequence when Tab key pressed", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Open virtual keyboard" }),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Tab/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\t");
  });

  it("calls activeSend with Ctrl+C sequence", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Open virtual keyboard" }),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Ctrl\+C/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x03");
  });

  it("calls activeSend with Escape sequence", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Open virtual keyboard" }),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Esc/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b");
  });

  it("calls activeSend with arrow key sequences", () => {
    render(<FloatingActionButton />);
    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Open virtual keyboard" }),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Up/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[A");

    fireEvent.click(screen.getByRole("menuitem", { name: /Down/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[B");

    fireEvent.click(screen.getByRole("menuitem", { name: /Right/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[C");

    fireEvent.click(screen.getByRole("menuitem", { name: /Left/ }));
    expect(mockActiveSend).toHaveBeenCalledWith("\x1b[D");
  });

  it("collapses when clicking outside", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <FloatingActionButton />
      </div>,
    );
    fireEvent.pointerUp(
      screen.getByRole("button", { name: "Open virtual keyboard" }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
