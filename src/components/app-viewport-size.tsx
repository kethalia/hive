"use client";

import { useEffect } from "react";
import { subscribeViewportEvents } from "@/lib/viewport-events";

/**
 * Publishes runtime viewport measurements without taking ownership of the app
 * layout height. The layout height intentionally stays CSS-owned as `100vh` so
 * installed iOS PWAs can extend into the bottom safe area; these measurements
 * are still useful for keyboard-aware overlays and field diagnostics.
 */
export function AppViewportSize() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;
    const visualViewport = window.visualViewport;

    const updateViewportSize = () => {
      root.style.setProperty("--app-window-inner-height", `${window.innerHeight}px`);
      root.style.setProperty(
        "--app-visual-viewport-height",
        `${visualViewport?.height ?? window.innerHeight}px`,
      );
      root.style.setProperty(
        "--app-visual-viewport-offset-top",
        `${visualViewport?.offsetTop ?? 0}px`,
      );
    };

    updateViewportSize();
    return subscribeViewportEvents(updateViewportSize);
  }, []);

  return null;
}
