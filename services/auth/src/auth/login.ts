import { encrypt } from "./encryption.js";
import { createSession } from "./session.js";
import {
  validateCoderInstance,
  coderLogin,
  createCoderApiKey,
} from "./coder-api.js";
import { TOKEN_LIFETIME_SECONDS } from "./constants.js";
import { getDb } from "../db.js";

const API_KEY_CREATION_RETRIES = 3;

function getTokenEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  if (Buffer.from(key, "hex").length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)",
    );
  }
  return key;
}

export interface LoginResult {
  sessionId: string;
  user: {
    id: string;
    username: string;
    email: string;
    coderUrl: string;
  };
}

export async function performLogin(
  coderUrl: string,
  email: string,
  password: string,
): Promise<LoginResult> {
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
      console.log(
        `[auth-service] API key created on attempt ${attempt}`,
      );
      break;
    }
    console.log(
      `[auth-service] API key creation attempt ${attempt}/${API_KEY_CREATION_RETRIES} failed`,
    );
  }

  if (!usedApiKey) {
    console.log(
      "[auth-service] Falling back to session token as credential (R101)",
    );
  }

  const expiresAt = usedApiKey
    ? new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000)
    : new Date(Date.now() + 24 * 60 * 60 * 1000);

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
    user: {
      id: user.id,
      username: loginResult.username,
      email,
      coderUrl: coderUrl.replace(/\/+$/, ""),
    },
  };
}
