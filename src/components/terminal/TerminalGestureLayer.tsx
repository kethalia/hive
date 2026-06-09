"use client";

import { useGesture } from "@use-gesture/react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef } from "react";
import { DRAG_LONG_PRESS_MOVE_PX } from "@/lib/gestures/conventions";
import { createLongPressDetector, type LongPressDetector } from "@/lib/gestures/long-press";

const CONTEXT_MENU_SUPPRESS_MS = 1200;

interface TerminalGestureLayerProps {
  children: ReactNode;
  onLongPress: (x: number, y: number) => void;
  className?: string;
  style?: CSSProperties;
  selectionModeEnabled?: boolean;
}

function preventDefaultIfCancelable(event: Event | null) {
  if (event?.cancelable) {
    event.preventDefault();
  }
}

function isTouchLikePointerEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  if (!("pointerType" in event)) return false;
  return event.pointerType === "touch" || event.pointerType === "pen";
}

export function TerminalGestureLayer({
  children,
  onLongPress,
  className,
  style,
  selectionModeEnabled = false,
}: TerminalGestureLayerProps) {
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const lastEventRef = useRef<Event | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const canceledByMovementRef = useRef(false);
  const suppressNextContextMenuRef = useRef(false);
  const suppressContextMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectorRef = useRef<LongPressDetector | null>(null);

  const clearSuppressContextMenuTimer = useCallback(() => {
    if (suppressContextMenuTimerRef.current !== null) {
      clearTimeout(suppressContextMenuTimerRef.current);
      suppressContextMenuTimerRef.current = null;
    }
  }, []);

  const armContextMenuSuppression = () => {
    suppressNextContextMenuRef.current = true;
    clearSuppressContextMenuTimer();
    suppressContextMenuTimerRef.current = setTimeout(() => {
      suppressNextContextMenuRef.current = false;
      suppressContextMenuTimerRef.current = null;
    }, CONTEXT_MENU_SUPPRESS_MS);
  };

  if (detectorRef.current === null) {
    detectorRef.current = createLongPressDetector({
      onArm: () => {
        if (canceledByMovementRef.current) return;
        const point = lastPointRef.current;
        if (!point) return;

        preventDefaultIfCancelable(lastEventRef.current);
        armContextMenuSuppression();
        onLongPressRef.current(point.x, point.y);
      },
    });
  }

  useEffect(() => {
    if (!selectionModeEnabled) return;

    detectorRef.current?.end();
    canceledByMovementRef.current = false;
    lastEventRef.current = null;
    lastPointRef.current = null;
    suppressNextContextMenuRef.current = false;
    clearSuppressContextMenuTimer();
  }, [clearSuppressContextMenuTimer, selectionModeEnabled]);

  useEffect(() => {
    return () => {
      detectorRef.current?.end();
      if (suppressContextMenuTimerRef.current !== null) {
        clearTimeout(suppressContextMenuTimerRef.current);
        suppressContextMenuTimerRef.current = null;
      }
    };
  }, []);

  const bind = useGesture(
    {
      onDrag: ({ first, last, distance: [dx, dy], event, xy: [x, y] }) => {
        if (selectionModeEnabled) return;
        if (!isTouchLikePointerEvent(event)) return;

        const detector = detectorRef.current;
        if (!detector) return;

        lastEventRef.current = event as Event;
        lastPointRef.current = { x, y };

        if (first) {
          canceledByMovementRef.current = false;
          detector.start();
        }

        const distance = Math.hypot(dx, dy);
        if (!detector.armed && distance >= DRAG_LONG_PRESS_MOVE_PX) {
          canceledByMovementRef.current = true;
          detector.end();
        }

        if (last) {
          if (detector.armed) {
            preventDefaultIfCancelable(event as Event);
          }
          detector.end();
          canceledByMovementRef.current = false;
          lastEventRef.current = null;
          lastPointRef.current = null;
        }
      },
    },
    {
      drag: {
        eventOptions: { passive: false },
        filterTaps: false,
        pointer: { capture: false, keys: false },
        threshold: 0,
        triggerAllEvents: true,
      },
    },
  );

  return (
    <div
      {...bind()}
      data-terminal-gesture-layer="true"
      className={["h-full", className].filter(Boolean).join(" ")}
      style={{
        ...style,
        touchAction: selectionModeEnabled ? "auto" : "pan-x pan-y",
        WebkitTouchCallout: selectionModeEnabled ? undefined : "none",
      }}
      onContextMenuCapture={(event) => {
        if (selectionModeEnabled) return;
        if (suppressNextContextMenuRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressNextContextMenuRef.current = false;
          clearSuppressContextMenuTimer();
          return;
        }
      }}
    >
      {children}
    </div>
  );
}
