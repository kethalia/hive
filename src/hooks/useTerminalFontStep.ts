"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EVENT_NAME,
  FONT_SIZE_LADDER,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  getTerminalFontSize,
  setTerminalFontSize,
} from "@/lib/terminal/font-size";

function getNextFontSize(size: number): number {
  return FONT_SIZE_LADDER.find((candidate) => candidate > size) ?? MAX_FONT_SIZE;
}

function getPreviousFontSize(size: number): number {
  return [...FONT_SIZE_LADDER].reverse().find((candidate) => candidate < size) ?? MIN_FONT_SIZE;
}

export function useTerminalFontStep() {
  const [size, setSize] = useState(() => getTerminalFontSize());

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handler = (event: Event) => {
      const nextSize = (event as CustomEvent<number>).detail;
      setSize(nextSize);
    };

    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  const increase = useCallback(() => {
    setTerminalFontSize(getNextFontSize(getTerminalFontSize()));
  }, []);

  const decrease = useCallback(() => {
    setTerminalFontSize(getPreviousFontSize(getTerminalFontSize()));
  }, []);

  return {
    size,
    increase,
    decrease,
    canIncrease: size < MAX_FONT_SIZE,
    canDecrease: size > MIN_FONT_SIZE,
  };
}
