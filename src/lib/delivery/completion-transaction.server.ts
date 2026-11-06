import { createHash } from "node:crypto";
import type { Prisma } from "@hive/db";
import type { z } from "zod";
import type { completionSchema } from "./contracts";
import type { EvidencePolicy } from "./repository";
import { resolveAttemptSource } from "./source-resolver.server";
import { assertCompletionEvidence, DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
type ModelCompletion = z.infer<typeof completionSchema>;
export type TransactionCompletion = Omit<ModelCompletion, "report"> & {
  report: Omit<ModelCompletion["report"], "difficulty"> & {
    difficulty: ModelCompletion["report"]["difficulty"] | "unknown";
  };
};
const canonical = (v: unknown): unknown =>
  v instanceof Date
    ? v.toISOString()
    : Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
async function now(tx: Tx) {
  return (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
}
async function lockTask(tx: Tx, ownerId: string, taskId: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM delivery_tasks WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid FOR UPDATE`;
  if (rows.length !== 1) throw new DeliveryConflict("task_not_found");
  return tx.deliveryTask.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id: taskId } } });
}
async function replay(tx: Tx, ownerId: string, eventId: string, requestDigest: string) {
  const row = await tx.deliveryEvent.findUnique({
    where: { ownerId_id: { ownerId, id: eventId } },
  });
  if (row && row.requestDigest !== requestDigest)
    throw new DeliveryConflict("event_replay_conflict");
  return row;
}
/** Shared completion transaction. Model input still uses completionSchema;
 * only a controller-built factual report can use unknown difficulty. Caller
 * owns current host/policy/producer authorization under this SAME transaction. */
export async function completeStepInTransaction(
  tx: Tx,
  ownerId: string,
  input: TransactionCompletion,
  policy: EvidencePolicy,
  afterComplete: (tx: Tx, ownerId: string, taskId: string) => Promise<void>,
) {
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(["step_completed", canonical(input)]))
    .digest("hex");
  const task = await lockTask(tx, ownerId, input.taskId);
  const previous = await replay(tx, ownerId, input.eventId, requestDigest);
  if (previous) {
    const report = await tx.deliveryStepReport.findUniqueOrThrow({
      where: { ownerId_eventId: { ownerId, eventId: previous.id } },
    });
    return {
      eventId: previous.id,
      reportId: report.id,
      version: previous.aggregateVersion,
      replayed: true,
    };
  }
  const step = await tx.deliveryStep.findUnique({
    where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
  });
  if (!step) throw new DeliveryConflict("step_not_found");
  if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
  const attempt = await tx.deliveryAttempt.findUnique({
    where: { ownerId_stepId_id: { ownerId, stepId: step.id, id: input.attemptId } },
  });
  const timestamp = await now(tx);
  if (
    !attempt ||
    step.state !== "running" ||
    attempt.outcome !== "running" ||
    attempt.leaseGeneration !== input.leaseGeneration ||
    step.leaseGeneration !== input.leaseGeneration ||
    attempt.leaseExpiresAt <= timestamp
  )
    throw new DeliveryConflict("stale_attempt");
  const acceptedSource = await resolveAttemptSource(tx, ownerId, task.id, attempt.id);
  if (acceptedSource.acceptedSha !== input.sourceSha)
    throw new DeliveryConflict("source_revision_changed");
  const evidence = await tx.deliveryEvidence.findMany({
    where: { ownerId, stepId: step.id, id: { in: input.evidenceIds } },
  });
  if (evidence.length !== input.evidenceIds.length)
    throw new DeliveryConflict("evidence_not_found");
  assertCompletionEvidence({
    ownerId,
    stepId: step.id,
    sourceSha: task.sourceSha,
    acceptancePhase: step.acceptancePhase,
    criterionIds: step.criterionIds,
    requiredKinds: step.requiredEvidenceKinds,
    policyVersion: policy.version,
    trustedProducers: policy.trustedProducers,
    now: timestamp,
    maxAgeMs: policy.maxAgeMs,
    evidence,
  });
  const version = step.version + 1;
  await tx.deliveryStep.update({
    where: { ownerId_id: { ownerId, id: step.id } },
    data: { state: "succeeded", version },
  });
  await tx.deliveryAttempt.update({
    where: { ownerId_id: { ownerId, id: attempt.id } },
    data: { outcome: "succeeded", finishedAt: timestamp },
  });
  await tx.deliveryEvent.create({
    data: {
      id: input.eventId,
      ownerId,
      taskId: task.id,
      stepId: step.id,
      attemptId: attempt.id,
      aggregateKey: `step/${step.id}`,
      aggregateVersion: version,
      type: "step_completed",
      requestDigest,
      policyVersion: policy.version,
    },
  });
  const report = await tx.deliveryStepReport.create({
    data: {
      ownerId,
      stepId: step.id,
      attemptId: attempt.id,
      eventId: input.eventId,
      ...input.report,
    },
  });
  await tx.deliveryReportEvidence.createMany({
    data: input.evidenceIds.map((evidenceId) => ({
      ownerId,
      stepId: step.id,
      reportId: report.id,
      evidenceId,
    })),
  });
  await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
  await afterComplete(tx, ownerId, task.id);
  return { eventId: input.eventId, reportId: report.id, version, replayed: false };
}
