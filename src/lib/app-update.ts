"use client";

export async function refreshInstalledApp() {
  try {
    const registrations =
      "serviceWorker" in navigator && typeof navigator.serviceWorker.getRegistrations === "function"
        ? await navigator.serviceWorker.getRegistrations().catch(() => [])
        : [];

    await Promise.all(
      registrations.map((registration) => registration.update().catch(() => undefined)),
    );
    await Promise.all(
      registrations.map((registration) => registration.unregister().catch(() => undefined)),
    );

    if ("caches" in window) {
      const cacheNames = await window.caches.keys().catch(() => []);
      await Promise.all(
        cacheNames.map((cacheName) => window.caches.delete(cacheName).catch(() => false)),
      );
    }
  } finally {
    window.location.reload();
  }
}
