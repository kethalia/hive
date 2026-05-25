// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockActiveSend, mockTriggerHapticFeedback } = vi.hoisted(() => ({
  mockActiveSend: vi.fn(),
  mockTriggerHapticFeedback: vi.fn(() => true),
}));

vi.mock("@/lib/device/haptics", () => ({
  triggerHapticFeedback: mockTriggerHapticFeedback,
}));

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

const {
  mockUseTerminalFontStep,
  mockIncreaseFontSize,
  mockDecreaseFontSize,
} = vi.hoisted(() => ({
  mockUseTerminalFontStep: vi.fn(),
  mockIncreaseFontSize: vi.fn(),
  mockDecreaseFontSize: vi.fn(),
}));

vi.mock("@/hooks/useTerminalFontStep", () => ({
  useTerminalFontStep: mockUseTerminalFontStep,
}));

import { HapticFloatingActionButton } from "@/components/terminal/HapticFloatingActionButton";

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

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockActiveSend.mockClear();
  mockTriggerHapticFeedback.mockReset();
  mockTriggerHapticFeedback.mockReturnValue(true);
  mockIsMobile.mockReturnValue(true);
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

describe("HapticFloatingActionButton", () => {
  it("is declared as a client component", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/terminal/HapticFloatingActionButton.tsx"),
      "utf8",
    );

    expect(source.startsWith('"use client";')).toBe(true);
  });

  it("is mounted by the dashboard layout instead of importing the server-unsafe FAB directly", () => {
    const source = readFileSync(join(process.cwd(), "src/app/(dashboard)/layout.tsx"), "utf8");

    expect(source).toContain(
      'import { HapticFloatingActionButton } from "@/components/terminal/HapticFloatingActionButton";',
    );
    expect(source).toContain("<HapticFloatingActionButton />");
    expect(source).not.toContain(
      'import { FloatingActionButton } from "@/components/terminal/FloatingActionButton";',
    );
  });

  it("passes a callable haptic prop into FloatingActionButton for the long-press armed seam", () => {
    render(<HapticFloatingActionButton />);

    expect(typeof capturedOnArmed).toBe("function");
    capturedOnArmed?.();

    expect(mockTriggerHapticFeedback).toHaveBeenCalledTimes(1);
  });

  it("keeps mobile virtual key presses flowing through FloatingActionButton's existing seam", () => {
    render(<HapticFloatingActionButton />);

    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    expect(mockTriggerHapticFeedback).toHaveBeenCalledTimes(1);
    expect(mockActiveSend).toHaveBeenCalledWith("\r");
  });

  it("renders without crashing in jsdom when vibration support is mocked", () => {
    render(<HapticFloatingActionButton />);

    expect(screen.getByRole("button", { name: "Open virtual keyboard" })).toBeInTheDocument();
  });
});
