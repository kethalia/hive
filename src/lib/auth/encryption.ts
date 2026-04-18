import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export interface EncryptedData {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function validateEncryptionKey(key: string): void {
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `Encryption key must be exactly 32 bytes (64 hex chars), got ${buf.length} bytes`
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
