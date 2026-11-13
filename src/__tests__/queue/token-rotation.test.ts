import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hive/db", () => ({
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

import { encrypt, TOKEN_LIFETIME_SECONDS, tryDecrypt } from "@hive/auth";
import { getDb } from "@hive/db";
import { CoderClient } from "@/lib/coder/client";
import { TOKEN_ROTATION_THRESHOLD } from "@/lib/constants";
import { processTokenRotation } from "@/lib/queue/token-rotation";

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
    coderToken: { findMany: vi.fn(), findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(mockDb as never);
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    mockDb.coderToken.findMany.mockResolvedValue([]);
    mockDb.coderToken.findUnique.mockResolvedValue(null);
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
      TOKEN_LIFETIME_SECONDS,
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

  it("handles version conflict without enumerating or deleting unproven account keys", async () => {
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
    vi.mocked(CoderClient.listApiKeys).mockResolvedValue([{ id: "old-key-id" } as never]);

    await processTokenRotation(makeJob());

    expect(CoderClient.listApiKeys).not.toHaveBeenCalled();
    expect(CoderClient.deleteApiKey).not.toHaveBeenCalled();
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

  it("retains unproven legacy, interactive and other application keys after success", async () => {
    const token = makeToken({ expiresAt: new Date(Date.now() + LIFETIME_MS / 4) });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "old-legacy-session" });
    vi.mocked(CoderClient.listApiKeys).mockResolvedValue([
      { id: "interactive" },
      { id: "other-app" },
    ] as never);
    await processTokenRotation(makeJob());
    expect(CoderClient.listApiKeys).not.toHaveBeenCalled();
    expect(CoderClient.deleteApiKey).not.toHaveBeenCalled();
  });

  it("deletes only an old key with matching recorded Hive provenance after successful CAS", async () => {
    const oldKey = `OOOOOOOOOO-${"O".repeat(22)}`;
    const token = makeToken({
      expiresAt: new Date(Date.now() + LIFETIME_MS / 4),
      rotationState: {
        schemaVersion: 1,
        managed: {
          id: "OOOOOOOOOO",
          name: "hive-r-11111111-1111-4111-8111-111111111111",
          version: 1,
        },
        pending: null,
      },
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: oldKey });
    await processTokenRotation(makeJob());
    expect(CoderClient.deleteApiKey).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      "new-api-key-123",
      "coder-uid-1",
      "OOOOOOOOOO",
    );
    expect(CoderClient.listApiKeys).not.toHaveBeenCalled();
  });

  it("deletes only this losing attempt's key when the stored credential is a different current key", async () => {
    const newKey = `NNNNNNNNNN-${"N".repeat(22)}`;
    const token = makeToken({ expiresAt: new Date(Date.now() + LIFETIME_MS / 4) });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    mockDb.coderToken.findUnique.mockResolvedValue({ ...token, version: 2 });
    mockDb.$executeRaw.mockResolvedValue(0);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "different-current-key" });
    vi.mocked(CoderClient.createApiKey).mockResolvedValue(newKey);
    await processTokenRotation(makeJob());
    expect(CoderClient.deleteApiKey).toHaveBeenCalledExactlyOnceWith(
      "https://coder.example.com",
      newKey,
      "coder-uid-1",
      "NNNNNNNNNN",
    );
    expect(CoderClient.listApiKeys).not.toHaveBeenCalled();
  });

  it("retains a losing attempt's key if it is now the active stored credential", async () => {
    const newKey = `NNNNNNNNNN-${"N".repeat(22)}`;
    const token = makeToken({ expiresAt: new Date(Date.now() + LIFETIME_MS / 4) });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    mockDb.coderToken.findUnique.mockResolvedValue({ ...token, version: 2 });
    mockDb.$executeRaw.mockResolvedValue(0);
    vi.mocked(tryDecrypt)
      .mockReturnValueOnce({ ok: true, plaintext: "old-current-key" })
      .mockReturnValueOnce({ ok: true, plaintext: newKey });
    vi.mocked(CoderClient.createApiKey).mockResolvedValue(newKey);
    await processTokenRotation(makeJob());
    expect(CoderClient.deleteApiKey).not.toHaveBeenCalled();
  });

  it("holds best-effort deletion failure without touching unrelated keys", async () => {
    const token = makeToken({
      expiresAt: new Date(Date.now() + LIFETIME_MS / 4),
      rotationState: {
        schemaVersion: 1,
        managed: {
          id: "OOOOOOOOOO",
          name: "hive-r-11111111-1111-4111-8111-111111111111",
          version: 1,
        },
        pending: null,
      },
    });
    mockDb.coderToken.findMany.mockResolvedValue([token]);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: `OOOOOOOOOO-${"O".repeat(22)}` });
    vi.mocked(CoderClient.deleteApiKey).mockRejectedValue(Error("provider detail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await processTokenRotation(makeJob());
    expect(warn).toHaveBeenCalledExactlyOnceWith("[token-rotation] Old key cleanup failed");
    expect(CoderClient.listApiKeys).not.toHaveBeenCalled();
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
