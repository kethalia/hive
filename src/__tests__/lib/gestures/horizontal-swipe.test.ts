import { describe, expect, it } from "vitest";
import { resolveHorizontalSwipe } from "@/lib/gestures/horizontal-swipe";

describe("resolveHorizontalSwipe", () => {
  it("recognizes left and right swipes with the shared distance rule", () => {
    expect(resolveHorizontalSwipe(200, 100, 130, 104)).toEqual({
      direction: "left",
      horizontalIntent: true,
    });
    expect(resolveHorizontalSwipe(100, 100, 170, 104)).toEqual({
      direction: "right",
      horizontalIntent: true,
    });
  });

  it("rejects short and vertically dominant movement", () => {
    expect(resolveHorizontalSwipe(100, 100, 140, 104)).toEqual({
      direction: null,
      horizontalIntent: true,
    });
    expect(resolveHorizontalSwipe(100, 100, 170, 190)).toEqual({
      direction: null,
      horizontalIntent: false,
    });
  });
});
