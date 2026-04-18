import webpush from "web-push";
import { getDb } from "@/lib/db";
import { getVapidKeys } from "@/lib/push/vapid";

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; tag: string }
): Promise<{ sent: number; cleaned: number }> {
  let keys: { publicKey: string; privateKey: string };
  try {
    keys = await getVapidKeys();
  } catch (err) {
    console.error(
      `[push] Failed to get VAPID keys: ${err instanceof Error ? err.message : String(err)}`
    );
    return { sent: 0, cleaned: 0 };
  }

  webpush.setVapidDetails(
    "mailto:noreply@hive.local",
    keys.publicKey,
    keys.privateKey
  );

  const db = getDb();
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId },
  });

  let sent = 0;
  let cleaned = 0;

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      const statusCode =
        err instanceof webpush.WebPushError ? err.statusCode : undefined;

      if (statusCode === 410 || statusCode === 404) {
        try {
          await db.pushSubscription.delete({ where: { id: sub.id } });
          cleaned++;
          const domain = new URL(sub.endpoint).hostname;
          console.log(
            `[push] Cleaned stale subscription for domain ${domain}`
          );
        } catch (deleteErr) {
          console.warn(
            `[push] Failed to delete stale subscription ${sub.id}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`
          );
        }
      } else {
        const domain = new URL(sub.endpoint).hostname;
        console.error(
          `[push] Failed to send to endpoint domain ${domain}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  console.log(
    `[push] Sent ${sent} notifications, cleaned ${cleaned} stale subscriptions for user ${userId}`
  );

  return { sent, cleaned };
}
