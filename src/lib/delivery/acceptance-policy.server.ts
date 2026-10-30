import type { Prisma } from "@hive/db";
import { acceptanceDeploymentConfig } from "./acceptance-config.server";
import {
  acceptanceDigest,
  acceptanceJobScopeSchema,
  acceptancePlanResultSchema,
  acceptanceReviewResultSchema,
} from "./acceptance-contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
export const acceptanceEvidenceProducer = (digest: string) => `hive-acceptance-v1:${digest}`;
const reject = () => {
  throw new DeliveryConflict("acceptance_evaluator_unavailable");
};
export async function acceptancePlanForIntent(tx: Tx, ownerId: string, intentId: string) {
  const captured = await tx.deliveryAcceptanceIntent.findUnique({
    where: { ownerId_intentId: { ownerId, intentId } },
  });
  if (!captured) return null;
  const producer = acceptanceDeploymentConfig();
  if (!producer) return reject();
  const digest = acceptanceDigest(producer);
  const row = await tx.deliveryAcceptancePlan.findUnique({
    where: { ownerId_intentId_producerDigest: { ownerId, intentId, producerDigest: digest } },
  });
  if (!row || row.intentDigest !== captured.intentDigest) return reject();
  const plan = acceptancePlanResultSchema.parse(row.content);
  if (plan.outcome !== "ready") return reject();
  return { row, plan, producer, digest };
}
export async function bindAcceptanceTask(
  tx: Tx,
  ownerId: string,
  taskId: string,
  intentId: string,
) {
  const plan = await acceptancePlanForIntent(tx, ownerId, intentId);
  if (!plan) return;
  const steps = await tx.deliveryStep.findMany({ where: { ownerId, taskId } });
  // A manager cannot omit a requirement or downgrade it to informational work.
  for (const requirement of plan.plan.requirements)
    if (
      !steps.some(
        (s) =>
          s.criterionIds.includes(requirement.id) &&
          s.requiredEvidenceKinds.includes("review") &&
          s.acceptancePhase === requirement.phase &&
          s.kind !== "understand",
      )
    )
      reject();
  for (const step of steps)
    for (const id of step.criterionIds.filter((c) => c.startsWith("acceptance:")))
      if (!plan.plan.requirements.some((r) => r.id === id && r.phase === step.acceptancePhase))
        reject();
}
export async function authorizeAcceptanceEvidence(
  tx: Tx,
  scope: {
    ownerId: string;
    taskId: string;
    stepId: string;
    sourceSha: string;
    sourceRevisionId?: string | null;
    sourceVersion?: number;
    acceptancePhase: string;
  },
  intentId: string,
  ids: string[],
  requireCoverage: boolean,
) {
  const plan = await acceptancePlanForIntent(tx, scope.ownerId, intentId);
  if (!plan) {
    if (ids.length) reject();
    return;
  }
  for (const id of ids) {
    const evidence = await tx.deliveryEvidence.findUnique({
      where: { ownerId_id: { ownerId: scope.ownerId, id } },
    });
    const job = await tx.deliveryAcceptanceJob.findUnique({
      where: { ownerId_id: { ownerId: scope.ownerId, id } },
    });
    if (
      !evidence ||
      !job ||
      job.phase !== "completed" ||
      job.kind !== "review" ||
      job.producerDigest !== plan.digest ||
      evidence.producer !== acceptanceEvidenceProducer(plan.digest) ||
      evidence.contentDigest !== job.resultDigest ||
      evidence.invalidatedAt ||
      evidence.stepId !== scope.stepId
    )
      return reject();
    const bound = acceptanceJobScopeSchema.parse(job.scope),
      result = acceptanceReviewResultSchema.parse(job.result);
    if (
      bound.taskId !== scope.taskId ||
      bound.stepId !== scope.stepId ||
      bound.sourceSha !== scope.sourceSha ||
      bound.sourceRevisionId !== scope.sourceRevisionId ||
      bound.sourceVersion !== scope.sourceVersion ||
      bound.planDigest !== plan.row.planDigest ||
      result.sourceSha !== scope.sourceSha
    )
      return reject();
    if (
      scope.acceptancePhase !== "implementation_preview" ||
      (requireCoverage && result.outcome !== "pass")
    )
      return reject();
  }
}
