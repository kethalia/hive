import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ENCRYPTION_ALGORITHM, HEX_64_RE, IV_LENGTH } from "./constants";
import type { DecryptResult, EncryptedData } from "./types";

export function validateEncryptionKey(key: string): void {
  if (!HEX_64_RE.test(key)) {
    throw new Error("Encryption key must be exactly 64 hex characters (32 bytes)");
  }
}

export function encrypt(plaintext: string, keyHex: string): EncryptedData {
  validateEncryptionKey(keyHex);
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, authTag };
}

export function decrypt(data: EncryptedData, keyHex: string): string {
  validateEncryptionKey(keyHex);
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, data.iv);
  decipher.setAuthTag(data.authTag);
  const decrypted = Buffer.concat([decipher.update(data.ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export function tryDecrypt(data: EncryptedData, keyHex: string): DecryptResult {
  try {
    const plaintext = decrypt(data, keyHex);
    return { ok: true, plaintext };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const msg = error.message.toLowerCase();
    const isKeyMismatch =
      msg.includes("unable to authenticate") || msg.includes("unsupported state");
    return {
      ok: false,
      reason: isKeyMismatch ? "key_mismatch" : "other",
      error,
    };
  }
}
