import * as React from "react";

export interface FabKeyboardOffset {
  liftPx: number;
}

/**
 * Returns the number of pixels the FAB must lift to stay above the on-screen
 * keyboard. Computed from window.visualViewport: when the soft keyboard opens,
 * visualViewport.height shrinks below window.innerHeight; the difference (minus
 * any offsetTop) is the amount the bottom-anchored FAB must rise.
 *
 * SSR-safe: returns { liftPx: 0 } on first render. Listeners are attached in
 * useEffect to window.visualViewport for 'resize' and 'scroll' events.
 */
export function useFabKeyboardOffset(): FabKeyboardOffset {
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
