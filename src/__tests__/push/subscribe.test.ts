import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpsert = vi.hoisted(() => vi.fn());
const mockDeleteMany = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockCookieStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mockCookieStore),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    pushSubscription: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { subscribePushAction, unsubscribePushAction } from "@/lib/push/subscribe";

const validSession = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "cu1",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "sid1",
    sessionId: "sess-123",
    expiresAt: new Date(Date.now() + 86400000),
  },
};

describe("subscribePushAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession);
    mockUpsert.mockResolvedValue({});
  });

  it("upserts push subscription for authenticated user", async () => {
    const result = await subscribePushAction({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      p256dh: "BNcRdre...test-key",
      auth: "tBHItJ...test-auth",
    });

    expect(result?.data).toEqual({ success: true });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        userId_endpoint: {
          userId: "user-123",
          endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        },
      },
      update: { p256dh: "BNcRdre...test-key", auth: "tBHItJ...test-auth" },
      create: {
        userId: "user-123",
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        p256dh: "BNcRdre...test-key",
        auth: "tBHItJ...test-auth",
      },
    });
  });

  it("rejects unauthenticated calls", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await subscribePushAction({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      p256dh: "key",
      auth: "auth",
    });

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects invalid input (missing endpoint)", async () => {
    const result = await subscribePushAction({
      endpoint: "not-a-url",
      p256dh: "key",
      auth: "auth",
    });

    expect(result?.validationErrors).toBeDefined();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("unsubscribePushAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(validSession);
    mockDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("deletes push subscription for authenticated user", async () => {
    const result = await unsubscribePushAction({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    });

    expect(result?.data).toEqual({ success: true });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      },
    });
  });

  it("rejects unauthenticated calls", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await unsubscribePushAction({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    });

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
