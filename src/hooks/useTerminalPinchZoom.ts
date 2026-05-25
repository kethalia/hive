"use client";

import { usePinch } from "@use-gesture/react";
import { useRef } from "react";
import {
  fontSizeFromPinchScale,
  getTerminalFontSize,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  setTerminalFontSize,
} from "@/lib/terminal/font-size";

export function useTerminalPinchZoom() {
  const baseSizeRef = useRef<number | null>(null);
  const lastSnappedSizeRef = useRef<number | null>(null);

  const resetGesture = () => {
    baseSizeRef.current = null;
    lastSnappedSizeRef.current = null;
  };

  return usePinch(
    ({ first, last, active, offset: [scale], event }) => {
      if (!event) {
        if (last || active === false) resetGesture();
        return;
      }

      if (first || baseSizeRef.current === null) {
        const baseSize = getTerminalFontSize();
        baseSizeRef.current = baseSize;
        lastSnappedSizeRef.current = baseSize;
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      const baseSize = baseSizeRef.current ?? getTerminalFontSize();
      const nextSize = fontSizeFromPinchScale(baseSize, scale);
      if (nextSize !== lastSnappedSizeRef.current) {
        setTerminalFontSize(nextSize);
        lastSnappedSizeRef.current = nextSize;
      }

      if (last || active === false) {
        resetGesture();
      }
    },
    {
      eventOptions: { passive: false },
      from: () => [1, 0],
      pinchOnWheel: false,
      pointer: { touch: true },
      scaleBounds: () => {
        const baseSize = getTerminalFontSize();
        return {
          min: MIN_FONT_SIZE / baseSize,
          max: MAX_FONT_SIZE / baseSize,
        };
      },
    },
  );
}
