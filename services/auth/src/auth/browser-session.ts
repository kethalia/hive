import type { SessionPayload } from "@hive/auth";
import { getDb } from "@hive/db";
import { createCoderAuth } from "./better-auth";
import { coderAuthCookieValues, coderOAuthEnabled } from "./coder-oauth-config";
import { getSessionById } from "./session";

/** Better Auth validates its own cookie before resolving Hive's public session UUID. */
export async function getBrowserSession(cookieHeader: string): Promise<SessionPayload | null> {
  const values = coderAuthCookieValues(cookieHeader);
  if (!coderOAuthEnabled() || values.length !== 1 || !values[0]) return null;
  const auth = createCoderAuth(getDb());
  const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookieHeader }) });
  if (!session) return null;
  const active = await getSessionById(session.session.sessionId);
  if (!active || active.user.id !== session.user.id) return null;
  return {
    userId: active.user.id,
    coderUserId: active.user.coderUserId,
    coderUrl: active.user.coderUrl,
    username: active.user.username,
    email: active.user.email,
    sessionId: active.session.sessionId,
    expiresAt: active.session.expiresAt.toISOString(),
  };
}
