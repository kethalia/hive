import {
  TWO_FINGER_SWIPE_HORIZONTAL_RATIO,
  TWO_FINGER_SWIPE_INTENT_PX,
  TWO_FINGER_SWIPE_MAX_SCALE_DELTA,
  TWO_FINGER_SWIPE_MAX_VERTICAL_PX,
  TWO_FINGER_SWIPE_TRIGGER_PX,
} from "@/lib/gestures/conventions";

export type TwoFingerSwipeDirection = "left" | "right";

export interface GestureTouchPoint {
  id: number;
  x: number;
  y: number;
}

export interface TwoFingerSwipeProgress {
  ownsGesture: boolean;
  direction: TwoFingerSwipeDirection | null;
}

export interface TwoFingerSwipeDetector {
  start(points: readonly GestureTouchPoint[]): boolean;
  move(points: readonly GestureTouchPoint[]): TwoFingerSwipeProgress;
  end(): TwoFingerSwipeDirection | null;
  cancel(): void;
  readonly active: boolean;
}

interface SwipeSnapshot {
  firstId: number;
  secondId: number;
  centerX: number;
  centerY: number;
  distance: number;
}

interface SwipeMovement {
  classification: GestureClassification;
  current: SwipeSnapshot;
  progress: TwoFingerSwipeProgress;
}

type GestureClassification = "pending" | "swipe" | "pinch" | "cancelled";

function classifyMovement(
  classification: GestureClassification,
  deltaX: number,
  deltaY: number,
  scaleDelta: number,
): GestureClassification {
  if (scaleDelta > TWO_FINGER_SWIPE_MAX_SCALE_DELTA) return "pinch";
  if (classification !== "pending") return classification;

  const horizontalDominates =
    Math.abs(deltaX) >= Math.abs(deltaY) * TWO_FINGER_SWIPE_HORIZONTAL_RATIO;
  if (Math.abs(deltaY) > TWO_FINGER_SWIPE_MAX_VERTICAL_PX && !horizontalDominates) {
    return "cancelled";
  }
  if (Math.abs(deltaX) >= TWO_FINGER_SWIPE_INTENT_PX && horizontalDominates) {
    return "swipe";
  }
  return classification;
}

function snapshotForPoints(
  points: readonly GestureTouchPoint[],
  firstId?: number,
  secondId?: number,
): SwipeSnapshot | null {
  if (points.length !== 2) return null;
  const first = firstId === undefined ? points[0] : points.find((point) => point.id === firstId);
  const second = secondId === undefined ? points[1] : points.find((point) => point.id === secondId);
  if (!first || !second || first.id === second.id) return null;

  return {
    firstId: first.id,
    secondId: second.id,
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

export function createTwoFingerSwipeDetector(): TwoFingerSwipeDetector {
  let startSnapshot: SwipeSnapshot | null = null;
  let lastSnapshot: SwipeSnapshot | null = null;
  let classification: GestureClassification = "cancelled";

  const reset = () => {
    startSnapshot = null;
    lastSnapshot = null;
    classification = "cancelled";
  };

  return {
    start(points) {
      const snapshot = snapshotForPoints(points);
      if (!snapshot || snapshot.distance === 0) {
        reset();
        return false;
      }
      startSnapshot = snapshot;
      lastSnapshot = snapshot;
      classification = "pending";
      return true;
    },
    move(points) {
      if (!startSnapshot) {
        return { ownsGesture: false, direction: null };
      }

      const movement = resolveMovement(startSnapshot, classification, points);
      if (!movement) {
        reset();
        return { ownsGesture: false, direction: null };
      }
      lastSnapshot = movement.current;
      classification = movement.classification;
      return movement.progress;
    },
    end() {
      if (!startSnapshot || !lastSnapshot || classification !== "swipe") {
        reset();
        return null;
      }

      const deltaX = lastSnapshot.centerX - startSnapshot.centerX;
      const deltaY = lastSnapshot.centerY - startSnapshot.centerY;
      const direction =
        Math.abs(deltaX) >= TWO_FINGER_SWIPE_TRIGGER_PX &&
        Math.abs(deltaY) <= TWO_FINGER_SWIPE_MAX_VERTICAL_PX
          ? deltaX < 0
            ? "left"
            : "right"
          : null;
      reset();
      return direction;
    },
    cancel: reset,
    get active() {
      return startSnapshot !== null;
    },
  };
}

function resolveMovement(
  start: SwipeSnapshot,
  classification: GestureClassification,
  points: readonly GestureTouchPoint[],
): SwipeMovement | null {
  if (classification === "cancelled") return null;
  const current = snapshotForPoints(points, start.firstId, start.secondId);
  if (!current) return null;

  const deltaX = current.centerX - start.centerX;
  const deltaY = current.centerY - start.centerY;
  const scaleDelta = Math.abs(current.distance / start.distance - 1);
  const nextClassification = classifyMovement(classification, deltaX, deltaY, scaleDelta);
  const progress: TwoFingerSwipeProgress =
    nextClassification === "swipe"
      ? { ownsGesture: true, direction: deltaX < 0 ? "left" : "right" }
      : { ownsGesture: false, direction: null };
  return { classification: nextClassification, current, progress };
}
