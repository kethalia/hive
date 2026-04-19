/// <reference lib="webworker" />

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
