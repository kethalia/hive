import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { dispatchNotificationBatch, sendDeliveryPush } from "../../../src/lib/delivery/dispatch";

type Environment = {
  DATABASE_URL?: string;
  HIVE_DELIVERY_DISPATCH_ENABLED?: string;
  VAPID_SUBJECT?: string;
  HIVE_PUBLIC_ORIGIN?: string;
};

export async function dispatchScheduled(env: Environment) {
  if (env.HIVE_DELIVERY_DISPATCH_ENABLED !== "true") return { enabled: false };
  const context = createCloudflareDatabaseRequest(env.DATABASE_URL);
  return context.run(async () => {
    try {
      const db = getDb();
      const result = await dispatchNotificationBatch(db, (ownerId, payload) =>
        sendDeliveryPush(
          db,
          ownerId,
          payload,
          env.VAPID_SUBJECT?.trim() || env.HIVE_PUBLIC_ORIGIN?.trim() || "",
        ),
      );
      return { enabled: true, ...result };
    } finally {
      await context.close();
    }
  });
}

export default {
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event: unknown, env: Environment) {
    // Cron is merely a wake-up. PostgreSQL owns claims, replay and retry timing;
    // no process-local timer or Redis service is required for delivery notices.
    try {
      const result = await dispatchScheduled(env);
      console.log(JSON.stringify({ event: "delivery_dispatch", ...result }));
    } catch {
      throw new Error("Delivery dispatch unavailable; durable notices remain pending.");
    }
  },
};
