import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSendPushToUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/push/send", () => ({
  sendPushToUser: (...args: unknown[]) => mockSendPushToUser(...args),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal()),
  tryDecrypt: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("@/lib/coder/client", () => ({
  CoderClient: {
    createApiKey: vi.fn(),
    listApiKeys: vi.fn(),
    deleteApiKey: vi.fn(),
  },
}));

vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: vi.fn(),
}));

import { getDb } from "@/lib/db";
import { tryDecrypt, encrypt, TOKEN_LIFETIME_SECONDS } from "@hive/auth";
import { CoderClient } from "@/lib/coder/client";
import { processTokenRotation } from "@/lib/queue/token-rotation";
import {
  TOKEN_ROTATION_THRESHOLD,
  PUSH_NOTIFICATION_HOURS,
  PUSH_NOTIFICATION_TAG,
} from "@/lib/constants";

const LIFETIME_MS = TOKEN_LIFETIME_SECONDS * 1000;

function makeJob(data = { triggeredAt: new Date().toISOString() }) {
  return { data } as Parameters<typeof processTokenRotation>[0];
}

function makeToken(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "tok-1",
    userId: "user-1",
    ciphertext: Buffer.from("enc"),
    iv: Buffer.from("iv-12-bytes!"),
    authTag: Buffer.from("tag-16-bytes!!!!"),
    version: 1,
    expiresAt: new Date(now + LIFETIME_MS),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    user: {
      id: "user-1",
      coderUrl: "https://coder.example.com",
      coderUserId: "coder-uid-1",
      username: "testuser",
      email: "test@example.com",
    },
    ...overrides,
  };
}

describe("token rotation push notification integration", () => {
  const mockDb = {
    coderToken: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDb as never);
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    mockDb.coderToken.findMany.mockResolvedValue([]);
    mockDb.$executeRaw.mockResolvedValue(1);
    vi.mocked(CoderClient.createApiKey).mockResolvedValue("new-api-key-123");
    vi.mocked(CoderClient.listApiKeys).mockResolvedValue([]);
    vi.mocked(CoderClient.deleteApiKey).mockResolvedValue(true);
    vi.mocked(encrypt).mockReturnValue({
      ciphertext: Buffer.from("new-enc"),
      iv: Buffer.from("new-iv-12-b!"),
      authTag: Buffer.from("new-tag-16-b!!!!"),
    });
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "current-session-token",
    } as ReturnType<typeof tryDecrypt>);
    mockSendPushToUser.mockResolvedValue({ sent: 1, cleaned: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENCRYPTION_KEY;
  });

  it("triggers push notification when token is ≤24h from expiry", async () => {
    const hoursLeft = 12;
    const msLeft = hoursLeft * 60 * 60 * 1000;
    const token = makeToken({
      createdAt: new Date(Date.now() - LIFETIME_MS + msLeft),
      expiresAt: new Date(Date.now() + msLeft),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);

    await processTokenRotation(makeJob());

    expect(mockSendPushToUser).toHaveBeenCalledWith("user-1", {
      title: "Hive: Token Expiring",
      body: expect.stringContaining("expires in"),
      tag: PUSH_NOTIFICATION_TAG,
    });
  });

  it("does not send notification when token has >24h remaining", async () => {
    const hoursLeft = PUSH_NOTIFICATION_HOURS + 10;
    const msLeft = hoursLeft * 60 * 60 * 1000;
    const elapsed = LIFETIME_MS - msLeft;
    const thresholdElapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;

    if (elapsed < thresholdElapsed) {
      const token = makeToken({
        createdAt: new Date(Date.now() - thresholdElapsed),
        expiresAt: new Date(Date.now() + LIFETIME_MS - thresholdElapsed),
      });
      mockDb.coderToken.findMany.mockResolvedValue([token]);

      await processTokenRotation(makeJob());

      const remainingMs = LIFETIME_MS - thresholdElapsed;
      const remainingHours = remainingMs / (1000 * 60 * 60);
      if (remainingHours > PUSH_NOTIFICATION_HOURS) {
        expect(mockSendPushToUser).not.toHaveBeenCalled();
      }
    }
  });

  it("push failure does not block token rotation", async () => {
    const hoursLeft = 12;
    const msLeft = hoursLeft * 60 * 60 * 1000;
    const token = makeToken({
      createdAt: new Date(Date.now() - LIFETIME_MS + msLeft),
      expiresAt: new Date(Date.now() + msLeft),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    mockSendPushToUser.mockRejectedValue(new Error("Push service unavailable"));

    await processTokenRotation(makeJob());

    expect(mockSendPushToUser).toHaveBeenCalled();
    expect(CoderClient.createApiKey).toHaveBeenCalledWith(
      "https://coder.example.com",
      "current-session-token",
      "coder-uid-1",
      TOKEN_LIFETIME_SECONDS
    );
    expect(mockDb.$executeRaw).toHaveBeenCalled();
  });

  it("rotation completes even when push notification throws", async () => {
    const hoursLeft = 6;
    const msLeft = hoursLeft * 60 * 60 * 1000;
    const token = makeToken({
      createdAt: new Date(Date.now() - LIFETIME_MS + msLeft),
      expiresAt: new Date(Date.now() + msLeft),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    mockSendPushToUser.mockRejectedValue(new Error("Network timeout"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await processTokenRotation(makeJob());

    expect(CoderClient.createApiKey).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[token-rotation] Push notification failed")
    );
    warnSpy.mockRestore();
  });
});
