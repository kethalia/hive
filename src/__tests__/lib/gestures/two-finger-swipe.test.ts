import { describe, expect, it } from "vitest";
import { DRAG_LONG_PRESS_MOVE_PX, TWO_FINGER_SWIPE_TRIGGER_PX } from "@/lib/gestures/conventions";
import {
  createTwoFingerSwipeDetector,
  type GestureTouchPoint,
} from "@/lib/gestures/two-finger-swipe";

function points(firstX: number, secondX: number, firstY = 100, secondY = 100): GestureTouchPoint[] {
  return [
    { id: 1, x: firstX, y: firstY },
    { id: 2, x: secondX, y: secondY },
  ];
}

describe("createTwoFingerSwipeDetector", () => {
  it("recognizes a deliberate left navigation swipe", () => {
    const detector = createTwoFingerSwipeDetector();
    expect(detector.start(points(100, 200))).toBe(true);

    expect(
      detector.move(points(100 - TWO_FINGER_SWIPE_TRIGGER_PX, 200 - TWO_FINGER_SWIPE_TRIGGER_PX)),
    ).toEqual({ ownsGesture: true, direction: "left" });
    expect(detector.end()).toBe("left");
  });

  it("recognizes a deliberate right navigation swipe", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    detector.move(points(175, 275));

    expect(detector.end()).toBe("right");
  });

  it("tolerates ordinary finger-spacing variation during a swipe", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    detector.move(points(30, 150));

    expect(detector.end()).toBe("left");
  });

  it("tolerates staggered real-device updates while both fingers move together", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));

    expect(detector.move(points(55, 200))).toEqual({ ownsGesture: false, direction: null });
    expect(detector.move(points(55, 155))).toEqual({ ownsGesture: true, direction: "left" });
    detector.move(points(30, 130));

    expect(detector.end()).toBe("left");
  });

  it("does not navigate when horizontal travel stays below the release threshold", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    const progress = detector.move(points(130, 230));

    expect(progress.ownsGesture).toBe(true);
    expect(detector.end()).toBeNull();
  });

  it("rejects navigation when finger spacing changes materially", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    const progress = detector.move(points(70, 230));

    expect(progress).toEqual({ ownsGesture: false, direction: null });
    expect(detector.end()).toBeNull();
  });

  it("does not downgrade an owned swipe when finger updates briefly diverge", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    expect(detector.move(points(75, 175)).ownsGesture).toBe(true);

    const progress = detector.move(points(20, 160));

    expect(progress).toEqual({ ownsGesture: true, direction: "left" });
    expect(detector.end()).toBe("left");
  });

  it("yields to vertical terminal scrolling", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    const progress = detector.move(points(104, 204, 145, 145));

    expect(progress).toEqual({ ownsGesture: false, direction: null });
    expect(detector.end()).toBeNull();
  });

  it("cancels when a third touch joins", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    const progress = detector.move([...points(40, 140), { id: 3, x: 240, y: 100 }]);

    expect(progress).toEqual({ ownsGesture: false, direction: null });
    expect(detector.active).toBe(false);
  });

  it("tracks touch identifiers rather than array order", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    detector.move([
      { id: 2, x: 130, y: 100 },
      { id: 1, x: 30, y: 100 },
    ]);

    expect(detector.end()).toBe("left");
  });

  it("does not confuse ordinary long-press jitter with navigation", () => {
    const detector = createTwoFingerSwipeDetector();
    detector.start(points(100, 200));
    detector.move(points(100 - DRAG_LONG_PRESS_MOVE_PX, 200 - DRAG_LONG_PRESS_MOVE_PX, 104, 104));

    expect(detector.end()).toBeNull();
  });
});
