import type { PrismaClient } from "@hive/db";
import { authorizeTemplateActor } from "./publication-actor";
import {
  type TemplateAssets,
  templateAssetsLoader,
  templatePublicationArtifact,
} from "./publication-artifact";
import {
  type TemplatePublicationActor,
  TemplatePublicationError,
  type TemplateRemoteVersion,
} from "./publication-contracts";
import {
  CoderTemplatePublicationProvider,
  type TemplatePublicationProvider,
} from "./publication-provider";
import { type TemplateJob, TemplateJobStore } from "./publication-store";
import { provisionerTagsDigest } from "./publication-tags";

export type TemplateJobDependencies = {
  authorize(
    job: Pick<TemplateJob, "ownerId" | "coderUserId" | "sessionId">,
    signal: AbortSignal,
  ): Promise<TemplatePublicationActor>;
  provider(
    actor: TemplatePublicationActor,
    signal: AbortSignal,
  ): Promise<TemplatePublicationProvider>;
  load: ReturnType<typeof templateAssetsLoader>;
};
export function templateJobDependencies(
  db: PrismaClient,
  assets: TemplateAssets,
): TemplateJobDependencies {
  return {
    authorize: (job, signal) => authorizeTemplateActor(db, job, signal),
    provider: (actor, signal) => CoderTemplatePublicationProvider.create(actor, fetch, signal),
    load: templateAssetsLoader(assets),
  };
}
function required(value: string | null): string {
  if (!value) throw new TemplatePublicationError("provider_identity_mismatch");
  return value;
}
function verifyVersion(job: TemplateJob, version: TemplateRemoteVersion) {
  if (
    version.name !== job.state.versionName ||
    version.message !== job.state.message ||
    version.fileId !== job.state.fileId ||
    (job.state.versionId && version.id !== job.state.versionId) ||
    (job.state.importJobId && version.importJobId !== job.state.importJobId) ||
    (job.state.tagDigest && provisionerTagsDigest(version.provisionerTags) !== job.state.tagDigest)
  )
    throw new TemplatePublicationError("provider_identity_mismatch");
}
/** One durable stage. All remote mutation admissions are committed first; an
 * unknown ACK is reconciled from exact provider identity, never blind replay. */
export async function processTemplateJob(
  store: TemplateJobStore,
  deps: TemplateJobDependencies,
  callerSignal?: AbortSignal,
  ownerId?: string,
) {
  const job = await store.claim(ownerId);
  if (!job) return false;
  const remaining = job.deadline.getTime() - Date.now();
  if (remaining <= 0 || job.attempts >= 128) {
    await store.save(job, job.state.effectIssued ? "held" : "failed", job.state, "import_timeout");
    return true;
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.min(60000, remaining)),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  let stage:
    | "authorize"
    | "provider"
    | "verify_artifact"
    | "current"
    | "tags"
    | "load"
    | "operation" = "authorize";
  try {
    const actor = await deps.authorize(job, signal);
    if (actor.origin !== job.origin) throw new TemplatePublicationError("actor_revoked");
    // Absolute deadline is also checked synchronously by the provider before
    // each fetch, independently of delayed AbortSignal timer delivery.
    actor.sessionExpiresAt = new Date(
      Math.min(actor.sessionExpiresAt.getTime(), job.deadline.getTime()),
    );
    stage = "provider";
    const provider = await deps.provider(actor, signal);
    stage = "verify_artifact";
    const expected = templatePublicationArtifact(job.name);
    if (
      Object.keys(expected).length !== Object.keys(job.artifact).length ||
      Object.entries(expected).some(
        ([key, value]) => job.artifact[key as keyof typeof expected] !== value,
      )
    )
      throw new TemplatePublicationError("artifact_changed");
    const state = job.state;
    const stableTarget = async () => {
      stage = "current";
      if (!state.target.templateId) return provider.absent(state.target);
      const current = await provider.current(state.target);
      if (current.activeVersionId !== state.target.activeVersionId)
        throw new TemplatePublicationError("external_drift");
      stage = "tags";
      if (
        state.tagDigest !==
        provisionerTagsDigest(
          await provider.tags(state.target, required(state.target.activeVersionId)),
        )
      )
        throw new TemplatePublicationError("provisioner_tags_changed");
    };
    stage = "operation";
    if (job.phase === "queued" || job.phase === "uploading") {
      await stableTarget();
      stage = "load";
      const bytes = await deps.load(job.artifact);
      stage = "operation";
      await store.markEffect(job, "uploading");
      // Coder's file upload is content-addressed; re-uploading these identical
      // verified bytes cannot create a second version or activate a template.
      const fileId = await provider.upload(bytes);
      await provider.verifyFile(fileId, job.artifact);
      await store.save(job, "creating_version", { ...job.state, fileId, effectIssued: false });
    } else if (job.phase === "creating_version") {
      await stableTarget();
      stage = "operation";
      if (!state.fileId) throw new TemplatePublicationError("provider_identity_mismatch");
      await provider.verifyFile(state.fileId, job.artifact);
      let version = state.target.templateId
        ? await provider.versionByName(state.target, state.versionName)
        : null;
      if (!version) {
        if (state.effectIssued) throw new TemplatePublicationError("version_unknown");
        const tags = state.target.templateId
          ? await provider.tags(state.target, required(state.target.activeVersionId))
          : undefined;
        if (tags && provisionerTagsDigest(tags) !== state.tagDigest)
          throw new TemplatePublicationError("provisioner_tags_changed");
        await store.markEffect(job, "creating_version");
        version = await provider.createVersion(state.target, {
          name: state.versionName,
          message: state.message,
          fileId: state.fileId,
          ...(tags ? { provisionerTags: tags } : {}),
        });
      }
      verifyVersion(job, version);
      await store.save(
        job,
        "importing",
        {
          ...job.state,
          versionId: version.id,
          importJobId: version.importJobId,
          effectIssued: false,
        },
        null,
        1000,
      );
    } else if (job.phase === "importing") {
      if (!state.versionId) throw new TemplatePublicationError("provider_identity_mismatch");
      const version = await provider.versionById(state.target, state.versionId);
      verifyVersion(job, version);
      if (["failed", "canceled", "canceling"].includes(version.status))
        await store.save(job, "failed", state, "import_failed");
      else if (version.status === "succeeded") {
        await stableTarget();
        stage = "operation";
        await provider.verifyFile(required(state.fileId), job.artifact);
        await store.save(job, state.target.templateId ? "activating" : "creating_template", {
          ...state,
          effectIssued: false,
        });
      } else await store.save(job, "importing", state, null, 2000);
    } else if (job.phase === "activating") {
      if (!state.versionId) throw new TemplatePublicationError("provider_identity_mismatch");
      const version = await provider.versionById(state.target, state.versionId);
      verifyVersion(job, version);
      if (version.status !== "succeeded") throw new TemplatePublicationError("import_failed");
      const current = await provider.current(state.target);
      if (current.activeVersionId === state.versionId) {
        await store.save(job, "succeeded", state);
      } else {
        if (current.activeVersionId !== state.target.activeVersionId)
          throw new TemplatePublicationError("external_drift");
        if (state.effectIssued) throw new TemplatePublicationError("activation_unknown");
        await stableTarget();
        stage = "operation";
        await provider.verifyFile(required(state.fileId), job.artifact);
        await store.markEffect(job, "activating");
        await provider.activate(state.target, state.versionId);
        if ((await provider.current(state.target)).activeVersionId !== state.versionId)
          throw new TemplatePublicationError("activation_unknown");
        await store.save(job, "succeeded", { ...job.state, target: current });
      }
    } else if (job.phase === "creating_template") {
      if (!state.versionId) throw new TemplatePublicationError("provider_identity_mismatch");
      const current = await provider.locate(job.name);
      if (current.templateId) {
        if (
          !state.effectIssued ||
          current.activeVersionId !== state.versionId ||
          current.createdById !== job.coderUserId ||
          current.organizationId !== job.organizationId
        )
          throw new TemplatePublicationError("external_drift");
        await store.save(job, "succeeded", { ...job.state, target: current });
      } else {
        if (state.effectIssued) throw new TemplatePublicationError("template_creation_unknown");
        await provider.absent(state.target);
        const version = await provider.versionById(state.target, state.versionId);
        verifyVersion(job, version);
        if (version.status !== "succeeded") throw new TemplatePublicationError("import_failed");
        await provider.verifyFile(required(state.fileId), job.artifact);
        await store.markEffect(job, "creating_template");
        const created = await provider.createTemplate(state.target, state.versionId);
        await store.save(job, "succeeded", { ...job.state, target: created });
      }
    } else throw new TemplatePublicationError("provider_identity_mismatch");
  } catch (error) {
    if (error instanceof TemplatePublicationError && error.code === "lease_lost") return true;
    const reason = error instanceof TemplatePublicationError ? error.code : "provider_unavailable";
    const errorClass =
      error instanceof TemplatePublicationError
        ? "TemplatePublicationError"
        : error instanceof Error &&
            [
              "TemplatePublicationError",
              "ZodError",
              "TypeError",
              "Error",
              "PrismaClientInitializationError",
              "PrismaClientKnownRequestError",
              "PrismaClientUnknownRequestError",
              "PrismaClientValidationError",
            ].includes(error.name)
          ? error.name
          : "Other";
    console.warn(
      JSON.stringify({
        event: "template_publication_failure",
        phase: job.phase,
        stage,
        errorClass,
      }),
    );
    if (
      ["provider_unavailable", "provider_deadline"].includes(reason) &&
      job.attempts < 20 &&
      job.deadline.getTime() > Date.now()
    ) {
      // Preserve any pre-effect marker. The next stage observes/reconciles it.
      await store.save(job, job.phase, job.state, reason, 2000);
    } else
      await store.save(
        job,
        job.state.effectIssued ||
          ["external_drift", "artifact_changed", "provider_identity_mismatch"].includes(reason)
          ? "held"
          : "failed",
        job.state,
        reason,
      );
  }
  return true;
}

/** Same-Worker scheduler entry. Caller owns/drains this database request scope. */
export async function dispatchTemplateJobs(
  db: PrismaClient,
  assets: TemplateAssets,
  options: { limit?: number; signal?: AbortSignal; ownerId?: string } = {},
) {
  const limit = options.limit ?? 4;
  if (!Number.isInteger(limit) || limit < 1 || limit > 8)
    throw new Error("Invalid template dispatch bound");
  const signal = AbortSignal.any([
    AbortSignal.timeout(60000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const store = new TemplateJobStore(db),
    deps = templateJobDependencies(db, assets);
  let processed = 0;
  while (
    processed < limit &&
    !signal.aborted &&
    (await processTemplateJob(store, deps, signal, options.ownerId))
  )
    processed++;
  return { processed };
}
