import { createHash } from "node:crypto";
import { getConfiguredCoderUrl } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import type { PublicationActorAuthorizer, PublicationActorIdentity } from "./publication-actor";
import { templatePublicationArtifact } from "./publication-artifact";
import {
  PUBLICATION_LIMITS,
  type PublicationReason,
  publicationNameSchema,
  type TemplateArtifactIdentity,
  TemplatePublicationError,
  type TemplateRemoteTarget,
  type TemplateRemoteVersion,
} from "./publication-contracts";
import { publicationAwait } from "./publication-io";
import {
  CoderTemplatePublicationProvider,
  type TemplatePublicationProvider,
} from "./publication-provider";
import { type PublicationJob, TemplatePublicationStore } from "./publication-store";
import { canonicalProvisionerTags, provisionerTagsDigest } from "./publication-tags";

export type TemplatePublicationDependencies = {
  enabled?: boolean;
  authorizeActor: PublicationActorAuthorizer;
  loadArtifact: (identity: TemplateArtifactIdentity) => Promise<Uint8Array>;
  currentArtifact?: typeof templatePublicationArtifact;
  provider?: (
    actor: Awaited<ReturnType<PublicationActorAuthorizer>>,
    signal: AbortSignal,
  ) => Promise<TemplatePublicationProvider>;
  signal?: AbortSignal;
};
const marker = (job: PublicationJob) => `hive-publication:${job.id}:${job.archiveDigest}`;
const target = (job: PublicationJob): TemplateRemoteTarget => ({
  organizationId: job.target.organizationId,
  organizationName: job.target.organizationName,
  templateId: job.target.templateId,
  name: job.templateName,
  activeVersionId: job.expectedActiveVersionId,
});
const identity = (job: PublicationJob): PublicationActorIdentity => ({
  ownerId: job.ownerId,
  coderUserId: job.actorCoderUserId,
  sessionId: job.actorSessionId,
});
const sameTarget = (actual: TemplateRemoteTarget, expected: TemplateRemoteTarget) => {
  if (
    ["organizationId", "organizationName", "templateId", "name"].some(
      (key) =>
        actual[key as keyof TemplateRemoteTarget] !== expected[key as keyof TemplateRemoteTarget],
    )
  )
    throw new TemplatePublicationError("provider_identity_mismatch");
};

/** One durable stage per invocation. No timers, HTTP processor, cron or implicit credential authority. */
export class TemplatePublicationService {
  readonly store: TemplatePublicationStore;
  constructor(
    readonly db: PrismaClient,
    private readonly dependencies: TemplatePublicationDependencies,
  ) {
    this.store = new TemplatePublicationStore(db);
  }
  private enabled() {
    if (!(this.dependencies.enabled ?? process.env.HIVE_TEMPLATE_PUBLICATION_ENABLED === "true"))
      throw new TemplatePublicationError("publication_disabled");
  }
  private signal() {
    return AbortSignal.any([
      AbortSignal.timeout(PUBLICATION_LIMITS.invocationMs),
      ...(this.dependencies.signal ? [this.dependencies.signal] : []),
    ]);
  }
  private artifact(name: string) {
    return (this.dependencies.currentArtifact ?? templatePublicationArtifact)(name);
  }
  private assertArtifact(job: PublicationJob) {
    const current = this.artifact(job.templateName);
    for (const key of ["contentHash", "archiveDigest", "archiveBytes", "manifestDigest"] as const)
      if (current[key] !== job[key]) throw new TemplatePublicationError("artifact_changed");
    return current;
  }
  private async actor(who: PublicationActorIdentity, signal: AbortSignal) {
    const actor = await publicationAwait(this.dependencies.authorizeActor(who, signal), signal);
    if (
      actor.ownerId !== who.ownerId ||
      actor.coderUserId !== who.coderUserId ||
      actor.sessionId !== who.sessionId ||
      actor.origin !== getConfiguredCoderUrl() ||
      !Number.isFinite(actor.sessionExpiresAt.getTime()) ||
      actor.sessionExpiresAt.getTime() <= Date.now()
    )
      throw new TemplatePublicationError("actor_revoked");
    return actor;
  }
  private async provider(who: PublicationActorIdentity, signal: AbortSignal) {
    const actor = await this.actor(who, signal);
    return publicationAwait(
      (
        this.dependencies.provider ??
        ((a, s) => CoderTemplatePublicationProvider.create(a, fetch, s))
      )(actor, signal),
      signal,
    );
  }
  async enqueue(who: PublicationActorIdentity, name: string, requestId?: string) {
    this.enabled();
    if (
      !publicationNameSchema.safeParse(name).success ||
      (requestId && !z.string().uuid().safeParse(requestId).success)
    )
      throw new TemplatePublicationError("invalid_request");
    const signal = this.signal(),
      artifact = this.artifact(name);
    await this.actor(who, signal);
    if (requestId) {
      const replay = await this.store.replay(who, artifact, requestId);
      if (replay) return replay;
    }
    const provider = await this.provider(who, signal),
      remote = await publicationAwait(provider.locate(name), signal);
    if (remote.name !== name) throw new TemplatePublicationError("provider_identity_mismatch");
    const tags = remote.templateId
      ? await publicationAwait(
          provider.tags(remote, z.string().uuid().parse(remote.activeVersionId)),
          signal,
        )
      : null;
    return this.store.enqueue(
      who,
      remote,
      artifact,
      requestId,
      tags ? provisionerTagsDigest(tags) : null,
    );
  }
  private async tags(
    job: PublicationJob,
    provider: TemplatePublicationProvider,
    remote: TemplateRemoteTarget,
    signal: AbortSignal,
  ) {
    if (!job.provisionerTagsDigest) return undefined; // Frozen schema-27 request semantics.
    if (job.operationMode !== "update" || !job.expectedActiveVersionId)
      throw new TemplatePublicationError("provider_identity_mismatch");
    const tags = canonicalProvisionerTags(
      await publicationAwait(provider.tags(remote, job.expectedActiveVersionId), signal),
    );
    if (provisionerTagsDigest(tags) !== job.provisionerTagsDigest)
      throw new TemplatePublicationError("provisioner_tags_changed");
    return tags;
  }
  private tagReadback(
    job: PublicationJob,
    version: TemplateRemoteVersion,
    inherited: Record<string, string> | undefined,
  ) {
    if (!inherited) return;
    const observed = canonicalProvisionerTags(version.provisionerTags);
    for (const [key, value] of Object.entries(inherited))
      if (value && key !== "scope" && key !== "owner" && observed[key] !== value)
        throw new TemplatePublicationError("provider_identity_mismatch");
    // Match pinned Coder MutateTags: reserved owner never comes from the old
    // publisher or a browser; scope user binds the current verified Coder user.
    const scope = inherited.scope
      ? inherited.scope === "user"
        ? "user"
        : "organization"
      : observed.scope;
    if (
      !["user", "organization"].includes(scope) ||
      observed.scope !== scope ||
      observed.owner !== (scope === "user" ? job.actorCoderUserId : "")
    )
      throw new TemplatePublicationError("provider_identity_mismatch");
  }
  private version(job: PublicationJob, remote: TemplateRemoteVersion) {
    if (
      remote.name !== job.versionName ||
      remote.message !== marker(job) ||
      remote.templateId !== job.target.templateId ||
      remote.organizationId !== job.target.organizationId ||
      remote.fileId !== job.fileId ||
      remote.creatorId !== job.actorCoderUserId ||
      remote.initiatorId !== job.actorCoderUserId ||
      (job.versionId && remote.id !== job.versionId) ||
      (job.importJobId && remote.importJobId !== job.importJobId)
    )
      throw new TemplatePublicationError("provider_identity_mismatch");
  }
  async processOne(): Promise<{
    claimed: boolean;
    jobId?: string;
    outcome?: string;
    reason?: PublicationReason;
  }> {
    this.enabled();
    const claim = await this.store.claim();
    if (!claim) return { claimed: false };
    const signal = this.signal();
    try {
      let job = await this.store.inspect(claim);
      this.assertArtifact(job);
      if (job.stage === "activating" && job.effectState !== "clear")
        throw new TemplatePublicationError("activation_unknown");
      if (job.stage === "creating_template" && job.effectState !== "clear")
        throw new TemplatePublicationError("template_creation_unknown");
      if (
        job.operationMode === "create" &&
        job.stage === "creating_version" &&
        job.effectState !== "clear"
      )
        throw new TemplatePublicationError("version_unknown");
      const provider = await this.provider(identity(job), signal),
        remote = target(job);
      if (job.operationMode === "create") await publicationAwait(provider.absent(remote), signal);
      else sameTarget(await publicationAwait(provider.current(remote), signal), remote);
      const fresh = async () => {
        await this.actor(identity(job), signal);
        await this.store.inspect(claim);
        this.assertArtifact(job);
      };
      if (["queued", "uploading"].includes(job.stage)) {
        const artifact = this.assertArtifact(job),
          bytes = await publicationAwait(this.dependencies.loadArtifact(artifact), signal);
        if (
          bytes.byteLength !== artifact.archiveBytes ||
          createHash("sha256").update(bytes).digest("hex") !== artifact.archiveDigest
        )
          throw new TemplatePublicationError("artifact_changed");
        job = await this.store.begin(claim, "uploading");
        await fresh();
        const file = await publicationAwait(provider.upload(bytes), signal);
        await publicationAwait(provider.verifyFile(file, artifact), signal);
        await fresh();
        await this.store.uploaded(claim, z.string().uuid().parse(file));
      } else if (job.stage === "creating_version") {
        const inherited = await this.tags(job, provider, remote, signal);
        let version: TemplateRemoteVersion | null;
        if (job.effectState !== "clear") {
          version = await publicationAwait(provider.versionByName(remote, job.versionName), signal);
          if (!version) throw new TemplatePublicationError("version_unknown");
        } else {
          job = await this.store.begin(claim, "creating_version");
          await fresh();
          version = await publicationAwait(
            provider.createVersion(remote, {
              name: job.versionName,
              message: marker(job),
              fileId: z.string().uuid().parse(job.fileId),
              ...(inherited ? { provisionerTags: inherited } : {}),
            }),
            signal,
          );
        }
        this.version(job, version);
        this.tagReadback(job, version, inherited);
        await publicationAwait(
          provider.verifyFile(version.fileId, this.assertArtifact(job)),
          signal,
        );
        await fresh();
        await this.store.versioned(claim, version);
      } else if (job.stage === "importing") {
        const version = await publicationAwait(
          provider.versionById(remote, z.string().uuid().parse(job.versionId)),
          signal,
        );
        this.version(job, version);
        let logs: Awaited<ReturnType<TemplatePublicationProvider["logs"]>> | null = null;
        if (!job.logsOverflowed)
          try {
            logs = await publicationAwait(
              provider.logs(version.id, job.remoteLogAfter.toString()),
              signal,
            );
          } catch (error) {
            if (
              error instanceof TemplatePublicationError &&
              error.code === "provider_response_limit"
            )
              logs = { after: job.remoteLogAfter.toString(), records: 0, overflowed: true };
            else throw error;
          }
        await fresh();
        job = await this.store.progress(claim, version, logs);
        if (["failed", "canceled"].includes(version.status))
          await this.store.settle(claim, "failed", "import_failed");
        else if (
          version.status !== "succeeded" &&
          Date.now() - job.createdAt.getTime() > PUBLICATION_LIMITS.importMs
        )
          throw new TemplatePublicationError("import_timeout");
      } else if (job.stage === "creating_template") {
        const version = await publicationAwait(
          provider.versionById(remote, z.string().uuid().parse(job.versionId)),
          signal,
        );
        this.version(job, version);
        if (version.status !== "succeeded") throw new TemplatePublicationError("import_failed");
        await publicationAwait(provider.absent(remote), signal);
        job = await this.store.begin(claim, "creating_template");
        await fresh();
        await publicationAwait(provider.absent(remote), signal);
        const created = await publicationAwait(provider.createTemplate(remote, version.id), signal);
        if (
          !created.templateId ||
          created.createdById !== job.actorCoderUserId ||
          created.activeVersionId !== version.id ||
          created.organizationId !== remote.organizationId ||
          created.organizationName !== remote.organizationName ||
          created.name !== remote.name
        )
          throw new TemplatePublicationError("provider_identity_mismatch");
        const current = await publicationAwait(provider.current(created), signal);
        sameTarget(current, created);
        if (current.createdById !== job.actorCoderUserId || current.activeVersionId !== version.id)
          throw new TemplatePublicationError("provider_identity_mismatch");
        const attached = await publicationAwait(provider.versionById(current, version.id), signal);
        this.version(
          { ...job, target: { ...job.target, templateId: current.templateId } },
          attached,
        );
        await fresh();
        await this.store.created(claim, current);
      } else if (job.stage === "activating") {
        const version = await publicationAwait(
          provider.versionById(remote, z.string().uuid().parse(job.versionId)),
          signal,
        );
        this.version(job, version);
        if (version.status !== "succeeded") throw new TemplatePublicationError("import_failed");
        let current = await publicationAwait(provider.current(remote), signal);
        sameTarget(current, remote);
        if (current.activeVersionId !== job.expectedActiveVersionId)
          throw new TemplatePublicationError("external_drift");
        job = await this.store.begin(claim, "activating");
        await fresh();
        current = await publicationAwait(provider.current(remote), signal);
        sameTarget(current, remote);
        if (current.activeVersionId !== job.expectedActiveVersionId)
          throw new TemplatePublicationError("external_drift");
        await publicationAwait(provider.activate(remote, version.id), signal);
        await fresh();
        current = await publicationAwait(provider.current(remote), signal);
        sameTarget(current, remote);
        if (current.activeVersionId !== version.id)
          throw new TemplatePublicationError("activation_unknown");
        await this.store.settle(claim, "succeeded");
      }
      return { claimed: true, jobId: claim.id, outcome: "progressed" };
    } catch (error) {
      let reason: PublicationReason =
        error instanceof TemplatePublicationError ? error.code : "provider_unavailable";
      const job = await this.db.templatePublicationJob.findUnique({ where: { id: claim.id } });
      if (job?.stage === "activating" && job.effectState !== "clear") reason = "activation_unknown";
      if (job?.stage === "creating_template" && job.effectState !== "clear")
        reason = "template_creation_unknown";
      if (
        job?.operationMode === "create" &&
        job.stage === "creating_version" &&
        job.effectState !== "clear"
      )
        reason = "version_unknown";
      try {
        if (["provider_unavailable", "provider_deadline"].includes(reason))
          await this.store.defer(claim, reason);
        else await this.store.settle(claim, "held", reason);
      } catch {
        /* A stale holder cannot acknowledge or release a newer claim. */
      }
      return { claimed: true, jobId: claim.id, outcome: "held_or_deferred", reason };
    } finally {
      await this.store.release(claim).catch(() => {});
    }
  }
}

export async function processTemplatePublications(
  service: TemplatePublicationService,
  options: { maximum?: number } = {},
) {
  const maximum = Math.min(2, Math.max(1, options.maximum ?? 2)),
    results = [];
  for (let i = 0; i < maximum; i++) {
    const result = await service.processOne();
    results.push(result);
    if (!result.claimed) break;
  }
  return results;
}
