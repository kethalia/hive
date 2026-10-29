import type { EncryptedData } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import { deleteManagedCoderKey, type ManagedCoderKey } from "./managed-keys.js";
import { createSession } from "./session.js";

export class CredentialCASConflict extends Error {
  constructor() {
    super("Credential write conflict");
    this.name = "CredentialCASConflict";
  }
}

/** Only these outcomes prove this operation cannot commit later. */
export function isConclusiveCredentialRollback(failure: unknown): boolean {
  if (failure instanceof CredentialCASConflict) return true;
  if (typeof failure !== "object" || failure === null) return false;
  const error = failure as { name?: unknown; code?: unknown; clientVersion?: unknown };
  return (
    error.name === "PrismaClientKnownRequestError" &&
    (error.code === "P2034" || error.code === "P2002") &&
    typeof error.clientVersion === "string" &&
    /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(error.clientVersion)
  );
}

/** Atomic credential version/provenance replacement and local session creation. */
export async function storeLoginCredential(
  db: PrismaClient,
  userId: string,
  credential: EncryptedData & { expiresAt: Date; remoteKeyId: string | null },
) {
  const stored = {
    ...credential,
    ciphertext: new Uint8Array(credential.ciphertext),
    iv: new Uint8Array(credential.iv),
    authTag: new Uint8Array(credential.authTag),
  };
  return db.$transaction(
    async (tx) => {
      const previous = await tx.coderToken.findUnique({ where: { userId } });
      if (previous) {
        const result = await tx.coderToken.updateMany({
          where: { id: previous.id, version: previous.version },
          data: { ...stored, version: { increment: 1 } },
        });
        if (result.count !== 1) throw new CredentialCASConflict();
      } else {
        // Unique userId rejects a concurrent first-login insert. Its transaction
        // rolls back; the caller may discard only its own freshly created key.
        await tx.coderToken.create({ data: { userId, ...stored } });
      }
      return {
        previousRemoteKeyId: previous?.remoteKeyId ?? null,
        sessionId: await createSession(userId, tx),
      };
    },
    { isolationLevel: "Serializable" },
  );
}

/** A snapshot cannot prove an in-flight write will never commit. Retain unknowns. */
export async function discardRolledBackKey(
  coderUrl: string,
  coderUserId: string,
  candidate: ManagedCoderKey,
  failure: unknown,
): Promise<boolean> {
  if (!isConclusiveCredentialRollback(failure)) return false;
  return deleteManagedCoderKey(coderUrl, candidate.token, coderUserId, candidate.id);
}
