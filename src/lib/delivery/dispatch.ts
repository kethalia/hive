import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { sendFetchPush } from "@/lib/push/fetch-transport";
import { notificationPreferencesSchema, type PushPayload } from "@/lib/push/types";
import { getVapidKeys } from "@/lib/push/vapid";
import { DeliveryOutbox, deliverClaim } from "./outbox";

// A bounded Worker invocation. Push is at-least-once; stable event tags collapse
// retried notifications on each device. The durable report remains the source of truth.
export async function sendDeliveryPush(
  db: PrismaClient,
  ownerId: string,
  payload: PushPayload,
  subject: string,
  transport: typeof fetch = fetch,
): Promise<"delivered" | "retry" | "failed"> {
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: ownerId },
    take: 51,
  });
  // Bound network fan-out. Do not silently acknowledge skipped devices.
  if (subscriptions.length > 50) return "failed";
  const enabled = subscriptions.filter(
    (sub) => notificationPreferencesSchema.parse(sub.preferences ?? {}).delivery,
  );
  if (enabled.length === 0) return "delivered";
  if (!subject) return "retry";
  const keys = await getVapidKeys();
  const results = await Promise.allSettled(
    enabled.map(async (sub) => {
      try {
        await sendFetchPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: "normal", vapidDetails: { subject, ...keys } },
          transport,
        );
      } catch (error) {
        const status =
          error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
        if (status !== 404 && status !== 410) throw error;
        // Match the selected subscription's exact owner and endpoint too; a new
        // account association must not be removed by a delayed provider response.
        await db.pushSubscription.deleteMany({
          where: { id: sub.id, userId: ownerId, endpoint: sub.endpoint },
        });
      }
    }),
  );
  return results.some((result) => result.status === "rejected") ? "retry" : "delivered";
}

export async function dispatchNotificationBatch(
  db: PrismaClient,
  send: (ownerId: string, payload: PushPayload) => Promise<"delivered" | "retry" | "failed">,
  ownerLimit = 5,
) {
  z.number().int().min(1).max(5).parse(ownerLimit);
  const due = await db.$queryRaw<{ ownerId: string }[]>`
    SELECT owner_id AS "ownerId" FROM delivery_outbox
    WHERE channel = 'push' AND status IN ('pending', 'processing')
      AND next_attempt_at <= clock_timestamp()
    GROUP BY owner_id ORDER BY min(next_attempt_at), owner_id LIMIT ${ownerLimit}`;
  const outbox = new DeliveryOutbox(db);
  const counts = { delivered: 0, retry: 0, failed: 0, stale: 0 };
  for (const { ownerId } of due) {
    const claims = await outbox.claim(ownerId, 1);
    for (const claim of claims) {
      const result = await deliverClaim(outbox, claim, send);
      counts[result]++;
    }
  }
  return counts;
}
