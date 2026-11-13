import type { PrismaClient } from "@hive/db";
import { cancelTerminalBody, terminalFetch } from "@/lib/terminal/transport-io";
import { sendFetchPush } from "./fetch-transport";
import { notificationPreferencesSchema, type PushPayload } from "./types";
import { getVapidKeys } from "./vapid";

/** Bounded pages preserve subscriptions created before the Worker migration. */
export async function sendBoundedPush(
  db: Pick<PrismaClient, "pushSubscription" | "vapidKeys">,
  ownerId: string,
  payload: PushPayload,
  subject: string,
  signal: AbortSignal = AbortSignal.timeout(15000),
  deadline = Date.now() + 15000,
): Promise<"delivered" | "retry" | "failed"> {
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw Error("push_deadline");
  };
  const boundedTransport: typeof fetch = async (input, init) => {
    checkDeadline();
    const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
    const response = await terminalFetch(
      fetch(input, { ...init, signal: requestSignal }),
      requestSignal,
    );
    await cancelTerminalBody(response);
    if (response.redirected) throw Error("push_redirect_rejected");
    return new Response(null, { status: response.status });
  };
  let cursor: string | undefined;
  let keys: Awaited<ReturnType<typeof getVapidKeys>> | undefined;
  let retry = false;
  do {
    checkDeadline();
    const subscriptions = await db.pushSubscription.findMany({
      where: { userId: ownerId },
      orderBy: { id: "asc" },
      take: 20,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    checkDeadline();
    const enabled = subscriptions.filter(
      (row) =>
        notificationPreferencesSchema.parse(row.preferences ?? {})[payload.kind ?? "template"],
    );
    if (enabled.length) {
      if (!subject) return "retry";
      keys ??= await getVapidKeys(db);
      checkDeadline();
      const vapidDetails = { subject, ...keys };
      for (let offset = 0; offset < enabled.length; offset += 5) {
        const sends = await Promise.allSettled(
          enabled.slice(offset, offset + 5).map(async (row) => {
            try {
              checkDeadline();
              await sendFetchPush(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                JSON.stringify(payload),
                {
                  TTL: 3600,
                  urgency: ["ready", "template"].includes(payload.kind ?? "") ? "normal" : "high",
                  vapidDetails,
                },
                boundedTransport,
              );
            } catch (error) {
              const code =
                error && typeof error === "object" && "statusCode" in error
                  ? error.statusCode
                  : null;
              if (code !== 404 && code !== 410) throw error;
              checkDeadline();
              await db.pushSubscription.deleteMany({
                where: { id: row.id, userId: ownerId, endpoint: row.endpoint },
              });
            }
          }),
        );
        retry ||= sends.some((result) => result.status === "rejected");
      }
    }
    cursor = subscriptions.length === 20 ? subscriptions[19].id : undefined;
  } while (cursor);
  return retry ? "retry" : "delivered";
}
