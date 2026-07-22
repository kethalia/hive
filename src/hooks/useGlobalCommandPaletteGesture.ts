"use client";

import { useEffect, useRef } from "react";
import { resolveHorizontalSwipe } from "@/lib/gestures/horizontal-swipe";

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

function startsOnPaneHeader(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-window-drag-surface="true"]') !== null;
}

function preventNativeForwardGesture(event: TouchEvent, clientX: number) {
  if (clientX >= window.innerWidth - NATIVE_HISTORY_EDGE_PX && event.cancelable) {
    event.preventDefault();
  }
}

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
      if (startsOnPaneHeader(event.target)) {
        reset();
        preventNativeForwardGesture(event, touch.clientX);
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
      preventNativeForwardGesture(event, touch.clientX);
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
