"use client";

import { useEffect } from "react";
import { isEmbeddedAppPreview } from "@/lib/app-preview-origin.mjs";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!isEmbeddedAppPreview() && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // registration failed — no action needed
      });
    }
  }, []);

  return null;
}
