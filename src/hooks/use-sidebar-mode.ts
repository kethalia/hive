"use client";

import { useCallback, useEffect, useState } from "react";

type SidebarVariant = "sidebar";

const STORAGE_KEY = "sidebar_variant";
const DEFAULT_VARIANT: SidebarVariant = "sidebar";

function persistIntegratedVariant() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, DEFAULT_VARIANT);
  } catch {
    // Storage can be unavailable in restricted browser modes; keep rendering with the safe default.
  }
}

export function useSidebarMode(): [SidebarVariant, (_integrated: boolean) => void] {
  const [variant, setVariant] = useState<SidebarVariant>(DEFAULT_VARIANT);

  useEffect(() => {
    persistIntegratedVariant();
  }, []);

  const setSidebarMode = useCallback((_integrated: boolean) => {
    persistIntegratedVariant();
    setVariant(DEFAULT_VARIANT);
  }, []);

  return [variant, setSidebarMode];
}
