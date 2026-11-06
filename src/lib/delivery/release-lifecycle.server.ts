import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import { releaseActionIdentitySchema } from "./release-action-journal";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import { releaseBuildManifestSchema } from "./release-build-attestation.server";
import { cloudflareReleaseRequestSchema } from "./release-cloudflare-provider.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import {
  nativeBaselineSchema,
  nativeBootstrapEnrollmentSchema,
  nativePublicationRequestSchema,
} from "./release-native-preview-contracts";
import type { NativePreviewReleaseTarget } from "./release-native-preview-reader.server";
import { appendReleaseNotice } from "./release-notice.server";
import { releasePolicyCovers, releasePolicySchema } from "./release-policy-contracts";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const databasePinSchema = z
  .object({ catalogDigest: digest, planEventId: uuid, planDigest: digest })
  .strict();
type Tx = Prisma.TransactionClient;
const deny = (): never => {
  throw new Error("release_authority_unavailable");
};

/** Controller-only lifecycle. All callbacks must be deployment-owned, perform
 * locked DB verification without network I/O, and fail closed on stale/missing
 * facts. No public route, default verifier, provider credential or action factory
 * is installed. Durable intents precede provider calls; completion requires an
 * independent smoke/observation/recovery verifier, not an adapter ACK. */
export class ReleaseLifecycle {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: {
      repositoryPolicies: RepositoryPolicyStore;
      policies(): unknown;
      productionEnabled?: boolean;
      singleWorker?: boolean;
      nativeTarget?: NativePreviewReleaseTarget;
      nativeBootstrap?: {
        enrollment: unknown;
        authorityConfigDigest: string;
        observationConfigDigest: string;
        observationWindowMs: number;
      };
      verifyNativeOpening?(
        tx: Tx,
        scope: {
          ownerId: string;
          taskId: string;
          sourceSha: string;
          targetDigest: string;
          riskAttestationDigest: string;
          baselines: z.infer<typeof nativeBaselineSchema>;
        },
      ): Promise<boolean>;
      verifyNativePreparation?(
        tx: Tx,
        ownerId: string,
        identity: ReleaseActionIdentity,
        snapshot: unknown,
        completed: {
          id: string;
          kind: string;
          request: Record<string, unknown>;
          receipt: Record<string, unknown>;
        }[],
      ): Promise<boolean>;
      recordNativeBaseline?(
        tx: Tx,
        ownerId: string,
        releaseId: string,
        evidence: Record<string, unknown>,
        evidenceDigest: string,
      ): Promise<void>;
      resolveDatabasePin?(
        tx: Tx,
        scope: { ownerId: string; taskId: string; sourceSha: string; targetDigest: string },
      ): Promise<z.infer<typeof databasePinSchema> | null>;
      verifyOpening(
        tx: Tx,
        scope: {
          ownerId: string;
          taskId: string;
          sourceSha: string;
          targetDigest: string;
          riskAttestationDigest: string;
          baselines: z.infer<typeof releaseBaselinesSchema>;
          riskClass: "application_only" | "database";
        },
      ): Promise<boolean>;
      verifyAction(tx: Tx, identity: z.infer<typeof releaseActionIdentitySchema>): Promise<boolean>;
      verifyObservation(
        tx: Tx,
        context: {
          releaseId: string;
          kind: "stage_ready" | "healthy" | "regression" | "recovered";
          evidence: Record<string, unknown>;
        },
      ): Promise<boolean>;
    },
  ) {}
  private async transaction<T>(run: (tx: Tx) => Promise<T>) {
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 10000,
        });
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
  async open(raw: unknown) {
    const input = z
      .object({
        id: uuid,
        ownerId: uuid,
        taskId: uuid,
        policyVersionId: uuid,
        riskAttestationDigest: digest,
        baselines: z.union([releaseBaselinesSchema, nativeBaselineSchema]),
        riskClass: z.enum(["application_only", "database"]).default("application_only"),
      })
      .strict()
      .parse(raw);
    const native = nativeBaselineSchema.safeParse(input.baselines);
    if (native.success !== !!this.dependencies.nativeTarget) return deny();
    if (
      !native.success &&
      this.dependencies.singleWorker &&
      githubSourceDigest(releaseBaselinesSchema.parse(input.baselines).app) !==
        githubSourceDigest(releaseBaselinesSchema.parse(input.baselines).auth)
    )
      return deny();
    return this.transaction(async (tx) => {
      const bound = await this.dependencies.repositoryPolicies.resolveTask(
        tx,
        input.ownerId,
        input.taskId,
      );
      if (
        !bound ||
        bound.task.pauseRequested ||
        bound.task.schedulingPaused ||
        !bound.task.currentSourceRevision
      )
        return deny();
      const source = bound.task.currentSourceRevision;
      if (bound.task.sourceSha !== source.headSha || bound.task.sourceRevisionId !== source.id)
        return deny();
      const policies = z.array(releasePolicySchema).max(32).parse(this.dependencies.policies());
      const candidates = policies.filter((p) => p.versionId === input.policyVersionId);
      if (candidates.length !== 1) return deny();
      const policy = candidates[0],
        now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0].now.getTime();
      if (policy.environmentKey !== "preview" && this.dependencies.productionEnabled !== true)
        return deny();
      if (
        !releasePolicyCovers(
          policy,
          {
            ownerId: input.ownerId,
            repositoryId: source.repositoryId,
            providerAccountId: source.providerAccountId,
            environmentKey: policy.environmentKey,
            targetDigest: policy.targetDigest,
            action: "merge",
            riskClass: input.riskClass,
          },
          now,
        )
      )
        return deny();
      const opening = {
        ownerId: input.ownerId,
        taskId: input.taskId,
        sourceSha: source.headSha,
        targetDigest: policy.targetDigest,
        riskAttestationDigest: input.riskAttestationDigest,
      };
      if (
        native.success
          ? !(await this.dependencies.verifyNativeOpening?.(tx, {
              ...opening,
              baselines: native.data,
            }))
          : !(await this.dependencies.verifyOpening(tx, {
              ...opening,
              baselines: releaseBaselinesSchema.parse(input.baselines),
              riskClass: input.riskClass,
            }))
      )
        return deny();
      const database =
        input.riskClass === "database"
          ? await this.dependencies.resolveDatabasePin?.(tx, {
              ownerId: input.ownerId,
              taskId: input.taskId,
              sourceSha: source.headSha,
              targetDigest: policy.targetDigest,
            })
          : undefined;
      if (input.riskClass === "database" && !database) return deny();
      const snapshot = {
        schemaVersion: 1,
        ...(native.success
          ? {
              provider: "cloudflare-native-preview",
              native: {
                provider: "cloudflare-native-preview",
                target: this.dependencies.nativeTarget,
                externalWriterPolicy: "observed-drift-hold-no-atomic-cas",
                purpose: "publication",
                recoveryBaseline: native.data,
              },
            }
          : {}),
        ...(this.dependencies.singleWorker ? { topology: "single" as const } : {}),
        policyVersionId: policy.versionId,
        repositoryPolicyDigest: bound.binding.policyDigest,
        repositoryBindingDigest: bound.binding.bindingDigest,
        sourceSha: source.headSha,
        riskAttestationDigest: input.riskAttestationDigest,
        observationWindowMs: policy.observationWindowMs,
        observationConfigDigest: policy.observationConfigDigest,
        buildAuthorityDigest: policy.buildAuthorityDigest,
        authorityConfigDigest: policy.authorityConfigDigest,
        baselines: input.baselines,
        ...(input.riskClass === "database"
          ? { riskClass: input.riskClass, database: databasePinSchema.parse(database) }
          : {}),
      };
      await tx.$executeRaw`INSERT INTO delivery_release_targets(target_digest) VALUES (${policy.targetDigest}) ON CONFLICT DO NOTHING`;
      for (const resource of policy.targetResources) {
        await tx.$executeRaw`INSERT INTO delivery_release_target_members(resource_digest,target_digest) VALUES (${resource},${policy.targetDigest}) ON CONFLICT (resource_digest) DO NOTHING`;
        const owners = await tx.$queryRaw<
          { target_digest: string }[]
        >`SELECT target_digest FROM delivery_release_target_members WHERE resource_digest=${resource} FOR UPDATE`;
        if (owners[0]?.target_digest !== policy.targetDigest) return deny();
      }
      const target = await tx.$queryRaw<
        { active_release_id: string | null; generation: number }[]
      >`SELECT active_release_id,generation FROM delivery_release_targets WHERE target_digest=${policy.targetDigest} FOR UPDATE`;
      if (target[0].active_release_id) {
        if (target[0].active_release_id !== input.id) return deny();
        const prior = await tx.$queryRaw<
          { owner_id: string; task_id: string; snapshot_digest: string; policy_digest: string }[]
        >`SELECT owner_id,task_id,snapshot_digest,policy_digest FROM delivery_releases WHERE id=${input.id}::uuid`;
        if (
          prior[0]?.owner_id !== input.ownerId ||
          prior[0]?.task_id !== input.taskId ||
          prior[0]?.snapshot_digest !== githubSourceDigest(snapshot) ||
          prior[0]?.policy_digest !== githubSourceDigest(policy)
        )
          return deny();
        return { releaseId: input.id, generation: target[0].generation, replay: true };
      }
      await tx.$executeRaw`INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest)
        VALUES (${input.id}::uuid,${input.ownerId}::uuid,${input.taskId}::uuid,${source.id}::uuid,${policy.targetDigest},${githubSourceDigest(policy)},${canonicalGitHubSource(snapshot)}::jsonb,${githubSourceDigest(snapshot)})`;
      const generation = target[0].generation + 1;
      await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=${input.id}::uuid,generation=${generation} WHERE target_digest=${policy.targetDigest}`;
      return { releaseId: input.id, generation, replay: false };
    });
  }
  /** Initial enrollment is deployment-owned, not a model/task request. It has
   * no recovery promise until independently accepted sampled health is stored. */
  async openNativeBootstrap() {
    const configured = this.dependencies.nativeBootstrap,
      target = this.dependencies.nativeTarget;
    if (!configured || !target) return deny();
    const b = nativeBootstrapEnrollmentSchema.parse(configured.enrollment),
      targetDigest = githubSourceDigest(target);
    return this.transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO delivery_release_targets(target_digest) VALUES (${targetDigest}) ON CONFLICT DO NOTHING`;
      const lock = (
        await tx.$queryRaw<
          { active_release_id: string | null; generation: number }[]
        >`SELECT active_release_id,generation FROM delivery_release_targets WHERE target_digest=${targetDigest} FOR UPDATE`
      )[0];
      const accepted = await tx.$queryRaw<
        { observation_digest: string }[]
      >`SELECT observation_digest FROM delivery_native_release_baselines WHERE target_digest=${targetDigest} LIMIT 1`;
      if (accepted.length || (lock.active_release_id && lock.active_release_id !== b.releaseId))
        return deny();
      const sources = await tx.$queryRaw<
        {
          source_sha: string | null;
          source_revision_id: string | null;
          head_sha: string;
          pause_requested: boolean;
          scheduling_paused: boolean;
        }[]
      >`SELECT t.source_sha,t.source_revision_id,s.head_sha,t.pause_requested,t.scheduling_paused FROM delivery_tasks t JOIN delivery_source_revisions s ON s.id=${b.sourceRevisionId}::uuid AND s.owner_id=t.owner_id AND s.task_id=t.id WHERE t.id=${b.taskId}::uuid AND t.owner_id=${b.ownerId}::uuid FOR UPDATE OF t`;
      const source = sources[0];
      if (
        !source ||
        source.head_sha !== b.sourceSha ||
        source.source_revision_id !== b.sourceRevisionId ||
        source.source_sha !== b.sourceSha ||
        source.pause_requested ||
        source.scheduling_paused
      )
        return deny();
      const snapshot = {
        schemaVersion: 1,
        provider: "cloudflare-native-preview",
        sourceSha: b.sourceSha,
        bootstrapApprovalDigest: githubSourceDigest(b),
        authorityConfigDigest: configured.authorityConfigDigest,
        observationConfigDigest: configured.observationConfigDigest,
        observationWindowMs: configured.observationWindowMs,
        native: {
          provider: "cloudflare-native-preview",
          target,
          externalWriterPolicy: "observed-drift-hold-no-atomic-cas",
          purpose: "bootstrap-baseline",
          recoveryBaseline: null,
        },
      };
      if (lock.active_release_id) {
        const previous = await tx.$queryRaw<
          { snapshot_digest: string }[]
        >`SELECT snapshot_digest FROM delivery_releases WHERE id=${b.releaseId}::uuid AND owner_id=${b.ownerId}::uuid`;
        if (previous[0]?.snapshot_digest !== githubSourceDigest(snapshot)) return deny();
        return { releaseId: b.releaseId, generation: lock.generation, replay: true };
      }
      const resource = githubSourceDigest({
        provider: "cloudflare-native-preview",
        accountId: target.accountId,
        workerName: target.workerName,
        previewId: target.previewId,
      });
      await tx.$executeRaw`INSERT INTO delivery_release_target_members(resource_digest,target_digest) VALUES (${resource},${targetDigest}) ON CONFLICT DO NOTHING`;
      const owners = await tx.$queryRaw<
        { target_digest: string }[]
      >`SELECT target_digest FROM delivery_release_target_members WHERE resource_digest=${resource} FOR UPDATE`;
      if (owners[0]?.target_digest !== targetDigest) return deny();
      await tx.$executeRaw`INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest) VALUES (${b.releaseId}::uuid,${b.ownerId}::uuid,${b.taskId}::uuid,${b.sourceRevisionId}::uuid,${targetDigest},${githubSourceDigest(b)},${canonicalGitHubSource(snapshot)}::jsonb,${githubSourceDigest(snapshot)})`;
      await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=${b.releaseId}::uuid,generation=generation+1 WHERE target_digest=${targetDigest}`;
      if (
        (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime() >=
        b.expiresAt
      )
        return deny();
      return { releaseId: b.releaseId, generation: lock.generation + 1, replay: false };
    });
  }
  async prepare(ownerId: string, raw: unknown) {
    uuid.parse(ownerId);
    const input = z
      .object({
        id: uuid,
        releaseId: uuid,
        kind: z.enum(["merge", "promote", "recover"]),
        request: z.record(z.unknown()),
      })
      .strict()
      .parse(raw);
    const encoded = canonicalGitHubSource(input.request);
    if (Buffer.byteLength(encoded) > 32768) return deny();
    if (input.kind === "merge") githubReleaseRequestSchema.parse(input.request);
    else if (input.request.provider === "cloudflare-native-preview") {
      if (!this.dependencies.nativeTarget) return deny();
      nativePublicationRequestSchema.parse(input.request);
    } else {
      if (this.dependencies.nativeTarget) return deny();
      cloudflareReleaseRequestSchema.parse(input.request);
    }
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          target_digest: string;
          generation: number;
          phase: string;
          snapshot: unknown;
          snapshot_digest: string;
        }[]
      >`SELECT r.target_digest,t.generation,r.phase,r.snapshot,r.snapshot_digest FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
        WHERE r.id=${input.releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND t.active_release_id=r.id FOR UPDATE OF t,r`;
      const row = rows[0];
      if (!row || (input.kind === "recover" ? row.phase !== "held" : row.phase !== "active"))
        return deny();
      if (githubSourceDigest(row.snapshot) !== row.snapshot_digest) return deny();
      const identity = releaseActionIdentitySchema.parse({
        ...input,
        targetDigest: row.target_digest,
        requestDigest: githubSourceDigest(input.request),
        generation: row.generation,
      });
      if (!(await this.dependencies.verifyAction(tx, identity))) return deny();
      const prior = await tx.$queryRaw<
        {
          id: string;
          release_id: string;
          kind: string;
          request_digest: string;
          target_digest: string;
          generation: number;
        }[]
      >`SELECT id,release_id,kind,request_digest,target_digest,generation FROM delivery_release_actions WHERE id=${input.id}::uuid`;
      if (prior.length) {
        if (
          prior[0].release_id !== input.releaseId ||
          prior[0].kind !== input.kind ||
          prior[0].request_digest !== identity.requestDigest ||
          prior[0].target_digest !== identity.targetDigest ||
          prior[0].generation !== identity.generation
        )
          return deny();
        return { actionId: input.id, replay: true };
      }
      const completed = await tx.$queryRaw<
        {
          id: string;
          kind: string;
          request: Record<string, unknown>;
          receipt: Record<string, unknown>;
          receipt_digest: string;
        }[]
      >`SELECT id,kind,request,receipt,receipt_digest FROM delivery_release_actions WHERE release_id=${input.releaseId}::uuid AND phase='observed'`;
      const merges = completed.filter(
        (a) => a.kind === "merge" && a.receipt?.provider === "github",
      );
      if (input.kind === "merge" && merges.length) return deny();
      const isNative = input.request.provider === "cloudflare-native-preview";
      if (
        isNative &&
        !(await this.dependencies.verifyNativePreparation?.(
          tx,
          ownerId,
          identity,
          row.snapshot,
          completed,
        ))
      )
        return deny();
      if (input.kind === "promote" && !isNative) {
        const baselines = z
          .object({ baselines: releaseBaselinesSchema })
          .passthrough()
          .parse(row.snapshot).baselines;
        const workerRequest = cloudflareReleaseRequestSchema.parse(input.request),
          baseline = baselines[workerRequest.component];
        const attestations = await tx.$queryRaw<
          {
            manifest: unknown;
            manifest_digest: string;
            evidence: Record<string, unknown>;
            evidence_digest: string;
          }[]
        >`SELECT b.manifest,b.manifest_digest,v.evidence,v.evidence_digest FROM delivery_release_build_attestations b JOIN delivery_release_build_verifications v ON v.owner_id=b.owner_id AND v.attestation_id=b.id WHERE b.owner_id=${ownerId}::uuid AND b.release_id=${input.releaseId}::uuid`;
        if (
          attestations.length !== 1 ||
          githubSourceDigest(attestations[0].manifest) !== attestations[0].manifest_digest ||
          githubSourceDigest(attestations[0].evidence) !== attestations[0].evidence_digest ||
          attestations[0].evidence.status !== "completed" ||
          attestations[0].evidence.conclusion !== "success" ||
          attestations[0].evidence.manifestDigest !== attestations[0].manifest_digest
        )
          return deny();
        const build = releaseBuildManifestSchema.parse(attestations[0].manifest),
          built = build[workerRequest.component];
        if (
          merges.length !== 1 ||
          merges[0].receipt.mergeSha !== input.request.mergedSha ||
          build.releaseId !== input.releaseId ||
          build.ownerId !== ownerId ||
          build.targetDigest !== row.target_digest ||
          (build.topology === "single") !== (this.dependencies.singleWorker === true) ||
          (this.dependencies.singleWorker && workerRequest.component !== "app") ||
          build.mergeSha !== workerRequest.mergedSha ||
          built.versionId !== workerRequest.versionId ||
          built.artifactDigest !== workerRequest.artifactDigest ||
          built.configDigest !== workerRequest.configDigest ||
          workerRequest.expectedDeploymentId !== baseline.deploymentId ||
          workerRequest.expectedVersionId !== baseline.versionId ||
          workerRequest.baselineSourceSha !== baseline.sourceSha ||
          workerRequest.baselineArtifactDigest !== baseline.artifactDigest ||
          workerRequest.baselineConfigDigest !== baseline.configDigest ||
          !["app", "auth"].includes(String(input.request.component)) ||
          completed.some(
            (a) => a.kind === "promote" && a.request.component === input.request.component,
          )
        )
          return deny();
        const previous = completed.filter((a) => a.kind === "promote");
        if (previous.length === 1) {
          const stage = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM delivery_release_observations WHERE release_id=${input.releaseId}::uuid AND kind='stage_ready' AND evidence->>'stageActionId'=${previous[0].id} AND evidence->>'stageReceiptDigest'=${previous[0].receipt_digest} AND created_at>clock_timestamp()-interval '30 seconds' LIMIT 1`;
          if (!stage.length) return deny();
        }
      }
      if (input.kind === "recover" && !isNative) {
        const priorPromotion = completed.filter(
          (a) => a.kind === "promote" && a.request.component === input.request.component,
        );
        if (
          priorPromotion.length !== 1 ||
          priorPromotion[0].receipt.deploymentId !== input.request.expectedDeploymentId ||
          priorPromotion[0].request.versionId !== input.request.expectedVersionId ||
          priorPromotion[0].request.expectedVersionId !== input.request.versionId ||
          priorPromotion[0].request.baselineSourceSha !== input.request.mergedSha ||
          priorPromotion[0].request.baselineArtifactDigest !== input.request.artifactDigest ||
          priorPromotion[0].request.baselineConfigDigest !== input.request.configDigest ||
          completed.some(
            (a) => a.kind === "recover" && a.request.component === input.request.component,
          )
        )
          return deny();
      }
      await tx.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation)
        VALUES (${input.id}::uuid,${input.releaseId}::uuid,${input.kind},${row.target_digest},${encoded}::jsonb,${identity.requestDigest},${row.generation})`;
      return { actionId: input.id, replay: false };
    });
  }
  async stageReady(ownerId: string, raw: unknown) {
    uuid.parse(ownerId);
    const input = z
      .object({ releaseId: uuid, evidence: z.record(z.unknown()) })
      .strict()
      .parse(raw);
    const encoded = canonicalGitHubSource(input.evidence),
      evidenceDigest = githubSourceDigest(input.evidence);
    if (Buffer.byteLength(encoded) > 32768 || input.evidence.smoke !== "passed") return deny();
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT r.id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.id=${input.releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND r.phase='active' AND t.active_release_id=r.id FOR UPDATE OF t,r`;
      if (!rows.length) return deny();
      const actions = await tx.$queryRaw<
        { id: string; receipt_digest: string }[]
      >`SELECT id,receipt_digest FROM delivery_release_actions WHERE release_id=${input.releaseId}::uuid AND kind='promote' AND phase='observed'`;
      const pending = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_actions WHERE release_id=${input.releaseId}::uuid AND phase IN ('prepared','effect_started','held') LIMIT 1`;
      if (
        actions.length !== 1 ||
        pending.length ||
        input.evidence.stageActionId !== actions[0].id ||
        input.evidence.stageReceiptDigest !== actions[0].receipt_digest ||
        !(await this.dependencies.verifyObservation(tx, { ...input, kind: "stage_ready" }))
      )
        return deny();
      const prior = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_observations WHERE release_id=${input.releaseId}::uuid AND kind='stage_ready' AND evidence_digest=${evidenceDigest}`;
      if (prior.length) return { phase: "stage_ready" as const, evidenceDigest, replay: true };
      await tx.$executeRaw`INSERT INTO delivery_release_observations(id,release_id,kind,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${input.releaseId}::uuid,'stage_ready',${encoded}::jsonb,${evidenceDigest})`;
      return { phase: "stage_ready" as const, evidenceDigest, replay: false };
    });
  }
  async observe(ownerId: string, raw: unknown) {
    uuid.parse(ownerId);
    const input = z
      .object({
        releaseId: uuid,
        kind: z.enum(["healthy", "regression", "recovered"]),
        evidence: z.record(z.unknown()),
      })
      .strict()
      .parse(raw);
    const encoded = canonicalGitHubSource(input.evidence),
      evidenceDigest = githubSourceDigest(input.evidence);
    if (Buffer.byteLength(encoded) > 32768) return deny();
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          phase: string;
          target_digest: string;
          snapshot: unknown;
          snapshot_digest: string;
          active_release_id: string | null;
          task_id: string;
        }[]
      >`SELECT r.phase,r.target_digest,r.snapshot,r.snapshot_digest,t.active_release_id,r.task_id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
        WHERE r.id=${input.releaseId}::uuid AND r.owner_id=${ownerId}::uuid FOR UPDATE OF t,r`;
      const row = rows[0];
      if (!row) return deny();
      const prior = await tx.$queryRaw<
        { evidence: unknown }[]
      >`SELECT evidence FROM delivery_release_observations WHERE release_id=${input.releaseId}::uuid AND kind=${input.kind} AND evidence_digest=${evidenceDigest}`;
      if (prior.length) {
        if (
          canonicalGitHubSource(prior[0].evidence) !== encoded ||
          (input.kind === "healthy" && row.phase !== "healthy") ||
          (input.kind === "regression" && !["held", "recovered"].includes(row.phase)) ||
          (input.kind === "recovered" && row.phase !== "recovered")
        )
          return deny();
        return {
          phase: input.kind === "regression" ? "held" : input.kind,
          evidenceDigest,
          replay: true,
          historical: true,
        };
      }
      if (
        row.active_release_id !== input.releaseId ||
        (input.kind === "recovered" ? row.phase !== "held" : row.phase !== "active")
      )
        return deny();
      if (githubSourceDigest(row.snapshot) !== row.snapshot_digest) return deny();
      const pending = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_actions WHERE release_id=${input.releaseId}::uuid AND phase IN ('prepared','effect_started','held') LIMIT 1`;
      const completed = await tx.$queryRaw<
        { kind: string; request: Record<string, unknown>; updated_at: Date }[]
      >`SELECT kind,request,updated_at FROM delivery_release_actions WHERE release_id=${input.releaseId}::uuid AND phase='observed'`;
      const promotions = completed.filter((a) => a.kind === "promote"),
        recoveries = completed.filter((a) => a.kind === "recover");
      if (input.kind === "healthy" || input.kind === "recovered") {
        const window = z
          .object({
            startedAt: z.number().int().nonnegative().safe(),
            endedAt: z.number().int().nonnegative().safe(),
            smoke: z.literal("passed"),
            metrics: this.dependencies.nativeTarget
              ? z.literal("sampled-only")
              : z.literal("passed"),
          })
          .passthrough()
          .safeParse(input.evidence);
        const config = z
          .object({ observationWindowMs: z.number().int().min(1000).max(86400000).safe() })
          .passthrough()
          .safeParse(row.snapshot);
        const now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0].now.getTime();
        if (
          !window.success ||
          !config.success ||
          window.data.endedAt > now ||
          window.data.endedAt - window.data.startedAt < config.data.observationWindowMs ||
          (input.kind === "healthy" ? promotions : recoveries).some(
            (p) => p.updated_at.getTime() > window.data.startedAt,
          )
        )
          return deny();
      }
      if (
        pending.length ||
        (input.kind === "healthy" &&
          !(
            this.dependencies.nativeTarget
              ? ["native-preview"]
              : this.dependencies.singleWorker
                ? ["app"]
                : ["app", "auth"]
          ).every((component) =>
            promotions.some((a) =>
              component === "native-preview"
                ? a.request.provider === "cloudflare-native-preview"
                : a.request.component === component,
            ),
          )) ||
        (input.kind === "regression" && promotions.length === 0) ||
        (input.kind === "recovered" &&
          !promotions.every((p) =>
            recoveries.some((a) => a.request.component === p.request.component),
          )) ||
        !(await this.dependencies.verifyObservation(tx, input))
      )
        return deny();
      await tx.$executeRaw`INSERT INTO delivery_release_observations(id,release_id,kind,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${input.releaseId}::uuid,${input.kind},${encoded}::jsonb,${evidenceDigest})`;
      if (this.dependencies.nativeTarget && ["healthy", "recovered"].includes(input.kind))
        await this.dependencies.recordNativeBaseline?.(
          tx,
          ownerId,
          input.releaseId,
          input.evidence,
          evidenceDigest,
        );
      await appendReleaseNotice(tx, {
        ownerId,
        taskId: row.task_id,
        releaseId: input.releaseId,
        aggregateKey: `release:${input.releaseId}`,
        aggregateVersion: input.kind === "recovered" ? 2 : 1,
        type:
          input.kind === "healthy"
            ? "release_healthy"
            : input.kind === "regression"
              ? "release_regression"
              : "release_recovered",
        evidenceDigest,
      });
      const next = input.kind === "regression" ? "held" : input.kind;
      await tx.$executeRaw`UPDATE delivery_releases SET phase=${next} WHERE id=${input.releaseId}::uuid`;
      if (input.kind !== "regression")
        await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=NULL WHERE target_digest=${row.target_digest}`;
      return { phase: next, evidenceDigest, replay: false, historical: false };
    });
  }
}
