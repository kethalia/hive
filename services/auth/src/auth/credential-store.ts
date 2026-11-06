import type { EncryptedData } from "@hive/auth";
import type { Prisma, PrismaClient } from "@hive/db";
import { deleteManagedCoderKey, type ManagedCoderKey } from "./managed-keys";
import { createSession } from "./session";

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
export type LoginCredential = EncryptedData & {
  expiresAt: Date;
  remoteKeyId: string | null;
  credentialSource?: "legacy" | "managed_key" | "oauth";
  oauthClientId?: string;
  refreshCiphertext?: Uint8Array;
  refreshIv?: Uint8Array;
  refreshAuthTag?: Uint8Array;
};
export async function writeLoginCredential(
  tx: Pick<Prisma.TransactionClient, "coderToken" | "session">,
  userId: string,
  credential: LoginCredential,
) {
  const stored = {
    ...credential,
    ciphertext: new Uint8Array(credential.ciphertext),
    iv: new Uint8Array(credential.iv),
    authTag: new Uint8Array(credential.authTag),
    credentialSource:
      credential.credentialSource ?? (credential.remoteKeyId ? "managed_key" : "legacy"),
    oauthClientId: credential.oauthClientId ?? null,
    refreshCiphertext: credential.refreshCiphertext
      ? new Uint8Array(credential.refreshCiphertext)
      : null,
    refreshIv: credential.refreshIv ? new Uint8Array(credential.refreshIv) : null,
    refreshAuthTag: credential.refreshAuthTag ? new Uint8Array(credential.refreshAuthTag) : null,
    oauthRefreshState: "idle",
    oauthRefreshHolder: null,
    oauthRefreshUntil: null,
  };
  const previous = await tx.coderToken.findUnique({ where: { userId } });
  if (previous) {
    const result = await tx.coderToken.updateMany({
      where: { id: previous.id, version: previous.version },
      data: { ...stored, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new CredentialCASConflict();
  } else await tx.coderToken.create({ data: { userId, ...stored } });
  return {
    previousRemoteKeyId: previous?.remoteKeyId ?? null,
    sessionId: await createSession(userId, tx),
  };
}
export async function storeLoginCredential(
  db: PrismaClient,
  userId: string,
  credential: LoginCredential,
) {
  return db.$transaction((tx) => writeLoginCredential(tx, userId, credential), {
    isolationLevel: "Serializable",
  });
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
