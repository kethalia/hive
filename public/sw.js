/// <reference lib="webworker" />

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.method === "GET" && event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
  }
});

function notificationUrl(value) {
  try {
    const url = new URL(value || "/workspaces", self.location.origin);
    if (url.origin === self.location.origin &&
        (url.pathname === "/login" || url.pathname === "/notifications" ||
         url.pathname === "/templates" || url.pathname.startsWith("/templates/") ||
         url.pathname === "/workspaces" || url.pathname.startsWith("/workspaces/"))) {
      return url.pathname + url.search;
    }
  } catch {}
  return "/workspaces";
}

async function updateBadge() {
  if (!self.navigator.setAppBadge) return;
  const notifications = await self.registration.getNotifications();
  if (notifications.length) await self.navigator.setAppBadge(notifications.length);
  else await self.navigator.clearAppBadge();
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() || {}; }
    catch { payload = { body: event.data?.text() }; }
    if (!payload || typeof payload !== "object") payload = {};
    const kind = payload.kind || "token";
    const url = notificationUrl(payload.url || (kind === "token" ? "/login" : "/workspaces"));
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = clients.find(client => client.visibilityState === "visible" && client.focused) ||
      clients.find(client => client.visibilityState === "visible");
    const title = typeof payload.title === "string" ? payload.title : "Hive";
    const body = typeof payload.body === "string" ? payload.body : "Hive needs your attention.";
    const previous = await self.registration.getNotifications({ tag: payload.tag });
    const duplicate = Boolean(payload.tag && previous.some(item => item.tag === payload.tag));
    const options = {
      body, tag: payload.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      data: { url, kind },
      requireInteraction: kind === "question" || kind === "approval" || kind === "failure",
      // Let the active page play CRT audio; background alerts use OS sound.
      silent: Boolean(visible),
    };
    if (!visible) options.vibrate = kind === "ready" ? [80, 60, 80] : [180, 80, 180];
    await self.registration.showNotification(title, options);
    if (!duplicate) visible?.postMessage({ type: "hive:notification", payload: { ...payload, title, body, kind, url } });
    await updateBadge().catch(() => {});
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = notificationUrl(event.notification.data?.url);
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (target) {
      const navigated = await target.navigate(url);
      await (navigated || target).focus();
    } else await self.clients.openWindow(url);
    await updateBadge().catch(() => {});
  })());
});
self.addEventListener("notificationclose", (event) => event.waitUntil(updateBadge().catch(() => {})));
