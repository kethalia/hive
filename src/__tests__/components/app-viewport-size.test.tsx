// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AppViewportSize } from "@/components/app-viewport-size";
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--app-window-inner-height");
  document.documentElement.style.removeProperty("--app-visual-viewport-height");
  document.documentElement.style.removeProperty("--app-visual-viewport-offset-top");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function KeyboardProbe() {
  const { isKeyboardVisible } = useVisualViewportKeyboardOffset();
  return <output data-testid="keyboard">{String(isKeyboardVisible)}</output>;
}
function installViewport() {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  return viewport;
}

describe("AppViewportSize", () => {
  it.each([
    "visibilitychange",
    "pageshow",
    "focus",
  ])("restores shell and keyboard state on %s without a viewport resize event", (event) => {
    vi.useFakeTimers();
    const viewport = installViewport();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const add = vi.spyOn(viewport, "addEventListener");
    const remove = vi.spyOn(viewport, "removeEventListener");
    const { unmount } = render(
      <>
        <AppViewportSize />
        <KeyboardProbe />
      </>,
    );
    expect(add.mock.calls.filter(([name]) => name === "resize")).toHaveLength(1);
    act(() => {
      viewport.height = 400;
      viewport.offsetTop = 35;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId("keyboard")).toHaveTextContent("true");
    act(() => {
      viewport.height = 844;
      viewport.offsetTop = 0;
      (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
    });
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-height")).toBe(
      "844px",
    );
    expect(
      document.documentElement.style.getPropertyValue("--app-visual-viewport-offset-top"),
    ).toBe("0px");
    expect(screen.getByTestId("keyboard")).toHaveTextContent("false");
    unmount();
    expect(remove.mock.calls.filter(([name]) => name === "resize")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rereads delayed foreground geometry while respecting a keyboard that remains open", () => {
    vi.useFakeTimers();
    const viewport = installViewport();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    render(
      <>
        <AppViewportSize />
        <KeyboardProbe />
      </>,
    );
    act(() => {
      viewport.height = 400;
      viewport.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("pageshow"));
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("keyboard")).toHaveTextContent("true");
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-height")).toBe(
      "400px",
    );
    act(() => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
      viewport.height = 844;
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("keyboard")).toHaveTextContent("false");
    expect(document.documentElement.style.getPropertyValue("--app-visual-viewport-height")).toBe(
      "844px",
    );
  });

  it("publishes measured viewport heights without overriding the CSS app viewport", () => {
    const addVisualViewportListener = vi.fn();
    const removeVisualViewportListener = vi.fn();

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener: addVisualViewportListener,
        height: 810,
        offsetTop: 42,
        removeEventListener: removeVisualViewportListener,
      },
    });

    const { unmount } = render(<AppViewportSize />);

    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(document.documentElement).toHaveStyle({
      "--app-window-inner-height": "844px",
      "--app-visual-viewport-height": "810px",
      "--app-visual-viewport-offset-top": "42px",
    });
    expect(addVisualViewportListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(addVisualViewportListener).toHaveBeenCalledWith("scroll", expect.any(Function));

    unmount();

    expect(removeVisualViewportListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeVisualViewportListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
