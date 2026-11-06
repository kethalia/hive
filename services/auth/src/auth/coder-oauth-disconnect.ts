import {
  type CoderDisconnectRequest,
  type CoderDisconnectResult,
  decrypt,
  getCoderOAuthConfig,
} from "@hive/auth";
import { getDb, type PrismaClient } from "@hive/db";
import { revokeCoderOAuthAccess } from "./coder-oauth-provider";

export class CoderDisconnectError extends Error {
  constructor(
    readonly code:
      | "coder_disconnect_unauthorized"
      | "coder_disconnect_changed"
      | "coder_disconnect_busy"
      | "coder_disconnect_unsupported",
  ) {
    super(code);
  }
}

export function isCoderDisconnectOperation(
  value: unknown,
): value is CoderDisconnectRequest & { sessionId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  return (
    Object.keys(input).length === 3 &&
    typeof input.sessionId === "string" &&
    uuid.test(input.sessionId) &&
    typeof input.credentialId === "string" &&
    uuid.test(input.credentialId) &&
    Number.isSafeInteger(input.version) &&
    Number(input.version) >= 1 &&
    Number(input.version) < 2147483647
  );
}

/** Authorize and detach one captured OAuth generation before external I/O.
 * An unknown outcome remains a reconnect hold, never proof of remote cutoff.
 * Replays lose their authorizing session; no post-provider write can affect a
 * newer sign-in. No caller-supplied user, origin or provider token is accepted. */
export async function disconnectCoderOAuth(
  sessionId: string,
  expected: CoderDisconnectRequest,
  options: { db?: PrismaClient; send?: typeof fetch; signal?: AbortSignal } = {},
): Promise<CoderDisconnectResult> {
  const config = getCoderOAuthConfig();
  if (!config) throw new CoderDisconnectError("coder_disconnect_unsupported");
  const db = options.db ?? getDb();
  options.signal?.throwIfAborted();
  // This read discovers the lock owner only. Authority is rechecked under lock.
  const initial = await db.session.findUnique({ where: { sessionId }, select: { userId: true } });
  if (!initial) throw new CoderDisconnectError("coder_disconnect_unauthorized");
  const captured = await db.$transaction(
    async (tx) => {
      options.signal?.throwIfAborted();
      await tx.$queryRaw`SELECT id FROM users WHERE id=${initial.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM coder_tokens WHERE user_id=${initial.userId}::uuid FOR UPDATE`;
      options.signal?.throwIfAborted();
      const session = await tx.session.findUnique({
        where: { sessionId },
        include: { user: true },
      });
      const token = await tx.coderToken.findUnique({ where: { userId: initial.userId } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (
        !session ||
        session.userId !== initial.userId ||
        session.expiresAt <= clock.now ||
        session.user.coderUrl !== config.coderOrigin
      )
        throw new CoderDisconnectError("coder_disconnect_unauthorized");
      if (!token || token.credentialSource !== "oauth" || token.oauthClientId !== config.clientId)
        throw new CoderDisconnectError("coder_disconnect_unsupported");
      if (token.id !== expected.credentialId || token.version !== expected.version)
        throw new CoderDisconnectError("coder_disconnect_changed");
      if (token.oauthRefreshState !== "idle")
        throw new CoderDisconnectError("coder_disconnect_busy");
      const claim = await tx.coderToken.updateMany({
        where: {
          id: token.id,
          userId: initial.userId,
          version: expected.version,
          credentialSource: "oauth",
          oauthClientId: config.clientId,
          oauthRefreshState: "idle",
        },
        data: { version: { increment: 1 }, oauthRefreshState: "reconnect" },
      });
      if (claim.count !== 1) throw new CoderDisconnectError("coder_disconnect_changed");
      options.signal?.throwIfAborted();
      await tx.session.deleteMany({ where: { userId: initial.userId } });
      const [after] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      options.signal?.throwIfAborted();
      if (session.expiresAt <= after.now)
        throw new CoderDisconnectError("coder_disconnect_unauthorized");
      return token;
    },
    { timeout: 5000, maxWait: 2000 },
  );

  // From this point local disconnection has committed. A closed browser cannot
  // undo it or safely reuse the grant. Finish the bounded exact-token attempt
  // independently of caller cancellation; retain every unconfirmed outcome.
  let acknowledged = false;
  try {
    const key = process.env.ENCRYPTION_KEY;
    if (key && /^[a-f0-9]{64}$/i.test(key)) {
      const access = decrypt(captured, key);
      acknowledged = await revokeCoderOAuthAccess(config, access, options.send);
    }
  } catch {
    /* Local authority stays detached; no token/provider error is logged. */
  }
  let currentConnection: CoderDisconnectResult["currentConnection"] = "unknown";
  try {
    const current = await db.coderToken.findUnique({
      where: { userId: initial.userId },
      select: { id: true, version: true, credentialSource: true, oauthRefreshState: true },
    });
    currentConnection =
      current?.id === captured.id &&
      current.version === captured.version + 1 &&
      current.credentialSource === "oauth" &&
      current.oauthRefreshState === "reconnect"
        ? "disconnected"
        : "changed";
  } catch {
    /* A response cannot promise the state of an unread newer login. */
  }
  return {
    status: "disconnected",
    providerRevocation: acknowledged ? "acknowledged" : "unconfirmed",
    currentConnection,
  };
}
