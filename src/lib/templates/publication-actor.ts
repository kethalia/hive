import { type AuthServiceClient, getConfiguredCoderUrl, isConfiguredCoderUrl } from "@hive/auth";
import { z } from "zod";
import { type TemplatePublicationActor, TemplatePublicationError } from "./publication-contracts";
import { publicationAwait } from "./publication-io";

export type PublicationActorIdentity = Pick<
  TemplatePublicationActor,
  "ownerId" | "coderUserId" | "sessionId"
>;
export type PublicationActorAuthorizer = (
  identity: PublicationActorIdentity,
  signal: AbortSignal,
) => Promise<TemplatePublicationActor>;
/** Uses the auth service: no application encryption key or credential is persisted in a job. */
export function publicationActorAuthorizer(
  client: Pick<AuthServiceClient, "getSession" | "getCoderToken">,
): PublicationActorAuthorizer {
  return async (identity, signal) => {
    if (!Object.values(identity).every((v) => z.string().uuid().safeParse(v).success))
      throw new TemplatePublicationError("actor_revoked");
    const session = await publicationAwait(client.getSession(identity.sessionId), signal);
    if (
      !session ||
      session.userId !== identity.ownerId ||
      session.coderUserId !== identity.coderUserId ||
      session.sessionId !== identity.sessionId ||
      !isConfiguredCoderUrl(session.coderUrl) ||
      !Number.isFinite(new Date(session.expiresAt).getTime()) ||
      new Date(session.expiresAt).getTime() <= Date.now()
    )
      throw new TemplatePublicationError("actor_revoked");
    const credential = await publicationAwait(client.getCoderToken(identity.sessionId), signal);
    if (
      !credential ||
      !isConfiguredCoderUrl(credential.coderUrl) ||
      typeof credential.token !== "string" ||
      !credential.token ||
      credential.token.length > 4096 ||
      (credential.expiresAt &&
        (!Number.isFinite(new Date(credential.expiresAt).getTime()) ||
          new Date(credential.expiresAt).getTime() <= Date.now()))
    )
      throw new TemplatePublicationError("actor_revoked");
    return {
      ...identity,
      sessionExpiresAt: new Date(session.expiresAt),
      origin: getConfiguredCoderUrl(),
      token: credential.token,
      tokenExpiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
    };
  };
}
