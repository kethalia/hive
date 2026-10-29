import { encrypt, getConfiguredCoderUrl, TOKEN_LIFETIME_SECONDS } from "@hive/auth";
import { getDb } from "@hive/db";
import { coderLogin, createCoderApiKey, validateCoderInstance } from "./coder-api.js";
import { API_KEY_CREATION_RETRIES, SESSION_TOKEN_FALLBACK_EXPIRY_MS } from "./constants.js";
import { createSession } from "./session.js";
import type { LoginResult } from "./types.js";

export type { LoginResult };

function getTokenEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  if (Buffer.from(key, "hex").length !== 32) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }
  return key;
}

export async function performLogin(email: string, password: string): Promise<LoginResult> {
  const coderUrl = getConfiguredCoderUrl();

  const validation = await validateCoderInstance(coderUrl);
  if (!validation.valid) {
    throw new Error(`Invalid Coder instance: ${validation.reason}`);
  }

  console.log(`[auth-service] Coder instance validated: ${coderUrl}`);

  const loginResult = await coderLogin(coderUrl, email, password);
  console.log(`[auth-service] Authenticated user: ${loginResult.username}`);

  let credential = loginResult.sessionToken;
  let usedApiKey = false;

  for (let attempt = 1; attempt <= API_KEY_CREATION_RETRIES; attempt++) {
    const apiKey = await createCoderApiKey(
      coderUrl,
      loginResult.sessionToken,
      loginResult.userId,
      TOKEN_LIFETIME_SECONDS,
    );
    if (apiKey) {
      credential = apiKey;
      usedApiKey = true;
      console.log(`[auth-service] API key created on attempt ${attempt}`);
      break;
    }
    console.log(
      `[auth-service] API key creation attempt ${attempt}/${API_KEY_CREATION_RETRIES} failed`,
    );
  }

  if (!usedApiKey) {
    console.log("[auth-service] Falling back to session token as credential (R101)");
  }

  const expiresAt = usedApiKey
    ? new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000)
    : new Date(Date.now() + SESSION_TOKEN_FALLBACK_EXPIRY_MS);

  const encryptionKey = getTokenEncryptionKey();
  const raw = encrypt(credential, encryptionKey);
  const encrypted = {
    ciphertext: new Uint8Array(raw.ciphertext),
    iv: new Uint8Array(raw.iv),
    authTag: new Uint8Array(raw.authTag),
  };

  const user = await getDb().user.upsert({
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

  await getDb().coderToken.upsert({
    where: { userId: user.id },
    update: {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      expiresAt,
      version: { increment: 1 },
    },
    create: {
      userId: user.id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      expiresAt,
    },
  });

  const sessionId = await createSession(user.id);
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
