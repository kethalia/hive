"use client";

import { useDrag } from "@use-gesture/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTextSelectionEvent, PULL_REFRESH_TRIGGER_PX } from "@/lib/gestures/conventions";
import {
  clampPullDistance,
  derivePullRefreshState,
  isPullRefreshEligible,
  type PullRefreshGestureInput,
  type PullRefreshState,
  shouldRefreshOnRelease,
} from "@/lib/gestures/pull-refresh";

export interface UsePullToRefreshOptions {
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
}

export interface UsePullToRefreshResult {
  bind: ReturnType<typeof useDrag>;
  pullState: PullRefreshState;
  pullDistance: number;
  statusText: string;
}

function getEventScrollTop(event: { currentTarget: EventTarget | null }): number {
  const currentTarget = event.currentTarget;
  if (currentTarget instanceof HTMLElement) return currentTarget.scrollTop;
  if (typeof window === "undefined") return 0;
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

export function getPullRefreshStatusText(state: PullRefreshState): string {
  switch (state) {
    case "disabled":
      return "Pull to refresh disabled";
    case "pulling":
    case "idle":
      return "Pull down to refresh";
    case "ready":
      return "Release to refresh";
    case "refreshing":
      return "Refreshing";
  }
}

export function usePullToRefresh({
  onRefresh,
  disabled = false,
}: UsePullToRefreshOptions): UsePullToRefreshResult {
  const [pullState, setPullState] = useState<PullRefreshState>(disabled ? "disabled" : "idle");
  const [pullDistance, setPullDistance] = useState(0);
  const onRefreshRef = useRef(onRefresh);
  const disabledRef = useRef(disabled);
  const refreshingRef = useRef(false);
  const textSelectionOriginRef = useRef(false);
  const mountedRef = useRef(true);

  onRefreshRef.current = onRefresh;
  disabledRef.current = disabled;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (refreshingRef.current) return;
    setPullDistance(0);
    setPullState(disabled ? "disabled" : "idle");
  }, [disabled]);

  const resetPull = useCallback(() => {
    refreshingRef.current = false;
    textSelectionOriginRef.current = false;
    if (!mountedRef.current) return;
    setPullDistance(0);
    setPullState(disabledRef.current ? "disabled" : "idle");
  }, []);

  const bind = useDrag(
    async ({
      first,
      last,
      movement: [movementX, movementY],
      direction: [, directionY],
      velocity: [, velocityY],
      event,
    }) => {
      if (first) {
        textSelectionOriginRef.current = isTextSelectionEvent(event);
      }

      const input: PullRefreshGestureInput = {
        isAtScrollTop: getEventScrollTop(event) <= 0,
        movementX,
        movementY,
        directionY,
        velocityY,
        disabled: disabledRef.current,
        isRefreshing: refreshingRef.current,
        isTextSelection: textSelectionOriginRef.current,
      };
      const eligible = isPullRefreshEligible(input);

      if (eligible && event.cancelable) {
        event.preventDefault();
      }

      if (!last) {
        if (!mountedRef.current) return;
        setPullDistance(eligible ? clampPullDistance(movementY) : 0);
        setPullState(derivePullRefreshState(input));
        return;
      }

      if (!shouldRefreshOnRelease(input)) {
        resetPull();
        return;
      }

      refreshingRef.current = true;
      if (mountedRef.current) {
        setPullDistance(PULL_REFRESH_TRIGGER_PX);
        setPullState("refreshing");
      }

      try {
        await Promise.resolve(onRefreshRef.current());
      } catch {
        // Failure mode is intentionally UI-local: keep existing list content and
        // reset the pull surface. Callers can surface fetch errors themselves.
      } finally {
        resetPull();
      }
    },
    {
      filterTaps: true,
      axis: "y",
      threshold: 0,
      eventOptions: { passive: false },
    },
  );

  return {
    bind,
    pullState,
    pullDistance,
    statusText: getPullRefreshStatusText(pullState),
  };
}
