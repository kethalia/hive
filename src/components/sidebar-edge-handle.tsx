"use client";

import { useEffect, useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import {
  isSidebarGestureIgnoredTarget,
  resolveHorizontalSwipe,
} from "@/lib/gestures/horizontal-swipe";

export interface SidebarEdgeHandleProps {
  className?: string;
}

type TouchStart = {
  id: number;
  x: number;
  y: number;
  qualified: boolean;
};

/**
 * Registers the mobile drawer-open gesture without rendering a visible edge
 * handle. The previous fixed left-side pill was too easy to hit accidentally
 * in the terminal; opening now happens through a deliberate one-finger
 * rightward swipe from anywhere on the page. Touch Events are used instead of
 * parallel Touch + Pointer listeners so additional fingers cancel this path
 * deterministically.
 */
export function SidebarEdgeHandle(_props: SidebarEdgeHandleProps) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const touchStartRef = useRef<TouchStart | null>(null);

  useEffect(() => {
    if (!isMobile || openMobile) {
      touchStartRef.current = null;
      return;
    }

    const reset = () => {
      touchStartRef.current = null;
    };

    const trackStart = ({ id, x, y }: Omit<TouchStart, "qualified">): TouchStart | null => {
      if (x < 0 || x > window.innerWidth) return null;
      return { id, x, y, qualified: false };
    };

    const maybeOpen = (
      start: TouchStart | null,
      x: number,
      y: number,
      event: { cancelable?: boolean; preventDefault: () => void },
    ) => {
      if (!start) return;
      const progress = resolveHorizontalSwipe(start.x, start.y, x, y);

      if (progress.horizontalIntent && event.cancelable) {
        event.preventDefault();
      }

      start.qualified = progress.direction === "right";
    };

    const onTouchEnd = (event: TouchEvent) => {
      const completed = touchStartRef.current;
      if (completed?.qualified && event.touches.length === 0) {
        setOpenMobile(true);
      }
      reset();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      const touch = event.touches[0];
      if (isSidebarGestureIgnoredTarget(event.target)) {
        reset();
        return;
      }
      const start = trackStart({
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
      });
      touchStartRef.current = start;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      const start = touchStartRef.current;
      if (!start) return;
      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === start.id,
      );
      if (!touch) return;
      maybeOpen(start, touch.clientX, touch.clientY, event);
    };

    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", reset, { capture: true, passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
      window.removeEventListener("touchend", onTouchEnd, { capture: true });
      window.removeEventListener("touchcancel", reset, { capture: true });
    };
  }, [isMobile, openMobile, setOpenMobile]);

  return null;
}
