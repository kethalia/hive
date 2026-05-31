"use client";

import * as React from "react";
import { COMPOSE_SHEET_BREAKPOINT } from "@/lib/terminal/config";

const COMPOSE_SHEET_QUERY = `(max-width: ${COMPOSE_SHEET_BREAKPOINT - 1}px)`;

export function useIsComposeSheet() {
  const [isComposeSheet, setIsComposeSheet] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(COMPOSE_SHEET_QUERY);
    const onChange = () => {
      setIsComposeSheet(mql.matches);
    };
    mql.addEventListener("change", onChange);
    setIsComposeSheet(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isComposeSheet;
}
