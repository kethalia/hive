"use client";

import { useEffect } from "react";

/**
 * Keeps viewport-sized shells aligned with the real app viewport on mobile
 * Safari/PWA. CSS dynamic viewport units are still the fallback, but installed
 * iOS PWAs can disagree with `svh`/`dvh` near the home-indicator area. The app
 * shell uses this variable so sidebar drawers and terminal surfaces share one
 * height source.
 */
export function AppViewportSize() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;
    const visualViewport = window.visualViewport;

    const updateViewportSize = () => {
      root.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
      root.style.setProperty(
        "--app-visual-viewport-height",
        `${visualViewport?.height ?? window.innerHeight}px`,
      );
    };

    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    window.addEventListener("orientationchange", updateViewportSize);
    visualViewport?.addEventListener("resize", updateViewportSize);
    visualViewport?.addEventListener("scroll", updateViewportSize);

    return () => {
      window.removeEventListener("resize", updateViewportSize);
      window.removeEventListener("orientationchange", updateViewportSize);
      visualViewport?.removeEventListener("resize", updateViewportSize);
      visualViewport?.removeEventListener("scroll", updateViewportSize);
    };
  }, []);

  return null;
}
