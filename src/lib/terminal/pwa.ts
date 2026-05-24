"use client";

import * as React from "react";

export function isPwaStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: (e: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (e: MediaQueryListEvent) => void) => void;
};

export function usePwaStandalone() {
  const [isStandalone, setIsStandalone] = React.useState<boolean>(isPwaStandalone);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(display-mode: standalone)") as LegacyMediaQueryList;
    const onChange = () => {
      setIsStandalone(mql.matches);
    };
    setIsStandalone(mql.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    if (typeof mql.addListener === "function") {
      mql.addListener(onChange);
      return () => mql.removeListener?.(onChange);
    }
  }, []);

  return isStandalone;
}
