"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useGesture } from "@use-gesture/react";
import { DRAG_LONG_PRESS_MOVE_PX, NO_TOUCH_STYLE } from "@/lib/gestures/conventions";
import { createLongPressDetector, type LongPressDetector } from "@/lib/gestures/long-press";

const CONTEXT_MENU_SUPPRESS_MS = 1200;

interface TerminalGestureLayerProps {
  children: ReactNode;
  onLongPress: (x: number, y: number) => void;
}

function preventDefaultIfCancelable(event: Event | null) {
  if (event?.cancelable) {
    event.preventDefault();
  }
}

export function TerminalGestureLayer({ children, onLongPress }: TerminalGestureLayerProps) {
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const lastEventRef = useRef<Event | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const canceledByMovementRef = useRef(false);
  const suppressNextContextMenuRef = useRef(false);
  const suppressContextMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectorRef = useRef<LongPressDetector | null>(null);

  const clearSuppressContextMenuTimer = () => {
    if (suppressContextMenuTimerRef.current !== null) {
      clearTimeout(suppressContextMenuTimerRef.current);
      suppressContextMenuTimerRef.current = null;
    }
  };

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
      className="h-full"
      style={{
        ...NO_TOUCH_STYLE,
        touchAction: "pan-x pan-y",
      }}
      onContextMenu={(event) => {
        if (!suppressNextContextMenuRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressNextContextMenuRef.current = false;
        clearSuppressContextMenuTimer();
      }}
    >
      {children}
    </div>
  );
}
