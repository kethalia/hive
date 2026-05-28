// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AppViewportSize } from "@/components/app-viewport-size";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--app-viewport-height");
  document.documentElement.style.removeProperty("--app-visual-viewport-height");
  vi.unstubAllGlobals();
});

describe("AppViewportSize", () => {
  it("publishes window and visual viewport heights for app shell sizing", () => {
    const addVisualViewportListener = vi.fn();
    const removeVisualViewportListener = vi.fn();

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener: addVisualViewportListener,
        height: 810,
        removeEventListener: removeVisualViewportListener,
      },
    });

    const { unmount } = render(<AppViewportSize />);

    expect(document.documentElement).toHaveStyle({
      "--app-viewport-height": "844px",
      "--app-visual-viewport-height": "810px",
    });
    expect(addVisualViewportListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(addVisualViewportListener).toHaveBeenCalledWith("scroll", expect.any(Function));

    unmount();

    expect(removeVisualViewportListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeVisualViewportListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
