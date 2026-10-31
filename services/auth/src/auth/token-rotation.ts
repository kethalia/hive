import {
  encrypt,
  getConfiguredCoderUrl,
  HEX_64_RE,
  isConfiguredCoderUrl,
  TOKEN_LIFETIME_SECONDS,
  tryDecrypt,
} from "@hive/auth";
import { getDb, type PrismaClient } from "@hive/db";
import { discardRolledBackKey, isConclusiveCredentialRollback } from "./credential-store";
import { createManagedCoderKey, deleteManagedCoderKey } from "./managed-keys";

export interface RotationOptions {
  db?: PrismaClient;
  now?: number;
  afterId?: string;
  batchSize?: number;
  thresholdFraction?: number;
  notifyWithinHours?: number;
  notifyExpiring?: (hiveUserId: string, hoursRemaining: number) => Promise<unknown>;
}

/** One bounded scan; no Redis, BullMQ, HTTP listener or startup side effects. */
export async function rotateCoderCredentials(options: RotationOptions = {}) {
  const db = options.db ?? getDb();
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("ENCRYPTION_KEY is not configured");
  if (!HEX_64_RE.test(encryptionKey)) throw new Error("ENCRYPTION_KEY must be 64 hex characters");
  const coderUrl = getConfiguredCoderUrl();
  const now = options.now ?? Date.now();
  const batchSize = options.batchSize ?? 100;
  const threshold = options.thresholdFraction ?? 0.75;
  const notifyWithinHours = options.notifyWithinHours ?? 24;
  if (
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold >= 1 ||
    !Number.isFinite(notifyWithinHours) ||
    notifyWithinHours < 0
  )
    throw new Error("Invalid rotation policy");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error("Rotation batch size must be between 1 and 100");
  const tokens = await db.coderToken.findMany({
    where: options.afterId ? { id: { gt: options.afterId } } : {},
    include: { user: true },
    orderBy: { id: "asc" },
    take: batchSize,
  });
  const result = {
    scanned: tokens.length,
    rotated: 0,
    conflicts: 0,
    skipped: 0,
    failed: 0,
    legacyKeysRetained: 0,
    cleanupFailed: 0,
    unknownWriteOutcomes: 0,
    nextCursor: tokens.length === batchSize ? tokens[tokens.length - 1].id : null,
  };
  for (const token of tokens) {
    if (!isConfiguredCoderUrl(token.user.coderUrl)) {
      result.skipped++;
      continue;
    }
    const expiresAt =
      token.expiresAt?.getTime() ?? token.createdAt.getTime() + TOKEN_LIFETIME_SECONDS * 1000;
    // updatedAt records the current credential generation. The provider's actual
    // lifetime may be shorter than the requested 30 days.
    const issuedAt = token.expiresAt ? token.updatedAt.getTime() : token.createdAt.getTime();
    const lifetime = Math.min(TOKEN_LIFETIME_SECONDS * 1000, Math.max(0, expiresAt - issuedAt));
    if (expiresAt <= now || now < expiresAt - lifetime * (1 - threshold)) {
      result.skipped++;
      continue;
    }
    const hoursRemaining = (expiresAt - now) / 3600000;
    if (hoursRemaining <= notifyWithinHours && options.notifyExpiring) {
      try {
        await options.notifyExpiring(token.userId, hoursRemaining);
      } catch {
        console.warn("[token-rotation] Push notification failed");
      }
    }
    const decrypted = tryDecrypt(
      {
        ciphertext: Buffer.from(token.ciphertext),
        iv: Buffer.from(token.iv),
        authTag: Buffer.from(token.authTag),
      },
      encryptionKey,
    );
    if (!decrypted.ok) {
      result.skipped++;
      continue;
    }
    const candidate = await createManagedCoderKey(
      coderUrl,
      decrypted.plaintext,
      token.user.coderUserId,
    );
    if (!candidate) {
      result.failed++;
      continue;
    }
    let stored: { count: number };
    try {
      const encrypted = encrypt(candidate.token, encryptionKey);
      stored = await db.coderToken.updateMany({
        where: { id: token.id, version: token.version },
        data: {
          ciphertext: new Uint8Array(encrypted.ciphertext),
          iv: new Uint8Array(encrypted.iv),
          authTag: new Uint8Array(encrypted.authTag),
          expiresAt: candidate.expiresAt,
          remoteKeyId: candidate.id,
          version: { increment: 1 },
        },
      });
    } catch (failure) {
      // Even a read of the old row cannot exclude a late commit. Only a
      // confirmed rollback authorizes cleanup; retain every unknown outcome.
      if (isConclusiveCredentialRollback(failure)) {
        if (!(await discardRolledBackKey(coderUrl, token.user.coderUserId, candidate, failure)))
          result.cleanupFailed++;
      } else result.unknownWriteOutcomes++;
      result.failed++;
      continue;
    }
    if (stored.count === 0) {
      result.conflicts++;
      if (
        !(await deleteManagedCoderKey(
          coderUrl,
          candidate.token,
          token.user.coderUserId,
          candidate.id,
        ))
      )
        result.cleanupFailed++;
      continue;
    }
    result.rotated++;
    if (token.remoteKeyId && token.remoteKeyId !== candidate.id) {
      if (
        !(await deleteManagedCoderKey(
          coderUrl,
          candidate.token,
          token.user.coderUserId,
          token.remoteKeyId,
        ))
      )
        result.cleanupFailed++;
    } else if (!token.remoteKeyId) result.legacyKeysRetained++;
  }
  return result;
}
