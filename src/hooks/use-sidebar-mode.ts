"use client";

import { useCallback, useState } from "react";

type SidebarVariant = "floating";

const STORAGE_KEY = "sidebar_variant";
const DEFAULT_VARIANT: SidebarVariant = "floating";

function persistFloatingVariant() {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, DEFAULT_VARIANT);
}

function readVariant(): SidebarVariant {
  persistFloatingVariant();
  return DEFAULT_VARIANT;
}

export function useSidebarMode(): [SidebarVariant, (_floating: boolean) => void] {
  const [variant, setVariant] = useState<SidebarVariant>(readVariant);

  const setSidebarMode = useCallback((_floating: boolean) => {
    persistFloatingVariant();
    setVariant(DEFAULT_VARIANT);
  }, []);

  return [variant, setSidebarMode];
}
