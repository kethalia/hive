import { randomUUID } from "node:crypto";
import { tryDecrypt } from "@hive/auth";
import { type CoderOAuthAccount, getDb, type PrismaClient } from "@hive/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { createCoderAuth } from "./better-auth";
import { fetchCoderApi } from "./coder-fetch";
import { getCoderOAuthConfig } from "./coder-oauth-config";
import { CoderOAuthError, verifyCoderOAuthIdentity } from "./coder-oauth-provider";

export type UsableCoderCredential = {
  token: string;
  expiresAt: Date | null;
  credentialSource: "legacy" | "oauth";
  coderUrl: string;
};

async function rejectGrant(db: PrismaClient, account: CoderOAuthAccount, holder?: string) {
  return db.$transaction(async (tx) => {
    const changed = await tx.coderOAuthAccount.updateMany({
      where: {
        id: account.id,
        userId: account.userId,
        version: account.version,
        ...(holder
          ? { refreshState: "refreshing", refreshHolder: holder }
          : { refreshState: "idle" }),
      },
      data: { refreshState: "reconnect", refreshHolder: null, refreshUntil: null },
    });
    if (changed.count === 1) await tx.session.deleteMany({ where: { userId: account.userId } });
    return changed.count;
  });
}

/** Postgres serializes rotating grants across requests and Worker isolates.
 * An admitted refresh survives rollback as a lease requiring explicit reconnect. */
export async function getUsableCoderCredential(
  userId: string,
  options: {
    db?: PrismaClient;
    send?: (input: string | URL, init?: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
  } = {},
): Promise<UsableCoderCredential> {
  const db = options.db ?? getDb();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new CoderOAuthError("coder_oauth_reconnect");
  if (user.authMode !== "oauth") {
    const stored = await db.coderToken.findUnique({ where: { userId } });
    const key = process.env.ENCRYPTION_KEY;
    if (!stored || !key) throw new CoderOAuthError("coder_oauth_reconnect");
    const result = tryDecrypt(stored, key);
    if (!result.ok) throw new CoderOAuthError("coder_oauth_reconnect");
    return {
      token: result.plaintext,
      expiresAt: stored.expiresAt,
      credentialSource: "legacy",
      coderUrl: user.coderUrl,
    };
  }
  const config = getCoderOAuthConfig();
  if (user.coderUrl !== config.coderOrigin) throw new CoderOAuthError("coder_oauth_reconnect");
  const send = options.send ?? fetchCoderApi;
  const signal = AbortSignal.any([
    AbortSignal.timeout(15000),
    ...(options.signal ? [options.signal] : []),
  ]);
  for (let attempt = 0; attempt < 150; attempt++) {
    signal.throwIfAborted();
    const account = await db.coderOAuthAccount.findUnique({
      where: { userId_providerId: { userId, providerId: "coder" } },
    });
    if (
      !account ||
      account.accountId !== `${config.coderOrigin}|${user.coderUserId}` ||
      !account.accessToken ||
      !account.refreshToken ||
      !account.accessTokenExpiresAt ||
      account.refreshState === "reconnect"
    )
      throw new CoderOAuthError("coder_oauth_reconnect");
    if (account.refreshState === "refreshing") {
      if (!account.refreshUntil || account.refreshUntil.getTime() <= Date.now()) {
        await rejectGrant(db, account, account.refreshHolder ?? undefined);
        throw new CoderOAuthError("coder_oauth_reconnect");
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        const timer = setTimeout(done, 100);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      continue;
    }
    if (account.accessTokenExpiresAt.getTime() > Date.now() + 5000) {
      const token = await symmetricDecrypt({ key: config.secret, data: account.accessToken });
      try {
        const identity = await verifyCoderOAuthIdentity(config, token, send, signal);
        if (identity.id !== user.coderUserId)
          throw new CoderOAuthError("coder_oauth_reconnect", false, true);
      } catch (error) {
        if (
          error instanceof CoderOAuthError &&
          error.credentialRejected &&
          (await rejectGrant(db, account)) === 0
        )
          continue;
        throw error;
      }
      const current = await db.coderOAuthAccount.findUnique({ where: { id: account.id } });
      if (!current || current.version !== account.version || current.refreshState !== "idle")
        continue;
      return {
        token,
        expiresAt: account.accessTokenExpiresAt,
        credentialSource: "oauth",
        coderUrl: config.coderOrigin,
      };
    }
    const holder = randomUUID();
    const claim = await db.coderOAuthAccount.updateMany({
      where: { id: account.id, version: account.version, refreshState: "idle" },
      data: {
        refreshState: "refreshing",
        refreshHolder: holder,
        refreshUntil: new Date(Date.now() + 20000),
      },
    });
    if (claim.count !== 1) continue;
    let providerFailure: unknown;
    let refreshIssued = false;
    try {
      const refreshed = await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM coder_oauth_accounts WHERE id=${account.id}::uuid FOR UPDATE`;
          const current = await tx.coderOAuthAccount.findUnique({ where: { id: account.id } });
          if (
            !current ||
            current.version !== account.version ||
            current.refreshHolder !== holder ||
            current.refreshState !== "refreshing"
          )
            return null;
          const refreshSignal = AbortSignal.any([signal, AbortSignal.timeout(7000)]);
          const refreshSend: typeof send = (input, init) => {
            if (new URL(input).pathname === "/oauth2/tokens" && init?.method === "POST")
              refreshIssued = true;
            return send(input, init);
          };
          const auth = createCoderAuth(tx, {
            send: refreshSend,
            signal: refreshSignal,
            refreshing: true,
            expectedCoderUserId: user.coderUserId,
            onRefreshError: (error) => {
              providerFailure = error;
            },
          });
          const result = await auth.api.getAccessToken({ body: { accountId: account.id, userId } });
          refreshSignal.throwIfAborted();
          if (
            !result.accessToken ||
            !result.accessTokenExpiresAt ||
            result.accessTokenExpiresAt.getTime() <= Date.now()
          )
            throw new CoderOAuthError("coder_oauth_unavailable");
          await tx.coderOAuthAccount.updateMany({
            where: { id: account.id, refreshHolder: holder, refreshState: "refreshing" },
            data: { refreshState: "idle", refreshHolder: null, refreshUntil: null },
          });
          return {
            token: result.accessToken,
            expiresAt: result.accessTokenExpiresAt,
            credentialSource: "oauth" as const,
            coderUrl: config.coderOrigin,
          };
        },
        { timeout: 10000, maxWait: 2000 },
      );
      if (refreshed) return refreshed;
    } catch {
      if (
        !refreshIssued ||
        (providerFailure instanceof CoderOAuthError && providerFailure.refreshNotConsumed)
      ) {
        await db.coderOAuthAccount.updateMany({
          where: { id: account.id, version: account.version, refreshHolder: holder },
          data: { refreshState: "idle", refreshHolder: null, refreshUntil: null },
        });
        throw new CoderOAuthError("coder_oauth_unavailable");
      }
      await rejectGrant(db, account, holder);
      throw new CoderOAuthError("coder_oauth_reconnect");
    }
  }
  throw new CoderOAuthError("coder_oauth_refresh_pending");
}
