import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";

export const HORIZONTAL_SWIPE_DISTANCE_PX = 56;

export type HorizontalSwipeDirection = "left" | "right";

export interface HorizontalSwipeProgress {
  direction: HorizontalSwipeDirection | null;
  horizontalIntent: boolean;
}

/** Resolves a horizontal swipe using the same intent and distance rules for every finger count. */
export function resolveHorizontalSwipe(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): HorizontalSwipeProgress {
  const deltaX = currentX - startX;
  const deltaY = currentY - startY;
  const horizontalIntent =
    Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > TAP_THRESHOLD_PX;

  if (!horizontalIntent || Math.abs(deltaX) < HORIZONTAL_SWIPE_DISTANCE_PX) {
    return { direction: null, horizontalIntent };
  }

  return { direction: deltaX < 0 ? "left" : "right", horizontalIntent };
}
