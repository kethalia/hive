import { randomUUID } from "node:crypto";
import {
  decrypt,
  encrypt,
  getCoderOAuthConfig,
  getConfiguredCoderUrl,
  isConfiguredCoderUrl,
} from "@hive/auth";
import { type CoderToken, getDb, type PrismaClient, type User } from "@hive/db";
import {
  CoderOAuthError,
  exchangeCoderOAuth,
  oauthAwait,
  verifyCoderOAuthIdentity,
} from "./coder-oauth-provider";

type Credential = CoderToken & { user: User };
const key = () => {
  const value = process.env.ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new CoderOAuthError("coder_oauth_unavailable");
  return value;
};
const open = (token: Credential, encryptionKey: string) =>
  decrypt({ ciphertext: token.ciphertext, iv: token.iv, authTag: token.authTag }, encryptionKey);
const fresh = (token: Credential) => {
  if (!token.expiresAt) return false;
  const window = Math.min(
    60000,
    Math.max(0, token.expiresAt.getTime() - token.updatedAt.getTime()) / 10,
  );
  return token.expiresAt.getTime() > Date.now() + window;
};
/** Shared credential path for API clients, auth sessions and internal token reads.
 * Refresh is serialized in Postgres; an abandoned rotating grant is held for
 * explicit reconnect, never stolen/reused or converted to a managed API key. */
export async function getUsableCoderCredential(
  userId: string,
  options: { db?: PrismaClient; send?: typeof fetch; signal?: AbortSignal } = {},
) {
  const db = options.db ?? getDb(),
    encryptionKey = key();
  const signal = AbortSignal.any([
    AbortSignal.timeout(15000),
    ...(options.signal ? [options.signal] : []),
  ]);
  for (let attempt = 0; attempt < 150; attempt++) {
    signal.throwIfAborted();
    const token = await db.coderToken.findUnique({ where: { userId }, include: { user: true } });
    signal.throwIfAborted();
    if (!token || !isConfiguredCoderUrl(token.user.coderUrl))
      throw new CoderOAuthError("coder_oauth_reconnect");
    if (token.credentialSource !== "oauth")
      return {
        token: open(token, encryptionKey),
        expiresAt: token.expiresAt,
        credentialSource: token.credentialSource,
      };
    const config = getCoderOAuthConfig();
    if (
      !config ||
      config.coderOrigin !== token.user.coderUrl ||
      config.clientId !== token.oauthClientId ||
      token.oauthRefreshState === "reconnect"
    )
      throw new CoderOAuthError("coder_oauth_reconnect");
    if (token.oauthRefreshState === "refreshing") {
      if (!token.oauthRefreshUntil || token.oauthRefreshUntil.getTime() <= Date.now()) {
        await db.coderToken.updateMany({
          where: {
            id: token.id,
            version: token.version,
            credentialSource: "oauth",
            oauthRefreshState: "refreshing",
            oauthRefreshHolder: token.oauthRefreshHolder,
          },
          data: {
            oauthRefreshState: "reconnect",
            oauthRefreshHolder: null,
            oauthRefreshUntil: null,
          },
        });
        throw new CoderOAuthError("coder_oauth_reconnect");
      }
      await oauthAwait(new Promise((done) => setTimeout(done, 100)), signal);
      continue;
    }
    if (fresh(token))
      return {
        token: open(token, encryptionKey),
        expiresAt: token.expiresAt,
        credentialSource: "oauth",
      };
    const holder = randomUUID();
    const claim = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM coder_tokens WHERE id=${token.id}::uuid FOR UPDATE`;
        const current = await tx.coderToken.findUnique({
          where: { id: token.id },
          include: { user: true },
        });
        if (
          !current ||
          current.version !== token.version ||
          current.credentialSource !== "oauth" ||
          current.oauthRefreshState !== "idle"
        )
          return null;
        if (
          current.user.coderUserId !== token.user.coderUserId ||
          current.user.coderUrl !== getConfiguredCoderUrl() ||
          current.oauthClientId !== config.clientId
        )
          throw new CoderOAuthError("coder_oauth_reconnect");
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const until = new Date(clock.now.getTime() + 30000);
        await tx.coderToken.update({
          where: { id: token.id },
          data: {
            oauthRefreshState: "refreshing",
            oauthRefreshHolder: holder,
            oauthRefreshUntil: until,
          },
        });
        signal.throwIfAborted();
        return { token: current, until };
      },
      { timeout: 5000, maxWait: 2000 },
    );
    if (!claim) continue;
    try {
      if (!claim.token.refreshCiphertext || !claim.token.refreshIv || !claim.token.refreshAuthTag)
        throw new CoderOAuthError("coder_oauth_reconnect");
      const oldRefresh = decrypt(
        {
          ciphertext: claim.token.refreshCiphertext,
          iv: claim.token.refreshIv,
          authTag: claim.token.refreshAuthTag,
        },
        encryptionKey,
      );
      const next = await exchangeCoderOAuth(
        config,
        { grant_type: "refresh_token", refresh_token: oldRefresh },
        options.send,
        signal,
      );
      const identity = await verifyCoderOAuthIdentity(
        config,
        next.accessToken,
        options.send,
        signal,
      );
      if (identity.id !== claim.token.user.coderUserId)
        throw new CoderOAuthError("coder_oauth_reconnect");
      const access = encrypt(next.accessToken, encryptionKey),
        refresh = encrypt(next.refreshToken ?? oldRefresh, encryptionKey);
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM coder_tokens WHERE id=${token.id}::uuid FOR UPDATE`;
          const current = await tx.coderToken.findUnique({
            where: { id: token.id },
            include: { user: true },
          });
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (
            !current ||
            current.version !== token.version ||
            current.credentialSource !== "oauth" ||
            current.oauthRefreshState !== "refreshing" ||
            current.oauthRefreshHolder !== holder ||
            !current.oauthRefreshUntil ||
            current.oauthRefreshUntil <= clock.now ||
            current.user.coderUserId !== identity.id ||
            current.user.coderUrl !== config.coderOrigin
          )
            throw new CoderOAuthError("coder_oauth_reconnect");
          await tx.coderToken.update({
            where: { id: token.id },
            data: {
              ciphertext: new Uint8Array(access.ciphertext),
              iv: new Uint8Array(access.iv),
              authTag: new Uint8Array(access.authTag),
              refreshCiphertext: new Uint8Array(refresh.ciphertext),
              refreshIv: new Uint8Array(refresh.iv),
              refreshAuthTag: new Uint8Array(refresh.authTag),
              expiresAt: next.expiresAt,
              version: { increment: 1 },
              oauthRefreshState: "idle",
              oauthRefreshHolder: null,
              oauthRefreshUntil: null,
            },
          });
          const [after] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          signal.throwIfAborted();
          if (after.now >= claim.until || after.now >= next.expiresAt)
            throw new CoderOAuthError("coder_oauth_reconnect");
        },
        { timeout: 5000, maxWait: 2000 },
      );
      return { token: next.accessToken, expiresAt: next.expiresAt, credentialSource: "oauth" };
    } catch (error) {
      if (error instanceof CoderOAuthError && error.code === "coder_oauth_reconnect")
        await db.coderToken.updateMany({
          where: {
            id: token.id,
            version: token.version,
            credentialSource: "oauth",
            oauthRefreshState: "refreshing",
            oauthRefreshHolder: holder,
          },
          data: {
            oauthRefreshState: "reconnect",
            oauthRefreshHolder: null,
            oauthRefreshUntil: null,
          },
        });
      if (error instanceof CoderOAuthError) throw error;
      throw new CoderOAuthError("coder_oauth_unavailable");
    }
  }
  throw new CoderOAuthError("coder_oauth_refresh_pending");
}
