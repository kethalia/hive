import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export interface EncryptedData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

export function validateEncryptionKey(key: string): void {
  if (!HEX_64_RE.test(key)) {
    throw new Error(
      "Encryption key must be exactly 64 hex characters (32 bytes)"
    );
  }
}

export function encrypt(plaintext: string, keyHex: string): EncryptedData {
  validateEncryptionKey(keyHex);
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, authTag };
}

export function decrypt(data: EncryptedData, keyHex: string): string {
  validateEncryptionKey(keyHex);
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, data.iv);
  decipher.setAuthTag(data.authTag);
  const decrypted = Buffer.concat([
    decipher.update(data.ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export type DecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "key_mismatch" | "other"; error: Error };

export function tryDecrypt(data: EncryptedData, keyHex: string): DecryptResult {
  try {
    const plaintext = decrypt(data, keyHex);
    return { ok: true, plaintext };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const msg = error.message.toLowerCase();
    const isKeyMismatch =
      msg.includes("unable to authenticate") ||
      msg.includes("unsupported state");
    return {
      ok: false,
      reason: isKeyMismatch ? "key_mismatch" : "other",
      error,
    };
  }
}
