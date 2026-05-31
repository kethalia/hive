import * as React from "react";

export type PwaMode = "standalone" | "browser";

/**
 * Returns whether the app is running as an installed PWA ("standalone") or in
 * a regular browser tab ("browser"). SSR-safe: defaults to "browser" so the
 * server render and first client paint agree (no hydration mismatch). The
 * effect then upgrades to "standalone" if either:
 *   - window.matchMedia('(display-mode: standalone)').matches, or
 *   - navigator.standalone === true (iOS Safari fallback).
 */
export function usePwaMode(): PwaMode {
  const [mode, setMode] = React.useState<PwaMode>("browser");

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)")
        : null;

    const compute = (): PwaMode => {
      const mqMatches = mql?.matches === true;
      const iosStandalone =
        typeof navigator !== "undefined" &&
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
      return mqMatches || iosStandalone ? "standalone" : "browser";
    };

    setMode(compute());

    if (!mql) return;
    const onChange = () => setMode(compute());
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return mode;
}
