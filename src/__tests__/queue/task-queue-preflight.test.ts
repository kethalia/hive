import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAuthError, isNetworkError } from "@/lib/queue/errors";
import {
  UserClientException,
  UserClientError,
} from "@/lib/coder/user-client";

describe("isAuthError", () => {
  it("matches 401 status in error message", () => {
    expect(isAuthError(new Error("Request failed with status 401"))).toBe(true);
  });

  it("matches 403 status in error message", () => {
    expect(isAuthError(new Error("HTTP 403 Forbidden"))).toBe(true);
  });

  it("matches UserClientException with KEY_MISMATCH", () => {
    const err = new UserClientException(
      UserClientError.KEY_MISMATCH,
      "key mismatch"
    );
    expect(isAuthError(err)).toBe(true);
  });

  it("matches UserClientException with NO_TOKEN", () => {
    const err = new UserClientException(
      UserClientError.NO_TOKEN,
      "no token"
    );
    expect(isAuthError(err)).toBe(true);
  });

  it("does not match generic errors", () => {
    expect(isAuthError(new Error("Something went wrong"))).toBe(false);
  });
});

describe("isNetworkError", () => {
  it("matches ECONNREFUSED", () => {
    expect(isNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(true);
  });

  it("matches ETIMEDOUT", () => {
    expect(isNetworkError(new Error("connect ETIMEDOUT 10.0.0.1:443"))).toBe(true);
  });

  it("matches ECONNRESET", () => {
    expect(isNetworkError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("matches ENOTFOUND", () => {
    expect(isNetworkError(new Error("getaddrinfo ENOTFOUND example.com"))).toBe(true);
  });

  it("matches 'fetch failed'", () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
  });

  it("matches 'socket hang up'", () => {
    expect(isNetworkError(new Error("socket hang up"))).toBe(true);
  });

  it("does not match generic errors", () => {
    expect(isNetworkError(new Error("Something went wrong"))).toBe(false);
  });

  it("does not match auth errors", () => {
    expect(isNetworkError(new Error("Request failed with status 401"))).toBe(false);
  });
});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth/encryption", () => ({
  tryDecrypt: vi.fn(),
}));

import { getDb } from "@/lib/db";
import { tryDecrypt } from "@/lib/auth/encryption";
import { getTokenStatus } from "@/lib/auth/token-status";

describe("pre-flight token expiry", () => {
  const mockDb = {
    coderToken: { findFirst: vi.fn() },
  };

  function mockToken(overrides: Record<string, unknown> = {}) {
    return {
      id: "tok-1",
      userId: "user-1",
      ciphertext: Buffer.from("encrypted"),
      iv: Buffer.from("iv-bytes-12b"),
      authTag: Buffer.from("auth-tag-16b!"),
      version: 1,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(mockDb as never);
    process.env.ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ENCRYPTION_KEY;
  });

  it("refuses job when token is expired", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "tok" });

    const result = await getTokenStatus("user-1");
    expect(result.status).toBe("expired");
  });

  it("refuses job when token has less than 2h remaining", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() + 1 * 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "tok" });

    const result = await getTokenStatus("user-1");
    expect(result.status).toBe("expiring");
    expect(result.expiresAt).toBeTruthy();
    const hoursLeft = (result.expiresAt!.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(hoursLeft).toBeLessThan(2);
  });

  it("returns valid when token has more than 48h remaining", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "tok" });

    const result = await getTokenStatus("user-1");
    expect(result.status).toBe("valid");
    const hoursLeft = (result.expiresAt!.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(hoursLeft).toBeGreaterThanOrEqual(48);
  });

  it("allows job when token has more than 2h remaining within warning window", async () => {
    const token = mockToken({
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    mockDb.coderToken.findFirst.mockResolvedValue(token);
    vi.mocked(tryDecrypt).mockReturnValue({ ok: true, plaintext: "tok" });

    const result = await getTokenStatus("user-1");
    expect(result.status).toBe("expiring");
    const hoursLeft = (result.expiresAt!.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(hoursLeft).toBeGreaterThanOrEqual(2);
  });
});
