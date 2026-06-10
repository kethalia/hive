"use client";

import * as React from "react";
import {
  isMobileLikeViewport,
  MOBILE_VIEWPORT_QUERY,
  TOUCH_TABLET_VIEWPORT_QUERY,
} from "@/hooks/use-mobile";

const COMPOSE_SHEET_QUERIES = [MOBILE_VIEWPORT_QUERY, TOUCH_TABLET_VIEWPORT_QUERY] as const;

export function useIsComposeSheet() {
  const [isComposeSheet, setIsComposeSheet] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const onChange = () => {
      setIsComposeSheet(isMobileLikeViewport(window));
    };

    onChange();
    const mediaQueries = COMPOSE_SHEET_QUERIES.map((query) => window.matchMedia(query));
    for (const mql of mediaQueries) {
      mql.addEventListener("change", onChange);
    }

    return () => {
      for (const mql of mediaQueries) {
        mql.removeEventListener("change", onChange);
      }
    };
  }, []);

  return !!isComposeSheet;
}
