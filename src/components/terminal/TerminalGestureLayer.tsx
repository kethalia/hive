"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
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

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
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
  const activePointerRef = useRef<ActivePointer | null>(null);
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
    activePointerRef.current = null;
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

  const resetPointerState = useCallback(() => {
    detectorRef.current?.end();
    canceledByMovementRef.current = false;
    activePointerRef.current = null;
    lastEventRef.current = null;
    lastPointRef.current = null;
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (selectionModeEnabled) return;
      if (!isTouchLikePointerEvent(event.nativeEvent)) return;

      const detector = detectorRef.current;
      if (!detector) return;

      activePointerRef.current = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      canceledByMovementRef.current = false;
      lastEventRef.current = event.nativeEvent;
      lastPointRef.current = { x: event.clientX, y: event.clientY };
      detector.start();
    },
    [selectionModeEnabled],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (selectionModeEnabled) return;
      if (!isTouchLikePointerEvent(event.nativeEvent)) return;

      const activePointer = activePointerRef.current;
      const detector = detectorRef.current;
      if (!activePointer || !detector || activePointer.id !== event.pointerId) return;

      lastEventRef.current = event.nativeEvent;
      lastPointRef.current = { x: event.clientX, y: event.clientY };

      const distance = Math.hypot(
        event.clientX - activePointer.startX,
        event.clientY - activePointer.startY,
      );
      if (!detector.armed && distance >= DRAG_LONG_PRESS_MOVE_PX) {
        canceledByMovementRef.current = true;
        detector.end();
      }
    },
    [selectionModeEnabled],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (selectionModeEnabled) return;
      if (!isTouchLikePointerEvent(event.nativeEvent)) return;

      const activePointer = activePointerRef.current;
      if (!activePointer || activePointer.id !== event.pointerId) return;

      if (detectorRef.current?.armed) {
        preventDefaultIfCancelable(event.nativeEvent);
      }
      resetPointerState();
    },
    [resetPointerState, selectionModeEnabled],
  );

  return (
    <div
      data-terminal-gesture-layer="true"
      className={["h-full", className].filter(Boolean).join(" ")}
      style={{
        ...style,
        touchAction: selectionModeEnabled ? "auto" : "pan-x pan-y",
        WebkitTouchCallout: selectionModeEnabled ? undefined : "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
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
