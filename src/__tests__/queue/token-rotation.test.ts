import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth/encryption", () => ({
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
import { tryDecrypt, encrypt } from "@/lib/auth/encryption";
import { CoderClient } from "@/lib/coder/client";
import { processTokenRotation } from "@/lib/queue/token-rotation";
import {
  TOKEN_LIFETIME_SECONDS,
  TOKEN_ROTATION_THRESHOLD,
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

describe("processTokenRotation", () => {
  const mockDb = {
    coderToken: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
  };

  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENCRYPTION_KEY;
  });

  it("skips token not yet at threshold", async () => {
    const token = makeToken({
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);

    await processTokenRotation(makeJob());

    expect(CoderClient.createApiKey).not.toHaveBeenCalled();
  });

  it("rotates token at threshold — creates new key, updates DB", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "current-session-token",
    });

    await processTokenRotation(makeJob());

    expect(CoderClient.createApiKey).toHaveBeenCalledWith(
      "https://coder.example.com",
      "current-session-token",
      "coder-uid-1",
      TOKEN_LIFETIME_SECONDS
    );
    expect(encrypt).toHaveBeenCalledWith("new-api-key-123", "a".repeat(64));
    expect(mockDb.$executeRaw).toHaveBeenCalled();
  });

  it("handles createApiKey failure gracefully — token unchanged", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-tok",
    });
    vi.mocked(CoderClient.createApiKey).mockResolvedValue(null);

    await processTokenRotation(makeJob());

    expect(encrypt).not.toHaveBeenCalled();
    expect(mockDb.$executeRaw).not.toHaveBeenCalled();
  });

  it("handles version conflict gracefully — skips, attempts cleanup", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-tok",
    });
    mockDb.$executeRaw.mockResolvedValue(0);
    vi.mocked(CoderClient.listApiKeys).mockResolvedValue([
      { id: "old-key-id" } as never,
    ]);

    await processTokenRotation(makeJob());

    expect(CoderClient.listApiKeys).toHaveBeenCalled();
  });

  it("skips token with key_mismatch", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: false,
      reason: "key_mismatch",
      error: new Error("unable to authenticate"),
    });

    await processTokenRotation(makeJob());

    expect(CoderClient.createApiKey).not.toHaveBeenCalled();
  });

  it("skips expired token", async () => {
    const token = makeToken({
      expiresAt: new Date(Date.now() - 1000),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);

    await processTokenRotation(makeJob());

    expect(tryDecrypt).not.toHaveBeenCalled();
    expect(CoderClient.createApiKey).not.toHaveBeenCalled();
  });

  it("handles null expiresAt — calculates from createdAt", async () => {
    const createdAt = new Date(Date.now() - LIFETIME_MS * TOKEN_ROTATION_THRESHOLD);
    const token = makeToken({
      createdAt,
      expiresAt: null,
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-tok",
    });

    await processTokenRotation(makeJob());

    expect(CoderClient.createApiKey).toHaveBeenCalled();
  });

  it("attempts to delete old keys after successful update", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-tok",
    });
    mockDb.$executeRaw.mockResolvedValue(1);
    vi.mocked(CoderClient.listApiKeys).mockResolvedValue([
      { id: "old-key-id" } as never,
      { id: "another-old" } as never,
    ]);

    await processTokenRotation(makeJob());

    expect(CoderClient.listApiKeys).toHaveBeenCalledWith(
      "https://coder.example.com",
      "new-api-key-123",
      "coder-uid-1"
    );
    expect(CoderClient.deleteApiKey).toHaveBeenCalled();
  });

  it("logs warning but does not throw when deleteApiKey fails", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-tok",
    });
    mockDb.$executeRaw.mockResolvedValue(1);
    vi.mocked(CoderClient.listApiKeys).mockRejectedValue(
      new Error("network failure")
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processTokenRotation(makeJob());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[token-rotation] Old key cleanup failed")
    );
    warnSpy.mockRestore();
  });

  it("does not rotate token at 74.9% lifetime", async () => {
    const elapsed = LIFETIME_MS * 0.749;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);

    await processTokenRotation(makeJob());

    expect(tryDecrypt).not.toHaveBeenCalled();
  });

  it("rotates token at exactly 75% lifetime", async () => {
    const elapsed = LIFETIME_MS * TOKEN_ROTATION_THRESHOLD;
    const token = makeToken({
      createdAt: new Date(Date.now() - elapsed),
      expiresAt: new Date(Date.now() + LIFETIME_MS - elapsed),
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-tok",
    });

    await processTokenRotation(makeJob());

    expect(CoderClient.createApiKey).toHaveBeenCalled();
  });
});
