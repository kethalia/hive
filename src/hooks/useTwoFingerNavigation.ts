"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import {
  type HorizontalSwipeDirection,
  resolveHorizontalSwipe,
} from "@/lib/gestures/horizontal-swipe";

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

function touchCenter(touches: TouchList): { x: number; y: number } | null {
  if (touches.length !== 2) return null;
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

interface TwoFingerGesture {
  direction: HorizontalSwipeDirection | null;
  startX: number;
  startY: number;
  surface: TwoFingerNavigationSurface;
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

    let gesture: TwoFingerGesture | null = null;
    let firstTouchSurface: TwoFingerNavigationSurface | null = null;

    const reset = () => {
      gesture = null;
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

      const surface = firstTouchSurface ?? navigationSurface(root, event.target);
      const center = touchCenter(event.touches);
      if (!surface || !center) {
        reset();
        return;
      }
      gesture = { direction: null, startX: center.x, startY: center.y, surface };
      if (event.cancelable) event.preventDefault();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const center = touchCenter(event.touches);
      if (!center) return;
      gesture.direction = resolveHorizontalSwipe(
        gesture.startX,
        gesture.startY,
        center.x,
        center.y,
      ).direction;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length > 0) return;
      const completed = gesture;
      const completedDirection = completed.direction;
      reset();
      if (completedDirection) {
        queueMicrotask(() => onNavigateRef.current(completed.surface, completedDirection));
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { capture: true, passive: false });
    window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", reset, { capture: true, passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart, { capture: true });
      window.removeEventListener("touchmove", handleTouchMove, { capture: true });
      window.removeEventListener("touchend", handleTouchEnd, { capture: true });
      window.removeEventListener("touchcancel", reset, { capture: true });
    };
  }, [enabled, rootRef]);
}
