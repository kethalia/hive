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

function navigationSurface(target: EventTarget | null): TwoFingerNavigationSurface | null {
  if (!(target instanceof Element)) return null;
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

    const reset = () => {
      detector.cancel();
      surface = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        if (event.touches.length > 2) reset();
        return;
      }

      surface = navigationSurface(event.target);
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
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (event.touches.length > 0) return;
      const completedSurface = surface;
      const direction = detector.end();
      surface = null;
      if (direction) onNavigateRef.current(completedSurface, direction);
    };

    root.addEventListener("touchstart", handleTouchStart, { capture: true, passive: false });
    root.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    root.addEventListener("touchend", handleTouchEnd, { capture: true, passive: false });
    root.addEventListener("touchcancel", reset, { capture: true, passive: true });

    return () => {
      root.removeEventListener("touchstart", handleTouchStart, { capture: true });
      root.removeEventListener("touchmove", handleTouchMove, { capture: true });
      root.removeEventListener("touchend", handleTouchEnd, { capture: true });
      root.removeEventListener("touchcancel", reset, { capture: true });
    };
  }, [enabled, rootRef]);
}
