"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import {
  createTwoFingerSwipeDetector,
  type GestureTouchPoint,
  type TwoFingerSwipeDirection,
} from "@/lib/gestures/two-finger-swipe";

export type TwoFingerNavigationSurface = "terminal" | "workspace";

interface TwoFingerNavigationOptions {
  enabled: boolean;
  onNavigate: (surface: TwoFingerNavigationSurface, direction: TwoFingerSwipeDirection) => void;
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

function gestureTouchPoints(touches: TouchList): GestureTouchPoint[] {
  return Array.from(touches, (touch) => ({
    id: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

export function useTwoFingerNavigation({
  enabled,
  onNavigate,
  rootRef,
}: TwoFingerNavigationOptions) {
  const onNavigateRef = useRef(onNavigate);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;

    const detector = createTwoFingerSwipeDetector();
    let surface: TwoFingerNavigationSurface | null = null;
    let firstTouchSurface: TwoFingerNavigationSurface | null = null;

    const reset = () => {
      detector.cancel();
      surface = null;
      firstTouchSurface = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        firstTouchSurface = navigationSurface(root, event.target);
        return;
      }
      if (event.touches.length !== 2) {
        if (event.touches.length > 2) reset();
        return;
      }

      surface = firstTouchSurface ?? navigationSurface(root, event.target);
      if (!surface || !detector.start(gestureTouchPoints(event.touches))) {
        reset();
        return;
      }
      if (event.cancelable) event.preventDefault();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!surface || !detector.active) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (event.touches.length !== 2) return;
      detector.move(gestureTouchPoints(event.touches));
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!surface || !detector.active) return;
      if (event.touches.length > 0) return;
      const completedSurface = surface;
      const direction = detector.end();
      surface = null;
      firstTouchSurface = null;
      if (direction) {
        queueMicrotask(() => onNavigateRef.current(completedSurface, direction));
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { capture: true, passive: false });
    window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart, { capture: true });
      window.removeEventListener("touchmove", handleTouchMove, { capture: true });
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, [enabled, rootRef]);
}
