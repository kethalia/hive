import type { Prisma, PrismaClient } from "@hive/db";
import { acceptanceDeploymentConfig } from "./acceptance-config.server";
import { type AcceptanceReviewResult, acceptanceDigest } from "./acceptance-contracts";
import {
  productionAcceptanceAnchorSchema,
  readProductionAcceptanceAnchor,
  refreshProductionAcceptance,
  verifyProductionAcceptanceAnchor,
} from "./release-automatic-acceptance.server";
import { configuredAutomaticRelease } from "./release-automatic-host.server";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
export const PRODUCTION_ACCEPTANCE_ENTRY = "evidence:production";
const unavailable = (): never => {
  throw new DeliveryConflict("acceptance_production_observation_unavailable");
};
export function productionAcceptanceConfig() {
  if (!acceptanceDeploymentConfig()) return unavailable();
  return configuredAutomaticRelease() ?? unavailable();
}
export async function productionAcceptanceMaterial(
  tx: Tx,
  scope: { ownerId: string; taskId: string; sourceRevisionId: string; sourceSha: string },
  pinned?: unknown,
  options: { fresh: boolean } = { fresh: true },
) {
  const config = productionAcceptanceConfig();
  const anchor =
    pinned === undefined
      ? await readProductionAcceptanceAnchor(tx, config, scope)
      : productionAcceptanceAnchorSchema.parse(pinned);
  if (
    !anchor ||
    anchor.ownerId !== scope.ownerId ||
    anchor.taskId !== scope.taskId ||
    anchor.sourceRevisionId !== scope.sourceRevisionId ||
    anchor.sourceSha !== scope.sourceSha ||
    !(await verifyProductionAcceptanceAnchor(tx, config, anchor, options))
  )
    return unavailable();
  return anchor;
}
/** Completed semantics remain provenance for preservation and exact replay;
 * only the independently sealed completion can select this historical mode. */
export async function productionAcceptanceStepMaterial(
  tx: Tx,
  scope: {
    ownerId: string;
    taskId: string;
    stepId: string;
    sourceRevisionId: string;
    sourceSha: string;
  },
  pinned?: unknown,
) {
  const step = await tx.deliveryStep.findUnique({
    where: { ownerId_id: { ownerId: scope.ownerId, id: scope.stepId } },
  });
  if (step?.taskId !== scope.taskId || step.state !== "succeeded")
    return productionAcceptanceMaterial(tx, scope, pinned);
  const jobs = await tx.deliveryAcceptanceJob.findMany({
    where: {
      ownerId: scope.ownerId,
      taskId: scope.taskId,
      kind: "review",
      phase: "completed",
      scope: { path: ["stepId"], equals: scope.stepId },
    },
    orderBy: { completedAt: "desc" },
    take: 17,
  });
  if (jobs.length > 16) return unavailable();
  for (const job of jobs) {
    const jobScope = job.scope as {
      attemptId?: string;
      sourceRevisionId?: string;
      sourceSha?: string;
    };
    if (
      !jobScope.attemptId ||
      jobScope.sourceRevisionId !== scope.sourceRevisionId ||
      jobScope.sourceSha !== scope.sourceSha
    )
      continue;
    const event = await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId: scope.ownerId,
          aggregateKey: `acceptance-success/${jobScope.attemptId}`,
          aggregateVersion: 1,
        },
      },
    });
    const saved = event?.payload as {
      identity?: unknown;
      receipt?: { version?: number };
      evidenceIds?: string[];
    } | null;
    const attempt = await tx.deliveryAttempt.findUnique({
      where: { ownerId_id: { ownerId: scope.ownerId, id: jobScope.attemptId } },
    });
    if (
      event?.type !== "acceptance_success_completed" ||
      event.taskId !== scope.taskId ||
      event.stepId !== scope.stepId ||
      event.attemptId !== jobScope.attemptId ||
      !saved?.identity ||
      acceptanceDigest(saved.identity) !== event.requestDigest ||
      saved.receipt?.version !== step.version ||
      !saved.evidenceIds?.includes(job.id) ||
      attempt?.outcome !== "succeeded" ||
      attempt.stepId !== step.id
    )
      continue;
    const stored = (job.material as { production?: unknown } | null)?.production;
    if (!stored || (pinned !== undefined && acceptanceDigest(stored) !== acceptanceDigest(pinned)))
      continue;
    return productionAcceptanceMaterial(tx, scope, stored, { fresh: false });
  }
  return unavailable();
}
/** A production validation claim cannot deploy, publish, migrate or invent a
 * source revision. Its independent semantic review is the sole step evidence;
 * release/build checks are authenticated supporting material, never relabeled CI. */
export async function authorizeProductionAcceptanceClaim(
  tx: Tx,
  ownerId: string,
  task: { id: string; sourceRevisionId: string | null; sourceSha: string },
  step: { kind: string; acceptancePhase: string; requiredEvidenceKinds: string[] },
) {
  if (
    step.acceptancePhase !== "activation_production" ||
    !["review", "validate"].includes(step.kind) ||
    !step.requiredEvidenceKinds.length ||
    step.requiredEvidenceKinds.some((kind) => kind !== "review") ||
    !task.sourceRevisionId
  )
    return unavailable();
  return productionAcceptanceMaterial(tx, {
    ownerId,
    taskId: task.id,
    sourceRevisionId: task.sourceRevisionId,
    sourceSha: task.sourceSha,
  });
}
export function productionReviewCoverage(result: AcceptanceReviewResult) {
  // A source-only citation cannot establish a production observation. The
  // independent evaluator must still judge whether the narrow supplied facts
  // actually cover the owner's meaning; absent business observations stay insufficient.
  if (
    result.requirements.some(
      (item) =>
        item.outcome === "pass" &&
        !item.citations.some((citation) => citation.entryId === PRODUCTION_ACCEPTANCE_ENTRY),
    )
  )
    throw new DeliveryConflict("acceptance_production_coverage_missing");
}
export async function verifyStoredProductionAcceptance(
  tx: Tx,
  scope: {
    ownerId: string;
    taskId: string;
    stepId: string;
    sourceRevisionId?: string | null;
    sourceSha: string;
  },
  material: unknown,
) {
  const stored = material as { production?: unknown } | null;
  if (!stored?.production || !scope.sourceRevisionId) return unavailable();
  return productionAcceptanceStepMaterial(
    tx,
    {
      ownerId: scope.ownerId,
      taskId: scope.taskId,
      stepId: scope.stepId,
      sourceRevisionId: scope.sourceRevisionId,
      sourceSha: scope.sourceSha,
    },
    stored.production,
  );
}
/** Called only after signed-host authentication, outside every SQL transaction.
 * The eventual mutation independently locks and verifies the refreshed scope. */
export async function refreshProductionForHost(
  db: PrismaClient,
  scope: {
    ownerId: string;
    managerThreadId: string;
    serverInstanceId: string;
    projectId: string;
    preparationIntentId: string;
  },
  signal?: AbortSignal,
) {
  if (process.env.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED !== "true") return;
  const binding = await db.deliveryManagerBinding.findFirst({
    where: {
      ownerId: scope.ownerId,
      nativeThreadId: scope.managerThreadId,
      serverInstanceId: scope.serverInstanceId,
      projectId: scope.projectId,
      preparationIntentId: scope.preparationIntentId,
    },
    include: { currentAttempt: { include: { step: { include: { task: true } } } } },
  });
  const attempt = binding?.currentAttempt;
  if (attempt?.step.acceptancePhase !== "activation_production") return;
  const config = productionAcceptanceConfig();
  const task = attempt.step.task;
  const sourceRevisionId = task.sourceRevisionId;
  if (!sourceRevisionId) return unavailable();
  if (attempt.outcome === "succeeded" && attempt.step.state === "succeeded") {
    await db.$transaction((tx) =>
      productionAcceptanceStepMaterial(tx, {
        ownerId: scope.ownerId,
        taskId: task.id,
        stepId: attempt.stepId,
        sourceRevisionId,
        sourceSha: task.sourceSha,
      }),
    );
    return;
  }
  // Capture the same immutable release anchor without mistaking its historical
  // observation for a current serving assertion. The collector performs fresh reads.
  const anchor = await db.$transaction((tx) =>
    readProductionAcceptanceAnchor(tx, config, {
      ownerId: scope.ownerId,
      taskId: task.id,
      sourceRevisionId,
      sourceSha: task.sourceSha,
    }),
  );
  if (!anchor) return unavailable();
  const deadline = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  if (
    !(await refreshProductionAcceptance(
      db,
      config,
      {
        ownerId: scope.ownerId,
        taskId: task.id,
        releaseId: anchor.releaseId,
      },
      deadline,
    ))
  )
    return unavailable();
}
