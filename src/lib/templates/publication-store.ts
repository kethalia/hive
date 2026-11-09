import { createHash, randomUUID } from "node:crypto";
import { getConfiguredCoderUrl, isConfiguredCoderUrl } from "@hive/auth";
import { Prisma, type PrismaClient } from "@hive/db";
import {
  PUBLICATION_LIMITS,
  type PublicationCode,
  type PublicationReason,
  publicationEventDataSchema,
  type TemplateArtifactIdentity,
  type TemplatePublicationActor,
  TemplatePublicationError,
  type TemplateRemoteTarget,
  type TemplateRemoteVersion,
} from "./publication-contracts";

type Tx = Prisma.TransactionClient;
export type PublicationJob = Prisma.TemplatePublicationJobGetPayload<{ include: { target: true } }>;
export type PublicationClaim = { id: string; ownerId: string; holder: string; generation: number };
type ActorIdentity = Pick<TemplatePublicationActor, "ownerId" | "coderUserId" | "sessionId">;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const databaseNow = async (tx: Tx) =>
  (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
const fail = (reason: PublicationReason): never => {
  throw new TemplatePublicationError(reason);
};

export class TemplatePublicationStore {
  // Per interactive transaction only: late clock checks run after all writes,
  // before Prisma commits. No network requests occur in these transactions.
  private readonly commitChecks = new WeakMap<Tx, (() => Promise<void>)[]>();
  constructor(readonly db: PrismaClient) {}
  private async transaction<T>(work: (tx: Tx) => Promise<T>) {
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            const checks: (() => Promise<void>)[] = [];
            this.commitChecks.set(tx, checks);
            try {
              const result = await work(tx);
              for (const check of checks) await check();
              return result;
            } finally {
              this.commitChecks.delete(tx);
            }
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
            maxWait: 10000,
          },
        );
      } catch (error) {
        const e = error as {
          name?: unknown;
          code?: unknown;
          clientVersion?: unknown;
          meta?: { code?: unknown };
        };
        if (
          retry >= 2 ||
          e?.name !== "PrismaClientKnownRequestError" ||
          !(e.code === "P2034" || (e.code === "P2010" && e.meta?.code === "40001")) ||
          typeof e.clientVersion !== "string"
        )
          throw error;
      }
  }
  private async actor(tx: Tx, identity: ActorIdentity, origin: string) {
    // A logout/session edit cannot race the local acceptance transaction.
    await tx.$queryRaw`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.session_id=${identity.sessionId}::uuid FOR SHARE OF u,s`;
    const session = await tx.session.findUnique({
      where: { sessionId: identity.sessionId },
      include: { user: true },
    });
    const time = await databaseNow(tx);
    if (
      !session ||
      session.userId !== identity.ownerId ||
      session.user.coderUserId !== identity.coderUserId ||
      !isConfiguredCoderUrl(session.user.coderUrl) ||
      origin !== getConfiguredCoderUrl() ||
      session.expiresAt <= time
    )
      fail("actor_revoked");
  }
  private async event(
    tx: Tx,
    job: PublicationJob,
    code: PublicationCode,
    key: string,
    value: unknown = {},
  ) {
    const data = publicationEventDataSchema.parse(value),
      hash = digest({ code, data });
    const previous = await tx.templatePublicationEvent.findUnique({
      where: { jobId_key: { jobId: job.id, key } },
    });
    if (previous) {
      if (previous.code !== code || previous.digest !== hash) fail("request_conflict");
      return;
    }
    if (job.eventSequence >= PUBLICATION_LIMITS.events) fail("progress_limit");
    const next = await tx.templatePublicationJob.update({
      where: { id: job.id },
      data: { eventSequence: { increment: 1 } },
    });
    job.eventSequence = next.eventSequence;
    await tx.templatePublicationEvent.create({
      data: {
        id: randomUUID(),
        ownerId: job.ownerId,
        jobId: job.id,
        sequence: next.eventSequence,
        key,
        code,
        data: JSON.parse(JSON.stringify(data)),
        digest: hash,
      },
    });
  }
  async enqueue(
    actor: ActorIdentity,
    target: TemplateRemoteTarget,
    artifact: TemplateArtifactIdentity,
    requestId?: string,
    provisionerTagsDigest: string | null = null,
  ) {
    const id = randomUUID(),
      requested = requestId ?? randomUUID(),
      origin = getConfiguredCoderUrl();
    const requestDigest = digest({
      ownerId: actor.ownerId,
      sessionId: actor.sessionId,
      coderUserId: actor.coderUserId,
      targetId: target.templateId,
      organizationId: target.organizationId,
      origin,
      artifact,
      ...(target.templateId === null ? { operationMode: "create" } : {}),
      ...(provisionerTagsDigest ? { provisionerTagsDigest } : {}),
    });
    await this.db.templatePublicationTarget.createMany({
      data: {
        id: randomUUID(),
        configuredOrigin: origin,
        organizationId: target.organizationId,
        organizationName: target.organizationName,
        templateId: target.templateId,
        templateName: target.name,
      },
      skipDuplicates: true,
    });
    return this.transaction(async (tx) => {
      const existing = await tx.templatePublicationTarget.findUniqueOrThrow({
        where: {
          configuredOrigin_organizationId_templateName: {
            configuredOrigin: origin,
            organizationId: target.organizationId,
            templateName: target.name,
          },
        },
      });
      await tx.$queryRaw`SELECT id FROM template_publication_targets WHERE id=${existing.id}::uuid FOR UPDATE`;
      const scope = await tx.templatePublicationTarget.findUniqueOrThrow({
        where: { id: existing.id },
      });
      await this.actor(tx, actor, origin);
      const replay = await tx.templatePublicationJob.findUnique({
        where: { ownerId_requestId: { ownerId: actor.ownerId, requestId: requested } },
        include: { target: true },
      });
      if (replay) {
        if (replay.requestDigest !== requestDigest) fail("request_conflict");
        return replay;
      }
      if (scope.organizationName !== target.organizationName || scope.templateName !== target.name)
        fail("provider_identity_mismatch");
      if (
        scope.templateId !== target.templateId ||
        (target.templateId === null) !== (target.activeVersionId === null)
      )
        fail("provider_identity_mismatch");
      if (scope.currentJobId) {
        const running = await tx.templatePublicationJob.findUniqueOrThrow({
          where: { id: scope.currentJobId },
          include: { target: true },
        });
        if (
          !requestId &&
          running.ownerId === actor.ownerId &&
          running.actorSessionId === actor.sessionId &&
          running.requestDigest === requestDigest
        )
          return running;
        fail("publication_busy");
      }
      if (scope.heldReason) fail("publication_busy");
      const generation = scope.generation + 1;
      const count = await tx.templatePublicationJob.createMany({
        data: {
          id,
          ownerId: actor.ownerId,
          actorSessionId: actor.sessionId,
          actorCoderUserId: actor.coderUserId,
          targetId: scope.id,
          targetGeneration: generation,
          requestId: requested,
          requestDigest,
          templateName: artifact.name,
          contentHash: artifact.contentHash,
          archiveDigest: artifact.archiveDigest,
          archiveBytes: artifact.archiveBytes,
          manifestDigest: artifact.manifestDigest,
          versionName: `hive-${id}`,
          expectedActiveVersionId: target.activeVersionId,
          operationMode: target.templateId === null ? "create" : "update",
          provisionerTagsDigest,
        },
        skipDuplicates: true,
      });
      if (count.count !== 1) {
        const prior = await tx.templatePublicationJob.findUnique({
          where: { ownerId_requestId: { ownerId: actor.ownerId, requestId: requested } },
          include: { target: true },
        });
        if (!prior || prior.requestDigest !== requestDigest)
          throw new TemplatePublicationError("request_conflict");
        return prior;
      }
      await tx.templatePublicationTarget.update({
        where: { id: scope.id },
        data: { currentJobId: id, generation },
      });
      const job = await tx.templatePublicationJob.findUniqueOrThrow({
        where: { id },
        include: { target: true },
      });
      await this.event(tx, job, "queued", "queued");
      await this.actor(tx, actor, origin);
      return job;
    });
  }
  /** Historical exact receipt only: no mode preflight, claim or execution permission. */
  replay(actor: ActorIdentity, artifact: TemplateArtifactIdentity, requestId: string) {
    return this.transaction(async (tx) => {
      await this.actor(tx, actor, getConfiguredCoderUrl());
      const job = await tx.templatePublicationJob.findUnique({
        where: { ownerId_requestId: { ownerId: actor.ownerId, requestId } },
        include: { target: true },
      });
      if (!job) return null;
      if (
        job.actorSessionId !== actor.sessionId ||
        job.actorCoderUserId !== actor.coderUserId ||
        job.templateName !== artifact.name ||
        job.target.configuredOrigin !== getConfiguredCoderUrl() ||
        (["contentHash", "archiveDigest", "archiveBytes", "manifestDigest"] as const).some(
          (key) => job[key] !== artifact[key],
        )
      )
        throw new TemplatePublicationError("request_conflict");
      return job;
    });
  }
  async claim(): Promise<PublicationClaim | null> {
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT j.id FROM template_publication_targets t JOIN template_publication_jobs j ON j.id=t.current_job_id AND j.target_id=t.id
        WHERE t.held_reason IS NULL AND j.stage IN ('queued','uploading','creating_version','importing','activating','creating_template')
          AND j.next_attempt_at<=clock_timestamp() AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
        ORDER BY j.next_attempt_at,j.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`;
      if (!rows.length) return null;
      const holder = randomUUID();
      const job = await tx.templatePublicationJob.update({
        where: { id: rows[0].id },
        data: {
          leaseHolder: holder,
          leaseGeneration: { increment: 1 },
          leaseUntil: new Date((await databaseNow(tx)).getTime() + PUBLICATION_LIMITS.leaseMs),
        },
      });
      return { id: job.id, ownerId: job.ownerId, holder, generation: job.leaseGeneration };
    });
  }
  private async locked(tx: Tx, claim: PublicationClaim, actor = true) {
    const initial = await tx.templatePublicationJob.findUnique({
      where: { ownerId_id: { ownerId: claim.ownerId, id: claim.id } },
    });
    if (!initial) throw new TemplatePublicationError("publication_not_found");
    await tx.$queryRaw`SELECT id FROM template_publication_targets WHERE id=${initial.targetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM template_publication_jobs WHERE id=${initial.id}::uuid AND owner_id=${claim.ownerId}::uuid FOR UPDATE`;
    const job = await tx.templatePublicationJob.findUniqueOrThrow({
        where: { id: claim.id },
        include: { target: true },
      }),
      time = await databaseNow(tx);
    if (
      job.target.currentJobId !== job.id ||
      job.target.generation !== job.targetGeneration ||
      job.leaseHolder !== claim.holder ||
      job.leaseGeneration !== claim.generation ||
      !job.leaseUntil ||
      job.leaseUntil <= time ||
      ["held", "succeeded", "failed"].includes(job.stage)
    )
      fail("lease_lost");
    if (actor)
      await this.actor(
        tx,
        { ownerId: job.ownerId, coderUserId: job.actorCoderUserId, sessionId: job.actorSessionId },
        job.target.configuredOrigin,
      );
    this.commitChecks.get(tx)?.push(async () => {
      if (!job.leaseUntil || job.leaseUntil <= (await databaseNow(tx))) fail("lease_lost");
      if (actor)
        await this.actor(
          tx,
          {
            ownerId: job.ownerId,
            coderUserId: job.actorCoderUserId,
            sessionId: job.actorSessionId,
          },
          job.target.configuredOrigin,
        );
    });
    return job;
  }
  inspect(claim: PublicationClaim) {
    return this.transaction((tx) => this.locked(tx, claim));
  }
  async begin(
    claim: PublicationClaim,
    stage: "uploading" | "creating_version" | "activating" | "creating_template",
  ) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim);
      if (
        !(["queued", "uploading"].includes(job.stage) && stage === "uploading") &&
        job.stage !== stage
      )
        fail("lease_lost");
      if (stage !== "uploading" && job.effectState !== "clear")
        fail(
          stage === "activating"
            ? "activation_unknown"
            : stage === "creating_template"
              ? "template_creation_unknown"
              : "version_unknown",
        );
      await this.event(
        tx,
        job,
        stage === "uploading"
          ? "upload_started"
          : stage === "creating_version"
            ? "version_started"
            : stage === "creating_template"
              ? "template_create_started"
              : "activation_started",
        `${stage}:started`,
      );
      return tx.templatePublicationJob.update({
        where: { id: job.id },
        data: {
          stage,
          effectState: "started",
          effectDigest: digest({
            request: job.requestDigest,
            stage,
            fileId: job.fileId,
            versionId: job.versionId,
          }),
        },
        include: { target: true },
      });
    });
  }
  async uploaded(claim: PublicationClaim, fileId: string) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim);
      if (job.stage !== "uploading") fail("lease_lost");
      await this.event(tx, job, "upload_verified", "upload:verified");
      return tx.templatePublicationJob.update({
        where: { id: job.id },
        data: { fileId, stage: "creating_version", effectState: "clear" },
        include: { target: true },
      });
    });
  }
  async versioned(claim: PublicationClaim, version: TemplateRemoteVersion) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim);
      if (job.stage !== "creating_version") fail("lease_lost");
      await this.event(tx, job, "version_verified", "version:verified");
      return tx.templatePublicationJob.update({
        where: { id: job.id },
        data: {
          versionId: version.id,
          importJobId: version.importJobId,
          stage: "importing",
          effectState: "clear",
        },
        include: { target: true },
      });
    });
  }
  async progress(
    claim: PublicationClaim,
    version: TemplateRemoteVersion,
    logs: { after: string; records: number; overflowed: boolean } | null,
  ) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim);
      if (job.stage !== "importing") fail("lease_lost");
      const code =
        version.status === "succeeded"
          ? "import_succeeded"
          : version.status === "running"
            ? "import_running"
            : version.status === "pending"
              ? "import_pending"
              : "import_failed";
      await this.event(tx, job, code, `import:${version.status}`, { status: version.status });
      if (logs && BigInt(logs.after) > job.remoteLogAfter)
        await this.event(tx, job, "log_metadata", `logs:${logs.after}`, {
          after: logs.after,
          records: logs.records,
        });
      if (logs?.overflowed || version.logsOverflowed)
        await this.event(tx, job, "log_limit", "logs:bounded");
      return tx.templatePublicationJob.update({
        where: { id: job.id },
        data: {
          remoteStatus: version.status,
          remoteLogAfter: logs ? BigInt(logs.after) : job.remoteLogAfter,
          logsOverflowed: job.logsOverflowed || logs?.overflowed || version.logsOverflowed,
          stage:
            version.status === "succeeded"
              ? job.operationMode === "create"
                ? "creating_template"
                : "activating"
              : "importing",
          nextAttemptAt: new Date((await databaseNow(tx)).getTime() + 10000),
        },
        include: { target: true },
      });
    });
  }
  async created(claim: PublicationClaim, target: TemplateRemoteTarget) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim);
      if (
        job.operationMode !== "create" ||
        job.stage !== "creating_template" ||
        job.effectState !== "started" ||
        job.target.templateId !== null ||
        !target.templateId ||
        target.organizationId !== job.target.organizationId ||
        target.organizationName !== job.target.organizationName ||
        target.name !== job.templateName ||
        target.activeVersionId !== job.versionId ||
        target.createdById !== job.actorCoderUserId
      )
        throw new TemplatePublicationError("provider_identity_mismatch");
      await tx.templatePublicationTarget.update({
        where: { id: job.targetId },
        data: { templateId: target.templateId },
      });
      await this.event(tx, job, "template_created", "template:created");
      await this.finishLocked(tx, job, "succeeded");
    });
  }
  async defer(claim: PublicationClaim, reason: PublicationReason) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim, false);
      if (job.retries >= PUBLICATION_LIMITS.retries - 1)
        return this.finishLocked(tx, job, "held", reason);
      await tx.templatePublicationJob.update({
        where: { id: job.id },
        data: {
          retries: { increment: 1 },
          leaseHolder: null,
          leaseUntil: null,
          nextAttemptAt: new Date(
            (await databaseNow(tx)).getTime() + Math.min(300000, 30000 * 2 ** job.retries),
          ),
        },
      });
    });
  }
  async release(claim: PublicationClaim) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim, false);
      await tx.templatePublicationJob.update({
        where: { id: job.id },
        data: { leaseHolder: null, leaseUntil: null },
      });
    });
  }
  private async finishLocked(
    tx: Tx,
    job: PublicationJob,
    stage: "succeeded" | "failed" | "held",
    reason?: PublicationReason,
  ) {
    await this.event(
      tx,
      job,
      stage === "succeeded" ? "activation_verified" : stage,
      `terminal:${stage}`,
      reason ? { reason } : {},
    );
    await tx.templatePublicationJob.update({
      where: { id: job.id },
      data: {
        stage,
        heldReason: reason,
        finishedAt: await databaseNow(tx),
        leaseHolder: null,
        leaseUntil: null,
        effectState: stage === "held" && job.effectState !== "clear" ? "unknown" : "clear",
      },
    });
    await tx.templatePublicationTarget.update({
      where: { id: job.targetId },
      data:
        stage === "held"
          ? { heldReason: reason ?? "provider_unavailable" }
          : { currentJobId: null, heldReason: null },
    });
    const event = await tx.templatePublicationEvent.findUniqueOrThrow({
      where: { jobId_key: { jobId: job.id, key: `terminal:${stage}` } },
    });
    await tx.templatePublicationNotice.create({
      data: { ownerId: job.ownerId, jobId: job.id, eventId: event.id },
    });
  }
  settle(
    claim: PublicationClaim,
    stage: "succeeded" | "failed" | "held",
    reason?: PublicationReason,
  ) {
    return this.transaction(async (tx) => {
      const job = await this.locked(tx, claim, stage !== "held");
      if (stage === "succeeded" && (job.stage !== "activating" || job.effectState !== "started"))
        fail("lease_lost");
      if (
        stage === "failed" &&
        (job.stage !== "importing" ||
          job.effectState !== "clear" ||
          !["failed", "canceled"].includes(job.remoteStatus ?? ""))
      )
        fail("lease_lost");
      return this.finishLocked(tx, job, stage, reason);
    });
  }
  async read(ownerId: string, name: string, jobId: string) {
    return this.db.templatePublicationJob.findFirst({
      where: { ownerId, id: jobId, templateName: name },
      include: {
        target: true,
        events: { orderBy: { sequence: "asc" }, take: PUBLICATION_LIMITS.events },
      },
    });
  }
}
