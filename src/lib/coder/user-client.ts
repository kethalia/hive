import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/auth/encryption";
import { CoderClient } from "./client";

export enum UserClientError {
  NO_TOKEN = "NO_TOKEN",
  DECRYPT_FAILED = "DECRYPT_FAILED",
  USER_NOT_FOUND = "USER_NOT_FOUND",
}

export class UserClientException extends Error {
  constructor(
    public readonly code: UserClientError,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "UserClientException";
  }
}

export async function getCoderClientForUser(
  userId: string
): Promise<CoderClient> {
  const db = getDb();

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`[user-client] User not found: ${userId}`);
    throw new UserClientException(
      UserClientError.USER_NOT_FOUND,
      `User ${userId} not found`
    );
  }

  const token = await db.coderToken.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (!token) {
    console.error(`[user-client] No CoderToken for user: ${userId}`);
    throw new UserClientException(
      UserClientError.NO_TOKEN,
      `No Coder API token stored for user ${userId}`
    );
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error("[user-client] ENCRYPTION_KEY env var is not set");
    throw new UserClientException(
      UserClientError.DECRYPT_FAILED,
      "ENCRYPTION_KEY environment variable is not set"
    );
  }

  let decryptedToken: string;
  try {
    decryptedToken = decrypt(
      {
        ciphertext: Buffer.from(token.ciphertext),
        iv: Buffer.from(token.iv),
        authTag: Buffer.from(token.authTag),
      },
      encryptionKey
    );
  } catch (err) {
    console.error(
      `[user-client] Decrypt failed for user ${userId}:`,
      err instanceof Error ? err.message : err
    );
    throw new UserClientException(
      UserClientError.DECRYPT_FAILED,
      `Failed to decrypt token for user ${userId}`,
      err
    );
  }

  return new CoderClient({
    baseUrl: user.coderUrl,
    sessionToken: decryptedToken,
  });
}
