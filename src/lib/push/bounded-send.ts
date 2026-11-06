import type { PrismaClient } from "@hive/db";
import { cancelPublicationBody, publicationFetch } from "@/lib/templates/publication-io";
import { sendFetchPush } from "./fetch-transport";
import { notificationPreferencesSchema, type PushPayload } from "./types";
import { getVapidKeys } from "./vapid";

// Shared bounded fetch/VAPID transport for template results and agent hooks.
export async function sendBoundedPush(
  db: PrismaClient,
  ownerId: string,
  payload: PushPayload,
  subject: string,
  signal: AbortSignal = AbortSignal.timeout(15000),
): Promise<"delivered" | "retry" | "failed"> {
  signal.throwIfAborted();
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: ownerId },
    take: 21,
  });
  signal.throwIfAborted();
  if (subscriptions.length > 20) return "failed";
  const enabled = subscriptions.filter(
    (row) => notificationPreferencesSchema.parse(row.preferences ?? {})[payload.kind ?? "template"],
  );
  if (!enabled.length) return "delivered";
  if (!subject) return "retry";
  const keys = await getVapidKeys();
  signal.throwIfAborted();
  const boundedTransport: typeof fetch = async (input, init) => {
    const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    const response = await publicationFetch(
      fetch(input, { ...init, signal: requestSignal }),
      requestSignal,
    );
    await cancelPublicationBody(response);
    if (response.redirected) throw new Error("push_redirect_rejected");
    // The shared VAPID helper only needs status; do not give it a body whose
    // cancellation could outlive the sender/drained database request.
    return new Response(null, { status: response.status });
  };
  const sends = await Promise.allSettled(
    enabled.map(async (row) => {
      try {
        signal.throwIfAborted();
        await sendFetchPush(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify(payload),
          {
            TTL: 3600,
            urgency: ["ready", "template", "delivery"].includes(payload.kind ?? "")
              ? "normal"
              : "high",
            vapidDetails: { subject, ...keys },
          },
          boundedTransport,
        );
      } catch (error) {
        const code =
          error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
        if (code !== 404 && code !== 410) throw error;
        signal.throwIfAborted();
        await db.pushSubscription.deleteMany({
          where: { id: row.id, userId: ownerId, endpoint: row.endpoint },
        });
      }
    }),
  );
  return sends.some((result) => result.status === "rejected") ? "retry" : "delivered";
}
