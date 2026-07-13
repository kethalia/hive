import * as React from "react";

export const MOBILE_BREAKPOINT = 1024;
export const TOUCH_TABLET_BREAKPOINT = 1366;
export const MOBILE_VIEWPORT_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;
export const TOUCH_TABLET_VIEWPORT_QUERY = `(pointer: coarse) and (max-width: ${TOUCH_TABLET_BREAKPOINT}px)`;

export function isMobileLikeViewport(win: Window): boolean {
  if (win.innerWidth <= MOBILE_BREAKPOINT) return true;
  return win.matchMedia?.(TOUCH_TABLET_VIEWPORT_QUERY).matches ?? false;
}

function subscribeToMobileViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
  }

  const mql = window.matchMedia(MOBILE_VIEWPORT_QUERY);
  const touchTabletMql = window.matchMedia(TOUCH_TABLET_VIEWPORT_QUERY);

  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    touchTabletMql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
      touchTabletMql.removeEventListener("change", onChange);
    };
  }

  mql.addListener?.(onChange);
  touchTabletMql.addListener?.(onChange);
  return () => {
    mql.removeListener?.(onChange);
    touchTabletMql.removeListener?.(onChange);
  };
}

function getMobileViewportSnapshot(): boolean {
  return typeof window !== "undefined" && isMobileLikeViewport(window);
}

export function useIsMobile() {
  const [hydrationSettled, setHydrationSettled] = React.useState(false);
  const isMobile = React.useSyncExternalStore(
    subscribeToMobileViewport,
    getMobileViewportSnapshot,
    () => false,
  );

  React.useEffect(() => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      setHydrationSettled(true);
    };

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(settle);
    });

    return () => {
      settled = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  return hydrationSettled && isMobile;
}
