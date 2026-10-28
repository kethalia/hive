"use client";

import { useEffect, useRef } from "react";
import { isLauncherGestureSelectionTarget } from "@/lib/gestures/horizontal-swipe";

interface GlobalCommandPaletteGestureOptions {
  enabled: boolean;
  onOpen: () => void;
}

const SWIPE_UP_DISTANCE = 56;
const PINCH_TOLERANCE = 24;
const IGNORE_TARGET =
  'input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [data-launcher-gesture-ignore="true"], [data-terminal-touch-selecting="true"]';

/** Two fingers moving upward open search; one-finger swipes belong to windows. */
export function useGlobalCommandPaletteGesture({
  enabled,
  onOpen,
}: GlobalCommandPaletteGestureOptions) {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    let start: {
      points: { id: number; x: number; y: number }[];
      target: EventTarget | null;
      qualified: boolean;
      claimed: boolean;
      releasing: boolean;
    } | null = null;
    let cancelled = false;
    const reset = () => {
      start = null;
      cancelled = false;
    };
    const consume = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
      // Prevent xterm and nested scroll handlers from also acting on this gesture.
      event.stopPropagation();
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length > 2) cancelled = true;
      if (start?.releasing) cancelled = true;
      if (cancelled || event.touches.length !== 2) return;
      if (event.target instanceof Element && event.target.closest(IGNORE_TARGET)) return;
      if (isLauncherGestureSelectionTarget(event.target)) return;
      start = {
        points: Array.from(event.touches).map((touch) => ({
          id: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
        })),
        target: event.target,
        qualified: false,
        claimed: false,
        releasing: false,
      };
    };
    const touchMove = (event: TouchEvent) => {
      if (start?.claimed) consume(event);
      if (!start || cancelled || start.releasing) return;
      if (event.touches.length !== 2 || isLauncherGestureSelectionTarget(start.target)) {
        cancelled = true;
        return;
      }
      const points = start.points.map((point) => {
        const touch = Array.from(event.touches).find((touch) => touch.identifier === point.id);
        return touch
          ? {
              x: touch.clientX,
              y: touch.clientY,
              dx: touch.clientX - point.x,
              dy: touch.clientY - point.y,
            }
          : null;
      });
      const [a, b] = points;
      if (!a || !b) {
        cancelled = true;
        return;
      }
      const [first, second] = start.points;
      const initialDistance = Math.hypot(first.x - second.x, first.y - second.y);
      if (Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - initialDistance) > PINCH_TOLERANCE) {
        cancelled = true;
        return;
      }
      const distance = -(a.dy + b.dy) / 2;
      const upward = [a, b].every((point) => -point.dy > Math.abs(point.dx) * 1.5);
      // Claim parallel upward movement before native scrolling begins. Keep
      // pinches/horizontal movement unclaimed, and allow natural finger lag.
      if (upward && distance >= 3) {
        start.claimed = true;
        consume(event);
      }
      start.qualified =
        upward &&
        distance >= SWIPE_UP_DISTANCE &&
        [a, b].every((point) => -point.dy >= SWIPE_UP_DISTANCE / 2);
    };
    const touchEnd = (event: TouchEvent) => {
      if (start?.claimed && event.cancelable) event.preventDefault();
      if (event.touches.length > 0) {
        if (start) start.releasing = true;
        return;
      }
      const open = start?.qualified && !cancelled;
      reset();
      if (open) queueMicrotask(() => callback.current());
    };
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
  }, [enabled]);
}
