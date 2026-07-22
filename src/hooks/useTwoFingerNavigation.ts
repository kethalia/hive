"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import {
  type HorizontalSwipeDirection,
  resolveHorizontalSwipe,
} from "@/lib/gestures/horizontal-swipe";
import { TERMINAL_MULTI_TOUCH_CLAIM_EVENT } from "@/lib/terminal/events";

export type TwoFingerNavigationSurface = "terminal" | "workspace";

interface TwoFingerNavigationOptions {
  enabled: boolean;
  onNavigate: (surface: TwoFingerNavigationSurface, direction: HorizontalSwipeDirection) => void;
  rootRef: RefObject<HTMLElement | null>;
}

function navigationSurface(
  root: HTMLElement,
  target: EventTarget | null,
): TwoFingerNavigationSurface | null {
  if (!(target instanceof Element)) return null;
  if (!root.contains(target)) return null;
  if (target.closest('[data-terminal-navigation-surface="true"]')) return "terminal";
  if (target.closest('[data-workspace-navigation-surface="true"]')) return "workspace";
  return null;
}

interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

function touchPoints(touches: TouchList): TouchPoint[] {
  return Array.from(touches, (touch) => ({
    id: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

function pointCenter(points: readonly TouchPoint[]): { x: number; y: number } | null {
  if (points.length !== 2) return null;
  return {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2,
  };
}

function terminalInputHost(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-testid="terminal-fit-host"]');
}

function claimTerminalMultiTouch(...targets: (EventTarget | null)[]) {
  const claimedHosts = new Set<Element>();
  for (const target of targets) {
    const host = terminalInputHost(target);
    if (!host || claimedHosts.has(host)) continue;
    claimedHosts.add(host);
    host.dispatchEvent(new Event(TERMINAL_MULTI_TOUCH_CLAIM_EVENT));
  }
}

interface TwoFingerGesture {
  direction: HorizontalSwipeDirection | null;
  startX: number;
  startY: number;
  surface: TwoFingerNavigationSurface;
}

type InputMode = "pointer" | "touch";

export function useTwoFingerNavigation({
  enabled,
  onNavigate,
  rootRef,
}: TwoFingerNavigationOptions) {
  const onNavigateRef = useRef(onNavigate);
  // Keep rapid consecutive gestures on the callback from the latest render.
  // A passive effect is too late when the next touch starts after the DOM
  // commits but before effects flush.
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;

    let gesture: TwoFingerGesture | null = null;
    let firstTouchSurface: TwoFingerNavigationSurface | null = null;
    let firstTouchTarget: EventTarget | null = null;
    let inputMode: InputMode | null = null;
    const activePointers = new Map<number, TouchPoint>();

    const reset = () => {
      gesture = null;
      firstTouchSurface = null;
      firstTouchTarget = null;
      inputMode = null;
      activePointers.clear();
    };

    const completeGesture = () => {
      if (!gesture) return;
      const completed = gesture;
      const completedDirection = completed.direction;
      reset();
      if (completedDirection) {
        queueMicrotask(() => onNavigateRef.current(completed.surface, completedDirection));
      }
    };

    const beginGesture = (
      points: readonly TouchPoint[],
      surface: TwoFingerNavigationSurface | null,
      target: EventTarget | null,
      event: Event,
    ) => {
      const center = pointCenter(points);
      if (!surface || !center) {
        reset();
        return;
      }

      if (surface === "terminal") {
        claimTerminalMultiTouch(firstTouchTarget, target);
      }
      gesture = { direction: null, startX: center.x, startY: center.y, surface };
      if (event.cancelable) event.preventDefault();
    };

    const updateGesture = (points: readonly TouchPoint[], event: Event) => {
      if (!gesture) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const center = pointCenter(points);
      if (!center) return;
      gesture.direction = resolveHorizontalSwipe(
        gesture.startX,
        gesture.startY,
        center.x,
        center.y,
      ).direction;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (inputMode === "pointer") return;
      inputMode = "touch";
      if (event.touches.length === 1) {
        firstTouchSurface = navigationSurface(root, event.target);
        firstTouchTarget = event.target;
        return;
      }
      if (event.touches.length !== 2) {
        if (event.touches.length > 2) reset();
        return;
      }

      beginGesture(
        touchPoints(event.touches),
        firstTouchSurface ?? navigationSurface(root, event.target),
        event.target,
        event,
      );
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (inputMode !== "touch") return;
      updateGesture(touchPoints(event.touches), event);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (inputMode !== "touch") return;
      if (event.touches.length > 0) return;
      if (gesture) completeGesture();
      else reset();
    };

    const handleTouchCancel = () => {
      if (inputMode !== "touch") return;
      if (gesture?.surface === "terminal" && gesture.direction) {
        completeGesture();
        return;
      }
      reset();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || inputMode === "touch") return;
      inputMode = "pointer";

      const surface = navigationSurface(root, event.target);
      activePointers.set(event.pointerId, {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      });

      if (activePointers.size === 1) {
        firstTouchSurface = surface;
        firstTouchTarget = event.target;
        return;
      }
      if (activePointers.size !== 2) {
        reset();
        return;
      }

      beginGesture(
        Array.from(activePointers.values()),
        firstTouchSurface ?? surface,
        event.target,
        event,
      );
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (inputMode !== "pointer" || event.pointerType !== "touch") return;
      const point = activePointers.get(event.pointerId);
      if (!point) return;
      point.x = event.clientX;
      point.y = event.clientY;
      updateGesture(Array.from(activePointers.values()), event);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (inputMode !== "pointer" || event.pointerType !== "touch") return;
      activePointers.delete(event.pointerId);
      if (gesture) {
        completeGesture();
        return;
      }
      if (activePointers.size === 0) reset();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (inputMode !== "pointer" || event.pointerType !== "touch") return;
      if (gesture?.direction) {
        completeGesture();
        return;
      }
      reset();
    };

    const handleNativeGesture = (event: Event) => {
      const surface = navigationSurface(root, event.target);
      if (!gesture && !firstTouchSurface && !surface) return;
      if (event.cancelable) event.preventDefault();
      if (gesture) event.stopPropagation();
    };

    window.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: false });
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", handlePointerEnd, { capture: true, passive: true });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true, passive: true });
    window.addEventListener("touchstart", handleTouchStart, { capture: true, passive: false });
    window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", handleTouchCancel, { capture: true, passive: true });
    window.addEventListener("gesturestart", handleNativeGesture, { capture: true, passive: false });
    window.addEventListener("gesturechange", handleNativeGesture, {
      capture: true,
      passive: false,
    });
    window.addEventListener("gestureend", handleNativeGesture, { capture: true, passive: false });

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerEnd, { capture: true });
      window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
      window.removeEventListener("touchstart", handleTouchStart, { capture: true });
      window.removeEventListener("touchmove", handleTouchMove, { capture: true });
      window.removeEventListener("touchend", handleTouchEnd, { capture: true });
      window.removeEventListener("touchcancel", handleTouchCancel, { capture: true });
      window.removeEventListener("gesturestart", handleNativeGesture, { capture: true });
      window.removeEventListener("gesturechange", handleNativeGesture, { capture: true });
      window.removeEventListener("gestureend", handleNativeGesture, { capture: true });
    };
  }, [enabled, rootRef]);
}
