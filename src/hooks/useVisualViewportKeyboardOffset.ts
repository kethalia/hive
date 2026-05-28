import * as React from "react";

export interface VisualViewportKeyboardOffset {
  liftPx: number;
  isKeyboardVisible: boolean;
  visualViewportHeightPx: number;
}

/**
 * Returns keyboard visibility information for visual-viewport-aware mobile
 * layouts. `liftPx` is still the safe amount for bottom-anchored floating UI,
 * but full-height frames should use `isKeyboardVisible` plus the published
 * `--app-visual-viewport-height` variable so Safari page panning does not
 * cancel the shrink calculation.
 *
 * SSR-safe: returns { liftPx: 0, isKeyboardVisible: false,
 * visualViewportHeightPx: 0 } on first render. Listeners are attached in
 * useEffect to window.visualViewport for both 'resize' and 'scroll' events.
 */
export function useVisualViewportKeyboardOffset(): VisualViewportKeyboardOffset {
  const [state, setState] = React.useState<VisualViewportKeyboardOffset>({
    liftPx: 0,
    isKeyboardVisible: false,
    visualViewportHeightPx: 0,
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const compute = () => {
      const heightDelta = Math.max(0, window.innerHeight - vv.height);
      const next = {
        liftPx: Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)),
        isKeyboardVisible: heightDelta > 80,
        visualViewportHeightPx: vv.height,
      };
      setState((current) =>
        current.liftPx === next.liftPx &&
        current.isKeyboardVisible === next.isKeyboardVisible &&
        current.visualViewportHeightPx === next.visualViewportHeightPx
          ? current
          : next,
      );
    };

    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
    };
  }, []);

  return state;
}
