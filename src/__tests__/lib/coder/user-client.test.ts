import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserClientError, UserClientException } from "@/lib/coder/user-client";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal()),
  tryDecrypt: vi.fn(),
}));

vi.mock("@/lib/coder/client", () => ({
  CoderClient: vi.fn(),
}));

import { tryDecrypt } from "@hive/auth";
import { CoderClient } from "@/lib/coder/client";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { getDb } from "@/lib/db";

const MOCK_USER_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const MOCK_CODER_URL = "https://coder.example.com";

function mockToken(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    userId: MOCK_USER_ID,
    ciphertext: Buffer.from("encrypted"),
    iv: Buffer.from("iv-bytes-12b"),
    authTag: Buffer.from("auth-tag-16b!"),
    version: 1,
    createdAt: new Date("2026-04-18T00:00:00Z"),
    updatedAt: new Date("2026-04-18T00:00:00Z"),
    ...overrides,
  };
}

function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_USER_ID,
    coderUrl: MOCK_CODER_URL,
    coderUserId: "coder-uid",
    username: "testuser",
    email: "test@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("getCoderClientForUser", () => {
  const mockDb = {
    user: { findUnique: vi.fn() },
    coderToken: { findFirst: vi.fn() },
  };

  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(mockDb as never);
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENCRYPTION_KEY;
  });

  it("returns a CoderClient when user and token exist", async () => {
    const user = mockUser();
    const token = mockToken({ user });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "decrypted-session-token" });

    const clientInstance = { fake: true };
    vi.mocked(CoderClient).mockImplementation(() => clientInstance as never);

    const result = await getCoderClientForUser(MOCK_USER_ID);

    expect(result).toBe(clientInstance);
    expect(CoderClient).toHaveBeenCalledWith({
      baseUrl: MOCK_CODER_URL,
      sessionToken: "decrypted-session-token",
    });
    expect(tryDecrypt).toHaveBeenCalledWith(
      {
        ciphertext: expect.any(Buffer),
        iv: expect.any(Buffer),
        authTag: expect.any(Buffer),
      },
      "a".repeat(64),
    );
  });

  it("queries for the most recent token", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(mockToken({ user: mockUser() }));
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "tok" });
    vi.mocked(CoderClient).mockImplementation(() => ({}) as never);

    await getCoderClientForUser(MOCK_USER_ID);

    expect(mockDb.coderToken.findFirst).toHaveBeenCalledWith({
      where: { userId: MOCK_USER_ID },
      orderBy: { createdAt: "desc" },
      include: { user: true },
    });
  });

  it("throws USER_NOT_FOUND when user does not exist", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue(null);

    await expect(getCoderClientForUser(MOCK_USER_ID)).rejects.toThrow(UserClientException);

    try {
      await getCoderClientForUser(MOCK_USER_ID);
    } catch (err) {
      expect(err).toBeInstanceOf(UserClientException);
      expect((err as UserClientException).code).toBe(UserClientError.USER_NOT_FOUND);
    }
  });

  it("throws NO_TOKEN when no CoderToken exists for user", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue(mockUser());

    try {
      await getCoderClientForUser(MOCK_USER_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UserClientException);
      expect((err as UserClientException).code).toBe(UserClientError.NO_TOKEN);
    }
  });

  it("throws KEY_MISMATCH when tryDecrypt reports key_mismatch", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(mockToken({ user: mockUser() }));
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: false,
      reason: "key_mismatch",
      error: new Error("unable to authenticate data"),
    });

    try {
      await getCoderClientForUser(MOCK_USER_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UserClientException);
      expect((err as UserClientException).code).toBe(UserClientError.KEY_MISMATCH);
      expect((err as UserClientException).cause).toBeInstanceOf(Error);
    }
  });

  it("throws DECRYPT_FAILED when tryDecrypt reports other error", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(mockToken({ user: mockUser() }));
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: false,
      reason: "other",
      error: new Error("corrupted data"),
    });

    try {
      await getCoderClientForUser(MOCK_USER_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UserClientException);
      expect((err as UserClientException).code).toBe(UserClientError.DECRYPT_FAILED);
    }
  });

  it("throws DECRYPT_FAILED when ENCRYPTION_KEY is missing", async () => {
    delete process.env.ENCRYPTION_KEY;
    mockDb.coderToken.findFirst.mockResolvedValue(mockToken({ user: mockUser() }));

    try {
      await getCoderClientForUser(MOCK_USER_ID);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UserClientException);
      expect((err as UserClientException).code).toBe(UserClientError.DECRYPT_FAILED);
      expect((err as UserClientException).message).toContain("ENCRYPTION_KEY");
    }
  });

  it("logs typed errors with [user-client] prefix", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(null);
    mockDb.user.findUnique.mockResolvedValue(null);

    try {
      await getCoderClientForUser(MOCK_USER_ID);
    } catch {
      // expected
    }

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[user-client]"));
  });
});
