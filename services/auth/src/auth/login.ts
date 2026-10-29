import { encrypt, getConfiguredCoderUrl, HEX_64_RE } from "@hive/auth";
import { getDb } from "@hive/db";
import { coderLogin, validateCoderInstance } from "./coder-api.js";
import { API_KEY_CREATION_RETRIES, SESSION_TOKEN_FALLBACK_EXPIRY_MS } from "./constants.js";
import { discardRolledBackKey, storeLoginCredential } from "./credential-store.js";
import {
  createManagedCoderKey,
  deleteManagedCoderKey,
  getCoderCredentialExpiry,
  type ManagedCoderKey,
} from "./managed-keys.js";
import type { LoginResult } from "./types.js";

export type { LoginResult };

function getTokenEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  if (!HEX_64_RE.test(key)) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }
  return key;
}

export async function performLogin(email: string, password: string): Promise<LoginResult> {
  const coderUrl = getConfiguredCoderUrl();
  const encryptionKey = getTokenEncryptionKey();

  const validation = await validateCoderInstance(coderUrl);
  if (!validation.valid) {
    throw new Error(`Invalid Coder instance: ${validation.reason}`);
  }

  console.log(`[auth-service] Coder instance validated: ${coderUrl}`);

  const loginResult = await coderLogin(coderUrl, email, password);
  console.log(`[auth-service] Authenticated user: ${loginResult.username}`);

  let credential = loginResult.sessionToken;
  let managed: ManagedCoderKey | null = null;

  for (let attempt = 1; attempt <= API_KEY_CREATION_RETRIES; attempt++) {
    const apiKey = await createManagedCoderKey(
      coderUrl,
      loginResult.sessionToken,
      loginResult.userId,
    );
    if (apiKey) {
      credential = apiKey.token;
      managed = apiKey;
      console.log(`[auth-service] API key created on attempt ${attempt}`);
      break;
    }
    console.log(
      `[auth-service] API key creation attempt ${attempt}/${API_KEY_CREATION_RETRIES} failed`,
    );
  }

  if (!managed) {
    console.log("[auth-service] Falling back to session token as credential (R101)");
  }

  const expiresAt =
    managed?.expiresAt ??
    (await getCoderCredentialExpiry(coderUrl, credential, loginResult.userId)) ??
    new Date(Date.now() + SESSION_TOKEN_FALLBACK_EXPIRY_MS);

  const raw = encrypt(credential, encryptionKey);
  const encrypted = {
    ciphertext: new Uint8Array(raw.ciphertext),
    iv: new Uint8Array(raw.iv),
    authTag: new Uint8Array(raw.authTag),
  };

  const db = getDb();
  let user: Awaited<ReturnType<typeof db.user.upsert>>;
  try {
    user = await db.user.upsert({
      where: {
        coderUrl_coderUserId: {
          coderUrl: coderUrl.replace(/\/+$/, ""),
          coderUserId: loginResult.userId,
        },
      },
      update: {
        username: loginResult.username,
        email,
      },
      create: {
        coderUrl: coderUrl.replace(/\/+$/, ""),
        coderUserId: loginResult.userId,
        username: loginResult.username,
        email,
      },
    });
  } catch (failure) {
    if (managed)
      await deleteManagedCoderKey(coderUrl, managed.token, loginResult.userId, managed.id);
    throw failure;
  }
  let stored: Awaited<ReturnType<typeof storeLoginCredential>>;
  try {
    stored = await storeLoginCredential(db, user.id, {
      ...encrypted,
      expiresAt,
      remoteKeyId: managed?.id ?? null,
    });
  } catch (failure) {
    if (managed) await discardRolledBackKey(coderUrl, loginResult.userId, managed, failure);
    throw failure;
  }
  if (managed && stored.previousRemoteKeyId && stored.previousRemoteKeyId !== managed.id)
    await deleteManagedCoderKey(
      coderUrl,
      managed.token,
      loginResult.userId,
      stored.previousRemoteKeyId,
    );
  const { sessionId } = stored;
  console.log(`[auth-service] Session created for user ${user.id}`);

  return {
    sessionId,
    applicationsHost: loginResult.applicationsHost,
    user: {
      id: user.id,
      username: loginResult.username,
      email,
      coderUrl: coderUrl.replace(/\/+$/, ""),
    },
  };
}
