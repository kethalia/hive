import type { PrismaClient } from "@hive/db";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { type TemplatePublicationActor, TemplatePublicationError } from "./publication-contracts";

export function getConfiguredCoderUrl() {
  const value = process.env.CODER_URL ?? "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new TemplatePublicationError("actor_revoked");
  return value;
}
export function isConfiguredCoderUrl(value: string) {
  return value === getConfiguredCoderUrl();
}
/** Legacy credential authority is refreshed for every stage, never stored in jobs. */
export async function authorizeTemplateActor(
  db: PrismaClient,
  identity: { ownerId: string; coderUserId: string; sessionId: string },
  signal: AbortSignal,
): Promise<TemplatePublicationActor> {
  signal.throwIfAborted();
  const session = await db.session.findUnique({
    where: { sessionId: identity.sessionId },
    include: { user: true },
  });
  if (
    !session ||
    session.userId !== identity.ownerId ||
    session.user.coderUserId !== identity.coderUserId ||
    session.expiresAt.getTime() <= Date.now() ||
    !isConfiguredCoderUrl(session.user.coderUrl)
  )
    throw new TemplatePublicationError("actor_revoked");
  const client = await getCoderClientForUser(identity.ownerId, { signal });
  signal.throwIfAborted();
  if (!isConfiguredCoderUrl(client.getBaseUrl()))
    throw new TemplatePublicationError("actor_revoked");
  const credential = await db.coderToken.findUnique({
    where: { userId: identity.ownerId },
    select: { expiresAt: true },
  });
  signal.throwIfAborted();
  if (!credential || (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()))
    throw new TemplatePublicationError("actor_revoked");
  return {
    ...identity,
    origin: client.getBaseUrl(),
    token: client.getSessionToken(),
    sessionExpiresAt: session.expiresAt,
    tokenExpiresAt: credential.expiresAt,
  };
}
