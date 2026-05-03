import type { TokenStatusResult } from "@hive/auth";
import { TOKEN_EXPIRY_WARNING_HOURS, tryDecrypt } from "@hive/auth";
import { getDb } from "../db.js";
import type { DecryptedTokenResult } from "./types.js";

export type { DecryptedTokenResult, TokenStatusResult };

export async function getTokenStatus(userId: string): Promise<TokenStatusResult> {
  const db = getDb();

  const token = await db.coderToken.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  if (!token) {
    return { status: "expired", expiresAt: null };
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    return { status: "key_mismatch", expiresAt: token.expiresAt };
  }

  const result = tryDecrypt(
    {
      ciphertext: Buffer.from(token.ciphertext),
      iv: Buffer.from(token.iv),
      authTag: Buffer.from(token.authTag),
    },
    encryptionKey,
  );

  if (!result.ok) {
    return {
      status: result.reason === "key_mismatch" ? "key_mismatch" : "decrypt_failed",
      expiresAt: token.expiresAt,
    };
  }

  if (token.expiresAt === null) {
    return { status: "valid", expiresAt: null };
  }

  const now = Date.now();
  const expiresAtMs = token.expiresAt.getTime();

  if (expiresAtMs <= now) {
    return { status: "expired", expiresAt: token.expiresAt };
  }

  const hoursLeft = (expiresAtMs - now) / (1000 * 60 * 60);
  if (hoursLeft <= TOKEN_EXPIRY_WARNING_HOURS) {
    return { status: "expiring", expiresAt: token.expiresAt };
  }

  return { status: "valid", expiresAt: token.expiresAt };
}

export async function getDecryptedCoderToken(userId: string): Promise<DecryptedTokenResult | null> {
  const db = getDb();

  const token = await db.coderToken.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  if (!token) {
    return null;
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("KEY_UNAVAILABLE");
  }

  const result = tryDecrypt(
    {
      ciphertext: Buffer.from(token.ciphertext),
      iv: Buffer.from(token.iv),
      authTag: Buffer.from(token.authTag),
    },
    encryptionKey,
  );

  if (!result.ok) {
    throw new Error(result.reason === "key_mismatch" ? "KEY_MISMATCH" : "DECRYPT_FAILED");
  }

  return {
    token: result.plaintext,
    expiresAt: token.expiresAt,
  };
}
