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
      if (!startSnapshot || classification === "cancelled") {
        return { ownsGesture: false, direction: null };
      }

      const current = snapshotForPoints(points, startSnapshot.firstId, startSnapshot.secondId);
      if (!current) {
        reset();
        return { ownsGesture: false, direction: null };
      }
      lastSnapshot = current;

      const deltaX = current.centerX - startSnapshot.centerX;
      const deltaY = current.centerY - startSnapshot.centerY;
      const scaleDelta = Math.abs(current.distance / startSnapshot.distance - 1);
      classification = classifyMovement(classification, deltaX, deltaY, scaleDelta);
      if (classification !== "swipe") return { ownsGesture: false, direction: null };
      return { ownsGesture: true, direction: deltaX < 0 ? "left" : "right" };
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
