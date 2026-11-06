import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CODER_OAUTH_FLOW_TTL_MS, decrypt, encrypt, getCoderOAuthConfig } from "@hive/auth";
import { getDb, type PrismaClient } from "@hive/db";
import {
  CoderOAuthError,
  coderOAuthApplicationsHost,
  exchangeCoderOAuth,
  verifyCoderOAuthDiscovery,
  verifyCoderOAuthIdentity,
} from "./coder-oauth-provider";
import { writeLoginCredential } from "./credential-store";
import type { LoginResult } from "./types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const secretKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new CoderOAuthError("coder_oauth_unavailable");
  return key;
};
export async function startCoderOAuth(
  options: { db?: PrismaClient; send?: typeof fetch; signal?: AbortSignal } = {},
) {
  const config = getCoderOAuthConfig();
  if (!config) throw new CoderOAuthError("coder_oauth_unavailable");
  const db = options.db ?? getDb(),
    key = secretKey();
  await verifyCoderOAuthDiscovery(config, options.send, options.signal);
  const state = random(),
    browserSecret = random(),
    verifier = random(),
    encrypted = encrypt(verifier, key);
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hive-coder-oauth-flow'),hashtext(${config.publicOrigin}))`;
      await tx.$executeRaw`DELETE FROM coder_oauth_flows WHERE id IN (SELECT id FROM coder_oauth_flows WHERE expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 100)`;
      const [count] = await tx.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM coder_oauth_flows WHERE public_origin=${config.publicOrigin} AND expires_at>clock_timestamp()`;
      if (Number(count.n) >= 1024) throw new CoderOAuthError("coder_oauth_unavailable");
      await tx.coderOAuthFlow.create({
        data: {
          id: randomUUID(),
          stateHash: hash(state),
          browserHash: hash(browserSecret),
          coderOrigin: config.coderOrigin,
          publicOrigin: config.publicOrigin,
          clientId: config.clientId,
          verifierCiphertext: new Uint8Array(encrypted.ciphertext),
          verifierIv: new Uint8Array(encrypted.iv),
          verifierAuthTag: new Uint8Array(encrypted.authTag),
        },
      });
      options.signal?.throwIfAborted();
    },
    { timeout: 5000, maxWait: 2000 },
  );
  const url = new URL(`${config.coderOrigin}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "coder:all",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { authorizationUrl: url.href, browserSecret, expiresIn: CODER_OAUTH_FLOW_TTL_MS / 1000 };
}
export async function completeCoderOAuth(
  input: { state: string; browserSecret: string; code?: string; denied?: boolean },
  options: { db?: PrismaClient; send?: typeof fetch; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const config = getCoderOAuthConfig();
  if (
    !config ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.browserSecret)
  )
    throw new CoderOAuthError("coder_oauth_flow_invalid");
  const db = options.db ?? getDb(),
    key = secretKey();
  const [flow] = await db.$queryRaw<
    {
      id: string;
      verifierCiphertext: Uint8Array;
      verifierIv: Uint8Array;
      verifierAuthTag: Uint8Array;
      expiresAt: Date;
    }[]
  >`
    UPDATE coder_oauth_flows SET consumed_at=clock_timestamp()
    WHERE state_hash=${hash(input.state)} AND browser_hash=${hash(input.browserSecret)} AND consumed_at IS NULL
      AND expires_at>clock_timestamp() AND coder_origin=${config.coderOrigin} AND public_origin=${config.publicOrigin} AND client_id=${config.clientId}
    RETURNING id,verifier_ciphertext AS "verifierCiphertext",verifier_iv AS "verifierIv",verifier_auth_tag AS "verifierAuthTag",expires_at AS "expiresAt"`;
  if (
    !flow ||
    input.denied ||
    !input.code ||
    input.code.length > 4096 ||
    Array.from(input.code).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new CoderOAuthError("coder_oauth_flow_invalid");
  // UPDATE may have evaluated its expiry predicate before waiting for a lock or
  // trigger. Never redeem a code merely because that earlier predicate passed.
  const [consumedClock] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (consumedClock.now >= flow.expiresAt) throw new CoderOAuthError("coder_oauth_flow_invalid");
  options.signal?.throwIfAborted();
  const verifier = decrypt(
    { ciphertext: flow.verifierCiphertext, iv: flow.verifierIv, authTag: flow.verifierAuthTag },
    key,
  );
  const tokens = await exchangeCoderOAuth(
    config,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: verifier,
      redirect_uri: config.callbackUrl,
    },
    options.send,
    options.signal,
  );
  if (!tokens.refreshToken) throw new CoderOAuthError("coder_oauth_unavailable");
  const [identity, applicationsHost] = await Promise.all([
    verifyCoderOAuthIdentity(config, tokens.accessToken, options.send, options.signal),
    coderOAuthApplicationsHost(config, tokens.accessToken, options.send, options.signal),
  ]);
  const access = encrypt(tokens.accessToken, key),
    refresh = encrypt(tokens.refreshToken, key);
  const result = await db.$transaction(
    async (tx) => {
      const user = await tx.user.upsert({
        where: { coderUrl_coderUserId: { coderUrl: config.coderOrigin, coderUserId: identity.id } },
        create: {
          coderUrl: config.coderOrigin,
          coderUserId: identity.id,
          username: identity.username,
          email: identity.email,
        },
        update: { username: identity.username, email: identity.email },
      });
      const stored = await writeLoginCredential(tx, user.id, {
        ...access,
        expiresAt: tokens.expiresAt,
        remoteKeyId: null,
        credentialSource: "oauth",
        oauthClientId: config.clientId,
        refreshCiphertext: new Uint8Array(refresh.ciphertext),
        refreshIv: new Uint8Array(refresh.iv),
        refreshAuthTag: new Uint8Array(refresh.authTag),
      });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      options.signal?.throwIfAborted();
      if (clock.now >= flow.expiresAt || clock.now >= tokens.expiresAt)
        throw new CoderOAuthError("coder_oauth_flow_invalid");
      return {
        sessionId: stored.sessionId,
        applicationsHost,
        user: { id: user.id, username: user.username, email: user.email, coderUrl: user.coderUrl },
      };
    },
    { isolationLevel: "Serializable", timeout: 5000, maxWait: 2000 },
  );
  return result;
}
