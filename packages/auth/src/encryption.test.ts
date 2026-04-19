import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, tryDecrypt, validateEncryptionKey } from "./encryption.js";

const VALID_KEY = randomBytes(32).toString("hex");

describe("validateEncryptionKey", () => {
  it("accepts valid 64-char hex key", () => {
    expect(() => validateEncryptionKey(VALID_KEY)).not.toThrow();
  });

  it("rejects short keys", () => {
    expect(() => validateEncryptionKey("abcd")).toThrow("64 hex characters");
  });

  it("rejects non-hex characters", () => {
    expect(() => validateEncryptionKey("g".repeat(64))).toThrow("64 hex characters");
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips plaintext", () => {
    const plaintext = "my-secret-token";
    const encrypted = encrypt(plaintext, VALID_KEY);
    const result = decrypt(encrypted, VALID_KEY);
    expect(result).toBe(plaintext);
  });

  it("handles unicode", () => {
    const plaintext = "emoji: 🔐 — ñ — 日本語";
    const encrypted = encrypt(plaintext, VALID_KEY);
    expect(decrypt(encrypted, VALID_KEY)).toBe(plaintext);
  });

  it("produces different IVs each time", () => {
    const a = encrypt("same", VALID_KEY);
    const b = encrypt("same", VALID_KEY);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
  });
});

describe("tryDecrypt", () => {
  it("returns ok:true on success", () => {
    const encrypted = encrypt("hello", VALID_KEY);
    const result = tryDecrypt(encrypted, VALID_KEY);
    expect(result).toEqual({ ok: true, plaintext: "hello" });
  });

  it("returns key_mismatch for wrong key", () => {
    const encrypted = encrypt("hello", VALID_KEY);
    const wrongKey = randomBytes(32).toString("hex");
    const result = tryDecrypt(encrypted, wrongKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("key_mismatch");
    }
  });

  it("returns other for corrupted data", () => {
    const encrypted = encrypt("hello", VALID_KEY);
    encrypted.ciphertext = new Uint8Array([1, 2, 3]);
    const result = tryDecrypt(encrypted, VALID_KEY);
    expect(result.ok).toBe(false);
  });
});
