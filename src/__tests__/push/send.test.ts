import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockGetVapidKeys = vi.hoisted(() => vi.fn());
const mockSendNotification = vi.hoisted(() => vi.fn());
const mockSetVapidDetails = vi.hoisted(() => vi.fn());

const MockWebPushError = vi.hoisted(() => {
  class WebPushError extends Error {
    statusCode: number;
    body: string;
    constructor(message: string, statusCode: number, body = "") {
      super(message);
      this.statusCode = statusCode;
      this.body = body;
      this.name = "WebPushError";
    }
  }
  return WebPushError;
});

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
    setVapidDetails: (...args: unknown[]) => mockSetVapidDetails(...args),
    WebPushError: MockWebPushError,
  },
}));

vi.mock("@hive/db", () => ({
  getDb: () => ({
    pushSubscription: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  }),
}));

vi.mock("@/lib/push/vapid", () => ({
  getVapidKeys: (...args: unknown[]) => mockGetVapidKeys(...args),
}));

import { sendPushToUser } from "@/lib/push/send";

const vapidKeys = {
  publicKey: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XkGDdw4",
  privateKey: "aDd0SFl3UlJMeG1EbTVEcGZVVlVWQ0hPQmtVMlhhME0",
};

const makeSub = (id: string, endpoint: string) => ({
  id,
  userId: "user-1",
  endpoint,
  p256dh: "p256dh-key",
  auth: "auth-key",
  createdAt: new Date(),
});

afterEach(() => vi.unstubAllEnvs());

describe("sendPushToUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.test");
    vi.stubEnv("VAPID_SUBJECT", "");
    mockGetVapidKeys.mockResolvedValue(vapidKeys);
    mockFindMany.mockResolvedValue([]);
    mockSendNotification.mockResolvedValue({});
    mockDelete.mockResolvedValue({});
  });

  it("sends to all subscriptions for a user", async () => {
    const subs = [
      makeSub("s1", "https://fcm.googleapis.com/send/abc"),
      makeSub("s2", "https://updates.push.services.mozilla.com/push/def"),
    ];
    mockFindMany.mockResolvedValue(subs);

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 2, cleaned: 0 });
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    expect(mockSendNotification).toHaveBeenCalledWith(
      { endpoint: subs[0].endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } },
      JSON.stringify({ title: "Test", body: "Hello", tag: "test-tag" }),
      { TTL: 3600, timeout: 10_000, urgency: "high" },
    );
    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      "https://hive.test",
      vapidKeys.publicKey,
      vapidKeys.privateKey,
    );
  });

  it("supports an explicit VAPID contact without changing subscription keys", async () => {
    vi.stubEnv("VAPID_SUBJECT", "mailto:admin@example.com");
    await sendPushToUser("user-1", { title: "Test", body: "Hello", tag: "test" });
    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      "mailto:admin@example.com",
      vapidKeys.publicKey,
      vapidKeys.privateKey,
    );
  });

  it("reports missing server configuration rather than asking the user to repair their phone", async () => {
    vi.stubEnv("HIVE_PUBLIC_ORIGIN", "");
    const result = await sendPushToUser(
      "user-1",
      { title: "Test", body: "Hello", tag: "test" },
      false,
      "https://web.push.apple.com/test",
    );
    expect(result.error).toContain("server's public origin");
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("reports bounded Apple rejection details without exposing subscription or provider bodies", async () => {
    mockFindMany.mockResolvedValue([makeSub("s1", "https://web.push.apple.com/secret-endpoint")]);
    mockSendNotification.mockRejectedValue(
      new MockWebPushError(
        "secret request details",
        403,
        JSON.stringify({ reason: "BadJwtToken", secret: "private-body" }),
      ),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendPushToUser(
      "user-1",
      { title: "Test", body: "Hello", tag: "test" },
      false,
      "https://web.push.apple.com/secret-endpoint",
    );
    expect(result.error).toContain("BadJwtToken");
    expect(JSON.stringify([result, log.mock.calls])).not.toMatch(
      /secret-endpoint|private-body|secret request details/,
    );
    log.mockRestore();
  });

  it("cleans up subscription on 410 Gone", async () => {
    const subs = [makeSub("s1", "https://fcm.googleapis.com/send/abc")];
    mockFindMany.mockResolvedValue(subs);
    mockSendNotification.mockRejectedValue(new MockWebPushError("Gone", 410));

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 0, cleaned: 1 });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "s1" } });
  });

  it("cleans up subscription on 404 Not Found", async () => {
    const subs = [makeSub("s1", "https://fcm.googleapis.com/send/abc")];
    mockFindMany.mockResolvedValue(subs);
    mockSendNotification.mockRejectedValue(new MockWebPushError("Not Found", 404));

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 0, cleaned: 1 });
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "s1" } });
  });

  it("logs other errors but does not throw", async () => {
    const subs = [
      makeSub("s1", "https://fcm.googleapis.com/send/abc"),
      makeSub("s2", "https://fcm.googleapis.com/send/def"),
    ];
    mockFindMany.mockResolvedValue(subs);
    mockSendNotification
      .mockRejectedValueOnce(new MockWebPushError("Server Error", 500))
      .mockResolvedValueOnce({});

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 1, cleaned: 0 });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[push] Failed to send to endpoint domain"),
    );
    expect(mockDelete).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns correct counts with mixed results", async () => {
    const subs = [
      makeSub("s1", "https://fcm.googleapis.com/send/a"),
      makeSub("s2", "https://fcm.googleapis.com/send/b"),
      makeSub("s3", "https://fcm.googleapis.com/send/c"),
    ];
    mockFindMany.mockResolvedValue(subs);
    mockSendNotification
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new MockWebPushError("Gone", 410))
      .mockResolvedValueOnce({});

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 2, cleaned: 1 });
  });

  it("handles getVapidKeys failure gracefully", async () => {
    mockGetVapidKeys.mockRejectedValue(new Error("DB connection failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 0, cleaned: 0 });
    expect(mockSendNotification).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns zeros when user has no subscriptions", async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await sendPushToUser("user-1", {
      title: "Test",
      body: "Hello",
      tag: "test-tag",
    });

    expect(result).toEqual({ sent: 0, cleaned: 0 });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
  it("respects device event preferences and still delivers to other devices", async () => {
    mockFindMany.mockResolvedValue([
      { ...makeSub("muted", "https://fcm.googleapis.com/send/a"), preferences: { ready: false } },
      makeSub("enabled", "https://fcm.googleapis.com/send/b"),
    ]);
    expect(
      await sendPushToUser("user-1", { title: "Ready", body: "Done", tag: "ready", kind: "ready" }),
    ).toEqual({ sent: 1, cleaned: 0 });
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification.mock.calls[0][0].endpoint).toContain("/b");
    expect(mockSendNotification.mock.calls[0][2].urgency).toBe("normal");
  });

  it("reports transient failure to the worker so delivery is retried", async () => {
    mockFindMany.mockResolvedValue([makeSub("s1", "https://fcm.googleapis.com/send/a")]);
    mockSendNotification.mockRejectedValue(new MockWebPushError("Unavailable", 503));
    await expect(
      sendPushToUser("user-1", { title: "Question", body: "Waiting", tag: "question" }, true),
    ).rejects.toThrow("retrying");
  });

  it("limits a test push query to the selected device", async () => {
    await sendPushToUser(
      "user-1",
      { title: "Test", body: "Test", tag: "test" },
      false,
      "https://fcm.googleapis.com/send/a",
    );
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", endpoint: "https://fcm.googleapis.com/send/a" },
    });
  });
});
