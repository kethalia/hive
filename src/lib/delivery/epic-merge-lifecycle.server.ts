import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import {
  type EpicMergeConfig,
  epicMergeAuthority,
  epicMergeEnrollment,
  epicMergePreparedSchema,
  epicMergeTarget,
} from "./epic-merge-contracts";
import { epicPreviewMergeCandidate } from "./epic-merge-observation.server";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import { appendReleaseNotice } from "./release-notice.server";
import { verifyReleaseTestReceipt } from "./release-tested-store.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("epic_preview_integration"),
    policyVersionId: id,
    authorityConfigDigest: digest,
    repositoryPolicyDigest: digest,
    repositoryBindingDigest: digest,
    epicId: id,
    intentId: id,
    sourceRevisionId: id,
    sourceSha: githubReleaseRequestSchema.shape.headSha,
    readinessDigest: digest,
    planDigest: digest,
    nodeDigest: digest,
    testedAttestationDigest: digest,
    request: githubReleaseRequestSchema,
    observedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
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
  throw Error("epic_merge_authority_unavailable");
};

/** A purpose branch of the existing release journal. Integration clears only
 * its GitHub branch fence; it never observes health, quiesces or archives a task. */
export class EpicPreviewMergeLifecycle {
  readonly targetDigest: string;
  constructor(
    private readonly db: PrismaClient,
    readonly config: EpicMergeConfig,
    private readonly store: RepositoryPolicyStore,
  ) {
    this.targetDigest = epicMergeTarget(config);
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
    >`SELECT r.* FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
      WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND r.target_digest=${this.targetDigest}
      AND t.active_release_id=r.id FOR UPDATE OF t,r`;
    return rows.length === 1 ? rows[0] : null;
  }
  private async current(tx: Tx, row: Row, requireFresh: boolean) {
    const parsed = snapshotSchema.safeParse(row.snapshot),
      p = this.config.policy;
    if (
      !parsed.success ||
      row.purpose !== "epic_preview_integration" ||
      row.phase !== "active" ||
      row.owner_id !== p.ownerId ||
      row.target_digest !== this.targetDigest ||
      row.policy_digest !== githubSourceDigest(epicMergeEnrollment(this.config)) ||
      githubSourceDigest(row.snapshot) !== row.snapshot_digest
    )
      return null;
    const snapshot = parsed.data;
    if (
      snapshot.policyVersionId !== p.versionId ||
      snapshot.authorityConfigDigest !== epicMergeAuthority(this.config) ||
      snapshot.sourceRevisionId !== row.source_revision_id ||
      snapshot.expiresAt <= snapshot.observedAt ||
      snapshot.expiresAt - snapshot.observedAt > 30000
    )
      return null;
    const candidate = await epicPreviewMergeCandidate(tx, this.store, {
      ownerId: row.owner_id,
      epicId: snapshot.epicId,
      intentId: snapshot.intentId,
    });
    const bound = await this.store.resolveTask(tx, row.owner_id, row.task_id),
      source = bound?.task.currentSourceRevision;
    if (
      !candidate ||
      !bound ||
      !source ||
      candidate.ready.taskId !== row.task_id ||
      candidate.ready.sourceRevisionId !== snapshot.sourceRevisionId ||
      candidate.ready.sourceSha !== snapshot.sourceSha ||
      candidate.ready.digest !== snapshot.readinessDigest ||
      candidate.planDigest !== snapshot.planDigest ||
      candidate.nodeDigest !== snapshot.nodeDigest ||
      bound.binding.policyDigest !== snapshot.repositoryPolicyDigest ||
      bound.binding.bindingDigest !== snapshot.repositoryBindingDigest ||
      source.repositoryId !== p.repositoryId ||
      source.providerAccountId !== p.providerAccountId ||
      source.baseBranch !== p.baseBranch ||
      source.fullName !== `${this.config.risk.owner}/${this.config.risk.name}` ||
      source.pullRequestId !== snapshot.request.pullRequestId ||
      source.pullNumber !== snapshot.request.pullNumber ||
      snapshot.request.repositoryId !== p.repositoryId ||
      snapshot.request.headSha !== source.headSha ||
      snapshot.request.baseRef !== p.baseBranch ||
      snapshot.request.method !== p.method ||
      !(await verifyReleaseTestReceipt(tx, {
        ownerId: row.owner_id,
        taskId: row.task_id,
        digest: snapshot.testedAttestationDigest,
        request: snapshot.request,
      }))
    )
      return null;
    const receipts = await tx.$queryRaw<
      {
        payload: { policyDigest?: string; checksDigest?: string };
        workflow_digest: string;
        expires_at: Date;
      }[]
    >`
      SELECT payload,workflow_digest,expires_at FROM delivery_release_test_attestations WHERE owner_id=${row.owner_id}::uuid AND task_id=${row.task_id}::uuid AND payload_digest=${snapshot.testedAttestationDigest} FOR SHARE`;
    if (
      receipts.length !== 1 ||
      receipts[0].payload.policyDigest !== row.policy_digest ||
      receipts[0].payload.checksDigest !== githubSourceDigest(bound.policy.evidenceGates) ||
      receipts[0].workflow_digest !== githubSourceDigest(this.config.tested)
    )
      return null;
    const now = (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    if (
      receipts[0].expires_at.getTime() <= now ||
      p.validFrom > now ||
      p.expiresAt <= now ||
      snapshot.observedAt > now ||
      (requireFresh && snapshot.expiresAt <= now)
    )
      return null;
    return snapshot;
  }
  readonly authorize = async (tx: Tx, identity: ReleaseActionIdentity) => {
    if (identity.kind !== "merge" || identity.targetDigest !== this.targetDigest) return false;
    const row = await this.locked(tx, this.config.policy.ownerId, identity.releaseId);
    if (!row) return false;
    const actions = await tx.$queryRaw<
      { phase: string; generation: number }[]
    >`SELECT phase,generation FROM delivery_release_actions WHERE id=${identity.id}::uuid AND release_id=${row.id}::uuid FOR UPDATE`;
    if (actions.length !== 1 || actions[0].generation !== identity.generation) return false;
    const snapshot = await this.current(tx, row, false);
    return (
      !!snapshot &&
      canonicalGitHubSource(snapshot.request) === canonicalGitHubSource(identity.request)
    );
  };
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
      const task = await tx.deliveryTask.findUnique({
        where: { ownerId_id: { ownerId: input.ownerId, id: input.taskId } },
        include: { managerBinding: true },
      });
      if (!task?.epicId || !task.managerBinding) return deny();
      const candidate = await epicPreviewMergeCandidate(tx, this.store, {
        ownerId: input.ownerId,
        epicId: task.epicId,
        intentId: task.managerBinding.preparationIntentId,
      });
      const bound = await this.store.resolveTask(tx, input.ownerId, input.taskId);
      if (!candidate || !bound || candidate.ready.taskId !== input.taskId) return deny();
      const snapshot = snapshotSchema.parse({
        schemaVersion: 1,
        purpose: "epic_preview_integration",
        policyVersionId: this.config.policy.versionId,
        authorityConfigDigest: epicMergeAuthority(this.config),
        repositoryPolicyDigest: bound.binding.policyDigest,
        repositoryBindingDigest: bound.binding.bindingDigest,
        epicId: task.epicId,
        intentId: task.managerBinding.preparationIntentId,
        sourceRevisionId: candidate.ready.sourceRevisionId,
        sourceSha: candidate.ready.sourceSha,
        readinessDigest: candidate.ready.digest,
        planDigest: candidate.planDigest,
        nodeDigest: candidate.nodeDigest,
        testedAttestationDigest: input.testedAttestationDigest,
        request: prepared.request,
        observedAt: input.observedAt,
        expiresAt: input.observedAt + 30000,
      });
      const row: Row = {
        id: input.id,
        owner_id: input.ownerId,
        task_id: input.taskId,
        source_revision_id: candidate.ready.sourceRevisionId,
        target_digest: this.targetDigest,
        policy_digest: githubSourceDigest(epicMergeEnrollment(this.config)),
        snapshot,
        snapshot_digest: githubSourceDigest(snapshot),
        phase: "active",
        purpose: "epic_preview_integration",
      };
      if (!(await this.current(tx, row, true))) return deny();
      await tx.$executeRaw`INSERT INTO delivery_release_targets(target_digest) VALUES (${this.targetDigest}) ON CONFLICT DO NOTHING`;
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
      await tx.$executeRaw`INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest,purpose)
        VALUES (${row.id}::uuid,${row.owner_id}::uuid,${row.task_id}::uuid,${row.source_revision_id}::uuid,${row.target_digest},${row.policy_digest},${canonicalGitHubSource(snapshot)}::jsonb,${row.snapshot_digest},'epic_preview_integration')`;
      await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=${row.id}::uuid,generation=generation+1 WHERE target_digest=${this.targetDigest}`;
      if (!(await this.current(tx, row, true))) return deny();
      return { releaseId: row.id, replayed: false };
    });
  }
  async advance(ownerId: string, releaseId: string) {
    id.parse(ownerId);
    id.parse(releaseId);
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row) return "held" as const;
      const actions = await tx.$queryRaw<
        {
          id: string;
          kind: string;
          phase: string;
          request: unknown;
          request_digest: string;
          receipt: unknown;
          receipt_digest: string | null;
          remote_reference: unknown;
        }[]
      >`
        SELECT id,kind,phase,request,request_digest,receipt,receipt_digest,remote_reference FROM delivery_release_actions WHERE release_id=${releaseId}::uuid ORDER BY created_at,id FOR UPDATE`;
      if (
        actions.length > 1 ||
        actions.some(
          (a) => a.kind !== "merge" || githubSourceDigest(a.request) !== a.request_digest,
        )
      )
        return "held" as const;
      const snapshot = await this.current(tx, row, false);
      if (!snapshot) return "held" as const;
      if (!actions.length) {
        const generation = (
          await tx.$queryRaw<
            { generation: number }[]
          >`SELECT generation FROM delivery_release_targets WHERE target_digest=${this.targetDigest}`
        )[0].generation;
        await tx.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation)
          VALUES (${randomUUID()}::uuid,${releaseId}::uuid,'merge',${this.targetDigest},${canonicalGitHubSource(snapshot.request)}::jsonb,${githubSourceDigest(snapshot.request)},${generation})`;
        return "prepared" as const;
      }
      const action = actions[0];
      if (action.phase !== "observed") return "waiting" as const;
      const receipt = z
        .object({
          provider: z.literal("github"),
          repositoryId: z.literal(snapshot.request.repositoryId),
          pullRequestId: z.literal(snapshot.request.pullRequestId),
          pullNumber: z.literal(snapshot.request.pullNumber),
          headSha: z.literal(snapshot.request.headSha),
          baseSha: z.literal(snapshot.request.baseSha),
          rulesDigest: z.literal(snapshot.request.rulesDigest),
          requestId: id,
          mergeSha: githubReleaseRequestSchema.shape.headSha,
        })
        .strict()
        .safeParse(action.receipt);
      const reference = z
        .object({ provider: z.literal("github"), requestId: id })
        .strict()
        .safeParse(action.remote_reference);
      if (
        !receipt.success ||
        !reference.success ||
        receipt.data.requestId !== reference.data.requestId ||
        githubSourceDigest(action.receipt) !== action.receipt_digest ||
        canonicalGitHubSource(action.request) !== canonicalGitHubSource(snapshot.request)
      )
        return "held" as const;
      await tx.$executeRaw`UPDATE delivery_releases SET phase='integrated' WHERE id=${releaseId}::uuid`;
      await tx.$executeRaw`UPDATE delivery_release_targets SET active_release_id=NULL WHERE target_digest=${this.targetDigest} AND active_release_id=${releaseId}::uuid`;
      await appendReleaseNotice(tx, {
        ownerId,
        taskId: row.task_id,
        releaseId,
        aggregateKey: `epic-integration/${releaseId}`,
        aggregateVersion: 1,
        type: "release_integrated",
        evidenceDigest: githubSourceDigest(receipt.data),
      });
      return "integrated" as const;
    });
  }
}
