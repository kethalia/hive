import { encrypt, TOKEN_LIFETIME_SECONDS, tryDecrypt } from "@hive/auth";
import { type Job, Queue, Worker } from "bullmq";
import { CoderClient } from "@/lib/coder/client";
import {
  PUSH_NOTIFICATION_HOURS,
  PUSH_NOTIFICATION_TAG,
  TOKEN_ROTATION_QUEUE,
  TOKEN_ROTATION_THRESHOLD,
} from "@/lib/constants";
import { getDb } from "@/lib/db";
import { sendPushToUser } from "@/lib/push/send";
import { getRedisConnection } from "@/lib/queue/connection";

export interface TokenRotationJobData {
  triggeredAt: string;
}

let queue: Queue<TokenRotationJobData> | null = null;

export function getTokenRotationQueue(): Queue<TokenRotationJobData> {
  if (!queue) {
    queue = new Queue<TokenRotationJobData>(TOKEN_ROTATION_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return queue;
}

export async function processTokenRotation(_job: Job<TokenRotationJobData>): Promise<void> {
  const db = getDb();
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.log("[token-rotation] ENCRYPTION_KEY not set, skipping");
    return;
  }

  const tokens = await db.coderToken.findMany({
    include: { user: true },
  });

  const now = Date.now();
  const lifetimeMs = TOKEN_LIFETIME_SECONDS * 1000;
  const thresholdFraction = TOKEN_ROTATION_THRESHOLD;

  for (const token of tokens) {
    const userId = token.user.coderUserId;
    const effectiveExpiresAt = token.expiresAt
      ? token.expiresAt.getTime()
      : token.createdAt.getTime() + lifetimeMs;

    if (now >= effectiveExpiresAt) {
      console.log(`[token-rotation] Skipped — token expired for user ${userId}`);
      continue;
    }

    const threshold = effectiveExpiresAt - lifetimeMs * (1 - thresholdFraction);

    if (now < threshold) {
      continue;
    }

    const hoursRemaining = (effectiveExpiresAt - now) / (1000 * 60 * 60);
    if (hoursRemaining <= PUSH_NOTIFICATION_HOURS) {
      try {
        await sendPushToUser(token.userId, {
          title: "Hive: Token Expiring",
          body: `Your Coder API token expires in ${Math.round(hoursRemaining)}h. Tap to re-authenticate.`,
          tag: PUSH_NOTIFICATION_TAG,
        });
        console.log(
          `[token-rotation] Push notification triggered for user ${userId} (${Math.round(hoursRemaining)}h remaining)`,
        );
      } catch (err) {
        console.warn(
          `[token-rotation] Push notification failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const decryptResult = tryDecrypt(
      {
        ciphertext: Buffer.from(token.ciphertext),
        iv: Buffer.from(token.iv),
        authTag: Buffer.from(token.authTag),
      },
      encryptionKey,
    );

    if (!decryptResult.ok) {
      console.log(`[token-rotation] Skipped — ${decryptResult.reason} for user ${userId}`);
      continue;
    }

    const currentSessionToken = decryptResult.plaintext;
    const coderUrl = token.user.coderUrl;

    const newKey = await CoderClient.createApiKey(
      coderUrl,
      currentSessionToken,
      userId,
      TOKEN_LIFETIME_SECONDS,
    );

    if (!newKey) {
      console.log(`[token-rotation] createApiKey failed for user ${userId}`);
      continue;
    }

    const encrypted = encrypt(newKey, encryptionKey);
    const newExpiresAt = new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000);
    const oldVersion = token.version;

    const updatedCount = await db.$executeRaw`
      UPDATE coder_tokens
      SET ciphertext = ${encrypted.ciphertext},
          iv = ${encrypted.iv},
          auth_tag = ${encrypted.authTag},
          expires_at = ${newExpiresAt},
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${token.id}::uuid AND version = ${oldVersion}
    `;

    if (updatedCount === 0) {
      console.log(`[token-rotation] Skipped — version conflict for user ${userId}`);
      try {
        const keys = await CoderClient.listApiKeys(coderUrl, currentSessionToken, userId);
        for (const k of keys) {
          if (k.id !== newKey.slice(0, 10)) {
            await CoderClient.deleteApiKey(coderUrl, currentSessionToken, userId, k.id);
          }
        }
      } catch {
        // best-effort cleanup
      }
      continue;
    }

    try {
      const keys = await CoderClient.listApiKeys(coderUrl, newKey, userId);
      for (const k of keys) {
        if (k.id !== newKey.slice(0, 10)) {
          const deleted = await CoderClient.deleteApiKey(coderUrl, newKey, userId, k.id);
          if (!deleted) {
            console.warn(`[token-rotation] Failed to delete old key ${k.id} for user ${userId}`);
          }
        }
      }
    } catch (err) {
      console.warn(
        `[token-rotation] Old key cleanup failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    console.log(
      `[token-rotation] Rotated token for user ${userId}, version ${oldVersion} → ${oldVersion + 1}`,
    );
  }
}

export function createTokenRotationWorker(): Worker<TokenRotationJobData> {
  return new Worker<TokenRotationJobData>(TOKEN_ROTATION_QUEUE, processTokenRotation, {
    connection: getRedisConnection(),
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
