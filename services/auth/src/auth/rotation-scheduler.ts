import {
  getConfiguredCoderUrl,
  HEX_64_RE,
  isConfiguredCoderUrl,
  TOKEN_LIFETIME_SECONDS,
  tryDecrypt,
} from "@hive/auth";
import { getDb, type PrismaClient } from "@hive/db";
import { CredentialCASConflict, isConclusiveCredentialRollback } from "./credential-store";
import { createManagedCoderKey, deleteManagedCoderKey, type ManagedCoderKey } from "./managed-keys";
import {
  ROTATION_LIMITS,
  RotationLeaseLost,
  type RotationOperation,
  rotationTiming,
} from "./rotation-contracts";
import { CredentialRotationStore } from "./rotation-store";

export type RotationStore = Pick<
  CredentialRotationStore,
  "claim" | "next" | "prepare" | "commit" | "finish" | "advance" | "release"
>;

export async function awaitRotationProvider<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("rotation_provider_deadline"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Auth-Worker internal entry; no HTTP endpoint and no scheduler on import. */
export async function runCredentialRotation(
  options: {
    db?: PrismaClient;
    enabled?: boolean;
    createKey?: typeof createManagedCoderKey;
    deleteKey?: typeof deleteManagedCoderKey;
    store?: RotationStore;
  } = {},
) {
  if (!(options.enabled ?? process.env.HIVE_TOKEN_ROTATION_ENABLED === "true"))
    return { enabled: false as const };
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey || !HEX_64_RE.test(encryptionKey))
    throw new Error("rotation_encryption_configuration_invalid");
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare" && process.env.CODER_CA_CERT?.trim())
    throw new Error("rotation_custom_ca_not_supported");
  const origin = getConfiguredCoderUrl(),
    store = options.store ?? new CredentialRotationStore(options.db ?? getDb()),
    claim = await store.claim(origin),
    counts = { scanned: 0, minted: 0, rotated: 0, held: 0, skipped: 0, cleanupFailed: 0 };
  if (!claim) return { enabled: true as const, claimed: false, ...counts };
  const deadline = AbortSignal.timeout(ROTATION_LIMITS.invocationMs),
    create = options.createKey ?? createManagedCoderKey,
    remove = options.deleteKey ?? deleteManagedCoderKey;
  const discard = async (credential: string, userId: string, id: string) => {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(ROTATION_LIMITS.providerMs)]);
    try {
      signal.throwIfAborted();
      return await awaitRotationProvider(remove(origin, credential, userId, id, signal), signal);
    } catch {
      return false;
    }
  };
  try {
    for (; counts.scanned < ROTATION_LIMITS.scan && !deadline.aborted; ) {
      const token = await store.next(claim);
      if (!token) {
        await store.advance(claim, null, true);
        break;
      }
      if (!isConfiguredCoderUrl(token.user.coderUrl)) {
        counts.skipped++;
        counts.scanned++;
        await store.advance(claim, token.id);
        continue;
      }
      const timing = rotationTiming(token, Date.now());
      if (timing.eligible && counts.minted >= ROTATION_LIMITS.mints) break;
      const decrypted = timing.eligible
        ? tryDecrypt(
            {
              ciphertext: Buffer.from(token.ciphertext),
              iv: Buffer.from(token.iv),
              authTag: Buffer.from(token.authTag),
            },
            encryptionKey,
          )
        : null;
      let operation: RotationOperation | null;
      try {
        operation = await store.prepare(claim, token, {
          mint: timing.eligible && decrypted?.ok === true,
          notify: timing.notify,
          expiresAt: timing.expiresAt,
        });
      } catch (error) {
        if (!(error instanceof CredentialCASConflict)) throw error;
        counts.skipped++;
        counts.scanned++;
        await store.advance(claim, token.id);
        continue;
      }
      if (operation && decrypted?.ok) {
        counts.minted++;
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(ROTATION_LIMITS.providerMs)]);
        let candidate: ManagedCoderKey | null;
        try {
          signal.throwIfAborted();
          candidate = await awaitRotationProvider(
            create(
              origin,
              decrypted.plaintext,
              token.user.coderUserId,
              TOKEN_LIFETIME_SECONDS,
              signal,
            ),
            signal,
          );
        } catch {
          // Abort bounds our wait, not the provider's side effect. The durable
          // generation reservation remains consumed even if the request finishes later.
          candidate = null;
        }
        if (!candidate) {
          counts.held++;
          await store.finish(operation, "uncertain", "mint_unknown");
        } else {
          try {
            await store.commit(claim, operation, token, candidate, encryptionKey);
            counts.rotated++;
            if (token.remoteKeyId && token.remoteKeyId !== candidate.id)
              if (!(await discard(candidate.token, token.user.coderUserId, token.remoteKeyId)))
                counts.cleanupFailed++;
          } catch (error) {
            const rolledBack =
              error instanceof RotationLeaseLost || isConclusiveCredentialRollback(error);
            const cleaned = rolledBack
              ? await discard(candidate.token, token.user.coderUserId, candidate.id)
              : false;
            if (rolledBack && !cleaned) counts.cleanupFailed++;
            counts.held++;
            await store.finish(
              operation,
              rolledBack ? "not_stored" : "uncertain",
              rolledBack ? (cleaned ? "rolled_back" : "cleanup_failed") : "write_unknown",
              candidate.id,
            );
          }
        }
      } else if (timing.eligible && decrypted?.ok) counts.held++;
      else counts.skipped++;
      counts.scanned++;
      await store.advance(claim, token.id);
    }
    return { enabled: true as const, claimed: true, ...counts };
  } finally {
    await store.release(claim);
  }
}
