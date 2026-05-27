import * as React from "react";

export interface VisualViewportKeyboardOffset {
  liftPx: number;
}

/**
 * Returns the number of pixels a bottom-anchored terminal layout must lift to
 * stay above the on-screen keyboard. Computed from window.visualViewport: when
 * the soft keyboard opens, visualViewport.height shrinks below
 * window.innerHeight; subtracting visualViewport.offsetTop avoids double
 * counting Safari's page shift in installed PWAs.
 *
 * SSR-safe: returns { liftPx: 0 } on first render. Listeners are attached in
 * useEffect to window.visualViewport for both 'resize' and 'scroll' events.
 */
export function useVisualViewportKeyboardOffset(): VisualViewportKeyboardOffset {
  const [liftPx, setLiftPx] = React.useState(0);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const compute = () => {
      const next = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      setLiftPx(next);
    };

    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
    };
  }, []);

  return { liftPx };
}
