import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, validateEncryptionKey } from "../../lib/auth/encryption";

const VALID_KEY = randomBytes(32).toString("hex");

describe("validateEncryptionKey", () => {
  it("accepts a valid 32-byte hex key", () => {
    expect(() => validateEncryptionKey(VALID_KEY)).not.toThrow();
  });

  it("rejects an empty key", () => {
    expect(() => validateEncryptionKey("")).toThrow("32 bytes");
  });

  it("rejects a too-short key", () => {
    const short = randomBytes(16).toString("hex");
    expect(() => validateEncryptionKey(short)).toThrow("32 bytes");
  });

  it("rejects a too-long key", () => {
    const long = randomBytes(48).toString("hex");
    expect(() => validateEncryptionKey(long)).toThrow("32 bytes");
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips a simple string", () => {
    const plaintext = "hello world";
    const encrypted = encrypt(plaintext, VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const encrypted = encrypt("", VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe("");
  });

  it("round-trips a very long string", () => {
    const long = "x".repeat(100_000);
    const encrypted = encrypt(long, VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe(long);
  });

  it("round-trips unicode content", () => {
    const text = "こんにちは 🌍 émojis";
    const encrypted = encrypt(text, VALID_KEY);
    expect(decrypt(encrypted, VALID_KEY)).toBe(text);
  });

  it("produces different ciphertext on each call (random IV)", () => {
    const a = encrypt("same", VALID_KEY);
    const b = encrypt("same", VALID_KEY);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("throws when decrypting with the wrong key", () => {
    const encrypted = encrypt("secret", VALID_KEY);
    const wrongKey = randomBytes(32).toString("hex");
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("throws when ciphertext is corrupted", () => {
    const encrypted = encrypt("test", VALID_KEY);
    encrypted.ciphertext[0] ^= 0xff;
    expect(() => decrypt(encrypted, VALID_KEY)).toThrow();
  });

  it("throws when authTag is corrupted", () => {
    const encrypted = encrypt("test", VALID_KEY);
    encrypted.authTag[0] ^= 0xff;
    expect(() => decrypt(encrypted, VALID_KEY)).toThrow();
  });

  it("rejects invalid key in encrypt", () => {
    expect(() => encrypt("hello", "tooshort")).toThrow("32 bytes");
  });

  it("rejects invalid key in decrypt", () => {
    const encrypted = encrypt("hello", VALID_KEY);
    expect(() => decrypt(encrypted, "bad")).toThrow("32 bytes");
  });
});
