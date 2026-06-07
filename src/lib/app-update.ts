"use client";

export async function refreshInstalledApp() {
  const registrations =
    "serviceWorker" in navigator && typeof navigator.serviceWorker.getRegistrations === "function"
      ? await navigator.serviceWorker.getRegistrations()
      : [];

  await Promise.all(
    registrations.map((registration) => registration.update().catch(() => undefined)),
  );
  await Promise.all(
    registrations.map((registration) => registration.unregister().catch(() => undefined)),
  );

  if ("caches" in window) {
    const cacheNames = await window.caches.keys();
    await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)));
  }

  window.location.reload();
}
