"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FONT_SIZE_LADDER,
  getTerminalFontSize,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  setTerminalFontSize,
  subscribeTerminalFontSize,
} from "@/lib/terminal/font-size";

function getNextFontSize(size: number): number {
  return FONT_SIZE_LADDER.find((candidate) => candidate > size) ?? MAX_FONT_SIZE;
}

function getPreviousFontSize(size: number): number {
  return [...FONT_SIZE_LADDER].reverse().find((candidate) => candidate < size) ?? MIN_FONT_SIZE;
}

export function useTerminalFontStep(scope: string | null) {
  const [state, setState] = useState(() => ({ scope, size: getTerminalFontSize(scope) }));
  const size = state.scope === scope ? state.size : getTerminalFontSize(scope);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const update = (nextSize: number) => {
      sizeRef.current = nextSize;
      setState({ scope, size: nextSize });
    };
    update(getTerminalFontSize(scope));
    if (!scope) return;
    return subscribeTerminalFontSize(scope, update);
  }, [scope]);

  const increase = useCallback(() => {
    if (scope) setTerminalFontSize(getNextFontSize(sizeRef.current), scope);
  }, [scope]);

  const decrease = useCallback(() => {
    if (scope) setTerminalFontSize(getPreviousFontSize(sizeRef.current), scope);
  }, [scope]);

  return {
    size,
    increase,
    decrease,
    canIncrease: scope !== null && size < MAX_FONT_SIZE,
    canDecrease: scope !== null && size > MIN_FONT_SIZE,
  };
}
