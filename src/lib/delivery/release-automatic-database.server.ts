import { z } from "zod";
import { sourcePlanIntent } from "../../../services/migrate/src/delivery/source-plan-intent.mjs";
import { databaseCatalogSchema } from "../../../services/migrate/src/delivery/wire.mjs";
import type { AutomaticReleaseConfig } from "./release-automatic-contracts";
import { automaticReleaseTarget } from "./release-automatic-contracts";

/** Intent comes only from deployment-owned catalog configuration. It is not an
 * accepted plan, a provider receipt, a tested-tree grant or SQL authorization. */
export function configuredAutomaticDatabaseCatalog(
  config: AutomaticReleaseConfig,
  sourceSha: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.HIVE_DELIVERY_DATABASE_ENABLED !== "true") return null;
  const raw = env.HIVE_DELIVERY_DATABASE_CATALOGS_JSON;
  if (!raw || Buffer.byteLength(raw) > 262144) return null;
  const catalogs = z.array(databaseCatalogSchema).max(32).parse(JSON.parse(raw));
  const matching = catalogs.filter((c) => {
    const mode = c.compatibilityTest?.config;
    return (
      mode &&
      "kind" in mode &&
      mode.kind === "automatic-source-build" &&
      c.ownerId === config.policy.ownerId &&
      c.repositoryId === config.policy.repositoryId &&
      c.targetDigest === automaticReleaseTarget(config) &&
      c.automaticPlan?.sourceSha === sourceSha
    );
  });
  if (matching.length > 1) throw Error("automatic_database_scope");
  return matching[0] ?? null;
}

import type { Prisma } from "@hive/db";
import {
  databaseObservationSchema,
  databaseScope,
} from "../../../services/migrate/src/delivery/wire.mjs";
import { githubSourceDigest } from "./github-evidence.server";
import {
  automaticDatabaseEndpointDigest,
  automaticObservationSchema,
  automaticReleaseEnrollment,
} from "./release-automatic-contracts";
import {
  automaticDatabaseActionSchema,
  automaticDatabaseRunSchema,
} from "./release-database-actions";

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().uuid();
export const automaticDatabaseIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.literal("plan_intent"),
    catalogId: id,
    catalogDigest: hash,
    planDigest: hash,
    sourceBuildDigest: hash,
    mergeActionId: id,
    mergeRequestDigest: hash,
    baseline: automaticObservationSchema,
  })
  .strict();
export type AutomaticDatabaseIntent = z.infer<typeof automaticDatabaseIntentSchema>;
export type AutomaticDatabaseCatalog = z.infer<typeof databaseCatalogSchema>;
type Tx = Prisma.TransactionClient;
const unavailable = (): never => {
  throw Error("automatic_database_unavailable");
};

export function automaticDatabaseIntent(
  config: AutomaticReleaseConfig,
  catalog: AutomaticDatabaseCatalog,
  input: {
    sourceSha: string;
    baseSha: string;
    mergeSha: string;
    treeSha: string;
    policyDigest: string;
    checksDigest: string;
    mergeActionId: string;
    mergeRequestDigest: string;
    baseline: unknown;
  },
  now: number,
) {
  const mode = catalog.compatibilityTest?.config,
    observation = automaticObservationSchema.parse(input.baseline);
  if (
    !mode ||
    !("kind" in mode) ||
    mode.kind !== "automatic-source-build" ||
    catalog.automaticExecutionEnabled !== true ||
    !catalog.automaticPlan ||
    catalog.ownerId !== config.policy.ownerId ||
    catalog.repositoryId !== config.policy.repositoryId ||
    catalog.targetDigest !== automaticReleaseTarget(config) ||
    catalog.validFrom > now ||
    catalog.expiresAt <= now ||
    mode.candidate.headSha !== input.sourceSha ||
    mode.candidate.baseSha !== input.baseSha ||
    mode.candidate.mergeSha !== input.mergeSha ||
    mode.candidate.treeSha !== input.treeSha ||
    mode.candidate.policyDigest !== input.policyDigest ||
    input.policyDigest !== githubSourceDigest(automaticReleaseEnrollment(config)) ||
    mode.candidate.checksDigest !== input.checksDigest ||
    mode.candidate.controlDigest !== config.tested.workflow.controlDigest ||
    observation.origin !== config.target.origin ||
    observation.mergeSha !== mode.baseline.sourceSha ||
    observation.health.build.sourceSha !== mode.baseline.sourceSha ||
    observation.treeSha !== mode.baseline.treeSha ||
    observation.health.build.buildUuid !== mode.baseline.providerBuildUuid ||
    observation.health.databaseEndpointDigest !== catalogDatabaseEndpointDigest(catalog) ||
    observation.observedAt > now ||
    observation.expiresAt <= now ||
    observation.expiresAt > observation.observedAt + 30000 ||
    observation.expiresAt <= observation.observedAt
  )
    return unavailable();
  return automaticDatabaseIntentSchema.parse({
    schemaVersion: 1,
    phase: "plan_intent",
    catalogId: catalog.id,
    catalogDigest: githubSourceDigest(catalog),
    planDigest: githubSourceDigest(catalog.automaticPlan),
    sourceBuildDigest: githubSourceDigest(mode),
    mergeActionId: input.mergeActionId,
    mergeRequestDigest: input.mergeRequestDigest,
    baseline: observation,
  });
}
export function catalogDatabaseEndpointDigest(catalog: AutomaticDatabaseCatalog) {
  return automaticDatabaseEndpointDigest(
    `postgresql://${catalog.databaseHost}:${catalog.databasePort}/${encodeURIComponent(catalog.databaseName)}`,
  );
}
export function verifyAutomaticDatabaseIntent(
  intent: AutomaticDatabaseIntent,
  catalog: AutomaticDatabaseCatalog,
  config: AutomaticReleaseConfig,
  sourceSha: string,
  now: number,
) {
  const mode = catalog.compatibilityTest?.config;
  if (
    !mode ||
    !("kind" in mode) ||
    mode.kind !== "automatic-source-build" ||
    catalog.automaticExecutionEnabled !== true ||
    catalog.id !== intent.catalogId ||
    catalog.ownerId !== config.policy.ownerId ||
    catalog.repositoryId !== config.policy.repositoryId ||
    catalog.targetDigest !== automaticReleaseTarget(config) ||
    catalog.validFrom > now ||
    catalog.expiresAt <= now ||
    catalog.automaticPlan?.sourceSha !== sourceSha ||
    githubSourceDigest(catalog) !== intent.catalogDigest ||
    githubSourceDigest(catalog.automaticPlan) !== intent.planDigest ||
    githubSourceDigest(mode) !== intent.sourceBuildDigest ||
    intent.baseline.health.databaseEndpointDigest !== catalogDatabaseEndpointDigest(catalog)
  )
    return false;
  return true;
}

/** Corroborate a completed controlled stage against its actual immutable plan
 * approval / SQL-runner report. A merely dispatched or still-running run cannot
 * satisfy this projection; all external facts must already be journaled. */
export async function automaticDatabaseStageFacts(
  tx: Tx,
  scope: {
    ownerId: string;
    taskId: string;
    releaseId: string;
    generation: number;
    sourceSha: string;
    intent: AutomaticDatabaseIntent;
    catalog: AutomaticDatabaseCatalog;
  },
) {
  const { acceptedDatabasePlan } = await import("./database-job-store.server");
  const approved = await acceptedDatabasePlan(tx, scope, scope.catalog);
  if (
    githubSourceDigest(sourcePlanIntent(approved.manifest.plan)) !== scope.intent.planDigest ||
    approved.catalogDigest !== scope.intent.catalogDigest
  )
    return unavailable();
  const rows = await tx.$queryRaw<
    {
      id: string;
      request: unknown;
      request_digest: string;
      receipt: unknown;
      receipt_digest: string;
      phase: string;
      generation: number;
    }[]
  >`
    SELECT id,request,request_digest,receipt,receipt_digest,phase,generation FROM delivery_release_actions
    WHERE release_id=${scope.releaseId}::uuid AND kind='database_job' ORDER BY created_at,id FOR SHARE`;
  const stages: {
    id: string;
    request: z.infer<typeof automaticDatabaseActionSchema>;
    receipt: z.infer<typeof automaticDatabaseRunSchema>;
  }[] = [];
  for (const row of rows) {
    if (row.phase !== "observed") continue;
    const request = automaticDatabaseActionSchema.parse(row.request),
      receipt = automaticDatabaseRunSchema.parse(row.receipt);
    if (
      row.generation !== scope.generation ||
      request.generation !== scope.generation ||
      request.releaseId !== scope.releaseId ||
      request.ownerId !== scope.ownerId ||
      request.taskId !== scope.taskId ||
      request.sourceSha !== scope.sourceSha ||
      request.catalogDigest !== scope.intent.catalogDigest ||
      request.planDigest !== scope.intent.planDigest ||
      githubSourceDigest(row.request) !== row.request_digest ||
      githubSourceDigest(row.receipt) !== row.receipt_digest ||
      receipt.dispatchId !== request.dispatchId ||
      receipt.stage !== request.stage ||
      receipt.catalogDigest !== request.catalogDigest ||
      receipt.planDigest !== request.planDigest ||
      receipt.sourceSha !== scope.sourceSha ||
      receipt.dispatcherSha !== scope.catalog.dispatcherSha ||
      receipt.workflowId !== scope.catalog.compatibilityTest?.workflowId
    )
      return unavailable();
    stages.push({ id: row.id, request, receipt });
  }
  const approvals = stages.filter((s) => s.request.stage === "approve");
  if (
    approvals.length !== 1 ||
    approved.manifest.dispatchId !== approvals[0].request.dispatchId ||
    approved.manifest.githubRunId !== approvals[0].receipt.runId ||
    approved.manifest.githubRunAttempt !== approvals[0].receipt.runAttempt
  )
    return unavailable();
  const reports = await tx.deliveryEvent.findMany({
    where: { ownerId: scope.ownerId, taskId: scope.taskId, type: "database_job_observed" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 64,
  });
  const completed: {
    eventId: string;
    eventDigest: string;
    stage: "advance" | "activate";
    observation: z.infer<typeof databaseObservationSchema>;
    expiresAt: number;
    stageId: string;
  }[] = [];
  for (const event of reports) {
    const payload = z
      .object({
        request: z
          .object({
            releaseId: id,
            ownerId: id,
            taskId: id,
            sourceSha: z.string(),
            dispatchId: id,
            githubRunId: z.string(),
            githubRunAttempt: z.number(),
            generation: z.number(),
            planEventId: id,
            observation: databaseObservationSchema,
          })
          .passthrough(),
        catalogDigest: hash,
        workflowDigest: hash,
        jtiDigest: hash,
        observedAt: z.number(),
        expiresAt: z.number(),
      })
      .passthrough()
      .safeParse(event.payload);
    if (!payload.success || payload.data.request.releaseId !== scope.releaseId) continue;
    const p = payload.data,
      r = p.request,
      stage = stages.find((s) => s.request.dispatchId === r.dispatchId);
    if (
      !stage ||
      stage.request.stage === "approve" ||
      stage.request.planEventId !== approved.id ||
      r.ownerId !== scope.ownerId ||
      r.taskId !== scope.taskId ||
      r.sourceSha !== scope.sourceSha ||
      r.generation !== scope.generation ||
      r.planEventId !== approved.id ||
      p.catalogDigest !== approved.catalogDigest ||
      p.workflowDigest !==
        githubSourceDigest({ ref: scope.catalog.workflowRef, sha: scope.catalog.workflowSha }) ||
      p.observedAt > event.createdAt.getTime() + 1000 ||
      p.expiresAt <= p.observedAt ||
      p.expiresAt > p.observedAt + 30000 ||
      r.githubRunId !== stage.receipt.runId ||
      r.githubRunAttempt !== stage.receipt.runAttempt ||
      githubSourceDigest(p.request) !== event.requestDigest
    )
      continue;
    const o = r.observation,
      plan = approved.manifest.plan;
    if (
      o.scopeDigest !== githubSourceDigest(databaseScope(scope.catalog)) ||
      o.runId !== approved.id ||
      o.planDigest !== approved.planDigest ||
      o.sourceSha !== scope.sourceSha ||
      o.beforeSchemaDigest !== plan.beforeSchemaDigest ||
      o.afterSchemaDigest !== plan.afterSchemaDigest ||
      o.oldAppDigest !== plan.oldAppDigest ||
      o.newAppDigest !== plan.newAppDigest ||
      o.compatibilityDigest !== plan.compatibilityDigest ||
      (["verified", "activated", "contract_held"].includes(o.phase) &&
        (!o.integrity ||
          o.integrity.schemaDigest !== plan.afterSchemaDigest ||
          o.integrity.queryDigest !== githubSourceDigest(plan.integritySql) ||
          o.integrity.violations !== "0"))
    )
      continue;
    completed.push({
      eventId: event.id,
      eventDigest: githubSourceDigest(event.payload),
      stage: stage.request.stage,
      observation: o,
      expiresAt: Math.min(p.expiresAt, o.expiresAt ?? p.expiresAt),
      stageId: stage.id,
    });
  }
  return { approved, stages, completed };
}

export const automaticDatabaseGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("d10-continuation-grant"),
    ownerId: id,
    taskId: id,
    releaseId: id,
    generation: z.number().int().positive(),
    targetDigest: hash,
    sourceRevisionId: id,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    testedMergeSha: z.string().regex(/^[a-f0-9]{40}$/),
    treeSha: z.string().regex(/^[a-f0-9]{40}$/),
    mergeActionId: id,
    mergeRequestDigest: hash,
    originalAttestationDigest: hash,
    catalogDigest: hash,
    planDigest: hash,
    policyVersionId: id,
    policyDigest: hash,
    databaseEventId: id,
    databaseEventDigest: hash,
    databaseActionId: id,
    databaseReceiptDigest: hash,
    freshChecksDigest: hash,
    freshPreparedDigest: hash,
    databaseProofExpiresAt: z.number().int().positive(),
    observedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AutomaticDatabaseGrant = z.infer<typeof automaticDatabaseGrantSchema>;

export async function readAutomaticDatabaseGrant(
  tx: Tx,
  scope: {
    ownerId: string;
    taskId: string;
    releaseId: string;
    generation: number;
    targetDigest: string;
    sourceRevisionId: string;
    sourceSha: string;
    baseSha: string;
    testedMergeSha: string;
    treeSha: string;
    originalAttestationDigest: string;
    policyVersionId: string;
    policyDigest: string;
    policyExpiresAt: number;
    preparedDigest: string;
    checksDigest: string;
    intent: AutomaticDatabaseIntent;
    catalog: AutomaticDatabaseCatalog;
    createdAt: number;
    now: number;
  },
) {
  const limits = scope.catalog.continuationGrants;
  if (!limits?.enabled || scope.now >= scope.createdAt + limits.maxLifetimeMs) return null;
  const actions = await tx.$queryRaw<{ id: string; request_digest: string; phase: string }[]>`
    SELECT id,request_digest,phase FROM delivery_release_actions
    WHERE release_id=${scope.releaseId}::uuid AND kind='merge' FOR SHARE`;
  if (
    actions.length !== 1 ||
    actions[0].id !== scope.intent.mergeActionId ||
    actions[0].request_digest !== scope.intent.mergeRequestDigest ||
    !["prepared", "effect_started"].includes(actions[0].phase)
  )
    return null;
  const events = await tx.deliveryEvent.findMany({
    where: {
      ownerId: scope.ownerId,
      taskId: scope.taskId,
      aggregateKey: { startsWith: `d10-grant/${scope.releaseId}/` },
      type: "release_test_grant_renewed",
    },
    orderBy: { createdAt: "desc" },
    take: 9,
  });
  if (events.length > limits.maxCount) return null;
  for (const event of events) {
    const parsed = automaticDatabaseGrantSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    const g = parsed.data;
    if (
      githubSourceDigest(g) !== event.requestDigest ||
      g.ownerId !== scope.ownerId ||
      g.taskId !== scope.taskId ||
      g.releaseId !== scope.releaseId ||
      g.generation !== scope.generation ||
      g.targetDigest !== scope.targetDigest ||
      g.sourceRevisionId !== scope.sourceRevisionId ||
      g.sourceSha !== scope.sourceSha ||
      g.baseSha !== scope.baseSha ||
      g.testedMergeSha !== scope.testedMergeSha ||
      g.treeSha !== scope.treeSha ||
      g.mergeActionId !== actions[0].id ||
      g.mergeRequestDigest !== actions[0].request_digest ||
      g.originalAttestationDigest !== scope.originalAttestationDigest ||
      g.catalogDigest !== scope.intent.catalogDigest ||
      g.planDigest !== scope.intent.planDigest ||
      g.policyVersionId !== scope.policyVersionId ||
      g.policyDigest !== scope.policyDigest ||
      g.freshChecksDigest !== scope.checksDigest ||
      g.freshPreparedDigest !== scope.preparedDigest ||
      g.observedAt > scope.now ||
      g.expiresAt <= scope.now ||
      g.expiresAt <= g.observedAt ||
      g.expiresAt - g.observedAt > limits.grantMs ||
      g.expiresAt > scope.createdAt + limits.maxLifetimeMs ||
      g.expiresAt > scope.catalog.expiresAt ||
      g.expiresAt > scope.policyExpiresAt ||
      g.databaseProofExpiresAt <= g.observedAt ||
      g.databaseProofExpiresAt > g.observedAt + 30000
    )
      continue;
    const report = await tx.deliveryEvent.findUnique({
      where: { ownerId_id: { ownerId: scope.ownerId, id: g.databaseEventId } },
    });
    const jobs = await tx.$queryRaw<{ receipt: unknown; receipt_digest: string; phase: string }[]>`
      SELECT receipt,receipt_digest,phase FROM delivery_release_actions WHERE id=${g.databaseActionId}::uuid
      AND release_id=${scope.releaseId}::uuid AND kind='database_job' FOR SHARE`;
    if (
      !report ||
      report.taskId !== scope.taskId ||
      !["database_plan_approved", "database_job_observed"].includes(report.type) ||
      githubSourceDigest(report.payload) !== g.databaseEventDigest ||
      jobs.length !== 1 ||
      jobs[0].phase !== "observed" ||
      jobs[0].receipt_digest !== g.databaseReceiptDigest ||
      githubSourceDigest(jobs[0].receipt) !== g.databaseReceiptDigest
    )
      continue;
    const receipt = automaticDatabaseRunSchema.safeParse(jobs[0].receipt);
    const rawPayload = report.payload as { manifest?: unknown; request?: unknown } | null;
    const reported = z
      .object({
        ownerId: id,
        taskId: id,
        sourceSha: z.string(),
        dispatchId: id,
        githubRunId: z.string(),
        githubRunAttempt: z.number(),
      })
      .passthrough()
      .safeParse(
        report.type === "database_plan_approved" ? rawPayload?.manifest : rawPayload?.request,
      );
    if (
      !receipt.success ||
      !reported.success ||
      receipt.data.dispatchId !== reported.data.dispatchId ||
      receipt.data.runId !== reported.data.githubRunId ||
      receipt.data.runAttempt !== reported.data.githubRunAttempt ||
      reported.data.ownerId !== scope.ownerId ||
      reported.data.taskId !== scope.taskId ||
      reported.data.sourceSha !== scope.sourceSha ||
      receipt.data.catalogDigest !== scope.intent.catalogDigest ||
      receipt.data.planDigest !== scope.intent.planDigest ||
      receipt.data.sourceSha !== scope.sourceSha ||
      receipt.data.dispatcherSha !== scope.catalog.dispatcherSha ||
      receipt.data.workflowId !== scope.catalog.compatibilityTest?.workflowId
    )
      continue;
    return { eventId: event.id, grant: g };
  }
  return null;
}
