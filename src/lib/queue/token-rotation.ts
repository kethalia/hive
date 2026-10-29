import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import {
  PUSH_NOTIFICATION_HOURS,
  PUSH_NOTIFICATION_TAG,
  TOKEN_ROTATION_QUEUE,
  TOKEN_ROTATION_THRESHOLD,
} from "@/lib/constants";
import { sendPushToUser } from "@/lib/push/send";
import { getRedisConnection } from "@/lib/queue/connection";
import { rotateCoderCredentials } from "../../../services/auth/src/auth/token-rotation";

export interface TokenRotationJobData {
  triggeredAt: string;
}

let queue: Queue<TokenRotationJobData> | null = null;

export function getTokenRotationQueue(): Queue<TokenRotationJobData> {
  if (!queue) {
    queue = new Queue<TokenRotationJobData>(TOKEN_ROTATION_QUEUE, {
      connection: getRedisConnection() as unknown as ConnectionOptions,
    }) as unknown as Queue<TokenRotationJobData>;
  }
  return queue;
}

export async function processTokenRotation(_job: Job<TokenRotationJobData>): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) {
    console.log("[token-rotation] ENCRYPTION_KEY not set, skipping");
    return;
  }
  let afterId: string | undefined;
  do {
    const result = await rotateCoderCredentials({
      afterId,
      thresholdFraction: TOKEN_ROTATION_THRESHOLD,
      notifyWithinHours: PUSH_NOTIFICATION_HOURS,
      notifyExpiring: (userId, hoursRemaining) =>
        sendPushToUser(userId, {
          title: "Token expiring",
          body: `Your Coder API token expires in ${Math.round(hoursRemaining)}h. Tap to re-authenticate.`,
          tag: PUSH_NOTIFICATION_TAG,
          kind: "token",
          url: "/login",
        }),
    });
    console.log(`[token-rotation] ${JSON.stringify(result)}`);
    afterId = result.nextCursor ?? undefined;
  } while (afterId);
}

export function createTokenRotationWorker(): Worker<TokenRotationJobData> {
  return new Worker<TokenRotationJobData>(TOKEN_ROTATION_QUEUE, processTokenRotation, {
    connection: getRedisConnection() as unknown as ConnectionOptions,
    concurrency: 1,
  });
}

export async function scheduleTokenRotation(): Promise<void> {
  const q = getTokenRotationQueue();
  await q.upsertJobScheduler(
    "token-rotation-scheduler",
    { every: 60 * 60 * 1000 },
    { data: { triggeredAt: new Date().toISOString() } },
  );
}
