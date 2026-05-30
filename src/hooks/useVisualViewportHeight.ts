import * as React from "react";

export interface VisualViewportHeight {
  height: number | null;
}

/**
 * Reports the current visual viewport height for mobile overlays that must fit
 * around the soft keyboard. SSR-safe: returns { height: null } until mounted
 * and when visualViewport is unavailable.
 */
export function useVisualViewportHeight(): VisualViewportHeight {
  const [height, setHeight] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    const updateHeight = () => {
      setHeight(visualViewport.height);
    };

    updateHeight();
    visualViewport.addEventListener("resize", updateHeight);
    visualViewport.addEventListener("scroll", updateHeight);

    return () => {
      visualViewport.removeEventListener("resize", updateHeight);
      visualViewport.removeEventListener("scroll", updateHeight);
    };
  }, []);

  return { height };
}
