import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";

function worker(visible = false) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const client = {
    url: "https://hive.test/workspaces",
    visibilityState: visible ? "visible" : "hidden",
    focused: visible,
    postMessage: vi.fn(),
    navigate: vi.fn(),
    focus: vi.fn(),
  };
  client.navigate.mockResolvedValue(client);
  const self = {
    location: { origin: "https://hive.test" },
    navigator: {},
    registration: {
      showNotification: vi.fn().mockResolvedValue(undefined),
      getNotifications: vi.fn().mockResolvedValue([]),
    },
    clients: { matchAll: vi.fn().mockResolvedValue([client]), openWindow: vi.fn() },
    addEventListener: (name: string, callback: (event: unknown) => void) => {
      listeners[name] = callback;
    },
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self,
    URL,
    MessageChannel,
    setTimeout,
    clearTimeout,
  });
  async function emit(name: string, data: Record<string, unknown>) {
    let finished: Promise<void> | undefined;
    listeners[name]({
      ...data,
      waitUntil: (promise: Promise<void>) => {
        finished = promise;
      },
    });
    await finished;
  }
  return { self, client, emit };
}

describe("notification service worker", () => {
  it("navigates an existing dashboard without reloading it when the app acknowledges", async () => {
    const { client, emit } = worker();
    client.postMessage.mockImplementation((_data, ports) =>
      ports[0].postMessage({ type: "hive:navigated" }),
    );
    await emit("notificationclick", {
      notification: { close: vi.fn(), data: { url: "/workspaces/w/terminal?session=dev" } },
    });
    expect(client.postMessage.mock.calls[0][0]).toEqual({
      type: "hive:navigate",
      url: "/workspaces?session=dev&workspace=w",
    });
    expect(client.postMessage.mock.calls[0][1]).toHaveLength(1);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(client.focus).toHaveBeenCalledOnce();
  });
  it("shows background questions persistently with a terminal deep link", async () => {
    const { self, emit } = worker();
    await emit("push", {
      data: {
        json: () => ({
          title: "Question",
          kind: "question",
          url: "/workspaces/w/terminal?session=dev",
        }),
      },
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Question",
      expect.objectContaining({
        requireInteraction: true,
        silent: false,
        data: { kind: "question", url: "/workspaces?session=dev&workspace=w" },
        vibrate: [180, 80, 180],
      }),
    );
  });
  it("sends foreground audio to one visible page and silences the OS alert", async () => {
    const { self, client, emit } = worker(true);
    await emit("push", { data: { json: () => ({ title: "Ready", kind: "ready" }) } });
    expect(client.postMessage).toHaveBeenCalledTimes(1);
    const options = self.registration.showNotification.mock.calls[0][1];
    expect(options.silent).toBe(true);
    expect(options.vibrate).toBeUndefined();
    expect(options.requireInteraction).toBe(false);
  });
  it("opens the notification section in settings with its anchor intact", async () => {
    const { client, emit } = worker();
    await emit("notificationclick", {
      notification: { close: vi.fn(), data: { url: "/settings#notifications" } },
    });
    expect(client.navigate).toHaveBeenCalledWith("/settings#notifications");
  });
  it("rejects cross-origin notification navigation", async () => {
    const { client, emit } = worker();
    await emit("notificationclick", {
      notification: { close: vi.fn(), data: { url: "https://evil.test/phish" } },
    });
    expect(client.navigate).toHaveBeenCalledWith("/workspaces");
    expect(client.focus).toHaveBeenCalledOnce();
  });
  it("reuses the matching workspace instead of an unrelated first window", async () => {
    const { self, client, emit } = worker();
    const wrong = {
      ...client,
      url: "https://hive.test/settings",
      navigate: vi.fn(),
    };
    client.url = "https://hive.test/workspaces";
    self.clients.matchAll.mockResolvedValue([wrong, client]);
    await emit("notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/workspaces/w/terminal/workspace?session=review" },
      },
    });
    expect(wrong.navigate).not.toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith("/workspaces?session=review&workspace=w");
    expect(client.focus).toHaveBeenCalledOnce();
  });
  it("prefers an exact destination when several windows share a workspace", async () => {
    const { self, client, emit } = worker();
    const other = {
      ...client,
      url: "https://hive.test/workspaces?session=other&workspace=w",
      navigate: vi.fn(),
    };
    client.url = "https://hive.test/workspaces?session=review&workspace=w";
    self.clients.matchAll.mockResolvedValue([other, client]);
    await emit("notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/workspaces/w/terminal/workspace?session=review" },
      },
    });
    expect(other.navigate).not.toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledOnce();
  });
  it.each([
    "closed",
    "rejected",
    "none",
  ])("opens the destination if the old window is %s", async (mode) => {
    const { self, client, emit } = worker();
    if (mode === "closed") client.navigate.mockResolvedValue(null);
    if (mode === "rejected") client.navigate.mockRejectedValue(new Error("Window closed"));
    if (mode === "none") self.clients.matchAll.mockResolvedValue([]);
    await emit("notificationclick", {
      notification: {
        close: vi.fn(),
        data: { url: "/workspaces/w/terminal/workspace?session=review" },
      },
    });
    expect(self.clients.openWindow).toHaveBeenCalledWith("/workspaces?session=review&workspace=w");
    expect(client.focus).not.toHaveBeenCalled();
  });
  it("keeps legacy token alerts linked to login and handles malformed data", async () => {
    const { self, emit } = worker();
    await emit("push", {
      data: {
        json: () => {
          throw new Error("text");
        },
        text: () => "Access expiring",
      },
    });
    expect(self.registration.showNotification.mock.calls[0][1]).toMatchObject({
      body: "Access expiring",
      data: { url: "/login" },
    });
  });
});
