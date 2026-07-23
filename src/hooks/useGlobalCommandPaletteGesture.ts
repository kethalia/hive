"use client";

import { useEffect, useRef } from "react";
import {
  isSidebarGestureIgnoredTarget,
  resolveHorizontalSwipe,
} from "@/lib/gestures/horizontal-swipe";

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

/** Opens the global command drawer with a deliberate one-finger leftward swipe. */
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
      if (isSidebarGestureIgnoredTarget(event.target)) {
        reset();
        return;
      }
      if (touch.clientX < 0 || touch.clientX > window.innerWidth) {
        reset();
        return;
      }

      touchStart = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        qualified: false,
      };
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

      const progress = resolveHorizontalSwipe(
        touchStart.x,
        touchStart.y,
        touch.clientX,
        touch.clientY,
      );
      if (progress.horizontalIntent && event.cancelable) event.preventDefault();
      touchStart.qualified = progress.direction === "left";
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
    window.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", reset, { capture: true, passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart, { capture: true });
      window.removeEventListener("touchmove", handleTouchMove, { capture: true });
      window.removeEventListener("touchend", handleTouchEnd, { capture: true });
      window.removeEventListener("touchcancel", reset, { capture: true });
    };
  }, [enabled]);
}
