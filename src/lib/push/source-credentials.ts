import { createHash, createHmac, randomUUID } from "node:crypto";
import { getDb } from "@hive/db";

export function callbackToken(sourceId: string, generation: number): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error("Notification credential key is not configured");
  return createHmac("sha256", secret)
    .update(`hive-notification-callback:${sourceId}:${generation}`)
    .digest("hex");
}
export function callbackTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function stageNotificationCredential(
  userId: string,
  workspaceId: string,
  workspaceName: string,
) {
  const db = getDb();
  const id = randomUUID();
  let source = await db.notificationSource.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    create: {
      id,
      userId,
      workspaceId,
      workspaceName,
      tokenHash: callbackTokenHash(callbackToken(id, 0)),
    },
    update: {},
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (source.pendingTokenHash) {
      const token = callbackToken(source.id, source.credentialGeneration);
      if (callbackTokenHash(token) !== source.pendingTokenHash)
        throw new Error("Pending notification credential cannot be recovered");
      return { source, token };
    }
    const generation = source.credentialGeneration + 1;
    const token = callbackToken(source.id, generation);
    const pendingTokenHash = callbackTokenHash(token);
    // Persist the candidate before any remote write, keeping the active hash valid.
    const staged = await db.notificationSource.updateMany({
      where: {
        id: source.id,
        credentialGeneration: source.credentialGeneration,
        pendingTokenHash: null,
      },
      data: { credentialGeneration: generation, pendingTokenHash },
    });
    if (staged.count)
      return { source: { ...source, credentialGeneration: generation, pendingTokenHash }, token };
    source = await db.notificationSource.findUniqueOrThrow({ where: { id: source.id } });
  }
  throw new Error("Workspace notification setup changed; retry");
}

export async function confirmNotificationCredential(
  sourceId: string,
  generation: number,
  token: string,
  workspaceName: string,
) {
  const hash = callbackTokenHash(token);
  // A late completion cannot replace a more recent rotation or resurrect a revoked source.
  await getDb().notificationSource.updateMany({
    where: { id: sourceId, credentialGeneration: generation, pendingTokenHash: hash },
    data: { tokenHash: hash, pendingTokenHash: null, workspaceName },
  });
}
