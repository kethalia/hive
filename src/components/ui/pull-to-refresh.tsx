"use client";

import type * as React from "react";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { cn } from "@/lib/utils";

export interface PullToRefreshProps extends Omit<React.ComponentProps<"div">, "onRefresh"> {
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
}

export function PullToRefresh({
  onRefresh,
  disabled = false,
  className,
  children,
  style,
  ...props
}: PullToRefreshProps) {
  const { bind, pullDistance, pullState, statusText } = usePullToRefresh({
    onRefresh,
    disabled,
  });
  const showIndicator =
    pullState === "pulling" || pullState === "ready" || pullState === "refreshing";

  return (
    <div
      {...props}
      {...bind()}
      data-slot="pull-to-refresh"
      data-testid="pull-to-refresh"
      data-pull-state={pullState}
      className={cn("relative min-h-0 overscroll-contain", className)}
      style={{
        ...style,
        overscrollBehavior: "contain",
        touchAction: "pan-y",
      }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-slot="pull-to-refresh-status"
        className="sr-only"
      >
        {statusText}
      </div>
      {showIndicator ? (
        <div
          aria-hidden="true"
          data-slot="pull-to-refresh-indicator"
          className="pointer-events-none flex items-center justify-center overflow-hidden text-sm text-muted-foreground transition-[height,opacity] motion-reduce:transition-none motion-reduce:duration-0"
          style={{ height: Math.max(0, pullDistance) }}
        >
          {statusText}
        </div>
      ) : null}
      {children}
    </div>
  );
}
