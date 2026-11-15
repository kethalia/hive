import { tryDecrypt } from "@hive/auth";
import { getDb } from "@hive/db";
import { CoderClient } from "./client";

export enum UserClientError {
  NO_TOKEN = "NO_TOKEN",
  DECRYPT_FAILED = "DECRYPT_FAILED",
  KEY_MISMATCH = "KEY_MISMATCH",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  OAUTH_RECONNECT = "OAUTH_RECONNECT",
}

export class UserClientException extends Error {
  constructor(
    public readonly code: UserClientError,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UserClientException";
  }
}

export async function getCoderClientForUser(
  userId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CoderClient> {
  options.signal?.throwIfAborted();
  const db = getDb();

  const token = await db.coderToken.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { user: true },
  });
  options.signal?.throwIfAborted();
  const user = token?.user ?? (await db.user.findUnique({ where: { id: userId } }));
  options.signal?.throwIfAborted();
  if (!user) {
    console.error(`[user-client] User not found: ${userId}`);
    throw new UserClientException(UserClientError.USER_NOT_FOUND, `User ${userId} not found`);
  }
  if (user.authMode === "oauth") {
    const { getUsableCoderCredential } = await import(
      "../../../services/auth/src/auth/coder-oauth-credentials"
    );
    const credential = await getUsableCoderCredential(userId, { db, signal: options.signal });
    options.signal?.throwIfAborted();
    if (
      credential.credentialSource !== "oauth" ||
      credential.coderUrl !== user.coderUrl ||
      !credential.expiresAt ||
      !Number.isFinite(credential.expiresAt.getTime()) ||
      credential.expiresAt.getTime() <= Date.now()
    )
      throw new UserClientException(
        UserClientError.OAUTH_RECONNECT,
        "Coder sign-in requires reconnection",
      );
    return new CoderClient({
      baseUrl: credential.coderUrl,
      sessionToken: credential.token,
      credentialSource: "oauth",
      credentialExpiresAt: credential.expiresAt,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  if (!token) {
    console.error(`[user-client] No CoderToken for user: ${userId}`);
    throw new UserClientException(
      UserClientError.NO_TOKEN,
      `No Coder API token stored for user ${userId}`,
    );
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error("[user-client] ENCRYPTION_KEY env var is not set");
    throw new UserClientException(
      UserClientError.DECRYPT_FAILED,
      "ENCRYPTION_KEY environment variable is not set",
    );
  }

  const decryptResult = tryDecrypt(
    {
      ciphertext: Buffer.from(token.ciphertext),
      iv: Buffer.from(token.iv),
      authTag: Buffer.from(token.authTag),
    },
    encryptionKey,
  );

  if (!decryptResult.ok) {
    const msg = `[user-client] Decrypt failed for user ${userId}: ${decryptResult.error.message}`;
    console.error(msg);
    if (decryptResult.reason === "key_mismatch") {
      throw new UserClientException(
        UserClientError.KEY_MISMATCH,
        `Encryption key mismatch for user ${userId} — token re-encryption required`,
        decryptResult.error,
      );
    }
    throw new UserClientException(
      UserClientError.DECRYPT_FAILED,
      `Failed to decrypt token for user ${userId}`,
      decryptResult.error,
    );
  }

  const decryptedToken = decryptResult.plaintext;

  return new CoderClient({
    baseUrl: user.coderUrl,
    sessionToken: decryptedToken,
    credentialSource: "legacy",
    credentialExpiresAt: token.expiresAt,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
