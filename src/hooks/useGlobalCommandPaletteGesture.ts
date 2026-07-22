"use client";

import { useEffect, useRef } from "react";
import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";

const OPEN_SWIPE_DISTANCE_PX = 56;
const NATIVE_HISTORY_EDGE_PX = 24;

interface GlobalCommandPaletteGestureOptions {
  enabled: boolean;
  onOpen: () => void;
}

type TouchStart = {
  id: number;
  x: number;
  y: number;
  qualified: boolean;
};

/** Opens the global command drawer with a one-finger swipe from the right edge. */
export function useGlobalCommandPaletteGesture({
  enabled,
  onOpen,
}: GlobalCommandPaletteGestureOptions) {
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    if (!enabled) return;

    let touchStart: TouchStart | null = null;

    const reset = () => {
      touchStart = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }

      const touch = event.touches[0];
      if (touch.clientX < window.innerWidth - NATIVE_HISTORY_EDGE_PX) {
        reset();
        return;
      }

      touchStart = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        qualified: false,
      };
      if (event.cancelable) event.preventDefault();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      if (!touchStart) return;

      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === touchStart?.id,
      );
      if (!touch) return;

      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      const horizontalDominates = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TAP_THRESHOLD_PX;
      if (horizontalDominates && event.cancelable) event.preventDefault();
      touchStart.qualified = dx <= -OPEN_SWIPE_DISTANCE_PX && horizontalDominates;
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const completed = touchStart;
      if (completed?.qualified && event.touches.length === 0) {
        queueMicrotask(() => onOpenRef.current());
      }
      reset();
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
  }, [enabled]);
}
