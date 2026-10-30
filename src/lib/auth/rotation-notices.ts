import { getConfiguredCoderUrl, isConfiguredCoderUrl, TOKEN_LIFETIME_SECONDS } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import { sendFetchPush } from "@/lib/push/fetch-transport";
import { notificationPreferencesSchema, type PushPayload } from "@/lib/push/types";
import { getVapidKeys } from "@/lib/push/vapid";

type Notice = {
  id: string;
  ownerId: string;
  tokenId: string;
  tokenVersion: number;
  configuredOrigin: string;
  expiresAt: Date;
  attempts: number;
};

export async function sendTokenWarning(
  db: PrismaClient,
  ownerId: string,
  payload: PushPayload,
  subject: string,
) {
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: ownerId },
    take: 51,
  });
  if (subscriptions.length > 50) return "failed" as const;
  const enabled = subscriptions.filter(
    (row) => notificationPreferencesSchema.parse(row.preferences ?? {}).token,
  );
  if (!enabled.length) return "delivered" as const;
  if (!subject) return "retry" as const;
  const keys = await getVapidKeys();
  const sent = await Promise.allSettled(
    enabled.map(async (row) => {
      try {
        await sendFetchPush(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: "high", vapidDetails: { subject, ...keys } },
        );
      } catch (error) {
        const code =
          error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
        if (code !== 404 && code !== 410) throw error;
        await db.pushSubscription.deleteMany({
          where: { id: row.id, userId: ownerId, endpoint: row.endpoint },
        });
      }
    }),
  );
  return sent.some((row) => row.status === "rejected")
    ? ("retry" as const)
    : ("delivered" as const);
}

/** Typed metadata only; no auth encryption key or credential token is needed. */
export async function dispatchTokenWarnings(
  db: PrismaClient,
  send: (ownerId: string, payload: PushPayload) => Promise<"delivered" | "retry" | "failed">,
) {
  const origin = getConfiguredCoderUrl();
  const counts = { delivered: 0, retry: 0, failed: 0, skipped: 0, stale: 0 };
  await db.$executeRaw`
    WITH exhausted AS (
      SELECT id FROM credential_expiry_notices WHERE configured_origin=${origin}
        AND status IN ('pending','processing') AND attempts>=5 AND next_attempt_at<=clock_timestamp()
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 5
    ) UPDATE credential_expiry_notices item SET status='failed'
      FROM exhausted WHERE item.id=exhausted.id`;
  for (let n = 0; n < 5; n++) {
    const rows = await db.$queryRaw<Notice[]>`
      WITH candidate AS (
        SELECT id FROM credential_expiry_notices WHERE configured_origin=${origin}
          AND status IN ('pending','processing') AND attempts<5 AND next_attempt_at<=clock_timestamp()
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE credential_expiry_notices item SET status='processing',attempts=item.attempts+1,
          next_attempt_at=clock_timestamp()+interval '120 seconds'
        FROM candidate WHERE item.id=candidate.id
        RETURNING item.id,item.owner_id AS "ownerId",item.token_id AS "tokenId",item.token_version AS "tokenVersion",
          item.configured_origin AS "configuredOrigin",item.expires_at AS "expiresAt",item.attempts`;
    const notice = rows[0];
    if (!notice) break;
    let outcome: "delivered" | "retry" | "failed" | "skipped";
    const current = await db.coderToken.findFirst({
      where: { id: notice.tokenId, userId: notice.ownerId },
      select: {
        version: true,
        expiresAt: true,
        createdAt: true,
        user: { select: { coderUrl: true } },
      },
    });
    const now = Date.now();
    const currentExpiry =
      current &&
      (current.expiresAt?.getTime() ?? current.createdAt.getTime() + TOKEN_LIFETIME_SECONDS * 1000);
    if (
      !current ||
      current.version !== notice.tokenVersion ||
      !isConfiguredCoderUrl(current.user.coderUrl) ||
      currentExpiry !== notice.expiresAt.getTime() ||
      currentExpiry <= now ||
      currentExpiry - now > 24 * 3600_000
    )
      outcome = "skipped";
    else if (notice.attempts > 5) outcome = "failed";
    else {
      try {
        outcome = await send(notice.ownerId, {
          title: "Token expiring",
          body: `Your Coder API token expires in ${Math.round((currentExpiry - now) / 3600_000)}h. Tap to re-authenticate.`,
          tag: `token-expiry:${notice.id}`,
          kind: "token",
          url: "/login",
        });
      } catch {
        outcome = "retry";
      }
      if (outcome === "retry" && notice.attempts >= 5) outcome = "failed";
    }
    const updated = await db.$executeRaw`
      UPDATE credential_expiry_notices SET status=${outcome === "retry" ? "pending" : outcome},
        next_attempt_at=clock_timestamp()+${Math.min(3600_000, 30000 * 2 ** Math.min(notice.attempts - 1, 5))}*interval '1 millisecond'
      WHERE id=${notice.id}::uuid AND owner_id=${notice.ownerId}::uuid AND status='processing'
        AND attempts=${notice.attempts} AND next_attempt_at>clock_timestamp()`;
    if (updated === 1) counts[outcome]++;
    else counts.stale++;
  }
  return counts;
}
