"use client";

import { useDrag } from "@use-gesture/react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { DRAG_DISMISS_DISTANCE_PX, DRAG_DISMISS_VELOCITY } from "@/lib/gestures/conventions";

const SNAP_BACK_TRANSITION = "transform 150ms ease-out";

interface SwipeToDismissOptions {
  enabled: boolean;
  maxHeight?: CSSProperties["maxHeight"];
  onDismiss: () => void;
  open: boolean;
}

function vectorValue(vector: unknown, index: number): number {
  if (!Array.isArray(vector)) return 0;
  const value = vector[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Shared downward drag-to-dismiss behavior for mobile bottom sheets. */
export function useSwipeToDismiss({ enabled, maxHeight, onDismiss, open }: SwipeToDismissOptions) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isSnapBack, setIsSnapBack] = useState(false);

  useEffect(() => {
    if (!open) {
      setDragY(0);
      setIsDragging(false);
      setIsSnapBack(false);
    }
  }, [open]);

  useEffect(() => {
    if (!isSnapBack) return;
    const timeoutId = window.setTimeout(() => setIsSnapBack(false), 150);
    return () => window.clearTimeout(timeoutId);
  }, [isSnapBack]);

  const bindDragHandle = useDrag(
    ({ active, direction, event, movement, velocity }) => {
      if (!enabled) return;
      const movementY = Math.max(0, vectorValue(movement, 1));
      const directionY = vectorValue(direction, 1);
      const velocityY = directionY > 0 ? vectorValue(velocity, 1) : 0;

      if ((active || movementY > 0) && event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      if (active) {
        setIsDragging(true);
        setIsSnapBack(false);
        setDragY(movementY);
        return;
      }

      setIsDragging(false);
      if (movementY >= DRAG_DISMISS_DISTANCE_PX || velocityY >= DRAG_DISMISS_VELOCITY) {
        setDragY(0);
        setIsSnapBack(false);
        onDismiss();
        return;
      }
      setDragY(0);
      setIsSnapBack(!prefersReducedMotion);
    },
    { axis: "y", eventOptions: { passive: false }, filterTaps: true },
  );

  const sheetStyle = useMemo<CSSProperties>(() => {
    const style: CSSProperties = maxHeight === undefined ? {} : { maxHeight };
    if (!enabled || prefersReducedMotion) return style;
    if (isDragging) {
      if (dragY > 0) style.transform = `translateY(${dragY}px)`;
      style.transition = "none";
    } else if (dragY > 0 || isSnapBack) {
      style.transform = `translateY(${dragY}px)`;
      style.transition = SNAP_BACK_TRANSITION;
    }
    return style;
  }, [dragY, enabled, isDragging, isSnapBack, maxHeight, prefersReducedMotion]);

  return { bindDragHandle, sheetStyle };
}
