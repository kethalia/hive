import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindMany = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockGetVapidKeys = vi.hoisted(() => vi.fn());
const mockSendNotification = vi.hoisted(() => vi.fn());
const mockSetVapidDetails = vi.hoisted(() => vi.fn());

const MockWebPushError = vi.hoisted(() => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
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

vi.mock("@/lib/db", () => ({
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

describe("sendPushToUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      JSON.stringify({ title: "Test", body: "Hello", tag: "test-tag" })
    );
    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      "mailto:noreply@hive.local",
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
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
      expect.stringContaining("[push] Failed to send to endpoint domain")
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
});
