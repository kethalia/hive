import type { Prisma } from "@hive/db";
import { maintenanceResumeScopeSchema } from "@/lib/codex-session/account-maintenance-contracts";
import { currentRepairReservation } from "./acceptance-repair.server";
import type { ManagerEnvelope } from "./manager-contracts";
import { NATIVE_OBSERVER_PRODUCER } from "./native-contracts";
import { resolveAttemptSource } from "./source-resolver.server";
import { DeliveryConflict } from "./state";

type Binding = Prisma.DeliveryManagerBindingGetPayload<Record<string, never>>;
/** Called only after registration/checkout/task locks. The signed envelope is
 * installed-host authority; continuation is absent from the model tool schema. */
export async function authorizeProgressionClaim(
  tx: Prisma.TransactionClient,
  ownerId: string,
  binding: Binding,
  input: ManagerEnvelope,
) {
  if (input.command.operation !== "claim_step") throw new DeliveryConflict("invalid_continuation");
  const prior = await tx.deliveryEvent.findUnique({
    where: { ownerId_id: { ownerId, id: input.eventId } },
  });
  if (prior) {
    const receipt = (
      prior.payload as { nativeClaim?: { cursorVersion?: number; sequence?: number } } | null
    )?.nativeClaim;
    const attempt =
      prior.attemptId && (await tx.deliveryAttempt.findUnique({ where: { id: prior.attemptId } }));
    if (
      prior.type !== "attempt_started" ||
      !attempt ||
      attempt.managerBindingId !== binding.id ||
      typeof receipt?.cursorVersion !== "number" ||
      typeof receipt?.sequence !== "number" ||
      !Number.isInteger(receipt?.cursorVersion) ||
      !Number.isInteger(receipt?.sequence)
    )
      throw new DeliveryConflict("event_replay_conflict");
    // Repository replay compares the entire canonical claim, including checkpoint.
    return {
      cursorVersion: receipt.cursorVersion,
      sequence: receipt.sequence,
      continuing: false,
      replayed: true,
    };
  }
  if (input.maintenanceContinuation) {
    const c = input.maintenanceContinuation;
    if (
      binding.executionEpochVersion !== c.epochVersion ||
      binding.executionEpochRuntimeId !== c.epochRuntimeId ||
      binding.executionEpochEventId !== c.nativeReceiptEventId ||
      binding.executionEpochResumeEventId !== c.epochResumeEventId ||
      !binding.currentAttemptId ||
      !binding.activeAttemptId
    )
      throw new DeliveryConflict("maintenance_claim_scope_changed");
    const event = await tx.deliveryEvent.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: c.epochResumeEventId } },
    });
    const scope = maintenanceResumeScopeSchema.parse(event.payload);
    const old = await tx.deliveryAttempt.findUniqueOrThrow({
      where: { id: binding.currentAttemptId },
      include: { step: true },
    });
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    if (
      event.type !== "account_maintenance_resume_requested" ||
      scope.managerBindingId !== binding.id ||
      scope.ownerIntentRuntimeId !== c.ownerIntentRuntimeId ||
      scope.ownerIntentEventId !== c.ownerIntentEventId ||
      scope.ownerRequestId !== c.inputRequestId ||
      scope.currentAttemptId !== old.id ||
      scope.cursorVersion !== binding.cursorVersion ||
      scope.nativeSequence !== binding.nativeSequence ||
      old.ownerId !== ownerId ||
      old.managerBindingId !== binding.id ||
      old.step.taskId !== input.command.payload.taskId ||
      !["reported", "succeeded"].includes(old.outcome) ||
      old.step.state !== old.outcome ||
      old.leaseExpiresAt <= now ||
      Date.parse(scope.leaseValidUntil) <= now.getTime()
    )
      throw new DeliveryConflict("maintenance_previous_attempt_held");
    if (
      await tx.deliveryEvent.findUnique({
        where: {
          ownerId_aggregateKey_aggregateVersion: {
            ownerId,
            aggregateKey: `maintenance-claim/${c.epochResumeEventId}`,
            aggregateVersion: 1,
          },
        },
      })
    )
      throw new DeliveryConflict("maintenance_claim_consumed");
    await resolveAttemptSource(tx, ownerId, input.command.payload.taskId, old.id);
    return {
      cursorVersion: binding.cursorVersion + 1,
      sequence: binding.nativeSequence,
      continuing: true,
      replayed: false,
      maintenanceResumeEventId: c.epochResumeEventId,
      priorAttemptId: old.id,
    };
  }
  if (!binding.activeAttemptId) {
    if (input.continuation || binding.currentAttemptId || binding.cursorVersion !== 0)
      throw new DeliveryConflict("invalid_continuation");
    return {
      cursorVersion: 1,
      sequence: binding.nativeSequence,
      continuing: false,
      replayed: false,
    };
  }
  const c = input.continuation;
  if (
    !c ||
    c.priorAttemptId !== binding.currentAttemptId ||
    c.cursorVersion !== binding.cursorVersion ||
    c.sequence !== binding.nativeSequence ||
    c.nextParentTurnId !== input.nativeTurnId ||
    c.parentTurnId === c.nextParentTurnId
  )
    throw new DeliveryConflict("continuation_boundary_required");
  const boundary = await tx.deliveryEvent.findUnique({
    where: { ownerId_id: { ownerId, id: c.boundaryEventId } },
  });
  const payload = boundary?.payload as {
    producer?: unknown;
    managerBindingId?: unknown;
    sequence?: unknown;
    source?: {
      parentTurnId?: unknown;
      nextParentTurnId?: unknown;
      cursorVersion?: unknown;
      observedAt?: unknown;
    };
  } | null;
  const old = await tx.deliveryAttempt.findUnique({
    where: { ownerId_id: { ownerId, id: c.priorAttemptId } },
    include: { step: true },
  });
  const anchor = await tx.deliveryAttempt.findUnique({
    where: { id: binding.activeAttemptId },
    include: { step: true },
  });
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  const age = now.getTime() - Date.parse(String(payload?.source?.observedAt));
  const repair =
    old?.outcome === "failed"
      ? await currentRepairReservation(tx, ownerId, binding.id, old.id, {
          ready: true,
          stepId: input.command.payload.stepId,
        })
      : null;
  if (
    !boundary ||
    boundary.type !== "native_root_boundary" ||
    boundary.taskId !== input.command.payload.taskId ||
    boundary.attemptId !== c.priorAttemptId ||
    payload?.producer !== NATIVE_OBSERVER_PRODUCER ||
    payload.managerBindingId !== binding.id ||
    payload.sequence !== c.sequence ||
    payload.source?.parentTurnId !== c.parentTurnId ||
    payload.source.nextParentTurnId !== c.nextParentTurnId ||
    payload.source.cursorVersion !== c.cursorVersion ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 60_000 ||
    !old ||
    old.managerBindingId !== binding.id ||
    (!repair && !["reported", "succeeded"].includes(old.outcome)) ||
    (!repair && old.step.state !== old.outcome) ||
    old.step.taskId !== input.command.payload.taskId ||
    old.leaseExpiresAt <= now ||
    anchor?.step.taskId !== input.command.payload.taskId
  )
    throw new DeliveryConflict("continuation_boundary_mismatch");
  await resolveAttemptSource(tx, ownerId, input.command.payload.taskId, old.id);
  if (
    await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId,
          aggregateKey: `boundary-consumed/${boundary.id}`,
          aggregateVersion: 1,
        },
      },
    })
  )
    throw new DeliveryConflict("continuation_boundary_consumed");
  return {
    ...(repair ? { repairId: repair.repairId } : {}),
    cursorVersion: binding.cursorVersion + 1,
    sequence: binding.nativeSequence,
    continuing: true,
    replayed: false,
  };
}

/** Recheck after claim/consumption SQL, so a lock or trigger wait cannot turn an
 * expired owner input or retained writer into a fresh executable reservation. */
export async function recheckMaintenanceClaimDeadline(
  tx: Prisma.TransactionClient,
  ownerId: string,
  input: ManagerEnvelope,
) {
  const c = input.maintenanceContinuation;
  if (!c) return;
  const event = await tx.deliveryEvent.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: c.epochResumeEventId } },
  });
  const scope = maintenanceResumeScopeSchema.parse(event.payload);
  if (!scope.currentAttemptId || !scope.writerAttemptId)
    throw new DeliveryConflict("maintenance_previous_attempt_held");
  const prior = await tx.deliveryAttempt.findUniqueOrThrow({
    where: { id: scope.currentAttemptId },
  });
  const writer = await tx.deliveryAttempt.findUniqueOrThrow({
    where: { id: scope.writerAttemptId },
  });
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  if (
    prior.ownerId !== ownerId ||
    writer.ownerId !== ownerId ||
    prior.managerBindingId !== scope.managerBindingId ||
    writer.managerBindingId !== scope.managerBindingId ||
    writer.runtimeVersion !== scope.writerRuntimeVersion ||
    !["reported", "succeeded"].includes(prior.outcome) ||
    prior.leaseExpiresAt <= now ||
    writer.leaseExpiresAt <= now ||
    Date.parse(scope.leaseValidUntil) <= now.getTime() ||
    input.expiresAt <= now.getTime()
  )
    throw new DeliveryConflict("maintenance_previous_attempt_held");
}
