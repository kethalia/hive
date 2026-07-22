import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";

export const HORIZONTAL_SWIPE_DISTANCE_PX = 56;

export type HorizontalSwipeDirection = "left" | "right";

export interface HorizontalSwipeProgress {
  direction: HorizontalSwipeDirection | null;
  horizontalIntent: boolean;
}

const SIDEBAR_GESTURE_IGNORE_SELECTOR = [
  '[data-sidebar-gesture-ignore="true"]',
  '[data-window-drag-surface="true"]',
].join(", ");

/** Returns true when a nested horizontal interaction owns the touch sequence. */
export function isSidebarGestureIgnoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SIDEBAR_GESTURE_IGNORE_SELECTOR) !== null;
}

/** Resolves a one-finger horizontal swipe using the shared intent and distance rules. */
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
