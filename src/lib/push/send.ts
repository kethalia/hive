import { getDb } from "@hive/db";
import webpush from "web-push";
import { getVapidKeys } from "@/lib/push/vapid";
import { notificationPreferencesSchema, type PushPayload } from "./types";

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  retryFailures = false,
  endpoint?: string,
): Promise<{ sent: number; cleaned: number }> {
  let keys: { publicKey: string; privateKey: string };
  try {
    keys = await getVapidKeys();
  } catch (err) {
    console.error(
      `[push] Failed to get VAPID keys: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (retryFailures) throw err;
    return { sent: 0, cleaned: 0 };
  }

  webpush.setVapidDetails("mailto:noreply@hive.local", keys.publicKey, keys.privateKey);

  const db = getDb();
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId, ...(endpoint ? { endpoint } : {}) },
  });

  let sent = 0;
  let cleaned = 0;

  let failed = false;
  for (const sub of subscriptions) {
    const preferences = notificationPreferencesSchema.parse(sub.preferences ?? {});
    if (payload.kind && !preferences[payload.kind]) continue;
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
        {
          TTL: 3600,
          urgency: payload.kind === "ready" || payload.kind === "template" ? "normal" : "high",
          timeout: 10_000,
        },
      );
      sent++;
    } catch (err) {
      const statusCode = err instanceof webpush.WebPushError ? err.statusCode : undefined;

      if (statusCode === 410 || statusCode === 404) {
        try {
          await db.pushSubscription.delete({ where: { id: sub.id } });
          cleaned++;
          const domain = new URL(sub.endpoint).hostname;
          console.log(`[push] Cleaned stale subscription for domain ${domain}`);
        } catch (deleteErr) {
          console.warn(
            `[push] Failed to delete stale subscription ${sub.id}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`,
          );
        }
      } else {
        failed = true;
        const domain = new URL(sub.endpoint).hostname;
        console.error(
          `[push] Failed to send to endpoint domain ${domain}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(
    `[push] Sent ${sent} notifications, cleaned ${cleaned} stale subscriptions for user ${userId}`,
  );

  if (failed && retryFailures) throw new Error("Push delivery failed; retrying");
  return { sent, cleaned };
}
