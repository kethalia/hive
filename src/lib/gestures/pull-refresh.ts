import {
  PULL_REFRESH_MAX_PULL_PX,
  PULL_REFRESH_MAX_RELEASE_VELOCITY,
  PULL_REFRESH_TRIGGER_PX,
  TAP_THRESHOLD_PX,
} from "./conventions";

export type PullRefreshState = "idle" | "pulling" | "ready" | "refreshing" | "disabled";

export interface PullRefreshGestureInput {
  /** True when the gesture surface's scroll container is at the very top. */
  isAtScrollTop: boolean;
  /** Horizontal drag movement in px from @use-gesture/react. */
  movementX: number;
  /** Vertical drag movement in px from @use-gesture/react. Positive means down. */
  movementY: number;
  /** Vertical drag direction from @use-gesture/react. Positive means down. */
  directionY?: number;
  /** Vertical release velocity in px/ms from @use-gesture/react. */
  velocityY?: number;
  /** Whether the consumer has disabled pull-to-refresh. */
  disabled?: boolean;
  /** Whether a refresh promise is already in flight. */
  isRefreshing?: boolean;
  /** True when the gesture began inside input/textarea/select/contenteditable. */
  isTextSelection?: boolean;
}

export function clampPullDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(distance, PULL_REFRESH_MAX_PULL_PX));
}

export function isPullRefreshEligible(input: PullRefreshGestureInput): boolean {
  if (input.disabled || input.isRefreshing || input.isTextSelection) return false;
  if (!input.isAtScrollTop) return false;

  const absY = Math.abs(input.movementY);
  const absX = Math.abs(input.movementX);
  const directionY = input.directionY ?? Math.sign(input.movementY);

  if (input.movementY <= TAP_THRESHOLD_PX) return false;
  if (directionY < 0) return false;
  return absY > absX;
}

export function derivePullRefreshState(input: PullRefreshGestureInput): PullRefreshState {
  if (input.disabled) return "disabled";
  if (input.isRefreshing) return "refreshing";
  if (!isPullRefreshEligible(input)) return "idle";
  return clampPullDistance(input.movementY) >= PULL_REFRESH_TRIGGER_PX ? "ready" : "pulling";
}

export function shouldRefreshOnRelease(input: PullRefreshGestureInput): boolean {
  if (!isPullRefreshEligible(input)) return false;
  if (clampPullDistance(input.movementY) < PULL_REFRESH_TRIGGER_PX) return false;
  return Math.abs(input.velocityY ?? 0) <= PULL_REFRESH_MAX_RELEASE_VELOCITY;
}
