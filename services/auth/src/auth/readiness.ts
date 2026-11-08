import { randomUUID } from "node:crypto";
import { decrypt, encrypt, getCoderOAuthConfig, signCookie, verifyCookie } from "@hive/auth";
import { getDb, type PrismaClient } from "@hive/db";

/** Read-only configuration, crypto and authentication-schema smoke test. This
 * does not authenticate an account or prove continuity with historical keys. */
export async function readAuthenticationReadiness(
  options: {
    env?: Record<string, string | undefined>;
    db?: PrismaClient;
    signal?: AbortSignal;
  } = {},
) {
  const env = options.env ?? process.env,
    key = env.ENCRYPTION_KEY,
    cookie = env.COOKIE_SECRET,
    config = getCoderOAuthConfig(env),
    nonce = randomUUID();
  options.signal?.throwIfAborted();
  if (
    !config ||
    !key ||
    !cookie ||
    cookie.length > 4096 ||
    /[\r\n]/.test(cookie) ||
    decrypt(encrypt(nonce, key), key) !== nonce ||
    verifyCookie(signCookie(nonce, cookie), cookie)?.sessionId !== nonce
  )
    throw Error("authentication_readiness_unavailable");
  const db = options.db ?? getDb();
  await db.session.findUnique({
    where: { sessionId: nonce },
    include: { user: { include: { coderTokens: { select: { credentialSource: true } } } } },
  });
  options.signal?.throwIfAborted();
  await db.coderOAuthFlow.findUnique({ where: { id: nonce } });
  options.signal?.throwIfAborted();
  return { status: "ready" as const, coverage: "db-config-crypto-smoke" as const };
}
