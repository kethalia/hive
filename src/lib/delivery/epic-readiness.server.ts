import type { Prisma } from "@hive/db";
import { z } from "zod";
import { acceptanceTerminalSchema } from "./acceptance-completion-contracts";
import { acceptanceDigest } from "./acceptance-contracts";
import { acceptancePlanForIntent } from "./acceptance-policy.server";
import { nativeRuntimeBindingSchema } from "./contracts";
import { epicDigest } from "./epic-contracts";
import {
  executionActorHistory,
  requireHistoricalExecutionComplete,
} from "./execution-authority.server";
import { NATIVE_OBSERVER_PRODUCER } from "./native-contracts";
import { verifyReleaseEvidence } from "./release-evidence.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { SOURCE_PUBLICATION_PRODUCER } from "./source-publication.server";

const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const sealSchema = z
  .object({
    identity: z
      .object({
        ownerId: id,
        registrationId: id,
        serverInstanceId: z.string(),
        managerBindingId: id,
        sourceContext: acceptanceTerminalSchema.shape.sourceContext,
        policyDigest: digest,
        planDigest: digest,
        producerDigest: digest,
        terminal: acceptanceTerminalSchema.omit({ observedAt: true }),
      })
      .strict(),
    receipt: z
      .object({
        eventId: id,
        reportId: id,
        version: z.number().int().positive(),
        replayed: z.boolean(),
      })
      .strict(),
    evidenceIds: z.array(id).min(1).max(40),
  })
  .strict();

/** Derived preview integration readiness, never production completion, tree
 * exit or a released writer. Recomputed at every admission; an old lineage
 * receipt cannot override invalidated gates, changed source or native work. */
export async function epicPreviewReadiness(
  tx: Prisma.TransactionClient,
  store: RepositoryPolicyStore,
  ownerId: string,
  taskId: string,
) {
  await tx.$queryRaw`SELECT t.id FROM delivery_tasks t JOIN delivery_manager_bindings b
    ON b.owner_id=t.owner_id AND b.id=t.manager_binding_id
    WHERE t.owner_id=${ownerId}::uuid AND t.id=${taskId}::uuid FOR UPDATE OF t,b`;
  const task = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId, id: taskId } },
    include: { project: true, managerBinding: true, currentSourceRevision: true },
  });
  const binding = task?.managerBinding,
    source = task?.currentSourceRevision;
  if (
    !task ||
    !binding ||
    !source ||
    binding.blockedReason ||
    !binding.currentAttemptId ||
    !binding.activeAttemptId ||
    !(await verifyReleaseEvidence(tx, store, {
      ownerId,
      taskId,
      sourceSha: task.sourceSha,
      milestone: "implementation_preview",
    }))
  )
    return null;
  const writer = await tx.deliveryAttempt.findUnique({
    where: { ownerId_id: { ownerId, id: binding.activeAttemptId } },
  });
  if (!writer || writer.managerBindingId !== binding.id || writer.quiescedAt) return null;
  const event = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId,
        aggregateKey: `acceptance-success/${binding.currentAttemptId}`,
        aggregateVersion: 1,
      },
    },
  });
  const saved = sealSchema.safeParse(event?.payload);
  if (
    !event ||
    !saved.success ||
    event.type !== "acceptance_success_completed" ||
    event.taskId !== taskId ||
    event.attemptId !== binding.currentAttemptId ||
    acceptanceDigest(saved.data.identity) !== event.requestDigest
  )
    return null;
  let actors: Map<string, boolean>;
  try {
    actors = await executionActorHistory(tx, binding);
  } catch {
    return null;
  }
  const { identity, receipt } = saved.data,
    terminal = identity.terminal;
  const bound = await store.resolveTask(tx, ownerId, taskId),
    plan = await acceptancePlanForIntent(tx, ownerId, binding.preparationIntentId);
  if (
    !bound ||
    !plan ||
    identity.ownerId !== ownerId ||
    identity.managerBindingId !== binding.id ||
    !actors.has(identity.serverInstanceId) ||
    identity.policyDigest !== bound.binding.policyDigest ||
    identity.planDigest !== plan.row.planDigest ||
    identity.producerDigest !== plan.row.producerDigest ||
    epicDigest(identity.sourceContext) !== epicDigest(terminal.sourceContext) ||
    identity.sourceContext.revisionId !== source.id ||
    identity.sourceContext.version !== source.version ||
    identity.sourceContext.headSha !== source.headSha ||
    source.headSha !== task.sourceSha ||
    source.producer !== SOURCE_PUBLICATION_PRODUCER ||
    source.repositoryId !== task.project.providerRepositoryId ||
    terminal.taskId !== taskId ||
    terminal.managerBindingId !== binding.id ||
    terminal.managerThreadId !== binding.nativeThreadId ||
    terminal.attemptId !== binding.currentAttemptId ||
    terminal.cursorVersion !== binding.cursorVersion ||
    terminal.nativeSequence !== binding.nativeSequence ||
    event.stepId !== terminal.stepId
  )
    return null;
  const attempt = await tx.deliveryAttempt.findUnique({
    where: { ownerId_id: { ownerId, id: terminal.attemptId } },
    include: { step: true },
  });
  const report = await tx.deliveryStepReport.findUnique({ where: { id: receipt.reportId } });
  const sourceEvent = await tx.deliveryEvent.findFirst({
    where: {
      ownerId,
      taskId,
      attemptId: source.producingAttemptId,
      type: "source_advanced",
      requestDigest: source.requestDigest,
      payload: { path: ["sourceRevisionId"], equals: source.id },
    },
  });
  if (
    !attempt ||
    attempt.outcome !== "succeeded" ||
    attempt.step.state !== "succeeded" ||
    attempt.step.acceptancePhase !== "implementation_preview" ||
    attempt.step.version !== receipt.version ||
    attempt.outputRevisionId !== source.id ||
    !sourceEvent ||
    !report ||
    report.ownerId !== ownerId ||
    report.attemptId !== attempt.id ||
    report.eventId !== receipt.eventId
  )
    return null;
  const allCohort = await tx.deliveryAttempt.findMany({
    where: { ownerId, managerBindingId: binding.id, runtimeBindingDigest: { not: null } },
    take: 21,
  });
  if (allCohort.length > 20) return null;
  const cohort = allCohort.filter((member) => {
    const runtime = nativeRuntimeBindingSchema.safeParse(member.runtimeBinding);
    return runtime.success && runtime.data.serverInstanceId === identity.serverInstanceId;
  });
  if (
    cohort.length > 20 ||
    cohort.length !== terminal.cohort.length ||
    new Set(terminal.cohort.map((member) => member.childThreadId)).size !==
      terminal.cohort.length ||
    !cohort.some((member) => member.id === attempt.id)
  )
    return null;
  for (const member of allCohort) {
    const parsed = nativeRuntimeBindingSchema.safeParse(member.runtimeBinding);
    if (!parsed.success || member.outcome === "running") return null;
    const runtime = parsed.data;
    const latest = await tx.deliveryEvent.findFirst({
      where: {
        ownerId,
        attemptId: member.id,
        type: {
          in: [
            "native_attempt_observed",
            "native_source_conflict",
            "native_command_observed",
            "native_runtime_started",
          ],
        },
      },
      orderBy: { aggregateVersion: "desc" },
    });
    const fact = latest?.payload as {
      producer?: string;
      nativeSourceKind?: string;
      turnStatus?: string;
      source?: { parentTurnId?: string };
    } | null;
    const historical = runtime.serverInstanceId !== identity.serverInstanceId;
    if (historical) {
      try {
        await requireHistoricalExecutionComplete(tx, binding, actors, member, latest);
      } catch {
        return null;
      }
    }
    if (
      latest?.type !== "native_attempt_observed" ||
      fact?.producer !== NATIVE_OBSERVER_PRODUCER ||
      fact.nativeSourceKind !== "turn_completed" ||
      fact.turnStatus !== "completed" ||
      !actors.has(runtime.serverInstanceId) ||
      runtime.managerThreadId !== binding.nativeThreadId ||
      (!historical &&
        !terminal.cohort.some(
          (entry) =>
            entry.parentTurnId === fact.source?.parentTurnId &&
            entry.spawnCallId === runtime.operationId &&
            entry.childThreadId === runtime.nativeThreadId &&
            entry.childTurnId === runtime.nativeTurnId &&
            entry.effectiveModel === member.effectiveModel &&
            entry.effectiveEffort === member.effectiveEffort,
        ))
    )
      return null;
  }
  const readiness = {
    schemaVersion: 1 as const,
    milestone: "implementation_preview" as const,
    ownerId,
    taskId,
    intentId: binding.preparationIntentId,
    repositoryId: source.repositoryId,
    sourceSha: source.headSha,
    sourceRevisionId: source.id,
    sourceVersion: source.version,
    sourceReceiptDigest: epicDigest({
      revisionId: source.id,
      operationId: source.operationId,
      requestDigest: source.requestDigest,
      proofDigest: source.proofDigest,
      eventId: sourceEvent.id,
    }),
    completionEventId: event.id,
    completionDigest: event.requestDigest,
    cohortDigest: epicDigest(terminal.cohort),
    writerHeld: true as const,
    productionVerified: false as const,
  };
  return { ...readiness, digest: epicDigest(readiness) };
}
export type EpicPreviewReadiness = NonNullable<Awaited<ReturnType<typeof epicPreviewReadiness>>>;
