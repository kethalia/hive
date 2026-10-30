import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { dispatchTokenWarnings, sendTokenWarning } from "../../../src/lib/auth/rotation-notices";
import { dispatchNotificationBatch, sendDeliveryPush } from "../../../src/lib/delivery/dispatch";
import {
  dispatchTemplatePublicationNotices,
  sendTemplatePublicationPush,
} from "../../../src/lib/templates/publication-notices";
import { dispatchProjectTaskReconciliation, type ProjectTaskEnvironment } from "./project-tasks";
import {
  dispatchTemplatePublication,
  type TemplatePublicationEnvironment,
} from "./template-publications";

type Environment = TemplatePublicationEnvironment &
  ProjectTaskEnvironment & {
    DATABASE_URL?: string;
    HIVE_DELIVERY_DISPATCH_ENABLED?: string;
    HIVE_PROJECT_TASKS_ENABLED?: string;
    HIVE_TOKEN_WARNING_DISPATCH_ENABLED?: string;
    HIVE_TEMPLATE_NOTIFICATION_DISPATCH_ENABLED?: string;
    VAPID_SUBJECT?: string;
    HIVE_PUBLIC_ORIGIN?: string;
  };

export async function dispatchScheduled(env: Environment) {
  if (
    env.HIVE_DELIVERY_DISPATCH_ENABLED !== "true" &&
    env.HIVE_PROJECT_TASKS_ENABLED !== "true" &&
    env.HIVE_TOKEN_WARNING_DISPATCH_ENABLED !== "true" &&
    env.HIVE_TEMPLATE_NOTIFICATION_DISPATCH_ENABLED !== "true" &&
    env.HIVE_TEMPLATE_PUBLICATION_ENABLED !== "true"
  )
    return { enabled: false };
  if (
    env.HIVE_DELIVERY_DISPATCH_ENABLED !== "true" &&
    env.HIVE_TOKEN_WARNING_DISPATCH_ENABLED !== "true" &&
    env.HIVE_TEMPLATE_NOTIFICATION_DISPATCH_ENABLED !== "true" &&
    env.HIVE_TEMPLATE_PUBLICATION_ENABLED !== "true"
  )
    return { enabled: true, projectTasks: await dispatchProjectTaskReconciliation(env) };
  const context = createCloudflareDatabaseRequest(env.DATABASE_URL, {
    queryTimeoutMillis: 10000,
    transactionTimeoutMillis: 10000,
  });
  return context.run(async () => {
    try {
      const db = getDb();
      const [noticeResult, taskResult, tokenResult, templateResult, templateNoticeResult] =
        await Promise.allSettled([
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
            ? dispatchProjectTaskReconciliation(env)
            : Promise.resolve(undefined),
          env.HIVE_TOKEN_WARNING_DISPATCH_ENABLED === "true"
            ? dispatchTokenWarnings(db, (ownerId, payload) =>
                sendTokenWarning(
                  db,
                  ownerId,
                  payload,
                  env.VAPID_SUBJECT?.trim() || env.HIVE_PUBLIC_ORIGIN?.trim() || "",
                ),
              )
            : Promise.resolve(undefined),
          dispatchTemplatePublication(db, env),
          env.HIVE_TEMPLATE_NOTIFICATION_DISPATCH_ENABLED === "true"
            ? dispatchTemplatePublicationNotices(
                db,
                (ownerId, payload, signal) =>
                  sendTemplatePublicationPush(
                    db,
                    ownerId,
                    payload,
                    env.VAPID_SUBJECT?.trim() || env.HIVE_PUBLIC_ORIGIN?.trim() || "",
                    signal,
                  ),
                { enabled: true },
              )
            : Promise.resolve(undefined),
        ]);
      // Independent dispatches finish before closing the shared request context;
      // a push-provider failure cannot strand accepted project preparation.
      if (
        noticeResult.status === "rejected" ||
        taskResult.status === "rejected" ||
        tokenResult.status === "rejected" ||
        templateResult.status === "rejected" ||
        templateNoticeResult.status === "rejected"
      )
        throw new Error("A durable dispatch could not complete");
      return {
        enabled: true,
        ...noticeResult.value,
        ...(taskResult.value ? { projectTasks: taskResult.value } : {}),
        ...(tokenResult.value ? { tokenWarnings: tokenResult.value } : {}),
        ...(templateResult.value.enabled ? { templatePublications: templateResult.value } : {}),
        ...(templateNoticeResult.value
          ? { templateNotifications: templateNoticeResult.value }
          : {}),
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
