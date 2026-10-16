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
        (url.pathname === "/login" || url.pathname === "/notifications" || url.pathname === "/settings" ||
         url.pathname === "/templates" || url.pathname.startsWith("/templates/") ||
         url.pathname === "/workspaces" || url.pathname.startsWith("/workspaces/"))) {
      return url.pathname + url.search + url.hash;
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

// Keep the app and its connected terminals alive when an existing dashboard
// can handle navigation. Older pages still use the normal navigation fallback.
function navigateInApp(client, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (handled) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(handled);
    };
    const timer = setTimeout(() => finish(false), 800);
    channel.port1.onmessage = (event) => finish(event.data?.type === "hive:navigated");
    try { client.postMessage({ type: "hive:navigate", url }, [channel.port2]); }
    catch { finish(false); }
  });
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
    const destination = new URL(url, self.location.origin);
    const workspace = destination.pathname.match(/^\/workspaces\/([^/]+)(?:\/|$)/)?.[1];
    const appClients = clients.filter(client => new URL(client.url).origin === self.location.origin);
    const target = appClients.find(client => client.url === destination.href) ||
      appClients.find(client => workspace && (new URL(client.url).pathname === `/workspaces/${workspace}` || new URL(client.url).pathname.startsWith(`/workspaces/${workspace}/`))) ||
      appClients.find(client => client.focused && client.visibilityState === "visible") || appClients[0];
    let navigated;
    if (target) {
      if (workspace && await navigateInApp(target, url)) {
        await target.focus();
        await updateBadge().catch(() => {});
        return;
      }
      try { navigated = await target.navigate(url); } catch {}
    }
    if (navigated) await navigated.focus();
    else await self.clients.openWindow(url);
    await updateBadge().catch(() => {});
  })());
});
self.addEventListener("notificationclose", (event) => event.waitUntil(updateBadge().catch(() => {})));
