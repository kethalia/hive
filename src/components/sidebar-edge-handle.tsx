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

function isGestureIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "summary",
        "[contenteditable='true']",
        "[role='button']",
        "[role='menuitem']",
        "[data-sidebar-gesture-ignore]",
      ].join(","),
    ),
  );
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

  useEffect(() => {
    if (!isMobile || openMobile) {
      startRef.current = null;
      return;
    }

    const reset = () => {
      startRef.current = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType && event.pointerType !== "touch") return;
      if (event.button !== 0) return;
      if (isGestureIgnoredTarget(event.target)) return;

      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
      const maxStartX = viewportWidth * MAX_START_X_RATIO;
      if (event.clientX > maxStartX) return;

      startRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || start.id !== event.pointerId) return;

      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const horizontalDominates = Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > TAP_THRESHOLD_PX;

      if (horizontalDominates && event.cancelable) {
        event.preventDefault();
      }

      if (dx >= OPEN_SWIPE_DISTANCE_PX && horizontalDominates) {
        setOpenMobile(true);
        reset();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", reset, { passive: true });
    window.addEventListener("pointercancel", reset, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", reset);
      window.removeEventListener("pointercancel", reset);
    };
  }, [isMobile, openMobile, setOpenMobile]);

  return null;
}
