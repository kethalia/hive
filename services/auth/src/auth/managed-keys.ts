import { randomUUID } from "node:crypto";
import { TOKEN_LIFETIME_SECONDS } from "@hive/auth";
import { fetchCoderApi } from "./coder-fetch.js";
import { CODER_API_TIMEOUT_MS } from "./constants.js";

export interface ManagedCoderKey {
  id: string;
  token: string;
  expiresAt: Date;
}

// Coder's apikey.Generate produces a 10-character ID and 22-character secret.
// Refuse unknown formats instead of guessing which remote key may be deleted.
export function coderKeyId(token: string): string | null {
  return /^([A-Za-z0-9]{10})-[A-Za-z0-9]{22}$/.exec(token)?.[1] ?? null;
}

interface KeyMetadata {
  id: string;
  user_id: string;
  expires_at: string;
  token_name: string;
  login_type: string;
}

async function metadata(
  baseUrl: string,
  token: string,
  userId: string,
  keyId: string,
): Promise<KeyMetadata | null> {
  try {
    const response = await fetchCoderApi(
      `${baseUrl}/api/v2/users/${encodeURIComponent(userId)}/keys/${keyId}`,
      {
        headers: { "Coder-Session-Token": token },
        signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const data = (await response.json()) as Partial<KeyMetadata>;
    return data.id === keyId && data.user_id === userId && typeof data.expires_at === "string"
      ? (data as KeyMetadata)
      : null;
  } catch {
    return null;
  }
}

/** Create a dedicated named Hive key and verify its identity and actual expiry. */
export async function createManagedCoderKey(
  coderUrl: string,
  credential: string,
  userId: string,
  lifetimeSeconds = TOKEN_LIFETIME_SECONDS,
): Promise<ManagedCoderKey | null> {
  const lifetime = lifetimeSeconds * 1_000_000_000;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) throw new Error("Invalid key lifetime");
  const baseUrl = coderUrl.replace(/\/+$/, "");
  const name = `hive-${randomUUID()}`;
  const startedAt = Date.now();
  try {
    // Coder CreateTokenRequest.lifetime is Go time.Duration (nanoseconds).
    // POST /keys creates a session and ignores the old lifetime_seconds body.
    const response = await fetchCoderApi(
      `${baseUrl}/api/v2/users/${encodeURIComponent(userId)}/keys/tokens`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Coder-Session-Token": credential },
        body: JSON.stringify({ token_name: name, lifetime }),
        signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const data: unknown = await response.json();
    const token =
      typeof data === "object" && data !== null && "key" in data && typeof data.key === "string"
        ? data.key
        : null;
    const id = token && coderKeyId(token);
    if (!token || !id) return null;
    const key = await metadata(baseUrl, token, userId, id);
    if (!key || key.token_name !== name || key.login_type !== "token") return null;
    const expiresAt = new Date(key.expires_at);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      expiresAt.getTime() > startedAt + lifetimeSeconds * 1000 + 60_000
    )
      return null;
    return { id, token, expiresAt };
  } catch {
    // Never log provider bodies, credentials, query strings or request errors.
    // Unverified keys are retained for expiry rather than deleting a guessed ID.
    return null;
  }
}

/** Metadata for a fallback login session does not confer Hive key ownership. */
export async function getCoderCredentialExpiry(coderUrl: string, token: string, userId: string) {
  const id = coderKeyId(token);
  if (!id) return null;
  const key = await metadata(coderUrl.replace(/\/+$/, ""), token, userId, id);
  const expiresAt = key && new Date(key.expires_at);
  return expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now()
    ? expiresAt
    : null;
}

/** Caller supplies only a positively tracked Hive ID, never a user key list. */
export async function deleteManagedCoderKey(
  coderUrl: string,
  credential: string,
  userId: string,
  keyId: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9]{10}$/.test(keyId)) return false;
  try {
    const response = await fetchCoderApi(
      `${coderUrl.replace(/\/+$/, "")}/api/v2/users/${encodeURIComponent(userId)}/keys/${keyId}`,
      {
        method: "DELETE",
        headers: { "Coder-Session-Token": credential },
        signal: AbortSignal.timeout(CODER_API_TIMEOUT_MS),
      },
    );
    await response.body?.cancel().catch(() => {});
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
