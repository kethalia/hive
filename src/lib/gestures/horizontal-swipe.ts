import { TAP_THRESHOLD_PX } from "@/lib/gestures/conventions";

export const HORIZONTAL_SWIPE_DISTANCE_PX = 56;

export type HorizontalSwipeDirection = "left" | "right";

export interface HorizontalSwipeProgress {
  direction: HorizontalSwipeDirection | null;
  horizontalIntent: boolean;
}

const LAUNCHER_GESTURE_IGNORE_SELECTOR = [
  '[data-launcher-gesture-ignore="true"]',
  '[data-terminal-touch-selecting="true"]',
  '[data-mobile-scroll-allow="true"]',
  '[data-window-drag-surface="true"]',
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
].join(", ");

/** Returns true when a nested horizontal interaction owns the touch sequence. */
export function isLauncherGestureIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(LAUNCHER_GESTURE_IGNORE_SELECTOR)) return true;

  return target.closest('[role="dialog"]') !== null;
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

/** Only the selected surface owns selection-handle drags. */
export function isLauncherGestureSelectionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const ancestor = selection.getRangeAt(0).commonAncestorContainer;
  const surface =
    target.closest('[data-terminal-native-selection="true"]') ??
    (ancestor instanceof Element ? ancestor : ancestor.parentElement);
  return Boolean(
    surface?.contains(target) &&
      surface.contains(selection.anchorNode) &&
      surface.contains(selection.focusNode),
  );
}
