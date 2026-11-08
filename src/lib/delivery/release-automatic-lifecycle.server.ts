import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { sourcePlanIntent } from "../../../services/migrate/src/delivery/source-plan-intent.mjs";
import { databaseActionHasReportedHistory } from "./database-job-history.server";
import { epicPreviewReadiness } from "./epic-readiness.server";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import {
  type AutomaticReleaseConfig,
  automaticObservationSchema,
  automaticPreparedSchema,
  automaticReleaseAuthority,
  automaticReleaseEnrollment,
  automaticReleaseResource,
  automaticReleaseTarget,
  type ProductionAcceptanceAnchor,
  productionAcceptanceAnchorSchema,
} from "./release-automatic-contracts";
import {
  type AutomaticDatabaseCatalog,
  automaticDatabaseGrantSchema,
  automaticDatabaseIntent,
  automaticDatabaseIntentSchema,
  automaticDatabaseStageFacts,
  catalogDatabaseEndpointDigest,
  configuredAutomaticDatabaseCatalog,
  readAutomaticDatabaseGrant,
  verifyAutomaticDatabaseIntent,
} from "./release-automatic-database.server";
import {
  type AutomaticDatabaseAction,
  automaticDatabaseActionSchema,
} from "./release-database-actions";
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
    riskClass: z.enum(["application_only", "database"]),
    database: automaticDatabaseIntentSchema.optional(),
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
  created_at: Date;
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
    private readonly databaseCatalog: (sourceSha: string) => AutomaticDatabaseCatalog | null = (
      sourceSha,
    ) => configuredAutomaticDatabaseCatalog(config, sourceSha),
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
  private async current(
    tx: Tx,
    row: Row,
    fresh: boolean,
    historical = false,
    pausedReceiptOnly = false,
  ) {
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
    const s = parsed.data;
    if (
      (s.riskClass === "database") !== !!s.database ||
      (s.database && s.database.mergeRequestDigest !== githubSourceDigest(s.request))
    )
      return null;
    const catalog = s.database ? this.databaseCatalog(s.sourceSha) : null;
    if (
      s.database &&
      (!catalog ||
        !verifyAutomaticDatabaseIntent(s.database, catalog, this.config, s.sourceSha, Date.now()))
    )
      return null;
    const ready = historical
        ? null
        : await epicPreviewReadiness(tx, this.store, row.owner_id, row.task_id, s.previewSeal),
      bound = await this.store.resolveTask(tx, row.owner_id, row.task_id),
      source = bound?.task.currentSourceRevision;
    if (
      (!historical && !ready) ||
      (historical &&
        !(await verifyReleaseEvidence(
          tx,
          this.store,
          {
            ownerId: row.owner_id,
            taskId: row.task_id,
            sourceSha: s.sourceSha,
            milestone: "implementation_preview",
          },
          pausedReceiptOnly ? { pausedReceiptOnly: true } : undefined,
        ))) ||
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
      (catalog && (catalog.validFrom > now || catalog.expiresAt <= now))
    )
      return null;
    let grantExpiresAt = receipt.expiresAt;
    if (fresh && receipt.expiresAt <= now) {
      if (!s.database || !catalog) return null;
      const target = await tx.$queryRaw<
        { generation: number }[]
      >`SELECT generation FROM delivery_release_targets WHERE target_digest=${this.targetDigest}`;
      const renewed =
        target.length === 1
          ? await readAutomaticDatabaseGrant(tx, {
              ownerId: row.owner_id,
              taskId: row.task_id,
              releaseId: row.id,
              generation: target[0].generation,
              targetDigest: this.targetDigest,
              sourceRevisionId: row.source_revision_id,
              sourceSha: s.sourceSha,
              baseSha: s.request.baseSha,
              testedMergeSha: s.tested.mergeSha,
              treeSha: s.tested.treeSha,
              originalAttestationDigest: s.testedAttestationDigest,
              policyVersionId: p.versionId,
              policyDigest: row.policy_digest,
              policyExpiresAt: p.expiresAt,
              preparedDigest: githubSourceDigest({
                request: s.request,
                riskClass: s.riskClass,
                rulesDigest: s.request.rulesDigest,
                testedMergeSha: s.tested.mergeSha,
                testedTreeSha: s.tested.treeSha,
              }),
              checksDigest: s.tested.checksDigest,
              intent: s.database,
              catalog,
              createdAt: row.created_at.getTime(),
              now,
            })
          : null;
      if (!renewed) return null;
      grantExpiresAt = renewed.grant.expiresAt;
    }
    return { snapshot: s, authorityExpiresAt: Math.min(grantExpiresAt, p.expiresAt) };
  }
  readonly authorize = async (tx: Tx, identity: ReleaseActionIdentity) => {
    if (identity.kind === "database_job") return this.authorizeDatabase(tx, identity);
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
      canonicalGitHubSource(current.snapshot.request) === canonicalGitHubSource(identity.request) &&
      (!current.snapshot.database ||
        (await this.databaseMergeReady(tx, row, current.snapshot, actions[0].phase === "prepared")))
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
      if (
        current.snapshot.database &&
        !(await this.databaseMergeReady(tx, row, current.snapshot, true))
      )
        return deny();
      if (current.snapshot.database) {
        const rows = await tx.deliveryEvent.findMany({
          where: {
            ownerId: row.owner_id,
            aggregateKey: `database-merge-authorized/${identity.id}`,
            aggregateVersion: 1,
          },
          take: 1,
        });
        const end = z.object({ expiresAt: z.number() }).passthrough().parse(rows[0]?.payload);
        return Math.min(current.authorityExpiresAt, end.expiresAt);
      }
      return current.authorityExpiresAt;
    });
  }
  async open(input: {
    id: string;
    ownerId: string;
    taskId: string;
    prepared: z.infer<typeof automaticPreparedSchema>;
    databaseBaseline?: unknown;
    testedAttestationDigest: string;
    observedAt: number;
  }) {
    id.parse(input.id);
    id.parse(input.ownerId);
    id.parse(input.taskId);
    digest.parse(input.testedAttestationDigest);
    const prepared = automaticPreparedSchema.parse(input.prepared);
    if (prepared.rulesDigest !== prepared.request.rulesDigest) return deny();
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
      const catalog =
        prepared.riskClass === "database" ? this.databaseCatalog(ready.sourceSha) : null;
      const openingNow = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      const database =
        prepared.riskClass === "database"
          ? automaticDatabaseIntent(
              this.config,
              catalog ?? deny(),
              {
                sourceSha: ready.sourceSha,
                baseSha: prepared.request.baseSha,
                mergeSha: prepared.testedMergeSha,
                treeSha: prepared.testedTreeSha,
                policyDigest: receipt.payload.policyDigest,
                checksDigest: receipt.payload.checksDigest,
                mergeActionId: randomUUID(),
                mergeRequestDigest: githubSourceDigest(prepared.request),
                baseline: input.databaseBaseline,
              },
              openingNow,
            )
          : undefined;
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
        riskClass: prepared.riskClass,
        ...(database ? { database } : {}),
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
        created_at: new Date(input.observedAt),
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
  private async databaseState(tx: Tx, row: Row, s: z.infer<typeof snapshotSchema>) {
    if (!s.database) return deny();
    const catalog = this.databaseCatalog(s.sourceSha),
      now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime();
    if (
      !catalog ||
      !verifyAutomaticDatabaseIntent(s.database, catalog, this.config, s.sourceSha, now)
    )
      return deny();
    const target = await tx.$queryRaw<
      { generation: number }[]
    >`SELECT generation FROM delivery_release_targets WHERE target_digest=${this.targetDigest} AND active_release_id=${row.id}::uuid`;
    if (target.length !== 1) return deny();
    return {
      catalog,
      intent: s.database,
      now,
      generation: target[0].generation,
      ownerId: row.owner_id,
      taskId: row.task_id,
      releaseId: row.id,
      sourceSha: s.sourceSha,
    };
  }
  private async databaseActivationProof(
    tx: Tx,
    row: Row,
    s: z.infer<typeof snapshotSchema>,
    pinned?: AutomaticDatabaseAction["activationProof"],
    fresh = true,
  ) {
    const scope = await this.databaseState(tx, row, s),
      merged = await this.merged(tx, row, s);
    if (!merged) return null;
    type Observation = { id: string; evidence: unknown; evidence_digest: string };
    const read = (o: Observation | undefined) => {
      if (!o) return null;
      const parsed = automaticObservationSchema.safeParse(o.evidence);
      if (!parsed.success) return null;
      const p = parsed.data,
        endpoint = scope.intent.baseline.health.databaseEndpointDigest;
      if (
        githubSourceDigest(p) !== o.evidence_digest ||
        !p.treeSha ||
        !endpoint ||
        p.observedAt > scope.now ||
        p.expiresAt <= p.observedAt ||
        p.expiresAt - p.observedAt > 30000 ||
        p.origin !== this.config.target.origin ||
        p.health.origin !== this.config.target.origin ||
        p.mergeSha !== merged.receipt.mergeSha ||
        p.health.build.sourceSha !== merged.receipt.mergeSha ||
        p.health.build.branch !== "main" ||
        p.treeSha !== s.tested.treeSha ||
        p.health.databaseEndpointDigest !== endpoint ||
        p.check.headSha !== merged.receipt.mergeSha ||
        p.check.buildUuid !== p.health.build.buildUuid
      )
        return null;
      return {
        observationId: o.id,
        observationDigest: o.evidence_digest,
        mergeSha: p.mergeSha,
        treeSha: p.treeSha,
        buildUuid: p.health.build.buildUuid,
        databaseEndpointDigest: endpoint,
        observedAt: p.observedAt,
        expiresAt: p.expiresAt,
      };
    };
    if (pinned) {
      const old = await tx.$queryRaw<
        Observation[]
      >`SELECT id,evidence,evidence_digest FROM delivery_release_observations WHERE id=${pinned.observationId}::uuid AND release_id=${row.id}::uuid AND kind='automatic_health'`;
      const original = read(old[0]);
      if (!original || canonicalGitHubSource(original) !== canonicalGitHubSource(pinned))
        return null;
      if (!fresh) return original;
    }
    const rows = await tx.$queryRaw<
      Observation[]
    >`SELECT id,evidence,evidence_digest FROM delivery_release_observations WHERE release_id=${row.id}::uuid AND kind='automatic_health' ORDER BY created_at DESC,id DESC LIMIT 1`;
    const current = read(rows[0]),
      end = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime();
    if (
      !current ||
      current.expiresAt <= end ||
      this.config.policy.expiresAt <= end ||
      scope.catalog.expiresAt <= end ||
      (pinned && current.buildUuid !== pinned.buildUuid)
    )
      return null;
    return current;
  }
  private async authorizeDatabase(tx: Tx, identity: ReleaseActionIdentity) {
    const row = await this.locked(tx, this.config.policy.ownerId, identity.releaseId);
    if (!row || row.phase !== "active") return false;
    const task = await tx.deliveryTask.findUnique({
      where: { ownerId_id: { ownerId: row.owner_id, id: row.task_id } },
      select: { pauseRequested: true, schedulingPaused: true },
    });
    const paused = !!task && (task.pauseRequested || task.schedulingPaused);
    const request = automaticDatabaseActionSchema.safeParse(identity.request);
    const catalog = request.success ? this.databaseCatalog(request.data.sourceSha) : null;
    if (
      paused &&
      (!request.success ||
        !catalog ||
        !(await databaseActionHasReportedHistory(
          tx,
          this.store,
          row.owner_id,
          row.task_id,
          request.data.dispatchId,
          catalog,
        )))
    )
      return false;
    const current = await this.current(tx, row, false, paused, paused);
    if (!current?.snapshot.database) return false;
    const scope = await this.databaseState(tx, row, current.snapshot),
      r = request;
    if (
      !r.success ||
      r.data.ownerId !== row.owner_id ||
      r.data.taskId !== row.task_id ||
      r.data.releaseId !== row.id ||
      r.data.generation !== scope.generation ||
      identity.generation !== scope.generation ||
      identity.targetDigest !== this.targetDigest ||
      r.data.targetDigest !== this.targetDigest ||
      r.data.catalogDigest !== scope.intent.catalogDigest ||
      r.data.planDigest !== scope.intent.planDigest ||
      r.data.sourceSha !== scope.sourceSha ||
      r.data.issuedAt > scope.now
    )
      return false;
    const actions = await tx.$queryRaw<{ id: string; request_digest: string; phase: string }[]>`
      SELECT id,request_digest,phase FROM delivery_release_actions WHERE release_id=${row.id}::uuid AND kind='database_job' FOR UPDATE`;
    if (!actions.some((a) => a.id === identity.id && a.request_digest === identity.requestDigest))
      return false;
    if (
      paused &&
      !actions.some((a) => a.id === identity.id && ["effect_started", "held"].includes(a.phase))
    )
      return false;
    if (r.data.stage === "approve")
      return (
        r.data.planEventId === null && actions.length <= (scope.catalog.automaticJobLimit ?? 8)
      );
    const facts = await automaticDatabaseStageFacts(tx, scope);
    if (r.data.planEventId !== facts.approved.id) return false;
    if (r.data.stage === "activate") {
      const action = actions.find((a) => a.id === identity.id);
      return !!(await this.databaseActivationProof(
        tx,
        row,
        current.snapshot,
        r.data.activationProof,
        action?.phase === "prepared",
      ));
    }
    return facts.stages.some((stage) => stage.request.stage === "approve");
  }
  async databaseDispatchAuthority(identity: ReleaseActionIdentity, freshDispatch = true) {
    return this.transaction(async (tx) => {
      if (!(await this.authorizeDatabase(tx, identity))) return deny();
      const row = await this.locked(tx, this.config.policy.ownerId, identity.releaseId);
      if (!row) return deny();
      const task = await tx.deliveryTask.findUnique({
        where: { ownerId_id: { ownerId: row.owner_id, id: row.task_id } },
        select: { pauseRequested: true, schedulingPaused: true },
      });
      const paused = !!task && (task.pauseRequested || task.schedulingPaused);
      if (paused && freshDispatch) return deny();
      const current = await this.current(tx, row, false, paused, paused);
      if (!current) return deny();
      const state = await this.databaseState(tx, row, current.snapshot),
        request = automaticDatabaseActionSchema.parse(identity.request);
      const activation =
        request.stage === "activate"
          ? await this.databaseActivationProof(
              tx,
              row,
              current.snapshot,
              request.activationProof,
              freshDispatch,
            )
          : null;
      if (request.stage === "activate" && !activation) return deny();
      return {
        catalog: state.catalog,
        expiresAt: Math.min(
          state.catalog.expiresAt,
          this.config.policy.expiresAt,
          state.now + 30000,
          ...(freshDispatch && activation ? [activation.expiresAt] : []),
        ),
      };
    });
  }
  private async databaseMergeReady(
    tx: Tx,
    row: Row,
    s: z.infer<typeof snapshotSchema>,
    fresh: boolean,
  ) {
    const scope = await this.databaseState(tx, row, s),
      facts = await automaticDatabaseStageFacts(tx, scope);
    const actions = await tx.$queryRaw<{ id: string; request_digest: string; phase: string }[]>`
      SELECT id,request_digest,phase FROM delivery_release_actions WHERE release_id=${row.id}::uuid AND kind='merge' FOR UPDATE`;
    if (
      actions.length !== 1 ||
      actions[0].id !== scope.intent.mergeActionId ||
      actions[0].request_digest !== scope.intent.mergeRequestDigest
    )
      return false;
    const action = actions[0],
      key = `database-merge-authorized/${action.id}`;
    let event = await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId: row.owner_id,
          aggregateKey: key,
          aggregateVersion: 1,
        },
      },
    });
    if (!event) {
      if (!fresh || action.phase !== "prepared") return false;
      const report = facts.completed.find(
        (r) =>
          r.stage === "advance" &&
          r.observation.phase === "verified" &&
          r.observation.kind === "database_compatibility_observation" &&
          r.expiresAt > scope.now,
      );
      if (!report) return false;
      const payload = {
        schemaVersion: 1,
        actionId: action.id,
        releaseId: row.id,
        generation: scope.generation,
        requestDigest: action.request_digest,
        catalogDigest: scope.intent.catalogDigest,
        planDigest: scope.intent.planDigest,
        reportId: report.eventId,
        reportDigest: report.eventDigest,
        observedAt: scope.now,
        expiresAt: Math.min(
          report.expiresAt,
          scope.catalog.expiresAt,
          this.config.policy.expiresAt,
        ),
      };
      event = await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId: row.owner_id,
          taskId: row.task_id,
          aggregateKey: key,
          aggregateVersion: 1,
          schemaVersion: 1,
          policyVersion: `automatic/${this.config.policy.versionId}`,
          type: "database_merge_authorized",
          requestDigest: githubSourceDigest(payload),
          payload,
        },
      });
    }
    const payload = z
      .object({
        schemaVersion: z.literal(1),
        actionId: id,
        releaseId: id,
        generation: z.number(),
        requestDigest: digest,
        catalogDigest: digest,
        planDigest: digest,
        reportId: id,
        reportDigest: digest,
        observedAt: z.number(),
        expiresAt: z.number(),
      })
      .strict()
      .safeParse(event.payload);
    if (!payload.success) return false;
    const a = payload.data,
      report = facts.completed.find(
        (r) => r.eventId === a.reportId && r.eventDigest === a.reportDigest,
      );
    return (
      event.type === "database_merge_authorized" &&
      event.taskId === row.task_id &&
      githubSourceDigest(a) === event.requestDigest &&
      a.actionId === action.id &&
      a.releaseId === row.id &&
      a.generation === scope.generation &&
      a.requestDigest === action.request_digest &&
      a.catalogDigest === scope.intent.catalogDigest &&
      a.planDigest === scope.intent.planDigest &&
      a.observedAt <= scope.now &&
      a.expiresAt > a.observedAt &&
      a.expiresAt - a.observedAt <= 30000 &&
      !!report &&
      report.stage === "advance" &&
      report.observation.phase === "verified" &&
      report.observation.kind === "database_compatibility_observation" &&
      (!fresh || (a.expiresAt > scope.now && report.expiresAt > scope.now))
    );
  }
  async reservedMergeScope(ownerId: string, releaseId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || row.phase !== "active") return null;
      const current = await this.current(tx, row, false);
      return current?.snapshot.database
        ? { taskId: row.task_id, actionId: current.snapshot.database.mergeActionId }
        : null;
    });
  }
  readonly prepareReservedMerge = async (tx: Tx, actionId: string) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT r.* FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
      WHERE r.owner_id=${this.config.policy.ownerId}::uuid AND r.target_digest=${this.targetDigest}
        AND r.purpose='automatic_production' AND r.phase='active' AND t.active_release_id=r.id
        AND r.snapshot#>>'{database,mergeActionId}'=${actionId} FOR UPDATE OF t,r`;
    if (rows.length !== 1) return false;
    const row = rows[0],
      current = await this.current(tx, row, false);
    if (!current?.snapshot.database) return deny();
    const s = current.snapshot,
      scope = await this.databaseState(tx, row, s),
      facts = await automaticDatabaseStageFacts(tx, scope);
    if (
      !facts.completed.some(
        (report) =>
          report.stage === "advance" &&
          report.observation.phase === "verified" &&
          report.observation.kind === "database_compatibility_observation" &&
          report.expiresAt > scope.now,
      ) ||
      scope.intent.mergeActionId !== actionId ||
      scope.intent.mergeRequestDigest !== githubSourceDigest(s.request)
    )
      return deny();
    const inserted =
      await tx.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation)
      VALUES (${actionId}::uuid,${row.id}::uuid,'merge',${this.targetDigest},${canonicalGitHubSource(s.request)}::jsonb,${scope.intent.mergeRequestDigest},${scope.generation})
      ON CONFLICT(id) DO NOTHING`;
    return inserted === 1;
  };
  private async advanceDatabase(tx: Tx, row: Row, s: z.infer<typeof snapshotSchema>) {
    const scope = await this.databaseState(tx, row, s);
    const actions = await tx.$queryRaw<
      { id: string; kind: string; request: unknown; phase: string }[]
    >`
      SELECT id,kind,request,phase FROM delivery_release_actions WHERE release_id=${row.id}::uuid ORDER BY created_at,id FOR UPDATE`;
    if (actions.some((a) => !["merge", "database_job"].includes(a.kind))) return "held" as const;
    const merges = actions.filter((a) => a.kind === "merge");
    if (merges.length > 1) return "held" as const;
    if (merges.length && merges[0].phase !== "observed") return "waiting" as const;
    const jobs = actions.filter((a) => a.kind === "database_job");
    if (jobs.some((a) => a.phase !== "observed")) return "waiting" as const;
    if (jobs.length >= (scope.catalog.automaticJobLimit ?? 8)) return "held" as const;
    let stage: "approve" | "advance" | "activate" = "approve",
      planEventId: string | null = null,
      activationProof: AutomaticDatabaseAction["activationProof"];
    if (jobs.length) {
      const facts = await automaticDatabaseStageFacts(tx, scope);
      planEventId = facts.approved.id;
      const merged = await this.merged(tx, row, s);
      if (merged) {
        if (
          facts.completed.some(
            (r) =>
              r.stage === "activate" &&
              r.observation.phase === "activated" &&
              r.observation.activationReceiptDigest,
          )
        )
          return "awaiting_build" as const;
        activationProof = (await this.databaseActivationProof(tx, row, s)) ?? undefined;
        if (!activationProof) return "awaiting_build" as const;
        stage = "activate";
      } else {
        if (
          facts.completed.some(
            (r) =>
              r.stage === "advance" &&
              r.observation.phase === "verified" &&
              r.observation.kind === "database_compatibility_observation" &&
              r.expiresAt > scope.now,
          )
        )
          return "ready_to_merge" as const;
        stage = "advance";
      }
    }
    const request = automaticDatabaseActionSchema.parse({
      schemaVersion: 1,
      purpose: "automatic-database-job",
      dispatchId: randomUUID(),
      issuedAt: scope.now,
      stage,
      ...(activationProof ? { activationProof } : {}),
      ownerId: row.owner_id,
      taskId: row.task_id,
      releaseId: row.id,
      targetDigest: this.targetDigest,
      generation: scope.generation,
      sourceSha: s.sourceSha,
      catalogDigest: scope.intent.catalogDigest,
      planDigest: scope.intent.planDigest,
      planEventId,
    });
    await tx.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation) VALUES (${randomUUID()}::uuid,${row.id}::uuid,'database_job',${this.targetDigest},${canonicalGitHubSource(request)}::jsonb,${githubSourceDigest(request)},${scope.generation})`;
    return "prepared" as const;
  }
  async advance(ownerId: string, releaseId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || row.phase !== "active") return "held" as const;
      const current = await this.current(tx, row, false);
      if (!current) return "held" as const;
      if (current.snapshot.database) return this.advanceDatabase(tx, row, current.snapshot);
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
  async renewDatabaseGrant(ownerId: string, releaseId: string, raw: unknown, began: number) {
    const prepared = automaticPreparedSchema.parse(raw);
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || row.phase !== "active") return false;
      const current = await this.current(tx, row, false);
      if (!current?.snapshot.database) return false;
      const s = current.snapshot,
        scope = await this.databaseState(tx, row, s),
        limits = scope.catalog.continuationGrants;
      if (
        !limits?.enabled ||
        began > scope.now ||
        scope.now - began >= 30000 ||
        scope.now >= row.created_at.getTime() + limits.maxLifetimeMs ||
        prepared.riskClass !== "database" ||
        canonicalGitHubSource(prepared.request) !== canonicalGitHubSource(s.request) ||
        prepared.testedMergeSha !== s.tested.mergeSha ||
        prepared.testedTreeSha !== s.tested.treeSha
      )
        return false;
      const merges = await tx.$queryRaw<{ id: string; request_digest: string; phase: string }[]>`
        SELECT id,request_digest,phase FROM delivery_release_actions WHERE release_id=${row.id}::uuid AND kind='merge' FOR UPDATE`;
      if (
        merges.length > 1 ||
        (merges.length === 1 &&
          (merges[0].phase !== "prepared" ||
            merges[0].id !== scope.intent.mergeActionId ||
            merges[0].request_digest !== scope.intent.mergeRequestDigest))
      )
        return false;
      const reservation = {
        id: scope.intent.mergeActionId,
        request_digest: scope.intent.mergeRequestDigest,
      };
      const facts = await automaticDatabaseStageFacts(tx, scope);
      let reportId = facts.approved.id,
        reportDigest = "",
        stageId = "",
        receiptDigest = "",
        proofExpiresAt = 0;
      const latest = facts.completed.find((report) => report.expiresAt > scope.now);
      if (latest) {
        reportId = latest.eventId;
        reportDigest = latest.eventDigest;
        stageId = latest.stageId;
        proofExpiresAt = latest.expiresAt;
        const stage = facts.stages.find((stage) => stage.id === latest.stageId);
        if (!stage) return false;
        receiptDigest = githubSourceDigest(stage.receipt);
      } else {
        const approval = await tx.deliveryEvent.findUniqueOrThrow({
          where: { ownerId_id: { ownerId, id: facts.approved.id } },
        });
        const stage = facts.stages.find((stage) => stage.request.stage === "approve");
        if (!stage) return false;
        reportDigest = githubSourceDigest(approval.payload);
        stageId = stage.id;
        receiptDigest = githubSourceDigest(stage.receipt);
        proofExpiresAt = approval.createdAt.getTime() + 30000;
      }
      if (proofExpiresAt <= scope.now || proofExpiresAt > scope.now + 30000) return false;
      const key = `d10-grant/${row.id}/${reportId}`,
        prior = await tx.deliveryEvent.findUnique({
          where: {
            ownerId_aggregateKey_aggregateVersion: {
              ownerId,
              aggregateKey: key,
              aggregateVersion: 1,
            },
          },
        });
      if (prior) {
        const old = automaticDatabaseGrantSchema.safeParse(prior.payload);
        return (
          !!old.success &&
          prior.taskId === row.task_id &&
          prior.type === "release_test_grant_renewed" &&
          prior.requestDigest === githubSourceDigest(old.data) &&
          old.data.databaseEventId === reportId &&
          old.data.expiresAt > scope.now &&
          old.data.catalogDigest === scope.intent.catalogDigest &&
          old.data.planDigest === scope.intent.planDigest &&
          old.data.policyDigest === row.policy_digest &&
          old.data.mergeActionId === reservation.id
        );
      }
      const count = await tx.deliveryEvent.count({
        where: {
          ownerId,
          taskId: row.task_id,
          type: "release_test_grant_renewed",
          aggregateKey: { startsWith: `d10-grant/${row.id}/` },
        },
      });
      if (count >= limits.maxCount) return false;
      const payload = automaticDatabaseGrantSchema.parse({
        schemaVersion: 1,
        kind: "d10-continuation-grant",
        ownerId,
        taskId: row.task_id,
        releaseId: row.id,
        generation: scope.generation,
        targetDigest: this.targetDigest,
        sourceRevisionId: row.source_revision_id,
        sourceSha: s.sourceSha,
        baseSha: s.request.baseSha,
        testedMergeSha: s.tested.mergeSha,
        treeSha: s.tested.treeSha,
        mergeActionId: reservation.id,
        mergeRequestDigest: reservation.request_digest,
        originalAttestationDigest: s.testedAttestationDigest,
        catalogDigest: scope.intent.catalogDigest,
        planDigest: scope.intent.planDigest,
        policyVersionId: this.config.policy.versionId,
        policyDigest: row.policy_digest,
        databaseEventId: reportId,
        databaseEventDigest: reportDigest,
        databaseActionId: stageId,
        databaseReceiptDigest: receiptDigest,
        freshChecksDigest: s.tested.checksDigest,
        freshPreparedDigest: githubSourceDigest(prepared),
        databaseProofExpiresAt: proofExpiresAt,
        observedAt: began,
        expiresAt: Math.min(
          began + limits.grantMs,
          this.config.policy.expiresAt,
          scope.catalog.expiresAt,
          row.created_at.getTime() + limits.maxLifetimeMs,
        ),
      });
      if (payload.expiresAt <= scope.now) return false;
      await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId,
          taskId: row.task_id,
          aggregateKey: key,
          aggregateVersion: 1,
          schemaVersion: 1,
          policyVersion: `database/${scope.catalog.id}`,
          type: "release_test_grant_renewed",
          requestDigest: githubSourceDigest(payload),
          payload,
        },
      });
      const end = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      if (end >= proofExpiresAt || end >= payload.expiresAt || end >= began + 30000) return deny();
      return true;
    });
  }
  async databaseObservationScope(ownerId: string, releaseId: string, action: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || row.phase !== "active") return null;
      const current = await this.current(tx, row, false);
      if (!current?.snapshot.database) return null;
      const scope = await this.databaseState(tx, row, current.snapshot),
        merged = await this.merged(tx, row, current.snapshot);
      const mode = scope.catalog.compatibilityTest?.config;
      if (
        !mode ||
        !("kind" in mode) ||
        mode.kind !== "automatic-source-build" ||
        (action === "activate"
          ? !merged
          : !["compatible", "certificate"].includes(action) || !!merged)
      )
        return null;
      return {
        taskId: row.task_id,
        catalog: scope.catalog,
        intent: scope.intent,
        sourceSha: merged ? merged.receipt.mergeSha : mode.baseline.sourceSha,
        treeSha: merged ? current.snapshot.tested.treeSha : mode.baseline.treeSha,
        buildUuid: merged ? null : mode.baseline.providerBuildUuid,
        baseline: !merged,
      };
    });
  }
  async recordDatabaseBaseline(ownerId: string, releaseId: string, raw: unknown, began: number) {
    const observation = automaticObservationSchema.parse(raw);
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row || row.phase !== "active") return false;
      const current = await this.current(tx, row, false);
      if (!current?.snapshot.database || (await this.merged(tx, row, current.snapshot)))
        return false;
      const scope = await this.databaseState(tx, row, current.snapshot),
        baseline = current.snapshot.database.baseline;
      if (
        began > scope.now ||
        observation.observedAt < began ||
        observation.observedAt > scope.now ||
        observation.expiresAt <= scope.now ||
        observation.expiresAt > began + 30000 ||
        observation.origin !== this.config.target.origin ||
        observation.mergeSha !== baseline.mergeSha ||
        observation.treeSha !== baseline.treeSha ||
        observation.health.build.buildUuid !== baseline.health.build.buildUuid ||
        observation.health.build.sourceSha !== baseline.health.build.sourceSha ||
        observation.health.databaseEndpointDigest !== baseline.health.databaseEndpointDigest
      )
        return false;
      await tx.$executeRaw`INSERT INTO delivery_release_observations(id,release_id,kind,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${releaseId}::uuid,'automatic_baseline',${canonicalGitHubSource(observation)}::jsonb,${githubSourceDigest(observation)})`;
      return true;
    });
  }
  async databaseDeployment(
    tx: Tx,
    request: {
      ownerId: string;
      taskId: string;
      releaseId: string;
      targetDigest: string;
      generation: number;
      sourceSha: string;
      planEventId: string;
      action: string;
    },
    catalog: AutomaticDatabaseCatalog,
    plan: Record<string, unknown>,
    planDigest: string,
  ) {
    const row = await this.locked(tx, request.ownerId, request.releaseId);
    if (!row || row.phase !== "active" || row.task_id !== request.taskId) return deny();
    const current = await this.current(tx, row, false);
    if (!current?.snapshot.database) return deny();
    const scope = await this.databaseState(tx, row, current.snapshot),
      merged = await this.merged(tx, row, current.snapshot);
    if (
      request.targetDigest !== this.targetDigest ||
      request.generation !== scope.generation ||
      request.sourceSha !== scope.sourceSha ||
      githubSourceDigest(catalog) !== scope.intent.catalogDigest ||
      planDigest !== githubSourceDigest(plan) ||
      githubSourceDigest(sourcePlanIntent(plan)) !== scope.intent.planDigest ||
      (request.action === "activate"
        ? !merged
        : !["compatible", "certificate"].includes(request.action) || !!merged)
    )
      return deny();
    const kind = request.action === "activate" ? "automatic_health" : "automatic_baseline";
    const observations = await tx.$queryRaw<{ evidence: unknown; evidence_digest: string }[]>`
      SELECT evidence,evidence_digest FROM delivery_release_observations WHERE release_id=${row.id}::uuid AND kind=${kind} ORDER BY created_at DESC,id DESC LIMIT 1`;
    if (observations.length !== 1) return deny();
    const o = automaticObservationSchema.parse(observations[0].evidence),
      baseline = scope.intent.baseline;
    if (
      githubSourceDigest(o) !== observations[0].evidence_digest ||
      o.observedAt > scope.now ||
      o.expiresAt <= scope.now ||
      o.expiresAt <= o.observedAt ||
      o.expiresAt - o.observedAt > 30000 ||
      o.origin !== this.config.target.origin ||
      o.mergeSha !== (merged ? merged.receipt.mergeSha : baseline.mergeSha) ||
      o.treeSha !== (merged ? current.snapshot.tested.treeSha : baseline.treeSha) ||
      o.health.databaseEndpointDigest !== baseline.health.databaseEndpointDigest ||
      (!merged && o.health.build.buildUuid !== baseline.health.build.buildUuid)
    )
      return deny();
    return {
      kind: request.action === "certificate" ? "compatible" : request.action,
      targetId: catalog.targetId,
      runId: request.planEventId,
      sourceSha: request.sourceSha,
      planDigest,
      schemaDigest: plan.afterSchemaDigest,
      oldAppDigest: plan.oldAppDigest,
      newAppDigest: plan.newAppDigest,
      compatibilityDigest: plan.compatibilityDigest,
      observedAt: scope.now,
      expiresAt: Math.min(o.expiresAt, scope.now + 20000),
      receiptDigest: githubSourceDigest({
        purpose: "automatic-source-build-deployment",
        observation: observations[0].evidence_digest,
        catalogDigest: scope.intent.catalogDigest,
        planDigest,
        releaseId: row.id,
        generation: scope.generation,
      }),
    };
  }
  async observationScope(ownerId: string, releaseId: string) {
    return this.transaction(async (tx) => {
      const row = await this.locked(tx, ownerId, releaseId);
      if (!row) return null;
      const current = await this.current(tx, row, false);
      if (!current) return null;
      const merged = await this.merged(tx, row, current.snapshot);
      return merged
        ? {
            taskId: row.task_id,
            ...merged,
            ...(current.snapshot.database
              ? { catalog: (await this.databaseState(tx, row, current.snapshot)).catalog }
              : {}),
          }
        : null;
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
      if (current.snapshot.database) {
        if (
          observation.treeSha !== current.snapshot.tested.treeSha ||
          observation.health.databaseEndpointDigest !==
            current.snapshot.database.baseline.health.databaseEndpointDigest
        )
          return this.hold(tx, row, "release_regression");
        const scope = await this.databaseState(tx, row, current.snapshot),
          facts = await automaticDatabaseStageFacts(tx, scope);
        if (
          !facts.completed.some(
            (report) =>
              report.stage === "activate" &&
              report.observation.phase === "activated" &&
              report.observation.activationReceiptDigest,
          )
        )
          return "waiting" as const;
      }
      if (row.phase === "healthy") return "healthy" as const;
      // Scheduled samples may arrive after the minimum window; lateness alone is no regression.
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
    let database: ProductionAcceptanceAnchor["database"];
    if (current.snapshot.database) {
      const catalog = this.databaseCatalog(current.snapshot.sourceSha);
      if (!catalog) return null;
      const endpointDigest = catalogDatabaseEndpointDigest(catalog);
      if (!endpointDigest) return null;
      const facts = await automaticDatabaseStageFacts(tx, {
        ownerId: row.owner_id,
        taskId: row.task_id,
        releaseId: row.id,
        sourceSha: current.snapshot.sourceSha,
        generation,
        intent: current.snapshot.database,
        catalog,
      });
      const activated = facts.completed.find(
        (report) =>
          report.stage === "activate" &&
          report.observation.phase === "activated" &&
          report.observation.activationReceiptDigest,
      );
      if (
        !activated ||
        observed.treeSha !== current.snapshot.tested.treeSha ||
        observed.health.databaseEndpointDigest !==
          current.snapshot.database.baseline.health.databaseEndpointDigest
      )
        return null;
      database = {
        kind: "controlled-source-build",
        coverage: "controlled-migration-activation-history",
        catalogDigest: current.snapshot.database.catalogDigest,
        planEventId: facts.approved.id,
        planDigest: facts.approved.planDigest,
        endpointDigest,
        plan: facts.approved.manifest.plan,
        sourceBuild: catalog.compatibilityTest?.config as NonNullable<
          ProductionAcceptanceAnchor["database"]
        >["sourceBuild"],
        reportEventId: activated.eventId,
        reportDigest: activated.eventDigest,
        observation: activated.observation,
      };
    }
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
      ...(database ? { database } : {}),
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
      githubSourceDigest(observed.data.health.build) === anchor.buildDigest &&
      (!anchor.database ||
        (observed.data.health.databaseEndpointDigest === anchor.database.endpointDigest &&
          observed.data.treeSha === anchor.database.sourceBuild.candidate.treeSha))
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
