import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerHapticFeedback } from "@/lib/device/haptics";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setNavigator(value: Partial<Navigator> | undefined) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.restoreAllMocks();

  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

describe("triggerHapticFeedback", () => {
  it("returns false when navigator is absent", () => {
    setNavigator(undefined);

    expect(triggerHapticFeedback()).toBe(false);
  });

  it("returns false when navigator.vibrate is unsupported", () => {
    setNavigator({});

    expect(triggerHapticFeedback()).toBe(false);
  });

  it("uses a short default vibration pattern and returns navigator.vibrate's result", () => {
    const vibrate = vi.fn(() => true);
    setNavigator({ vibrate });

    expect(triggerHapticFeedback()).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("returns false when navigator.vibrate returns false", () => {
    const vibrate = vi.fn(() => false);
    setNavigator({ vibrate });

    expect(triggerHapticFeedback()).toBe(false);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("passes through a custom vibration pattern", () => {
    const vibrate = vi.fn(() => true);
    setNavigator({ vibrate });

    expect(triggerHapticFeedback([5, 10, 5])).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([5, 10, 5]);
  });

  it("swallows navigator.vibrate exceptions and returns false", () => {
    const vibrate = vi.fn(() => {
      throw new Error("vibrate failed");
    });
    setNavigator({ vibrate });

    expect(triggerHapticFeedback()).toBe(false);
  });
});
