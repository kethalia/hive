/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  applyMobileViewportLock,
  COMPOSE_SHEET_KEYBOARD_BOTTOM_OFFSET,
  composeSheetKeyboardStyle,
  MOBILE_TERMINAL_FRAME_HEIGHT_WITH_LAYOUT_VIEWPORT,
  MOBILE_TERMINAL_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT,
  MOBILE_TERMINAL_TOP_OFFSET,
  MOBILE_TERMINAL_TOP_OFFSET_WITH_VISUAL_VIEWPORT,
  mobileTerminalFrameStyle,
  mobileViewportLockedHeight,
  restoreMobileViewportLock,
} from "@/lib/terminal/mobile-shell-layout";

function resetDocumentStyles() {
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  document.body.replaceChildren();
}

afterEach(() => {
  resetDocumentStyles();
});

describe("mobile shell layout", () => {
  it("uses layout viewport height when the keyboard is hidden", () => {
    expect(mobileViewportLockedHeight(false)).toBe("var(--app-viewport-height)");
    expect(mobileTerminalFrameStyle(false)).toEqual({
      height: MOBILE_TERMINAL_FRAME_HEIGHT_WITH_LAYOUT_VIEWPORT,
      maxHeight: MOBILE_TERMINAL_FRAME_HEIGHT_WITH_LAYOUT_VIEWPORT,
      top: MOBILE_TERMINAL_TOP_OFFSET,
    });
    expect(composeSheetKeyboardStyle(false)).toEqual({
      bottom: "0px",
      height: "var(--app-viewport-height)",
      maxHeight: "var(--app-viewport-height)",
      paddingBottom: "var(--safe-area-inset-bottom)",
    });
  });

  it("uses visual viewport height and offset-aware bottom when the keyboard is visible", () => {
    expect(mobileViewportLockedHeight(true)).toBe("var(--app-visual-viewport-height)");
    expect(mobileTerminalFrameStyle(true)).toEqual({
      height: MOBILE_TERMINAL_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT,
      maxHeight: MOBILE_TERMINAL_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT,
      top: MOBILE_TERMINAL_TOP_OFFSET_WITH_VISUAL_VIEWPORT,
    });
    expect(composeSheetKeyboardStyle(true)).toEqual({
      bottom: COMPOSE_SHEET_KEYBOARD_BOTTOM_OFFSET,
      height: "var(--app-visual-viewport-height)",
      maxHeight: "var(--app-visual-viewport-height)",
      paddingBottom: "var(--safe-area-inset-bottom)",
    });
    expect(COMPOSE_SHEET_KEYBOARD_BOTTOM_OFFSET).toBe(
      "calc(var(--app-viewport-height) - var(--app-visual-viewport-height) - var(--app-visual-viewport-offset-top))",
    );
  });

  it("locks html and body to the active mobile viewport and restores previous styles", () => {
    document.documentElement.style.height = "90vh";
    document.documentElement.style.overflow = "auto";
    document.documentElement.style.overscrollBehaviorY = "contain";
    document.body.style.height = "80vh";
    document.body.style.maxHeight = "81vh";
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehaviorY = "contain";
    document.body.style.position = "relative";
    document.body.style.left = "2px";
    document.body.style.right = "3px";
    document.body.style.top = "4px";
    document.body.style.width = "calc(100% - 5px)";

    const snapshot = applyMobileViewportLock(document, true);

    expect(document.documentElement.style.height).toBe("var(--app-visual-viewport-height)");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overscrollBehaviorY).toBe("none");
    expect(document.body.style.height).toBe("var(--app-visual-viewport-height)");
    expect(document.body.style.maxHeight).toBe("var(--app-visual-viewport-height)");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehaviorY).toBe("none");
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.left).toBe("0px");
    expect(document.body.style.right).toBe("0px");
    expect(document.body.style.top).toBe("0px");
    expect(document.body.style.width).toBe("100%");

    restoreMobileViewportLock(snapshot);

    expect(document.documentElement.style.height).toBe("90vh");
    expect(document.documentElement.style.overflow).toBe("auto");
    expect(document.documentElement.style.overscrollBehaviorY).toBe("contain");
    expect(document.body.style.height).toBe("80vh");
    expect(document.body.style.maxHeight).toBe("81vh");
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehaviorY).toBe("contain");
    expect(document.body.style.position).toBe("relative");
    expect(document.body.style.left).toBe("2px");
    expect(document.body.style.right).toBe("3px");
    expect(document.body.style.top).toBe("4px");
    expect(document.body.style.width).toBe("calc(100% - 5px)");
  });
});
