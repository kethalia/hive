import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("./encryption.js", () => ({
  tryDecrypt: vi.fn(),
}));

import { getDb } from "../db.js";
import { tryDecrypt } from "./encryption.js";
import { getTokenStatus } from "./token-status.js";

const MOCK_USER_ID = "aaaaaaaa-1111-2222-3333-444444444444";

function mockToken(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    userId: MOCK_USER_ID,
    ciphertext: Buffer.from("encrypted"),
    iv: Buffer.from("iv-bytes-12b"),
    authTag: Buffer.from("auth-tag-16b!"),
    version: 1,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date("2026-04-18T00:00:00Z"),
    updatedAt: new Date("2026-04-18T00:00:00Z"),
    ...overrides,
  };
}

describe("getTokenStatus", () => {
  const mockDb = {
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

  it("returns 'valid' for non-expiring token", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-token",
    });

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("valid");
    expect(result.expiresAt).toEqual(token.expiresAt);
  });

  it("returns 'expiring' for token within warning window (48h)", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-token",
    });

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("expiring");
  });

  it("returns 'expired' for token past expiry", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-token",
    });

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("expired");
  });

  it("returns 'expired' when no token exists", async () => {
    mockDb.coderToken.findFirst.mockResolvedValue(null);

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("expired");
    expect(result.expiresAt).toBeNull();
  });

  it("returns 'key_mismatch' when tryDecrypt reports key mismatch", async () => {
    const token = mockToken();
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: false,
      reason: "key_mismatch",
      error: new Error("unable to authenticate"),
    });

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("key_mismatch");
  });

  it("returns 'valid' for legacy token with null expiresAt", async () => {
    const token = mockToken({ expiresAt: null });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: true,
      plaintext: "session-token",
    });

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("valid");
    expect(result.expiresAt).toBeNull();
  });

  it("returns 'key_mismatch' when ENCRYPTION_KEY is not set", async () => {
    delete process.env.ENCRYPTION_KEY;
    const token = mockToken();
    mockDb.coderToken.findFirst.mockResolvedValue(token);

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("key_mismatch");
  });

  it("returns 'decrypt_failed' for non-key-mismatch decrypt error", async () => {
    const token = mockToken();
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({
      ok: false,
      reason: "other",
      error: new Error("corrupted data"),
    });

    const result = await getTokenStatus(MOCK_USER_ID);
    expect(result.status).toBe("decrypt_failed");
  });
});
