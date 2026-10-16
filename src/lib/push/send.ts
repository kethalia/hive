import { getDb } from "@hive/db";
import webpush from "web-push";
import { getVapidKeys } from "@/lib/push/vapid";
import { notificationPreferencesSchema, type PushPayload } from "./types";

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  retryFailures = false,
  endpoint?: string,
): Promise<{ sent: number; cleaned: number; error?: string }> {
  let keys: { publicKey: string; privateKey: string };
  try {
    keys = await getVapidKeys();
    // Apple rejects local-only VAPID subjects such as noreply@hive.local.
    const subject = process.env.VAPID_SUBJECT?.trim() || process.env.HIVE_PUBLIC_ORIGIN?.trim();
    if (!subject) throw new Error("Set HIVE_PUBLIC_ORIGIN or VAPID_SUBJECT for push delivery");
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  } catch (err) {
    console.error(
      `[push] Failed to configure delivery: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (retryFailures) throw err;
    return {
      sent: 0,
      cleaned: 0,
      ...(endpoint
        ? { error: "Push delivery is not configured. Check the server's public origin." }
        : {}),
    };
  }

  const db = getDb();
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId, ...(endpoint ? { endpoint } : {}) },
  });

  let sent = 0;
  let cleaned = 0;
  let deliveryError: string | undefined;

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
      // Provider bodies and endpoints can contain sensitive data. Only surface a
      // bounded reason code, never raw request details, credentials or responses.
      let reason: string | undefined;
      if (err instanceof webpush.WebPushError) {
        try {
          const value = JSON.parse(err.body).reason;
          if (typeof value === "string" && /^[A-Za-z0-9_]{1,80}$/.test(value)) reason = value;
        } catch {}
      }
      deliveryError =
        statusCode === 404 || statusCode === 410
          ? "This device's push subscription has expired. Disable notifications on this device, then enable them again."
          : statusCode === 401 || statusCode === 403
            ? `The push provider rejected Hive's delivery credentials${reason ? ` (${reason})` : ""}. Check the server's push configuration.`
            : "The push provider is unavailable. Try sending a test again shortly.";

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
          `[push] Failed to send to endpoint domain ${domain}: status=${statusCode ?? "unknown"} reason=${reason ?? "unavailable"}`,
        );
      }
    }
  }

  console.log(
    `[push] Sent ${sent} notifications, cleaned ${cleaned} stale subscriptions for user ${userId}`,
  );

  if (failed && retryFailures) throw new Error("Push delivery failed; retrying");
  return { sent, cleaned, ...(endpoint && deliveryError ? { error: deliveryError } : {}) };
}
