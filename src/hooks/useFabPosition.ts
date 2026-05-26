"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";
import { createLongPressDetector, type LongPressDetector } from "@/lib/gestures/long-press";

export interface UseFabPositionOptions {
  /**
   * Called once when the press transitions to "armed" — either by holding past
   * LONG_PRESS_MS without crossing DRAG_LONG_PRESS_MOVE_PX, or by exceeding
   * DRAG_LONG_PRESS_MOVE_PX of in-press movement. Wired by FloatingActionButton
   * as a haptic-feedback seam (S08 will trigger navigator.vibrate from here).
   */
  onArmed?: () => void;
}

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const STORAGE_KEY = "fab_position";
const DEFAULT_CORNER: Corner = "bottom-right";
const OFFSET = 16;
const SNAP_DURATION = 200;

function readCorner(): Corner {
  if (typeof window === "undefined") return DEFAULT_CORNER;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (
    stored === "top-left" ||
    stored === "top-right" ||
    stored === "bottom-left" ||
    stored === "bottom-right"
  ) {
    return stored;
  }
  return DEFAULT_CORNER;
}

function viewportMetrics() {
  const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
  if (vv) {
    return {
      width: vv.width,
      height: vv.height,
      offsetLeft: vv.offsetLeft,
      offsetTop: vv.offsetTop,
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetLeft: 0,
    offsetTop: 0,
  };
}

export function cornerToPosition(corner: Corner) {
  const { width, height, offsetLeft, offsetTop } = viewportMetrics();
  switch (corner) {
    case "top-left":
      return { x: offsetLeft + OFFSET, y: offsetTop + OFFSET };
    case "top-right":
      return { x: offsetLeft + width - 56 - OFFSET, y: offsetTop + OFFSET };
    case "bottom-left":
      return { x: offsetLeft + OFFSET, y: offsetTop + height - 56 - OFFSET };
    case "bottom-right":
      return {
        x: offsetLeft + width - 56 - OFFSET,
        y: offsetTop + height - 56 - OFFSET,
      };
  }
}

export function nearestCorner(x: number, y: number): Corner {
  const corners: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

  const targets = corners.map((c) => {
    const pos = cornerToPosition(c);
    const dx = x - pos.x;
    const dy = y - pos.y;
    return { corner: c, dist: Math.sqrt(dx * dx + dy * dy) };
  });

  targets.sort((a, b) => a.dist - b.dist);
  return targets[0].corner;
}

export function useFabPosition(options?: UseFabPositionOptions) {
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isSnapping, setIsSnapping] = useState(false);
  const [isArmed, setIsArmed] = useState(false);
  const onArmedRef = useRef<(() => void) | undefined>(options?.onArmed);
  onArmedRef.current = options?.onArmed;
  const dragStartPosRef = useRef({ x: 0, y: 0 });
  const dragDistRef = useRef(0);
  const wasDragRef = useRef(false);
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRef = useRef<LongPressDetector | null>(null);
  if (longPressRef.current === null) {
    longPressRef.current = createLongPressDetector({
      onArm: () => {
        setIsArmed(true);
        onArmedRef.current?.();
      },
    });
  }

  useEffect(() => {
    return () => {
      if (snapTimeoutRef.current !== null) {
        clearTimeout(snapTimeoutRef.current);
        snapTimeoutRef.current = null;
      }
      longPressRef.current?.end();
    };
  }, []);

  useEffect(() => {
    setPosition(cornerToPosition(corner));
  }, [corner]);

  useEffect(() => {
    const handleResize = () => {
      setPosition(cornerToPosition(corner));
    };
    window.addEventListener("resize", handleResize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", handleResize);
    vv?.addEventListener("scroll", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      vv?.removeEventListener("resize", handleResize);
      vv?.removeEventListener("scroll", handleResize);
    };
  }, [corner]);

  const bind = useDrag(
    ({ first, last, movement: [mx, my], distance: [dx, dy] }) => {
      const detector = longPressRef.current;
      if (detector === null) return;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (first) {
        setIsDragging(true);
        dragStartPosRef.current = { ...position };
        dragDistRef.current = 0;
        wasDragRef.current = false;
        detector.start();
      }

      dragDistRef.current = Math.max(dragDistRef.current, dist);
      detector.move(dist);

      // Reposition only commits once the press has armed — either by holding
      // past LONG_PRESS_MS or by crossing DRAG_LONG_PRESS_MOVE_PX. This is
      // what prevents a casual tap from accidentally dragging the FAB.
      if (!first && !last && detector.armed) {
        const { width, height, offsetLeft, offsetTop } = viewportMetrics();
        setPosition({
          x: Math.max(
            offsetLeft,
            Math.min(offsetLeft + width - 56, dragStartPosRef.current.x + mx),
          ),
          y: Math.max(offsetTop, Math.min(offsetTop + height - 56, dragStartPosRef.current.y + my)),
        });
      }

      if (last) {
        const wasArmed = detector.end();
        setIsDragging(false);
        setIsArmed(false);
        wasDragRef.current = wasArmed;
        if (wasArmed) {
          setPosition((current) => {
            const newCorner = nearestCorner(current.x, current.y);
            localStorage.setItem(STORAGE_KEY, newCorner);
            setCorner(newCorner);
            setIsSnapping(true);
            if (snapTimeoutRef.current !== null) {
              clearTimeout(snapTimeoutRef.current);
            }
            snapTimeoutRef.current = setTimeout(() => {
              setIsSnapping(false);
              snapTimeoutRef.current = null;
            }, SNAP_DURATION);
            return cornerToPosition(newCorner);
          });
        }
      }
    },
    {
      filterTaps: true,
      threshold: TAP_THRESHOLD_PX,
      pointer: { capture: true },
    },
  );

  const bound = useMemo(() => bind(), [bind]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      bound.onPointerDown?.(e as unknown as React.PointerEvent);
    },
    [bound],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      bound.onPointerMove?.(e);
    },
    [bound],
  );

  const onPointerUp = useCallback(
    (e?: ReactPointerEvent) => {
      if (e) bound.onPointerUp?.(e);
      return wasDragRef.current;
    },
    [bound],
  );

  return {
    corner,
    position,
    isDragging,
    isSnapping,
    isArmed,
    dragDist: dragDistRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
