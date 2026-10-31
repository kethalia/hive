import { createHash } from "node:crypto";
import { getConfiguredCoderUrl } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import type { PublicationActorAuthorizer, PublicationActorIdentity } from "./publication-actor";
import { publicationNameSchema } from "./publication-contracts";
import { publicationAwait } from "./publication-io";
import { type TemplateLogPage, templateLogCursorSchema } from "./publication-log-contracts";
import { readPublicationLogPage, TemplateLogAccessError } from "./publication-log-provider";

export class TemplatePublicationLogService {
  constructor(
    private readonly db: PrismaClient,
    private readonly authorize: PublicationActorAuthorizer,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async read(
    who: PublicationActorIdentity,
    name: string,
    jobId: string,
    after: string,
    signal: AbortSignal,
  ) {
    publicationNameSchema.parse(name);
    templateLogCursorSchema.parse(after);
    const actor = await publicationAwait(this.authorize(who, signal), signal);
    const job = await this.db.templatePublicationJob.findFirst({
      where: { id: jobId, ownerId: who.ownerId, templateName: name },
      include: { target: true, owner: true },
    });
    if (!job) throw new TemplateLogAccessError("not_found");
    const origin = getConfiguredCoderUrl();
    const authorized = (value: typeof actor) =>
      value.ownerId === who.ownerId &&
      value.coderUserId === who.coderUserId &&
      value.sessionId === who.sessionId &&
      value.origin === origin &&
      value.sessionExpiresAt.getTime() > Date.now() &&
      job.actorCoderUserId === who.coderUserId &&
      job.target.configuredOrigin === origin &&
      job.owner.coderUserId === who.coderUserId &&
      job.owner.coderUrl === origin;
    if (!authorized(actor)) throw new TemplateLogAccessError("actor_revoked");
    const slug = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
    const available = !!(job.versionId && job.fileId && job.importJobId);
    const coderUrl =
      available &&
      job.target.templateId &&
      (job.operationMode !== "create" || job.stage === "succeeded") &&
      [job.target.organizationName, job.templateName, job.versionName].every((v) => slug.test(v))
        ? `${origin}/templates/${job.target.organizationName}/${job.templateName}/versions/${job.versionName}`
        : `${origin}/templates`;
    const viewScope = createHash("sha256")
      .update(JSON.stringify([who.ownerId, who.coderUserId, who.sessionId, job.id]))
      .digest("hex");
    let page: TemplateLogPage = { records: [], nextAfter: after, hasMore: false, fallback: null };
    if (available) {
      try {
        page = await readPublicationLogPage(
          actor,
          {
            organizationId: job.target.organizationId,
            templateId: job.target.templateId,
            operationMode: job.operationMode,
            stage: job.stage,
            versionId: job.versionId as string,
            fileId: job.fileId as string,
            importJobId: job.importJobId as string,
            versionName: job.versionName,
            message: `hive-publication:${job.id}:${job.archiveDigest}`,
            actorCoderUserId: job.actorCoderUserId,
          },
          after,
          signal,
          this.transport,
        );
      } catch (error) {
        if (error instanceof TemplateLogAccessError && error.code !== "unavailable") throw error;
        page = { records: [], nextAfter: after, hasMore: true, fallback: "provider_unavailable" };
      }
    }
    const current = await publicationAwait(this.authorize(who, signal), signal);
    const owner = await this.db.user.findUnique({
      where: { id: who.ownerId },
      select: { coderUserId: true, coderUrl: true },
    });
    if (!authorized(current) || owner?.coderUserId !== who.coderUserId || owner.coderUrl !== origin)
      throw new TemplateLogAccessError("actor_revoked");
    return { ...page, available, stage: job.stage, coderUrl, viewScope };
  }
}
