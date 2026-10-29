import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { dispatchNotificationBatch, sendDeliveryPush } from "../../../src/lib/delivery/dispatch";
import { reconcileProjectTasks } from "../../../src/lib/projects/task.server";

type Environment = {
  DATABASE_URL?: string;
  HIVE_DELIVERY_DISPATCH_ENABLED?: string;
  HIVE_PROJECT_TASKS_ENABLED?: string;
  VAPID_SUBJECT?: string;
  HIVE_PUBLIC_ORIGIN?: string;
};

export async function dispatchScheduled(env: Environment) {
  if (env.HIVE_DELIVERY_DISPATCH_ENABLED !== "true" && env.HIVE_PROJECT_TASKS_ENABLED !== "true")
    return { enabled: false };
  const context = createCloudflareDatabaseRequest(env.DATABASE_URL);
  return context.run(async () => {
    try {
      const db = getDb();
      const [noticeResult, taskResult] = await Promise.allSettled([
        env.HIVE_DELIVERY_DISPATCH_ENABLED === "true"
          ? dispatchNotificationBatch(db, (ownerId, payload) =>
              sendDeliveryPush(
                db,
                ownerId,
                payload,
                env.VAPID_SUBJECT?.trim() || env.HIVE_PUBLIC_ORIGIN?.trim() || "",
              ),
            )
          : Promise.resolve({}),
        env.HIVE_PROJECT_TASKS_ENABLED === "true"
          ? reconcileProjectTasks()
          : Promise.resolve(undefined),
      ]);
      // Independent dispatches finish before closing the shared request context;
      // a push-provider failure cannot strand accepted project preparation.
      if (noticeResult.status === "rejected" || taskResult.status === "rejected")
        throw new Error("A durable dispatch could not complete");
      return {
        enabled: true,
        ...noticeResult.value,
        ...(taskResult.value ? { projectTasks: taskResult.value } : {}),
      };
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
