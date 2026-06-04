"use client";

import { useCallback, useEffect, useState } from "react";

type SidebarVariant = "floating";

const STORAGE_KEY = "sidebar_variant";
const DEFAULT_VARIANT: SidebarVariant = "floating";

function persistFloatingVariant() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, DEFAULT_VARIANT);
  } catch {
    // Storage can be unavailable in restricted browser modes; keep rendering with the safe default.
  }
}

function readVariant(): SidebarVariant {
  return DEFAULT_VARIANT;
}

export function useSidebarMode(): [SidebarVariant, (_floating: boolean) => void] {
  const [variant, setVariant] = useState<SidebarVariant>(readVariant);

  useEffect(() => {
    persistFloatingVariant();
  }, []);

  const setSidebarMode = useCallback((_floating: boolean) => {
    persistFloatingVariant();
    setVariant(DEFAULT_VARIANT);
  }, []);

  return [variant, setSidebarMode];
}
