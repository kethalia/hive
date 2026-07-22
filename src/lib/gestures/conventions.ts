/**
 * Gesture conventions shared by mobile touch surfaces. Single source of truth
 * so per-slice handlers do not drift on long-press thresholds, tap tolerance,
 * or iOS magnifier suppression.
 *
 * Usage notes for @use-gesture/react:
 * - Bind handlers to the wrapper element, not the xterm canvas — the canvas
 *   captures pointer events for cursor/selection and breaks gesture detection.
 * - Pass `eventOptions: { passive: false }` ONLY on handlers that call
 *   `event.preventDefault()` (e.g. preventing scroll during drag/long-press).
 *   Leaving passive:false on tap/hover handlers regresses scroll performance.
 * - On any surface that supports long-press, set the following CSS on the
 *   bound element to suppress the iOS text-selection magnifier and callout:
 *     user-select: none;
 *     -webkit-user-select: none;
 *     -webkit-touch-callout: none;
 *   Without these, iOS Safari shows the loupe during the 500ms hold.
 */

/** Minimum hold duration (ms) before a press becomes a long-press. */
export const LONG_PRESS_MS = 500;

/**
 * Max pointer travel (px) during a press that still counts as a tap rather
 * than a drag. Above this, treat the gesture as a drag/swipe.
 */
export const TAP_THRESHOLD_PX = 5;

/**
 * Downward pull distance (px) required before release triggers a refresh.
 * Shared by all card-stack list surfaces so mobile list pages do not drift.
 */
export const PULL_REFRESH_TRIGGER_PX = 72;

/** Max visual pull travel (px) exposed to UI wrappers while dragging. */
export const PULL_REFRESH_MAX_PULL_PX = 112;

/**
 * Max downward release velocity (px/ms) that still counts as an intentional
 * pull-to-refresh. Faster flings are treated as native scrolling momentum.
 */
export const PULL_REFRESH_MAX_RELEASE_VELOCITY = 1.5;

/**
 * Downward drag travel (px) that dismisses bottom sheets on release. The
 * drag-to-dismiss rule is an OR trigger: close when downward travel exceeds
 * this distance OR downward release velocity exceeds DRAG_DISMISS_VELOCITY.
 */
export const DRAG_DISMISS_DISTANCE_PX = 80;

/**
 * Downward release velocity (px/ms) that dismisses bottom sheets on release.
 * The drag-to-dismiss rule is an OR trigger with DRAG_DISMISS_DISTANCE_PX.
 */
export const DRAG_DISMISS_VELOCITY = 0.5;

/**
 * Max pointer travel (px) during the long-press hold window before the
 * gesture is reclassified from long-press to drag. Slightly looser than
 * TAP_THRESHOLD_PX to tolerate finger jitter on a stationary press.
 */
export const DRAG_LONG_PRESS_MOVE_PX = 8;

/** Minimum horizontal centroid travel before a two-finger swipe owns the gesture. */
export const TWO_FINGER_SWIPE_INTENT_PX = 18;

/** Horizontal centroid travel required before release navigates to another surface. */
export const TWO_FINGER_SWIPE_TRIGGER_PX = 64;

/** Horizontal travel must exceed vertical travel by this ratio. */
export const TWO_FINGER_SWIPE_HORIZONTAL_RATIO = 1.5;

/** Maximum vertical centroid drift allowed for a horizontal navigation swipe. */
export const TWO_FINGER_SWIPE_MAX_VERTICAL_PX = 32;

/**
 * Maximum relative change in finger spacing before the gesture belongs to
 * a pinch that must not trigger navigation.
 */
export const TWO_FINGER_SWIPE_MAX_SCALE_DELTA = 0.08;

/**
 * Shared style that suppresses iOS text selection/callout chrome on touch
 * gesture surfaces while leaving each caller free to choose its touch-action.
 */
export const NO_TOUCH_STYLE = {
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
} as const;

/**
 * Returns true when the event target is an editable surface where the OS
 * text-selection/caret behavior should win over custom gestures. Use to
 * early-return from long-press handlers bound to wrappers that contain
 * inputs, textareas, or contenteditable regions.
 */
export function isTextSelectionEvent(event: Event | { target: EventTarget | null }): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
