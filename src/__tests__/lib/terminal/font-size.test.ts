import { describe, expect, it } from "vitest";
import { fontSizeFromPinchScale, snapTerminalFontSize } from "@/lib/terminal/font-size";

describe("terminal font-size helpers", () => {
  it("snaps arbitrary font sizes to the nearest supported ladder value", () => {
    expect(snapTerminalFontSize(9)).toBe(8);
    expect(snapTerminalFontSize(10.8)).toBe(10);
    expect(snapTerminalFontSize(11.4)).toBe(12);
    expect(snapTerminalFontSize(15.2)).toBe(16);
    expect(snapTerminalFontSize(100)).toBe(28);
  });

  it("derives snapped terminal font sizes from pinch scale", () => {
    expect(fontSizeFromPinchScale(14, 1.25)).toBe(18);
    expect(fontSizeFromPinchScale(14, 0.72)).toBe(10);
    expect(fontSizeFromPinchScale(18, 1.2)).toBe(22);
  });

  it("falls back safely to the snapped base size for invalid pinch scales", () => {
    expect(fontSizeFromPinchScale(16, Number.NaN)).toBe(16);
    expect(fontSizeFromPinchScale(16, Number.POSITIVE_INFINITY)).toBe(16);
    expect(fontSizeFromPinchScale(16, 0)).toBe(16);
    expect(fontSizeFromPinchScale(16, -1)).toBe(16);
  });
});
