import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encrypt, tryDecrypt } from "@/lib/auth/encryption";
import { CoderClient } from "@/lib/coder/client";
import { randomBytes } from "node:crypto";

function makeKey(): string {
  return randomBytes(32).toString("hex");
}

describe("tryDecrypt", () => {
  it("returns ok: true with valid key", () => {
    const key = makeKey();
    const data = encrypt("secret-token", key);
    const result = tryDecrypt(data, key);
    expect(result).toEqual({ ok: true, plaintext: "secret-token" });
  });

  it("returns key_mismatch with wrong key", () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const data = encrypt("secret-token", key1);
    const result = tryDecrypt(data, key2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("key_mismatch");
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns other with corrupted ciphertext", () => {
    const key = makeKey();
    const data = encrypt("secret-token", key);
    data.ciphertext = Buffer.from("corrupted");
    const result = tryDecrypt(data, key);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("key_mismatch");
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns other with truncated IV", () => {
    const key = makeKey();
    const data = encrypt("secret-token", key);
    data.iv = data.iv.subarray(0, 4);
    const result = tryDecrypt(data, key);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["key_mismatch", "other"]).toContain(result.reason);
    }
  });

  it("returns other with empty authTag", () => {
    const key = makeKey();
    const data = encrypt("secret-token", key);
    data.authTag = Buffer.alloc(0);
    const result = tryDecrypt(data, key);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["key_mismatch", "other"]).toContain(result.reason);
    }
  });
});

describe("CoderClient.listApiKeys", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns array on success", async () => {
    const keys = [
      { id: "key-1", expires_at: "2026-05-01T00:00:00Z", last_used: "2026-04-18T00:00:00Z" },
      { id: "key-2", expires_at: "2026-06-01T00:00:00Z", last_used: "2026-04-17T00:00:00Z" },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(keys), { status: 200 })
    );

    const result = await CoderClient.listApiKeys(
      "https://coder.example.com",
      "session-token",
      "user-id"
    );
    expect(result).toEqual(keys);
    expect(result).toHaveLength(2);
  });

  it("returns empty array on error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );

    const result = await CoderClient.listApiKeys(
      "https://coder.example.com",
      "bad-token",
      "user-id"
    );
    expect(result).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network error"));

    const result = await CoderClient.listApiKeys(
      "https://coder.example.com",
      "session-token",
      "user-id"
    );
    expect(result).toEqual([]);
  });
});

describe("CoderClient.deleteApiKey", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true on 204 success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 204 })
    );

    const result = await CoderClient.deleteApiKey(
      "https://coder.example.com",
      "session-token",
      "user-id",
      "key-1"
    );
    expect(result).toBe(true);
  });

  it("returns true on 200 success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );

    const result = await CoderClient.deleteApiKey(
      "https://coder.example.com",
      "session-token",
      "user-id",
      "key-1"
    );
    expect(result).toBe(true);
  });

  it("returns false on error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Not Found", { status: 404 })
    );

    const result = await CoderClient.deleteApiKey(
      "https://coder.example.com",
      "session-token",
      "user-id",
      "bad-key"
    );
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));

    const result = await CoderClient.deleteApiKey(
      "https://coder.example.com",
      "session-token",
      "user-id",
      "key-1"
    );
    expect(result).toBe(false);
  });
});
