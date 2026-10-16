import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker(visible = false) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const client = {
    url: "https://hive.test/workspaces",
    visibilityState: visible ? "visible" : "hidden",
    focused: visible,
    postMessage: vi.fn(),
    navigate: vi.fn().mockResolvedValue(null),
    focus: vi.fn(),
  };
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
  runInNewContext(readFileSync("public/sw.js", "utf8"), { self, URL });
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
        data: { kind: "question", url: "/workspaces/w/terminal?session=dev" },
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
  it("rejects cross-origin notification navigation", async () => {
    const { client, emit } = worker();
    await emit("notificationclick", {
      notification: { close: vi.fn(), data: { url: "https://evil.test/phish" } },
    });
    expect(client.navigate).toHaveBeenCalledWith("/workspaces");
    expect(client.focus).toHaveBeenCalledOnce();
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
