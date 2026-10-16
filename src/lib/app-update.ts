"use client";

import { type AppVersion, appVersionSchema } from "@/lib/app-version";

export async function checkAppVersion(): Promise<AppVersion> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("/api/app-version", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok || response.redirected) {
      throw new Error("Could not check for updates. Check your connection and try again.");
    }
    return appVersionSchema.parse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshInstalledApp() {
  // Keep the registration and push subscription intact when updating this app.
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  }
  window.location.reload();
}
