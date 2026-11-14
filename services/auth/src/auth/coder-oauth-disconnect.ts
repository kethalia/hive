import { getDb, type PrismaClient } from "@hive/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { fetchCoderApi } from "./coder-fetch";
import { getCoderOAuthConfig } from "./coder-oauth-config";
import { revokeCoderOAuthAccess } from "./coder-oauth-provider";

/** Capture one exact grant while ending local sessions under the account row lock. */
export async function disconnectCoderOAuth(
  userId: string,
  options: {
    db?: PrismaClient;
    send?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  } = {},
) {
  const db = options.db ?? getDb();
  const config = getCoderOAuthConfig();
  const captured = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM coder_oauth_accounts WHERE user_id=${userId}::uuid AND provider_id='coder' FOR UPDATE`;
    const account = await tx.coderOAuthAccount.findUnique({
      where: { userId_providerId: { userId, providerId: "coder" } },
      include: { user: true },
    });
    if (
      !account ||
      account.user.coderUrl !== config.coderOrigin ||
      account.accountId !== `${config.coderOrigin}|${account.user.coderUserId}`
    )
      throw Error("coder_identity_mismatch");
    await tx.coderOAuthAccount.update({
      where: { id: account.id },
      data: {
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        refreshState: "reconnect",
        refreshHolder: null,
        refreshUntil: null,
      },
    });
    await tx.session.deleteMany({ where: { userId } });
    return account.accessToken;
  });
  if (!captured) return true;
  const token = await symmetricDecrypt({ key: config.secret, data: captured });
  return revokeCoderOAuthAccess(config, token, options.send ?? fetchCoderApi);
}
