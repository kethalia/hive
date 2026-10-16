import { createHash } from "node:crypto";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { getRedisConnection } from "@/lib/queue/connection";
import { sendPushToUser } from "./send";
import type { PushPayload } from "./types";

interface NotificationJob {
  userId: string;
  sourceId: string;
  payload: PushPayload;
}
let queue: Queue<NotificationJob> | null = null;
export function getNotificationQueue() {
  queue ??= new Queue<NotificationJob>("agent-notifications", {
    connection: getRedisConnection() as unknown as ConnectionOptions,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 86400, count: 10000 },
      removeOnFail: { age: 86400, count: 1000 },
    },
  });
  return queue;
}
export async function enqueueNotification(data: NotificationJob, eventId: string) {
  const jobId = createHash("sha256").update(`${data.sourceId}:${eventId}`).digest("hex");
  await getNotificationQueue().add("deliver", data, { jobId });
}
export function createNotificationWorker() {
  return new Worker<NotificationJob>(
    "agent-notifications",
    async (job) => {
      // Revoked workspace callbacks must not deliver queued events.
      const { getDb } = await import("@hive/db");
      if (!(await getDb().notificationSource.findUnique({ where: { id: job.data.sourceId } })))
        return;
      await sendPushToUser(job.data.userId, job.data.payload, true);
    },
    { connection: getRedisConnection() as unknown as ConnectionOptions, concurrency: 5 },
  );
}
