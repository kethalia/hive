"use client";

import { useEffect } from "react";
import { appPreviewOrigin } from "@/lib/app-preview-origin.mjs";

export function ServiceWorkerRegister() {
  useEffect(() => {
    const previewFrame =
      window.parent !== window &&
      appPreviewOrigin(window.location.hostname.split(".")[0]) === window.location.origin;
    if (!previewFrame && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // registration failed — no action needed
      });
    }
  }, []);

  return null;
}
