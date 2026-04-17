"use client";

import { useCallback, useState } from "react";

type SidebarMode = "offcanvas" | "icon";

const STORAGE_KEY = "sidebar_mode";
const DEFAULT_MODE: SidebarMode = "offcanvas";

function readMode(): SidebarMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "icon" ? "icon" : "offcanvas";
}

export function useSidebarMode(): [SidebarMode, () => void] {
  const [mode, setMode] = useState<SidebarMode>(readMode);

  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next: SidebarMode = prev === "offcanvas" ? "icon" : "offcanvas";
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return [mode, toggleMode];
}
