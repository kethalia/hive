// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { PULL_REFRESH_TRIGGER_PX } from "@/lib/gestures/conventions";

let originalPointerEvent: typeof window.PointerEvent | undefined;
const originalSetPointerCapture = Element.prototype.setPointerCapture;
const originalReleasePointerCapture = Element.prototype.releasePointerCapture;
const originalHasPointerCapture = Element.prototype.hasPointerCapture;

function renderPullToRefresh({
  onRefresh = vi.fn(),
  disabled = false,
}: {
  onRefresh?: () => void | Promise<void>;
  disabled?: boolean;
} = {}) {
  return render(
    <PullToRefresh onRefresh={onRefresh} disabled={disabled}>
      <ul data-testid="list">
        <li>Alpha task</li>
      </ul>
    </PullToRefresh>,
  );
}

function pointerDown(target: HTMLElement, { x = 20, y = 10 } = {}) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function pointerMove(target: HTMLElement, { x = 20, y }: { x?: number; y: number }) {
  fireEvent.pointerMove(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function pointerUp(target: HTMLElement, { x = 20, y }: { x?: number; y: number }) {
  fireEvent.pointerUp(target, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    buttons: 0,
    clientX: x,
    clientY: y,
    cancelable: true,
  });
}

function dragPull(target: HTMLElement, moveY: number, moveX = 20) {
  pointerDown(target);
  pointerMove(target, { x: moveX, y: 10 + moveY });
  pointerUp(target, { x: moveX, y: 10 + moveY });
}

beforeAll(() => {
  originalPointerEvent = window.PointerEvent;
  if (!window.PointerEvent) {
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => true);
  }
});

afterAll(() => {
  window.PointerEvent = originalPointerEvent as typeof PointerEvent;
  Element.prototype.setPointerCapture = originalSetPointerCapture;
  Element.prototype.releasePointerCapture = originalReleasePointerCapture;
  Element.prototype.hasPointerCapture = originalHasPointerCapture;
});

afterEach(() => {
  cleanup();
});

describe("PullToRefresh", () => {
  it("renders children with DOM diagnostics and contained overscroll", () => {
    renderPullToRefresh();

    const surface = screen.getByTestId("pull-to-refresh");
    expect(surface).toHaveAttribute("data-pull-state", "idle");
    expect(surface).toHaveStyle({ overscrollBehavior: "contain" });
    expect(screen.getByRole("status")).toHaveTextContent("Pull down to refresh");
    expect(screen.getByTestId("list")).toHaveTextContent("Alpha task");
  });

  it("moves through ready, calls onRefresh once, and resets after refresh resolves", async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const onRefresh = vi.fn(() => refreshPromise);
    renderPullToRefresh({ onRefresh });
    const surface = screen.getByTestId("pull-to-refresh");

    pointerDown(surface);
    pointerMove(surface, { y: 10 + PULL_REFRESH_TRIGGER_PX });

    await waitFor(() => {
      expect(surface).toHaveAttribute("data-pull-state", "ready");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Release to refresh");

    pointerUp(surface, { y: 10 + PULL_REFRESH_TRIGGER_PX });

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(surface).toHaveAttribute("data-pull-state", "refreshing");
    });

    await act(async () => {
      resolveRefresh();
      await refreshPromise;
    });

    await waitFor(() => {
      expect(surface).toHaveAttribute("data-pull-state", "idle");
    });
  });

  it("does not refresh below threshold, upward, horizontal, scrolled, editable, disabled, or in-flight pulls", async () => {
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const onRefresh = vi.fn(() => refreshPromise);
    const { rerender } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <input aria-label="Filter tasks" />
      </PullToRefresh>,
    );
    const surface = screen.getByTestId("pull-to-refresh");

    dragPull(surface, PULL_REFRESH_TRIGGER_PX - 1);
    dragPull(surface, -PULL_REFRESH_TRIGGER_PX);
    dragPull(surface, PULL_REFRESH_TRIGGER_PX, PULL_REFRESH_TRIGGER_PX * 2);

    surface.scrollTop = 24;
    dragPull(surface, PULL_REFRESH_TRIGGER_PX);
    surface.scrollTop = 0;

    dragPull(screen.getByLabelText("Filter tasks"), PULL_REFRESH_TRIGGER_PX);

    expect(onRefresh).not.toHaveBeenCalled();

    rerender(
      <PullToRefresh onRefresh={onRefresh} disabled>
        <input aria-label="Filter tasks" />
      </PullToRefresh>,
    );
    const disabledSurface = screen.getByTestId("pull-to-refresh");
    expect(disabledSurface).toHaveAttribute("data-pull-state", "disabled");
    dragPull(disabledSurface, PULL_REFRESH_TRIGGER_PX);
    expect(onRefresh).not.toHaveBeenCalled();

    rerender(
      <PullToRefresh onRefresh={onRefresh}>
        <input aria-label="Filter tasks" />
      </PullToRefresh>,
    );
    const activeSurface = screen.getByTestId("pull-to-refresh");
    dragPull(activeSurface, PULL_REFRESH_TRIGGER_PX);
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(activeSurface).toHaveAttribute("data-pull-state", "refreshing");
    });

    dragPull(activeSurface, PULL_REFRESH_TRIGGER_PX);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh();
      await refreshPromise;
    });
  });

  it("resets to idle when onRefresh rejects", async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error("network failed")));
    renderPullToRefresh({ onRefresh });
    const surface = screen.getByTestId("pull-to-refresh");

    dragPull(surface, PULL_REFRESH_TRIGGER_PX);

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(surface).toHaveAttribute("data-pull-state", "idle");
    });
  });
});
