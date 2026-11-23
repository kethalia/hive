"use client";

import { useEffect } from "react";
import { hiveProductionOrigin } from "@/lib/app-preview-origin.mjs";

export function AppPreviewReady() {
  useEffect(() => {
    if (window.parent !== window)
      window.parent.postMessage("hive:preview-ready", hiveProductionOrigin);
  }, []);
  return null;
}
