"use client";

import { type RefObject, useEffect, useRef } from "react";
import { LONG_PRESS_MS, TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";
import {
  type HorizontalSwipeDirection,
  isLauncherGestureSelectionTarget,
  resolveHorizontalSwipe,
} from "@/lib/gestures/horizontal-swipe";

/** Navigate panes without consuming terminal scrollback, selection, or nested controls. */
export function useWindowSwipe(
  container: RefObject<HTMLElement | null>,
  enabled: boolean,
  onSwipe: (direction: HorizontalSwipeDirection) => void,
) {
  const callback = useRef(onSwipe);
  callback.current = onSwipe;
  useEffect(() => {
    if (!enabled) return;
    let start: {
      id: number;
      x: number;
      y: number;
      time: number;
      target: Element;
      horizontal: boolean;
      direction: HorizontalSwipeDirection | null;
    } | null = null;
    const reset = () => {
      start = null;
    };
    const touchStart = (event: TouchEvent) => {
      reset();
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element)) return;
      if (!container.current?.contains(target)) return;
      if (
        target.closest(
          'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [data-launcher-gesture-ignore="true"], [data-terminal-touch-selecting="true"]',
        )
      )
        return;
      const scroller = target.closest('[data-mobile-scroll-allow="true"]');
      if (scroller && scroller !== container.current) return;
      if (isLauncherGestureSelectionTarget(target)) return;
      const touch = event.touches[0];
      start = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        target,
        horizontal: false,
        direction: null,
      };
    };
    const touchMove = (event: TouchEvent) => {
      if (!start) return;
      if (
        event.touches.length !== 1 ||
        (!start.horizontal && Date.now() - start.time >= LONG_PRESS_MS) ||
        isLauncherGestureSelectionTarget(start.target) ||
        start.target.closest('[data-terminal-touch-selecting="true"]')
      ) {
        reset();
        return;
      }
      const touch = Array.from(event.touches).find((touch) => touch.identifier === start?.id);
      if (!touch) return reset();
      const dx = touch.clientX - start.x,
        dy = touch.clientY - start.y;
      if (!start.horizontal && Math.abs(dy) > TAP_THRESHOLD_PX && Math.abs(dy) >= Math.abs(dx)) {
        reset();
        return;
      }
      const progress = resolveHorizontalSwipe(start.x, start.y, touch.clientX, touch.clientY);
      start.horizontal ||= progress.horizontalIntent;
      start.direction = progress.direction;
      if (start.horizontal && event.cancelable) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
      const direction = start?.direction;
      reset();
      if (direction && event.touches.length === 0)
        queueMicrotask(() => callback.current(direction));
    };
    // Capture at the window so xterm's document touch-end handlers cannot swallow navigation.
    window.addEventListener("touchstart", touchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", touchMove, { capture: true, passive: false });
    window.addEventListener("touchend", touchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", reset, { capture: true, passive: true });
    return () => {
      window.removeEventListener("touchstart", touchStart, true);
      window.removeEventListener("touchmove", touchMove, true);
      window.removeEventListener("touchend", touchEnd, true);
      window.removeEventListener("touchcancel", reset, true);
    };
  }, [container, enabled]);
}
