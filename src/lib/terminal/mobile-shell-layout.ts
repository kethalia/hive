import type { CSSProperties } from "react";

export const MOBILE_TERMINAL_TOP_OFFSET = "calc(var(--safe-area-inset-top) + 3.5rem)";
export const MOBILE_TERMINAL_TOP_OFFSET_WITH_VISUAL_VIEWPORT =
  "calc(var(--app-visual-viewport-offset-top) + var(--safe-area-inset-top) + 3.5rem)";
export const MOBILE_TERMINAL_SAFE_TOP_OFFSET = "var(--safe-area-inset-top)";
export const MOBILE_TERMINAL_SAFE_TOP_OFFSET_WITH_VISUAL_VIEWPORT =
  "var(--app-visual-viewport-offset-top)";
export const MOBILE_TERMINAL_FRAME_HEIGHT_WITH_LAYOUT_VIEWPORT =
  "max(0px, calc(var(--app-viewport-height) - var(--safe-area-inset-top) - 3.5rem))";
export const MOBILE_TERMINAL_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT =
  "max(0px, calc(var(--app-visual-viewport-height) - var(--safe-area-inset-top) - 3.5rem))";
export const MOBILE_TERMINAL_SAFE_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT =
  "var(--app-visual-viewport-height)";
export const COMPOSE_SHEET_KEYBOARD_BOTTOM_OFFSET =
  "calc(var(--app-viewport-height) - var(--app-visual-viewport-height) - var(--app-visual-viewport-offset-top))";

interface ElementStyleSnapshot {
  height: string;
  overflow: string;
  overscrollBehaviorY: string;
}

interface BodyStyleSnapshot extends ElementStyleSnapshot {
  left: string;
  maxHeight: string;
  position: string;
  right: string;
  top: string;
  width: string;
}

export interface MobileViewportLockSnapshot {
  body: BodyStyleSnapshot;
  html: ElementStyleSnapshot;
  bodyElement: HTMLElement;
  htmlElement: HTMLElement;
}

export function mobileViewportLockedHeight(isKeyboardVisible: boolean): string {
  return isKeyboardVisible ? "var(--app-visual-viewport-height)" : "var(--app-viewport-height)";
}

export function mobileTerminalFrameStyle(
  _isKeyboardVisible: boolean,
  reserveDashboardTrigger = true,
): CSSProperties {
  const height = reserveDashboardTrigger
    ? MOBILE_TERMINAL_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT
    : MOBILE_TERMINAL_SAFE_FRAME_HEIGHT_WITH_VISUAL_VIEWPORT;

  return {
    height,
    maxHeight: height,
    top: reserveDashboardTrigger
      ? MOBILE_TERMINAL_TOP_OFFSET_WITH_VISUAL_VIEWPORT
      : MOBILE_TERMINAL_SAFE_TOP_OFFSET_WITH_VISUAL_VIEWPORT,
  };
}

export function composeSheetKeyboardStyle(isKeyboardVisible: boolean): CSSProperties {
  const height = mobileViewportLockedHeight(isKeyboardVisible);

  return {
    bottom: isKeyboardVisible ? COMPOSE_SHEET_KEYBOARD_BOTTOM_OFFSET : "0px",
    height,
    maxHeight: height,
    paddingBottom: "var(--safe-area-inset-bottom)",
  };
}

export function applyMobileViewportLock(
  documentRef: Document,
  isKeyboardVisible: boolean,
): MobileViewportLockSnapshot {
  const html = documentRef.documentElement;
  const body = documentRef.body;
  const lockedHeight = mobileViewportLockedHeight(isKeyboardVisible);
  const snapshot: MobileViewportLockSnapshot = {
    htmlElement: html,
    bodyElement: body,
    html: {
      height: html.style.height,
      overflow: html.style.overflow,
      overscrollBehaviorY: html.style.overscrollBehaviorY,
    },
    body: {
      height: body.style.height,
      left: body.style.left,
      maxHeight: body.style.maxHeight,
      overflow: body.style.overflow,
      overscrollBehaviorY: body.style.overscrollBehaviorY,
      position: body.style.position,
      right: body.style.right,
      top: body.style.top,
      width: body.style.width,
    },
  };

  html.style.height = lockedHeight;
  html.style.overflow = "hidden";
  html.style.overscrollBehaviorY = "none";
  body.style.height = lockedHeight;
  body.style.left = "0";
  body.style.maxHeight = lockedHeight;
  body.style.overflow = "hidden";
  body.style.overscrollBehaviorY = "none";
  body.style.position = "fixed";
  body.style.right = "0";
  body.style.top = "0";
  body.style.width = "100%";

  return snapshot;
}

export function restoreMobileViewportLock(snapshot: MobileViewportLockSnapshot) {
  const { body, bodyElement, html, htmlElement } = snapshot;

  htmlElement.style.height = html.height;
  htmlElement.style.overflow = html.overflow;
  htmlElement.style.overscrollBehaviorY = html.overscrollBehaviorY;
  bodyElement.style.height = body.height;
  bodyElement.style.left = body.left;
  bodyElement.style.maxHeight = body.maxHeight;
  bodyElement.style.overflow = body.overflow;
  bodyElement.style.overscrollBehaviorY = body.overscrollBehaviorY;
  bodyElement.style.position = body.position;
  bodyElement.style.right = body.right;
  bodyElement.style.top = body.top;
  bodyElement.style.width = body.width;
}
