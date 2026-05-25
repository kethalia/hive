"use client";

import { useDrag } from "@use-gesture/react";
import { useCallback } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { NO_TOUCH_STYLE, TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";
import { cn } from "@/lib/utils";

const OPEN_SWIPE_DISTANCE_PX = 32;

export interface SidebarEdgeHandleProps {
  className?: string;
}

export function SidebarEdgeHandle({ className }: SidebarEdgeHandleProps) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();

  const openSidebar = useCallback(() => {
    setOpenMobile(true);
  }, [setOpenMobile]);

  const bind = useDrag(
    ({ movement: [mx, my], cancel, event }) => {
      const horizontalDominates = Math.abs(mx) > Math.abs(my);

      if (horizontalDominates && event.cancelable) {
        event.preventDefault();
      }

      if (mx > OPEN_SWIPE_DISTANCE_PX && horizontalDominates) {
        setOpenMobile(true);
        cancel();
      }
    },
    {
      filterTaps: true,
      axis: "x",
      threshold: TAP_THRESHOLD_PX,
      eventOptions: { passive: false },
    },
  );

  if (!isMobile || openMobile) {
    return null;
  }

  return (
    <button
      type="button"
      aria-label="Open sidebar"
      data-testid="sidebar-edge-handle"
      className={cn(
        "fixed left-4 top-1/2 z-40 flex h-16 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-sidebar-border/70 bg-sidebar/80 text-sidebar-foreground shadow-lg backdrop-blur transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring active:scale-95 motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:active:scale-100",
        className,
      )}
      style={{
        ...NO_TOUCH_STYLE,
        touchAction: "pan-y",
      }}
      onClick={openSidebar}
      {...bind()}
    >
      <span
        aria-hidden="true"
        className="block h-10 w-1.5 rounded-full bg-sidebar-foreground/45 shadow-sm"
      />
    </button>
  );
}
