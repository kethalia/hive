import { describe, expect, it } from "vitest";
import {
  PULL_REFRESH_MAX_PULL_PX,
  PULL_REFRESH_MAX_RELEASE_VELOCITY,
  PULL_REFRESH_TRIGGER_PX,
} from "@/lib/gestures/conventions";
import {
  clampPullDistance,
  derivePullRefreshState,
  shouldRefreshOnRelease,
} from "@/lib/gestures/pull-refresh";

const baseGesture = {
  isAtScrollTop: true,
  movementX: 0,
  movementY: 0,
  directionY: 1,
  velocityY: 0,
  disabled: false,
  isRefreshing: false,
  isTextSelection: false,
};

describe("clampPullDistance", () => {
  it("clamps negative pulls to zero and caps visual travel", () => {
    expect(clampPullDistance(-10)).toBe(0);
    expect(clampPullDistance(PULL_REFRESH_TRIGGER_PX)).toBe(PULL_REFRESH_TRIGGER_PX);
    expect(clampPullDistance(PULL_REFRESH_MAX_PULL_PX + 24)).toBe(PULL_REFRESH_MAX_PULL_PX);
  });
});

describe("derivePullRefreshState", () => {
  it("stays idle until an eligible downward top-of-scroll pull starts", () => {
    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX / 2,
        isAtScrollTop: false,
      }),
    ).toBe("idle");

    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX / 2,
      }),
    ).toBe("pulling");
  });

  it("reports ready at the shared trigger distance and refreshing while in flight", () => {
    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
      }),
    ).toBe("ready");

    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        isRefreshing: true,
      }),
    ).toBe("refreshing");
  });

  it("blocks disabled, editable-origin, horizontal, and upward gestures", () => {
    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        disabled: true,
      }),
    ).toBe("disabled");

    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        isTextSelection: true,
      }),
    ).toBe("idle");

    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementX: PULL_REFRESH_TRIGGER_PX * 2,
        movementY: PULL_REFRESH_TRIGGER_PX,
      }),
    ).toBe("idle");

    expect(
      derivePullRefreshState({
        ...baseGesture,
        movementY: -PULL_REFRESH_TRIGGER_PX,
        directionY: -1,
      }),
    ).toBe("idle");
  });
});

describe("shouldRefreshOnRelease", () => {
  it("refreshes only for an eligible top-of-scroll downward release past threshold", () => {
    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
      }),
    ).toBe(true);

    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        directionY: 0,
      }),
    ).toBe(true);

    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX - 1,
      }),
    ).toBe(false);

    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        isAtScrollTop: false,
      }),
    ).toBe(false);
  });

  it("guards against wrong-direction, duplicate, editable-origin, and fast-fling releases", () => {
    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: -PULL_REFRESH_TRIGGER_PX,
        directionY: -1,
      }),
    ).toBe(false);

    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        isRefreshing: true,
      }),
    ).toBe(false);

    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX,
        isTextSelection: true,
      }),
    ).toBe(false);

    expect(
      shouldRefreshOnRelease({
        ...baseGesture,
        movementY: PULL_REFRESH_TRIGGER_PX + 12,
        velocityY: PULL_REFRESH_MAX_RELEASE_VELOCITY + 0.01,
      }),
    ).toBe(false);
  });
});
