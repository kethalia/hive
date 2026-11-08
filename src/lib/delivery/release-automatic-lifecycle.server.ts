import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { epicMergePreparedSchema } from "./epic-merge-contracts";
import { epicPreviewReadiness } from "./epic-readiness.server";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import {
  type AutomaticReleaseConfig,
  automaticObservationSchema,
  automaticReleaseAuthority,
  automaticReleaseEnrollment,
  automaticReleaseResource,
  automaticReleaseTarget,
  type ProductionAcceptanceAnchor,
  productionAcceptanceAnchorSchema,
} from "./release-automatic-contracts";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import { appendReleaseNotice } from "./release-notice.server";
import {
  releaseTestAttestationSchema,
  releaseTestChallengeRequestSchema,
} from "./release-tested-attestation.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { isInformationalStep } from "./state";

const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("automatic_production"),
    policyVersionId: id,
    authorityConfigDigest: digest,
    repositoryPolicyDigest: digest,
    repositoryBindingDigest: digest,
    sourceRevisionId: id,
    sourceSha: githubReleaseRequestSchema.shape.headSha,
    readinessDigest: digest,
    previewSeal: z.object({ attemptId: id, completionEventId: id, writerAttemptId: id }).strict(),
    testedAttestationDigest: digest,
    tested: releaseTestAttestationSchema,
    request: githubReleaseRequestSchema,
    riskClass: z.literal("application_only"),
    observationWindowMs: z.number().int().min(1000).max(86400000),
    observedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Tx = Prisma.TransactionClient;
type Row = {
  id: string;
  owner_id: string;
  task_id: string;
  source_revision_id: string;
  target_digest: string;
  policy_digest: string;
  snapshot: unknown;
  snapshot_digest: string;
  phase: string;
  purpose: string;
};
const deny = (): never => {
  throw Error("automatic_release_authority_unavailable");
};
export class AutomaticReleaseLifecycle {
  readonly targetDigest: string;
  constructor(
    private readonly db: PrismaClient,
    readonly config: AutomaticReleaseConfig,
    private readonly store: RepositoryPolicyStore,
  ) {
    this.targetDigest = automaticReleaseTarget(config);
  }
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
  private async locked(tx: Tx, ownerId: string, releaseId: string) {
    const rows = await tx.$queryRaw<
      Row[]
    >`SELECT r.* FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND r.target_digest=${this.targetDigest} AND t.active_release_id=r.id FOR UPDATE OF t,r`;
    return rows.length === 1 ? rows[0] : null;
  }
  private async testReceipt(tx: Tx, ownerId: string, taskId: string, receiptDigest: string) {
    const rows = await tx.$queryRaw<
      {
        payload: unknown;
        payload_digest: string;
        workflow_digest: string;
        expires_at: Date;
        created_at: Date;
        request: unknown;
        request_digest: string;
        policy_digest: string;
        checks_digest: string;
        nonce_digest: string;
      }[]
    >`SELECT a.payload,a.payload_digest,a.workflow_digest,a.expires_at,a.created_at,c.request,c.request_digest,c.policy_digest,c.checks_digest,c.nonce_digest FROM delivery_release_test_attestations a JOIN delivery_release_test_challenges c ON c.id=a.challenge_id AND c.owner_id=a.owner_id AND c.task_id=a.task_id WHERE a.owner_id=${ownerId}::uuid AND a.task_id=${taskId}::uuid AND a.payload_digest=${receiptDigest} FOR SHARE OF a,c`;
    if (rows.length !== 1) return null;
    const row = rows[0],
      parsed = releaseTestAttestationSchema.safeParse(row.payload);
    if (
      !parsed.success ||
      githubSourceDigest(row.payload) !== receiptDigest ||
      row.workflow_digest !== githubSourceDigest(this.config.tested)
    )
      return null;
    const {
      challengeId: _id,
      nonce,
      policyDigest,
      checksDigest,
      purpose: _purpose,
      ...rest
    } = parsed.data;
    const request = releaseTestChallengeRequestSchema.parse({
      ...rest,
      purpose: "release_test_challenge",
    });
    // The immutable challenge and submitted payload remain provenance after their grant expires.
    if (
      canonicalGitHubSource(request) !== canonicalGitHubSource(row.request) ||
      githubSourceDigest(row.request) !== row.request_digest ||
      policyDigest !== row.policy_digest ||
      checksDigest !== row.checks_digest ||
      createHash("sha256").update(nonce, "hex").digest("hex") !== row.nonce_digest ||
      parsed.data.controlDigest !== this.config.tested.workflow.controlDigest ||
      parsed.data.repositoryOwnerId !== this.config.tested.workflow.repositoryOwnerId ||
      row.expires_at.getTime() <= row.created_at.getTime() ||
      row.expires_at.getTime() - row.created_at.getTime() > 600000
    )
      return null;
    return {
      payload: parsed.data,
      expiresAt: row.expires_at.getTime(),
      createdAt: row.created_at.getTime(),
    };
  }
  private async current(tx: Tx, row: Row, fresh: boolean, historical = false) {
    const parsed = snapshotSchema.safeParse(row.snapshot),
      p = this.config.policy;
    if (
      !parsed.success ||
      row.purpose !== "automatic_production" ||
      !["active", "healthy"].includes(row.phase) ||
      row.owner_id !== p.ownerId ||
      row.target_digest !== this.targetDigest ||
      row.policy_digest !== githubSourceDigest(automaticReleaseEnrollment(this.config)) ||
      githubSourceDigest(row.snapshot) !== row.snapshot_digest
    )
      return null;
    const s = parsed.data,
      ready = historical
        ? null
        : await epicPreviewReadiness(tx, this.store, row.owner_id, row.task_id, s.previewSeal),
      bound = await this.store.resolveTask(tx, row.owner_id, row.task_id),
      source = bound?.task.currentSourceRevision;
    if (
      (!historical && !ready) ||
      (historical &&
        !(await verifyReleaseEvidence(tx, this.store, {
          ownerId: row.owner_id,
          taskId: row.task_id,
          sourceSha: s.sourceSha,
          milestone: "implementation_preview",
        }))) ||
      !bound ||
      !source ||
      s.policyVersionId !== p.versionId ||
      s.authorityConfigDigest !== automaticReleaseAuthority(this.config) ||
      s.observationWindowMs !== this.config.observation.windowMs ||
      s.sourceRevisionId !== row.source_revision_id ||
      (!historical &&
        (ready?.sourceRevisionId !== s.sourceRevisionId ||
          ready?.sourceSha !== s.sourceSha ||
          ready?.digest !== s.readinessDigest)) ||
      bound.task.sourceRevisionId !== s.sourceRevisionId ||
      bound.binding.policyDigest !== s.repositoryPolicyDigest ||
      bound.binding.bindingDigest !== s.repositoryBindingDigest ||
      source.repositoryId !== p.repositoryId ||
      source.providerAccountId !== p.providerAccountId ||
      source.baseBranch !== "main" ||
      source.fullName !== `${this.config.risk.owner}/${this.config.risk.name}` ||
      source.pullRequestId !== s.request.pullRequestId ||
      source.pullNumber !== s.request.pullNumber ||
      s.request.repositoryId !== p.repositoryId ||
      s.request.headSha !== source.headSha ||
      s.request.baseRef !== "main" ||
      s.request.method !== p.method
    )
      return null;
    const receipt = await this.testReceipt(
        tx,
        row.owner_id,
        row.task_id,
        s.testedAttestationDigest,
      ),
      now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime();
    if (
      !receipt ||
      canonicalGitHubSource(receipt.payload) !== canonicalGitHubSource(s.tested) ||
      s.tested.repositoryId !== s.request.repositoryId ||
      s.tested.pullNumber !== s.request.pullNumber ||
      s.tested.headSha !== s.request.headSha ||
      s.tested.baseSha !== s.request.baseSha ||
      s.tested.policyDigest !== row.policy_digest ||
      s.tested.checksDigest !== githubSourceDigest(bound.policy.evidenceGates) ||
      receipt.createdAt > now ||
      p.validFrom > now ||
      p.expiresAt <= now ||
      s.observedAt > now ||
      s.expiresAt <= s.observedAt ||
      s.expiresAt - s.observedAt > 30000 ||
      (fresh && receipt.expiresAt <= now)
    )
      return null;
    return { snapshot: s, authorityExpiresAt: Math.min(receipt.expiresAt, p.expiresAt) };
  }
  readonly authorize = async (tx: Tx, identity: ReleaseActionIdentity) => {
    if (identity.kind !== "merge" || identity.targetDigest !== this.targetDigest) return false;
    const row = await this.locked(tx, this.config.policy.ownerId, identity.releaseId);
    if (!row || row.phase !== "active") return false;
    const actions = await tx.$queryRaw<
      { phase: string; generation: number }[]
    >`SELECT phase,generation FROM delivery_release_actions WHERE id=${identity.id}::uuid AND release_id=${row.id}::uuid FOR UPDATE`;
    if (actions.length !== 1 || actions[0].generation !== identity.generation) return false;
    const current = await this.current(tx, row, actions[0].phase === "prepared");
    return (
      !!current &&
      canonicalGitHubSource(current.snapshot.request) === canonicalGitHubSource(identity.request)
    );
  };
  async dispatchAuthority(identity: ReleaseActionIdentity) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, this.config.policy.ownerId, identity.releaseId);
      if (!row || row.phase !== "active" || identity.kind !== "merge") return deny();
      const current = await this.current(tx, row, true);
      if (
        !current ||
        canonicalGitHubSource(current.snapshot.request) !== canonicalGitHubSource(identity.request)
      )
        return deny();
      return current.authorityExpiresAt;
    });
  }
  async open(input: {
    id: string;
    ownerId: string;
    taskId: string;
    prepared: z.infer<typeof epicMergePreparedSchema>;
    testedAttestationDigest: string;
    observedAt: number;
  }) {
    id.parse(input.id);
    id.parse(input.ownerId);
    id.parse(input.taskId);
    digest.parse(input.testedAttestationDigest);
    const prepared = epicMergePreparedSchema.parse(input.prepared);
    if (
      prepared.rulesDigest !== prepared.request.rulesDigest ||
      prepared.riskClass !== "application_only"
    )
      return deny();
    return this.transaction(async (tx) => {
      const ready = await epicPreviewReadiness(tx, this.store, input.ownerId, input.taskId),
        bound = await this.store.resolveTask(tx, input.ownerId, input.taskId),
        receipt = await this.testReceipt(
          tx,
          input.ownerId,
          input.taskId,
          input.testedAttestationDigest,
        );
      if (
        !ready ||
        !bound ||
        !receipt ||
        !bound.task.managerBinding?.currentAttemptId ||
        !bound.task.managerBinding.activeAttemptId
      )
        return deny();
      if (
        receipt.payload.mergeSha !== prepared.testedMergeSha ||
        receipt.payload.treeSha !== prepared.testedTreeSha
      )
        return deny();
      const snapshot = snapshotSchema.parse({
        schemaVersion: 1,
        purpose: "automatic_production",
        policyVersionId: this.config.policy.versionId,
        authorityConfigDigest: automaticReleaseAuthority(this.config),
        repositoryPolicyDigest: bound.binding.policyDigest,
        repositoryBindingDigest: bound.binding.bindingDigest,
        sourceRevisionId: ready.sourceRevisionId,
        sourceSha: ready.sourceSha,
        readinessDigest: ready.digest,
        previewSeal: {
          attemptId: bound.task.managerBinding.currentAttemptId,
          completionEventId: ready.completionEventId,
          writerAttemptId: bound.task.managerBinding.activeAttemptId,
        },
        testedAttestationDigest: input.testedAttestationDigest,
        tested: receipt.payload,
        request: prepared.request,
        riskClass: "application_only",
        observationWindowMs: this.config.observation.windowMs,
        observedAt: input.observedAt,
        expiresAt: input.observedAt + 30000,
      });
      const row: Row = {
        id: input.id,
        owner_id: input.ownerId,
        task_id: input.taskId,
        source_revision_id: ready.sourceRevisionId,
        target_digest: this.targetDigest,
        policy_digest: githubSourceDigest(automaticReleaseEnrollment(this.config)),
        snapshot,
        snapshot_digest: githubSourceDigest(snapshot),
        phase: "active",
        purpose: "automatic_production",
      };
      if (!(await this.current(tx, row, true))) return deny();
      await tx.$executeRaw`INSERT INTO delivery_release_targets(target_digest) VALUES (${this.targetDigest}) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO delivery_release_target_members(resource_digest,target_digest) VALUES (${automaticReleaseResource(this.config)},${this.targetDigest}) ON CONFLICT DO NOTHING`;
      const members = await tx.$queryRaw<
        { target_digest: string }[]
      >`SELECT target_digest FROM delivery_release_target_members WHERE resource_digest=${automaticReleaseResource(this.config)} FOR UPDATE`;
      if (members.length !== 1 || members[0].target_digest !== this.targetDigest) return deny();
      const target = (
        await tx.$queryRaw<
          { active_release_id: string | null }[]
        >`SELECT active_release_id FROM delivery_release_targets WHERE target_digest=${this.targetDigest} FOR UPDATE`
      )[0];
      if (target.active_release_id) {
        const prior = await this.locked(tx, input.ownerId, target.active_release_id);
        if (
          !prior ||
          prior.source_revision_id !== row.source_revision_id ||
          prior.policy_digest !== row.policy_digest ||
          !(await this.current(tx, prior, false))
        )
          return deny();
        return { releaseId: prior.id, replayed: true };
      }
      const existing = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_releases WHERE source_revision_id=${row.source_revision_id}::uuid AND target_digest=${this.targetDigest} LIMIT 1`;
      if (existing.length) return deny();
      await tx.$executeRaw`INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest,purpose) VALUES (${row.id}::uuid,${row.owner_id}::uuid,${row.task_id}::uuid,${row.source_revision_id}::uuid,${this.targetDigest},${row.policy_digest},${canonicalGitHubSource(snapshot)}::jsonb,${row.snapshot_digest},'automatic_production')`;
      await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=${row.id}::uuid,generation=generation+1 WHERE target_digest=${this.targetDigest}`;
      if (
        !(await this.current(tx, row, true)) ||
        (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime() >=
          snapshot.expiresAt
      )
        return deny();
      return { releaseId: row.id, replayed: false };
    });
  }
  private async merged(tx: Tx, row: Row, s: z.infer<typeof snapshotSchema>) {
    const rows = await tx.$queryRaw<
      {
        id: string;
        phase: string;
        generation: number;
        request: unknown;
        request_digest: string;
        receipt: unknown;
        receipt_digest: string;
        remote_reference: unknown;
      }[]
    >`SELECT id,phase,generation,request,request_digest,receipt,receipt_digest,remote_reference FROM delivery_release_actions WHERE release_id=${row.id}::uuid AND kind='merge' FOR UPDATE`;
    if (rows.length !== 1) return null;
    const a = rows[0];
    const receipt = z
        .object({
          provider: z.literal("github"),
          repositoryId: z.literal(s.request.repositoryId),
          pullRequestId: z.literal(s.request.pullRequestId),
          pullNumber: z.literal(s.request.pullNumber),
          headSha: z.literal(s.request.headSha),
          baseSha: z.literal(s.request.baseSha),
          rulesDigest: z.literal(s.request.rulesDigest),
          requestId: id,
          mergeSha: githubReleaseRequestSchema.shape.headSha,
        })
        .strict()
        .safeParse(a.receipt),
      ref = z
        .object({ provider: z.literal("github"), requestId: id })
        .strict()
        .safeParse(a.remote_reference);
    if (
      a.phase !== "observed" ||
      !receipt.success ||
      !ref.success ||
      receipt.data.requestId !== ref.data.requestId ||
      githubSourceDigest(a.receipt) !== a.receipt_digest ||
      githubSourceDigest(a.request) !== a.request_digest ||
      canonicalGitHubSource(a.request) !== canonicalGitHubSource(s.request)
    )
      return null;
    return { actionId: a.id, generation: a.generation, receipt: receipt.data };
  }
  async advance(ownerId: string, releaseId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || row.phase !== "active") return "held" as const;
      const current = await this.current(tx, row, false);
      if (!current) return "held" as const;
      const actions = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid FOR UPDATE`;
      if (actions.length > 1) return "held" as const;
      if (!actions.length) {
        if (!(await this.current(tx, row, true))) return "held" as const;
        const generation = (
          await tx.$queryRaw<
            { generation: number }[]
          >`SELECT generation FROM delivery_release_targets WHERE target_digest=${this.targetDigest}`
        )[0].generation;
        await tx.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation) VALUES (${randomUUID()}::uuid,${releaseId}::uuid,'merge',${this.targetDigest},${canonicalGitHubSource(current.snapshot.request)}::jsonb,${githubSourceDigest(current.snapshot.request)},${generation})`;
        return "prepared" as const;
      }
      return (await this.merged(tx, row, current.snapshot))
        ? ("awaiting_build" as const)
        : ("waiting" as const);
    });
  }
  async observationScope(ownerId: string, releaseId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row) return null;
      const current = await this.current(tx, row, false);
      if (!current) return null;
      const merged = await this.merged(tx, row, current.snapshot);
      return merged ? { taskId: row.task_id, ...merged } : null;
    });
  }
  async recordObservation(ownerId: string, releaseId: string, raw: unknown, began: number) {
    const observation = automaticObservationSchema.parse(raw);
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row) return "held" as const;
      const current = await this.current(tx, row, false);
      if (!current) return "held" as const;
      const merged = await this.merged(tx, row, current.snapshot);
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      if (
        !merged ||
        observation.mergeSha !== merged.receipt.mergeSha ||
        observation.health.build.sourceSha !== merged.receipt.mergeSha ||
        observation.origin !== this.config.target.origin ||
        observation.health.origin !== this.config.target.origin ||
        observation.health.build.branch !== "main" ||
        observation.check.headSha !== merged.receipt.mergeSha ||
        observation.check.buildUuid !== observation.health.build.buildUuid ||
        observation.check.status !== "completed" ||
        observation.check.conclusion !== "success" ||
        observation.check.detailsUrl !==
          `https://dash.cloudflare.com/${this.config.target.accountId}/workers/services/view/hive/production/builds/${observation.health.build.buildUuid}` ||
        began > now ||
        now - began >= 30000 ||
        observation.expiresAt <= observation.observedAt ||
        observation.expiresAt <= Date.now()
      )
        return "held" as const;
      const previous = await tx.$queryRaw<
        { evidence: unknown; evidence_digest: string; created_at: Date }[]
      >`SELECT evidence,evidence_digest,created_at FROM delivery_release_observations WHERE release_id=${releaseId}::uuid AND kind='automatic_health' ORDER BY created_at ASC LIMIT 1`;
      if (previous.length) {
        const prior = automaticObservationSchema.safeParse(previous[0].evidence);
        if (
          !prior.success ||
          githubSourceDigest(previous[0].evidence) !== previous[0].evidence_digest ||
          githubSourceDigest(prior.data.health.build) !==
            githubSourceDigest(observation.health.build)
        )
          return this.hold(tx, row, "release_regression");
      }
      const evidenceDigest = githubSourceDigest(observation);
      await tx.$executeRaw`INSERT INTO delivery_release_observations(id,release_id,kind,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${releaseId}::uuid,'automatic_health',${canonicalGitHubSource(observation)}::jsonb,${evidenceDigest}) ON CONFLICT DO NOTHING`;
      if (row.phase === "healthy") return "healthy" as const;
      if (
        previous.length &&
        now - previous[0].created_at.getTime() > this.config.observation.windowMs + 60000
      )
        return this.hold(tx, row, "release_regression");
      if (
        !previous.length ||
        now - previous[0].created_at.getTime() < this.config.observation.windowMs
      )
        return "observing" as const;
      await tx.$executeRaw`UPDATE delivery_releases SET phase='healthy' WHERE id=${releaseId}::uuid`;
      if (
        await verifyReleaseEvidence(tx, this.store, {
          ownerId,
          taskId: row.task_id,
          sourceSha: current.snapshot.sourceSha,
          milestone: "task_complete",
        })
      )
        await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=NULL WHERE target_digest=${this.targetDigest} AND active_release_id=${releaseId}::uuid`;
      await appendReleaseNotice(tx, {
        ownerId,
        taskId: row.task_id,
        releaseId,
        aggregateKey: `automatic-health/${releaseId}`,
        aggregateVersion: 1,
        type: "release_healthy",
        evidenceDigest,
      });
      return "healthy" as const;
    });
  }
  private async hold(tx: Tx, row: Row, type: "release_regression") {
    await tx.$executeRaw`UPDATE delivery_releases SET phase='held' WHERE id=${row.id}::uuid`;
    await appendReleaseNotice(tx, {
      ownerId: row.owner_id,
      taskId: row.task_id,
      releaseId: row.id,
      aggregateKey: `automatic-regression/${row.id}`,
      aggregateVersion: 1,
      type,
    });
    return "held" as const;
  }
  async observationFailed(ownerId: string, releaseId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || !["active", "healthy"].includes(row.phase)) return "held" as const;
      const prior = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_observations WHERE release_id=${releaseId}::uuid AND kind='automatic_health' LIMIT 1`;
      return prior.length ? this.hold(tx, row, "release_regression") : ("awaiting_build" as const);
    });
  }
  async readAcceptanceAnchor(
    tx: Tx,
    scope: { ownerId: string; taskId: string; sourceRevisionId: string; sourceSha: string },
  ) {
    const rows = await tx.$queryRaw<
      (Row & { fence_release_id: string | null; fence_generation: number })[]
    >`SELECT r.*,t.active_release_id AS fence_release_id,t.generation AS fence_generation FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.owner_id=${scope.ownerId}::uuid AND r.task_id=${scope.taskId}::uuid AND r.source_revision_id=${scope.sourceRevisionId}::uuid AND r.target_digest=${this.targetDigest} AND r.purpose='automatic_production' AND r.phase='healthy' FOR UPDATE OF t,r`;
    if (rows.length !== 1) return null;
    const row = rows[0],
      fenced = row.fence_release_id === row.id;
    const finalized = await this.finalized(tx, row.owner_id, row.id, row.task_id);
    if (!fenced && !finalized) return null;
    const current = await this.current(tx, row, false, !fenced);
    if (!current || current.snapshot.sourceSha !== scope.sourceSha) return null;
    const merged = await this.merged(tx, row, current.snapshot);
    if (!merged) return null;
    const notice = await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId: scope.ownerId,
          aggregateKey: `automatic-health/${row.id}`,
          aggregateVersion: 1,
        },
      },
    });
    const evidence = z
      .object({ releaseId: z.literal(row.id), evidenceDigest: digest })
      .strict()
      .safeParse(notice?.payload);
    if (
      !notice ||
      notice.taskId !== row.task_id ||
      notice.type !== "release_healthy" ||
      !evidence.success ||
      githubSourceDigest({ type: "release_healthy", payload: notice.payload }) !==
        notice.requestDigest
    )
      return null;
    const observations = await tx.$queryRaw<
      { id: string; evidence: unknown; evidence_digest: string }[]
    >`SELECT id,evidence,evidence_digest FROM delivery_release_observations WHERE release_id=${row.id}::uuid AND kind='automatic_health' AND evidence_digest=${evidence.data.evidenceDigest}`;
    if (
      observations.length !== 1 ||
      githubSourceDigest(observations[0].evidence) !== observations[0].evidence_digest
    )
      return null;
    const parsed = automaticObservationSchema.safeParse(observations[0].evidence);
    if (!parsed.success) return null;
    const observed = parsed.data;
    if (
      observed.mergeSha !== merged.receipt.mergeSha ||
      observed.origin !== this.config.target.origin ||
      observed.health.origin !== this.config.target.origin ||
      observed.health.build.sourceSha !== merged.receipt.mergeSha ||
      observed.health.build.branch !== "main" ||
      observed.check.buildUuid !== observed.health.build.buildUuid ||
      observed.check.headSha !== merged.receipt.mergeSha ||
      observed.check.status !== "completed" ||
      observed.check.conclusion !== "success" ||
      observed.check.detailsUrl !==
        `https://dash.cloudflare.com/${this.config.target.accountId}/workers/services/view/hive/production/builds/${observed.health.build.buildUuid}`
    )
      return null;
    const generation = merged.generation;
    if (fenced && row.fence_generation !== generation) return null;
    const anchor = productionAcceptanceAnchorSchema.parse({
      schemaVersion: 1,
      purpose: "automatic-production-acceptance",
      ownerId: row.owner_id,
      taskId: row.task_id,
      releaseId: row.id,
      generation,
      targetDigest: this.targetDigest,
      policyVersionId: current.snapshot.policyVersionId,
      policyDigest: row.policy_digest,
      authorityConfigDigest: current.snapshot.authorityConfigDigest,
      snapshotDigest: row.snapshot_digest,
      sourceRevisionId: row.source_revision_id,
      sourceSha: current.snapshot.sourceSha,
      mergeSha: merged.receipt.mergeSha,
      origin: this.config.target.origin,
      build: observed.health.build,
      buildDigest: githubSourceDigest(observed.health.build),
      observationId: observations[0].id,
      observationDigest: observations[0].evidence_digest,
      observation: observed,
      tested: current.snapshot.tested,
      previewSeal: {
        ...current.snapshot.previewSeal,
        readinessDigest: current.snapshot.readinessDigest,
      },
    });
    if (!fenced && finalized?.anchorDigest !== githubSourceDigest(anchor)) return null;
    return anchor;
  }
  private async finalized(tx: Tx, ownerId: string, releaseId: string, taskId: string) {
    const event = await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId,
          aggregateKey: `automatic-acceptance-finalized/${releaseId}`,
          aggregateVersion: 1,
        },
      },
    });
    const parsed = z
      .object({
        releaseId: z.literal(releaseId),
        anchorDigest: digest,
        generation: z.number().int().positive(),
        observationId: id,
        observationDigest: digest,
      })
      .strict()
      .safeParse(event?.payload);
    return event &&
      event.type === "production_acceptance_finalized" &&
      event.taskId === taskId &&
      parsed.success &&
      githubSourceDigest({ type: event.type, payload: event.payload }) === event.requestDigest
      ? parsed.data
      : null;
  }
  async verifyAcceptanceAnchor(
    tx: Tx,
    raw: ProductionAcceptanceAnchor,
    options: { fresh: boolean },
  ) {
    const parsed = productionAcceptanceAnchorSchema.safeParse(raw);
    if (!parsed.success) return false;
    const anchor = parsed.data,
      current = await this.readAcceptanceAnchor(tx, anchor);
    if (!current || canonicalGitHubSource(current) !== canonicalGitHubSource(anchor)) return false;
    if (!options.fresh) return true;
    const fence = await tx.$queryRaw<
      { active_release_id: string | null; generation: number }[]
    >`SELECT active_release_id,generation FROM delivery_release_targets WHERE target_digest=${this.targetDigest} FOR UPDATE`;
    if (
      fence.length !== 1 ||
      fence[0].active_release_id !== anchor.releaseId ||
      fence[0].generation !== anchor.generation
    )
      return false;
    const rows = await tx.$queryRaw<
      { evidence: unknown; evidence_digest: string; created_at: Date; now: Date }[]
    >`SELECT evidence,evidence_digest,created_at,clock_timestamp() AS now FROM delivery_release_observations WHERE release_id=${anchor.releaseId}::uuid AND kind='automatic_health' ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (rows.length !== 1 || githubSourceDigest(rows[0].evidence) !== rows[0].evidence_digest)
      return false;
    const observed = automaticObservationSchema.safeParse(rows[0].evidence),
      now = rows[0].now.getTime();
    return (
      observed.success &&
      rows[0].created_at.getTime() <= now &&
      now - rows[0].created_at.getTime() < 30000 &&
      observed.data.observedAt <= now + 1000 &&
      observed.data.expiresAt > now &&
      observed.data.expiresAt > observed.data.observedAt &&
      observed.data.expiresAt - observed.data.observedAt <= 30000 &&
      observed.data.mergeSha === anchor.mergeSha &&
      observed.data.origin === anchor.origin &&
      githubSourceDigest(observed.data.health.build) === anchor.buildDigest
    );
  }
  async finalizeAcceptance(tx: Tx, anchor: ProductionAcceptanceAnchor) {
    const prior = await this.finalized(tx, anchor.ownerId, anchor.releaseId, anchor.taskId);
    if (prior) {
      if (
        prior.anchorDigest !== githubSourceDigest(anchor) ||
        !(await this.verifyAcceptanceAnchor(tx, anchor, { fresh: false }))
      )
        return deny();
      return true;
    }
    // Invalid current authority aborts the caller's completion transaction.
    // Only other legitimate unfinished production steps defer finalization.
    if (!(await this.verifyAcceptanceAnchor(tx, anchor, { fresh: true }))) return deny();
    if (
      !(await verifyReleaseEvidence(tx, this.store, {
        ownerId: anchor.ownerId,
        taskId: anchor.taskId,
        sourceSha: anchor.sourceSha,
        milestone: "task_complete",
      }))
    ) {
      const steps = await tx.deliveryStep.findMany({
        where: { ownerId: anchor.ownerId, taskId: anchor.taskId },
      });
      const unfinished = steps.filter(
        (step) => !isInformationalStep(step) && step.state !== "succeeded",
      );
      if (
        !unfinished.length ||
        unfinished.some(
          (step) =>
            step.acceptancePhase !== "activation_production" ||
            !["pending", "ready", "running"].includes(step.state),
        )
      )
        return deny();
      return false;
    }
    const proof = (
      await tx.$queryRaw<
        { id: string; evidence_digest: string; evidence: unknown }[]
      >`SELECT id,evidence_digest,evidence FROM delivery_release_observations WHERE release_id=${anchor.releaseId}::uuid AND kind='automatic_health' ORDER BY created_at DESC,id DESC LIMIT 1`
    )[0];
    if (!proof) return deny();
    const deadline = Math.min(
      automaticObservationSchema.parse(proof.evidence).expiresAt,
      this.config.policy.expiresAt,
    );
    const payload = {
        releaseId: anchor.releaseId,
        anchorDigest: githubSourceDigest(anchor),
        generation: anchor.generation,
        observationId: proof.id,
        observationDigest: proof.evidence_digest,
      },
      type = "production_acceptance_finalized";
    await tx.$executeRaw`INSERT INTO delivery_events(id,owner_id,task_id,aggregate_key,aggregate_version,schema_version,policy_version,type,request_digest,payload) VALUES (${randomUUID()}::uuid,${anchor.ownerId}::uuid,${anchor.taskId}::uuid,${`automatic-acceptance-finalized/${anchor.releaseId}`},1,1,'release-v1',${type},${githubSourceDigest({ type, payload })},${canonicalGitHubSource(payload)}::jsonb)`;
    await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=NULL WHERE target_digest=${this.targetDigest} AND active_release_id=${anchor.releaseId}::uuid AND generation=${anchor.generation}`;
    if (
      (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime() >=
      deadline
    )
      return deny();
    return true;
  }
}
