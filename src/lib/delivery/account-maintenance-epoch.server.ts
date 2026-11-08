import { randomUUID } from "node:crypto";
import type { Prisma } from "@hive/db";
import {
  maintenanceNativeRebindSchema,
  maintenanceOwnerResumeSchema,
  maintenanceResumeScopeSchema,
} from "@/lib/codex-session/account-maintenance-contracts";
import {
  parseAccountMaintenance,
  updateAccountMaintenanceState,
} from "@/lib/codex-session/account-maintenance-store.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";

type Tx = Prisma.TransactionClient;
const check: (value: unknown) => asserts value = (value) => {
  if (!value) throw new RegistrationRejected();
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

/** Runs INSIDE the existing native-finalization/receipt transaction. It cannot
 * mint producer authority or relabel an old attempt. Lost ACK is receipt replay,
 * never another thread/start, first prompt, or epoch advancement. */
export async function commitMaintenanceNativeReceipt(
  tx: Tx,
  identity: {
    ownerId: string;
    runtimeId: string;
    eventId: string;
  },
) {
  const receipt = await tx.codexGuardianOperationReceipt.findUniqueOrThrow({
    where: { ownerId_runtimeId_eventId: identity },
  });
  const response = receipt.response as Prisma.JsonObject;
  if (!response.maintenanceRebind) return;
  const rebind = maintenanceNativeRebindSchema.parse(response.maintenanceRebind);
  const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
    where: { id: identity.runtimeId },
  });
  const slot = await tx.codexHostSlot.findUniqueOrThrow({ where: { id: runtime.slotId } });
  const state = parseAccountMaintenance(slot.accountMaintenance);
  check(
    state?.phase === "resuming" &&
      state.id === rebind.maintenanceId &&
      state.idleRuntimeId === runtime.id &&
      state.resumeIntentRuntimeId === rebind.ownerIntentRuntimeId &&
      state.resumeIntentEventId === rebind.ownerIntentEventId,
  );
  const ownerIntent = await tx.codexGuardianOperationReceipt.findUniqueOrThrow({
    where: {
      ownerId_runtimeId_eventId: {
        ownerId: identity.ownerId,
        runtimeId: rebind.ownerIntentRuntimeId,
        eventId: rebind.ownerIntentEventId,
      },
    },
  });
  check(ownerIntent.action === "maintenance_resume_intent" && receipt.action === "native");
  const ownerScope = maintenanceOwnerResumeSchema.parse(
    (ownerIntent.response as Prisma.JsonObject).maintenance,
  );
  check(
    ownerScope.ownerId === identity.ownerId &&
      ownerScope.idleRuntimeId === runtime.id &&
      ownerScope.workspaceId === runtime.workspaceId &&
      ownerScope.buildId === runtime.buildId &&
      ownerScope.maintenanceId === state.id &&
      ownerScope.requestId === state.resumeRequestId &&
      ownerScope.maintenanceVersion === slot.accountMaintenanceVersion &&
      ownerScope.parkedJournalDigest === rebind.parkedJournalDigest,
  );
  const result = response.admission as Prisma.JsonObject;
  check(typeof result.id === "string");
  const admission = await tx.codexGuardianAdmission.findUniqueOrThrow({ where: { id: result.id } });
  const retained = ownerScope.projects.find(
    (p) => p.preparationIntentId === admission.preparationIntentId,
  );
  check(
    retained &&
      retained.historyDigest === rebind.historyDigest &&
      admission.runtimeId === runtime.id &&
      admission.ownerId === identity.ownerId &&
      admission.phase === "native" &&
      admission.registrationId &&
      admission.nativeThreadId === retained.nativeThreadId &&
      admission.leaseId === retained.leaseId &&
      admission.leaseGeneration === retained.leaseGeneration &&
      guardianDigest(admission.checkoutBinding) === retained.checkoutDigest,
  );
  const registration = await tx.codexHostRegistration.findUniqueOrThrow({
    where: { id: admission.registrationId },
  });
  check(
    slot.activeRegistrationId === registration.id &&
      runtime.phase === "open" &&
      runtime.producerApproved &&
      runtime.serverInstanceId === registration.serverInstanceId &&
      runtime.generation === receipt.resultRuntimeGeneration &&
      admission.generation === receipt.resultAdmissionGeneration,
  );
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM delivery_manager_bindings
    WHERE owner_id=${identity.ownerId}::uuid AND preparation_intent_id=${admission.preparationIntentId}::uuid ORDER BY id FOR UPDATE`;
  check(locked.length <= 1);
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  check(
    runtime.authorityUntil > clock.now &&
      registration.expiresAt > clock.now &&
      Date.parse(rebind.leaseValidUntil) > clock.now.getTime(),
  );
  if (locked.length) {
    const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: locked[0].id },
    });
    check(
      binding.ownerId === identity.ownerId &&
        binding.workspaceId === runtime.workspaceId &&
        binding.buildId === runtime.buildId &&
        binding.projectId === admission.projectId &&
        binding.sourceSha === retained.sourceSha &&
        binding.nativeThreadId === admission.nativeThreadId &&
        binding.leaseId === admission.leaseId &&
        binding.leaseGeneration === admission.leaseGeneration &&
        !binding.blockedReason,
    );
    await tx.$queryRaw`SELECT id FROM delivery_tasks WHERE owner_id=${identity.ownerId}::uuid
      AND manager_binding_id=${binding.id}::uuid ORDER BY id FOR UPDATE`;
    const tasks = await tx.deliveryTask.findMany({
      where: { ownerId: identity.ownerId, managerBindingId: binding.id },
      orderBy: { id: "asc" },
    });
    check(
      tasks.length > 0 &&
        tasks.length <= 32 &&
        tasks.every(
          (t) =>
            t.pauseRequested &&
            state.tasks.some((p) => p.taskId === t.id && p.sourceVersion === t.sourceVersion),
        ),
    );
    let writerRuntimeVersion = 0;
    if (binding.activeAttemptId) {
      await tx.$queryRaw`SELECT id FROM delivery_attempts WHERE owner_id=${identity.ownerId}::uuid AND id=${binding.activeAttemptId}::uuid FOR UPDATE`;
      const writer = await tx.deliveryAttempt.findUniqueOrThrow({
        where: { id: binding.activeAttemptId },
      });
      // Physical writer identity/history is retained, never rewritten to the new
      // server. An expired/uncertain lease cannot be resurrected by reconnect.
      check(writer.managerBindingId === binding.id && writer.leaseExpiresAt > clock.now);
      writerRuntimeVersion = writer.runtimeVersion;
    }
    const resumeEventId = randomUUID();
    const scope = maintenanceResumeScopeSchema.parse({
      schemaVersion: 1,
      purpose: "account-maintenance",
      maintenanceId: state.id,
      maintenanceVersion: slot.accountMaintenanceVersion,
      ownerRequestId: state.resumeRequestId,
      ownerId: identity.ownerId,
      workspaceId: runtime.workspaceId,
      buildId: runtime.buildId,
      slotId: slot.id,
      managerBindingId: binding.id,
      previousEpochVersion: binding.executionEpochVersion,
      projectId: binding.projectId,
      preparationIntentId: binding.preparationIntentId,
      managerThreadId: binding.nativeThreadId,
      sourceSha: binding.sourceSha,
      leaseId: binding.leaseId,
      leaseGeneration: binding.leaseGeneration,
      leaseValidUntil: rebind.leaseValidUntil,
      writerAttemptId: binding.activeAttemptId,
      writerRuntimeVersion,
      currentAttemptId: binding.currentAttemptId,
      cursorVersion: binding.cursorVersion,
      nativeSequence: binding.nativeSequence,
      checkoutDigest: retained.checkoutDigest,
      parkedHistoryDigest: retained.historyDigest,
      parkedJournalDigest: rebind.parkedJournalDigest,
      oldRuntimeId: retained.oldRuntimeId,
      oldBarrierId: retained.oldBarrierId,
      oldTreeReceiptId: retained.oldTreeReceiptId,
      oldTreeReceiptDigest: retained.oldTreeReceiptDigest,
      ownerIntentRuntimeId: ownerIntent.runtimeId,
      ownerIntentEventId: ownerIntent.eventId,
      newRuntimeId: runtime.id,
      newNativeReceiptEventId: receipt.eventId,
      newRegistrationId: registration.id,
      newServerInstanceId: registration.serverInstanceId,
      newMetadataPinsDigest: admission.metadataPinsDigest,
      tasks: tasks.map((t) => ({
        taskId: t.id,
        version: t.version,
        sourceVersion: t.sourceVersion,
        sourceRevisionId: t.sourceRevisionId,
        sourceSha: t.sourceSha,
      })),
    });
    await tx.deliveryEvent.create({
      data: {
        id: resumeEventId,
        ownerId: identity.ownerId,
        taskId: tasks[0].id,
        aggregateKey: `maintenance-resume/${binding.id}/${state.id}`,
        aggregateVersion: 1,
        type: "account_maintenance_resume_requested",
        requestDigest: guardianDigest(scope),
        payload: json(scope),
        policyVersion: "account-maintenance-v1",
      },
    });
    const committed = {
      managerBindingId: binding.id,
      previousEpochVersion: binding.executionEpochVersion,
      epochVersion: binding.executionEpochVersion + 1,
      resumeEventId,
      newRuntimeId: runtime.id,
      newNativeReceiptEventId: receipt.eventId,
    };
    await tx.deliveryEvent.create({
      data: {
        id: randomUUID(),
        ownerId: identity.ownerId,
        taskId: tasks[0].id,
        aggregateKey: `maintenance-epoch/${binding.id}`,
        aggregateVersion: committed.epochVersion,
        type: "account_maintenance_epoch_committed",
        requestDigest: guardianDigest(committed),
        payload: committed,
        policyVersion: "account-maintenance-v1",
      },
    });
    await tx.deliveryManagerBinding.update({
      where: { id: binding.id },
      data: {
        executionEpochVersion: { increment: 1 },
        executionEpochRuntimeId: runtime.id,
        executionEpochEventId: receipt.eventId,
        executionEpochResumeEventId: resumeEventId,
      },
    });
  }
  const finalized = await tx.codexGuardianOperationReceipt.findMany({
    where: { ownerId: identity.ownerId, runtimeId: runtime.id, action: "native" },
  });
  const complete = ownerScope.projects.every((p) =>
    finalized.some((r) => {
      const data = r.response as Prisma.JsonObject,
        a = data.admission as Prisma.JsonObject;
      const proof = maintenanceNativeRebindSchema.safeParse(data.maintenanceRebind);
      return (
        a?.preparationIntentId === p.preparationIntentId &&
        proof.success &&
        proof.data.ownerIntentEventId === ownerIntent.eventId &&
        proof.data.ownerIntentRuntimeId === ownerIntent.runtimeId
      );
    }),
  );
  if (complete) {
    // Preserve unrelated/manual pauses. Only reverse our exact, unchanged pause
    // transition. A concurrent source/review/attempt change holds atomically.
    for (const parked of state.tasks) {
      const task = await tx.deliveryTask.findUniqueOrThrow({ where: { id: parked.taskId } });
      if (parked.pauseRequested) continue;
      check(
        task.pauseRequested &&
          task.version === parked.version + 1 &&
          task.sourceVersion === parked.sourceVersion,
      );
      await tx.deliveryTask.update({
        where: { id: task.id },
        data: {
          pauseRequested: false,
          schedulingPaused: parked.schedulingPaused,
          version: { increment: 1 },
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId: identity.ownerId,
          taskId: task.id,
          aggregateKey: `task/${task.id}`,
          aggregateVersion: task.version + 1,
          type: "scheduling_resumed",
          requestDigest: guardianDigest({ maintenanceId: state.id, taskId: task.id }),
          payload: {
            maintenanceId: state.id,
            ownerIntentRuntimeId: ownerIntent.runtimeId,
            ownerIntentEventId: ownerIntent.eventId,
          },
          policyVersion: "account-maintenance-v1",
        },
      });
    }
    await updateAccountMaintenanceState(tx, { ...state, phase: "finished" });
  }
  const [fresh] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  check(
    runtime.authorityUntil > fresh.now &&
      registration.expiresAt > fresh.now &&
      Date.parse(rebind.leaseValidUntil) > fresh.now.getTime(),
  );
}
