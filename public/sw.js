/// <reference lib="webworker" />

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request));
  }
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Hive Orchestrator", body: event.data.text() };
  }

  const { title = "Hive Orchestrator", body, tag, icon } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon,
      data: { url: "/login" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if ("focus" in client) {
            return client.focus().then((c) => c.navigate("/login"));
          }
        }
        return self.clients.openWindow("/login");
      })
  );
});
