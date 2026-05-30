import * as React from "react";

const KEYBOARD_VISIBILITY_THRESHOLD_PX = 80;

export interface VisualViewportKeyboardOffset {
  liftPx: number;
  isKeyboardVisible: boolean;
  visualViewportHeightPx: number;
  visualViewportOffsetTopPx: number;
}

/**
 * Returns keyboard visibility information for visual-viewport-aware mobile
 * layouts. `liftPx` is still the safe amount for bottom-anchored floating UI,
 * but full-height frames should use `isKeyboardVisible` plus the published
 * visual viewport height/offset variables so Safari page panning does not
 * cancel the shrink calculation.
 *
 * iOS installed PWAs can shrink `window.innerHeight` together with
 * `visualViewport.height`, so keyboard detection cannot rely only on
 * `innerHeight - visualViewport.height`. Track the largest seen visual viewport
 * as the closed-keyboard baseline and compare the current visual viewport
 * against that baseline.
 *
 * SSR-safe: returns { liftPx: 0, isKeyboardVisible: false,
 * visualViewportHeightPx: 0, visualViewportOffsetTopPx: 0 } on first render.
 * Listeners are attached in useEffect to window.visualViewport for both
 * 'resize' and 'scroll' events, plus window orientation changes to reset the
 * baseline.
 */
export function useVisualViewportKeyboardOffset(): VisualViewportKeyboardOffset {
  const [state, setState] = React.useState<VisualViewportKeyboardOffset>({
    liftPx: 0,
    isKeyboardVisible: false,
    visualViewportHeightPx: 0,
    visualViewportOffsetTopPx: 0,
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    let baselineHeight = vv.height;

    const compute = () => {
      baselineHeight = Math.max(baselineHeight, vv.height);
      const innerHeightDelta = Math.max(0, window.innerHeight - vv.height);
      const baselineDelta = Math.max(0, baselineHeight - vv.height);
      const next = {
        liftPx: Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)),
        isKeyboardVisible:
          innerHeightDelta > KEYBOARD_VISIBILITY_THRESHOLD_PX ||
          baselineDelta > KEYBOARD_VISIBILITY_THRESHOLD_PX,
        visualViewportHeightPx: vv.height,
        visualViewportOffsetTopPx: vv.offsetTop,
      };
      setState((current) =>
        current.liftPx === next.liftPx &&
        current.isKeyboardVisible === next.isKeyboardVisible &&
        current.visualViewportHeightPx === next.visualViewportHeightPx &&
        current.visualViewportOffsetTopPx === next.visualViewportOffsetTopPx
          ? current
          : next,
      );
    };

    const resetBaseline = () => {
      baselineHeight = vv.height;
      compute();
    };

    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    window.addEventListener("orientationchange", resetBaseline);
    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
      window.removeEventListener("orientationchange", resetBaseline);
    };
  }, []);

  return state;
}
