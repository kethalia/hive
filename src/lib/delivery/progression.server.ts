import type { Prisma } from "@hive/db";
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
