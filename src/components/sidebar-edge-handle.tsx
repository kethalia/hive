"use client";

import { useEffect, useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";

const OPEN_SWIPE_DISTANCE_PX = 56;
const MAX_START_X_RATIO = 0.72;

export interface SidebarEdgeHandleProps {
  className?: string;
}

type PointerStart = {
  id: number;
  x: number;
  y: number;
};

type TouchStart = {
  id: number;
  x: number;
  y: number;
};

function isGestureIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const nativeInteractiveTarget = target.closest(
    [
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "summary",
      "[contenteditable='true']",
      "[role='menuitem']",
      "[data-sidebar-gesture-ignore]",
    ].join(","),
  );
  if (nativeInteractiveTarget) return true;

  const roleButtonTarget = target.closest("[role='button']");
  return Boolean(roleButtonTarget && !roleButtonTarget.hasAttribute("data-pane-mode"));
}

/**
 * Registers the mobile drawer-open gesture without rendering a visible edge
 * handle. The previous fixed left-side pill was too easy to hit accidentally
 * in the terminal; opening now happens through a rightward page swipe that
 * starts on non-interactive content.
 */
export function SidebarEdgeHandle(_props: SidebarEdgeHandleProps) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const startRef = useRef<PointerStart | null>(null);
  const touchStartRef = useRef<TouchStart | null>(null);

  useEffect(() => {
    if (!isMobile || openMobile) {
      startRef.current = null;
      touchStartRef.current = null;
      return;
    }

    const reset = () => {
      startRef.current = null;
      touchStartRef.current = null;
    };

    const trackStart = ({
      id,
      target,
      x,
      y,
    }: {
      id: number;
      target: EventTarget | null;
      x: number;
      y: number;
    }): PointerStart | null => {
      if (isGestureIgnoredTarget(target)) return null;

      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
      const maxStartX = viewportWidth * MAX_START_X_RATIO;
      if (x > maxStartX) return null;

      return { id, x, y };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== "touch") return;
      if (event.button !== 0) return;

      startRef.current = trackStart({
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target: event.target,
      });
    };

    const maybeOpen = (
      start: PointerStart | TouchStart | null,
      x: number,
      y: number,
      event: { cancelable?: boolean; preventDefault: () => void },
    ): boolean => {
      if (!start) return false;
      const dx = x - start.x;
      const dy = y - start.y;
      const horizontalDominates = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TAP_THRESHOLD_PX;

      if (horizontalDominates && event.cancelable) {
        event.preventDefault();
      }

      if (dx >= OPEN_SWIPE_DISTANCE_PX && horizontalDominates) {
        setOpenMobile(true);
        reset();
        return true;
      }
      return false;
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId) return;
      maybeOpen(start, event.clientX, event.clientY, event);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      touchStartRef.current = trackStart({
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        target: event.target,
      });
    };

    const onTouchMove = (event: TouchEvent) => {
      const start = touchStartRef.current;
      if (!start) return;
      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === start.id,
      );
      if (!touch) return;
      maybeOpen(start, touch.clientX, touch.clientY, event);
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    window.addEventListener("pointerup", reset, { passive: true });
    window.addEventListener("pointercancel", reset, { passive: true });
    window.addEventListener("touchend", reset, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
      window.removeEventListener("pointerup", reset);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("touchend", reset);
      window.removeEventListener("touchcancel", reset);
    };
  }, [isMobile, openMobile, setOpenMobile]);

  return null;
}
