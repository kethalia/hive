import type { Prisma } from "@hive/db";
import { DeliveryConflict } from "@/lib/delivery/state";

/** Call only after live registration/producer and manager/checkout locks. This is
 * an action-specific INPUT/source gate, not the generic producer identity fence.
 * Historical reads, authoritative checks and forensic/replay recording keep their
 * own exact authorization; they must not be converted into execution authority. */
export async function requireAppliedSourceForAction(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    managerBindingId: string;
    taskId?: string;
    action: "execution" | "publication" | "root_boundary" | "completion" | "report" | "failure";
    attemptId?: string;
    parentTurnId?: string;
  },
) {
  const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: input.ownerId, id: input.managerBindingId } },
  });
  const admission = await tx.codexGuardianAdmission.findFirst({
    where: {
      ownerId: input.ownerId,
      projectId: binding.projectId,
      preparationIntentId: binding.preparationIntentId,
      nativeThreadId: binding.nativeThreadId,
      leaseId: binding.leaseId,
      leaseGeneration: binding.leaseGeneration,
      runtime: {
        serverInstanceId: binding.serverInstanceId,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
      },
    },
  });
  // Genuinely unguarded legacy bindings retain their previous source behavior.
  // Feature flags never erase a persisted guarded admission.
  if (!admission) return { guarded: false, applied: true, reportOnly: false };
  let taskId = input.taskId;
  if (!taskId && binding.currentAttemptId) {
    const current = await tx.deliveryAttempt.findUniqueOrThrow({
      where: { id: binding.currentAttemptId },
      include: { step: true },
    });
    taskId = current.step.taskId;
  }
  if (!taskId) return { guarded: true, applied: true, reportOnly: false };
  const task = await tx.deliveryTask.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: input.ownerId, id: taskId } },
    include: { currentSourceRevision: true },
  });
  if (task.managerBindingId !== binding.id || task.projectId !== binding.projectId)
    throw new DeliveryConflict("source_application_scope_mismatch");
  const latest = await tx.deliverySourceApplication.findFirst({
    where: { ownerId: input.ownerId, admissionId: admission.id },
    orderBy: { applicationVersion: "desc" },
  });
  if (!task.sourceRevisionId && task.sourceVersion === 0 && !latest)
    return { guarded: true, applied: true, reportOnly: false };
  if (
    latest?.phase === "applied" &&
    latest.targetRevisionId === task.sourceRevisionId &&
    latest.taskId === task.id
  )
    return { guarded: true, applied: true, reportOnly: false };
  const accepted = task.currentSourceRevision;
  if (
    ["completion", "report", "failure"].includes(input.action) &&
    accepted &&
    input.attemptId === accepted.producingAttemptId &&
    binding.currentAttemptId === input.attemptId &&
    (!binding.blockedReason || input.action === "failure")
  ) {
    const claim = await tx.deliveryEvent.findFirst({
      where: { ownerId: input.ownerId, attemptId: input.attemptId, type: "attempt_started" },
    });
    const native = (
      claim?.payload as {
        nativeClaim?: {
          cursorVersion?: unknown;
          parentTurnId?: unknown;
          managerThreadId?: unknown;
        };
      } | null
    )?.nativeClaim;
    if (
      native?.cursorVersion === binding.cursorVersion &&
      native.parentTurnId === input.parentTurnId &&
      native.managerThreadId === binding.nativeThreadId
    )
      return { guarded: true, applied: false, reportOnly: true };
  }
  throw new DeliveryConflict("source_application_required");
}
