"use client";

import { useCallback, useState } from "react";

type SidebarVariant = "sidebar" | "floating";

const STORAGE_KEY = "sidebar_variant";
const DEFAULT_VARIANT: SidebarVariant = "floating";

function readVariant(): SidebarVariant {
  if (typeof window === "undefined") return DEFAULT_VARIANT;
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "sidebar" ? "sidebar" : "floating";
}

export function useSidebarMode(): [SidebarVariant, (floating: boolean) => void] {
  const [variant, setVariant] = useState<SidebarVariant>(readVariant);

  const setSidebarMode = useCallback((floating: boolean) => {
    const next: SidebarVariant = floating ? "floating" : "sidebar";
    localStorage.setItem(STORAGE_KEY, next);
    setVariant(next);
  }, []);

  return [variant, setSidebarMode];
}
