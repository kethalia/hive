import { encrypt, TOKEN_LIFETIME_SECONDS, tryDecrypt } from "@hive/auth";
import { getDb } from "@hive/db";
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import { z } from "zod";
import { CoderClient } from "@/lib/coder/client";
import {
  PUSH_NOTIFICATION_HOURS,
  PUSH_NOTIFICATION_TAG,
  TOKEN_ROTATION_QUEUE,
  TOKEN_ROTATION_THRESHOLD,
} from "@/lib/constants";
import { sendPushToUser } from "@/lib/push/send";
import { getRedisConnection } from "@/lib/queue/connection";

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
          title: "Token expiring",
          body: `Your Coder API token expires in ${Math.round(hoursRemaining)}h. Tap to re-authenticate.`,
          tag: PUSH_NOTIFICATION_TAG,
          kind: "token",
          url: "/login",
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
        const newKeyId = newKey.match(/^([A-Za-z0-9]{10})-[A-Za-z0-9]{22}$/)?.[1];
        const latest = newKeyId
          ? await db.coderToken.findUnique({
              where: { userId: token.userId },
              include: { user: true },
            })
          : null;
        if (
          newKeyId &&
          latest &&
          latest.user.coderUserId === userId &&
          latest.user.coderUrl === coderUrl
        ) {
          const stored = tryDecrypt(
            {
              ciphertext: Buffer.from(latest.ciphertext),
              iv: Buffer.from(latest.iv),
              authTag: Buffer.from(latest.authTag),
            },
            encryptionKey,
          );
          if (stored.ok && !stored.plaintext.startsWith(`${newKeyId}-`)) {
            // Only this losing invocation's returned key is a cleanup target.
            await CoderClient.deleteApiKey(coderUrl, newKey, userId, newKeyId);
          }
        }
      } catch {
        // Best-effort cleanup never enumerates unrelated account keys.
      }
      continue;
    }

    try {
      const proof = z
        .object({
          managed: z.object({
            id: z.string().regex(/^[A-Za-z0-9]{10}$/),
            name: z.string().regex(/^hive-r-[a-f0-9-]{36}$/),
            version: z.number().int().positive(),
          }),
        })
        .safeParse(token.rotationState);
      // Legacy credentials have no creation provenance. Retain them to expiry.
      if (
        proof.success &&
        proof.data.managed.version === oldVersion &&
        currentSessionToken.startsWith(`${proof.data.managed.id}-`) &&
        !newKey.startsWith(`${proof.data.managed.id}-`)
      ) {
        await CoderClient.deleteApiKey(coderUrl, newKey, userId, proof.data.managed.id);
      }
    } catch {
      console.warn("[token-rotation] Old key cleanup failed");
    }

    console.log(
      `[token-rotation] Rotated token for user ${userId}, version ${oldVersion} → ${oldVersion + 1}`,
    );
  }
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
