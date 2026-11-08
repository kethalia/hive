import type { CodexHostRegistration, DeliveryManagerBinding, Prisma } from "@hive/db";
import { z } from "zod";
import {
  maintenanceOwnerResumeSchema,
  maintenanceResumeScopeSchema,
} from "@/lib/codex-session/account-maintenance-contracts";
import { guardianCheckoutSchema, guardianDigest } from "@/lib/codex-session/guardian-contracts";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";

import { nativeRuntimeBindingSchema } from "./contracts";
import { NATIVE_OBSERVER_PRODUCER } from "./native-contracts";

type Tx = Prisma.TransactionClient;
const requireValue: (value: unknown) => asserts value = (value) => {
  if (!value) throw new RegistrationRejected();
};
const nativeReceiptProjection = z.object({
  runtime: z.object({
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    slotId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    buildId: z.string().uuid(),
    generation: z.number().int().positive(),
    serverInstanceId: z.string().min(1),
    hostKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    producerApproved: z.literal(true),
    phase: z.literal("open"),
    nativeLaunchId: z.string().uuid(),
  }),
  admission: z.object({
    id: z.string().uuid(),
    ownerId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    generation: z.number().int().positive(),
    phase: z.literal("native"),
    registrationId: z.string().uuid(),
    projectId: z.string().uuid(),
    nativeThreadId: z.string().min(1),
    preparationIntentId: z.string().uuid(),
    leaseId: z.string().uuid(),
    leaseGeneration: z.number().int().positive(),
    metadataPinsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    checkoutBinding: guardianCheckoutSchema,
  }),
});
type ExecutionFields = {
  managerBindingId: string;
  registrationId: string;
  workspaceId: string;
  buildId: string;
  serverInstanceId: string;
  nativeThreadId: string;
  leaseId: string;
  leaseGeneration: number;
};
export type EffectiveExecutionAuthority = ExecutionFields &
  (
    | { kind: "original"; epochVersion: 0 }
    | {
        kind: "maintenance";
        epochVersion: number;
        runtimeId: string;
        receiptEventId: string;
        resumeEventId: string;
      }
  );
/** Call only after the existing slot/registration/guardian/intent/binding locks.
 * Original task/source/history identity is never rewritten or re-labelled. This
 * discriminated actor authority is for NEW effects; old receipts stay history. */
export async function resolveEffectiveExecutionAuthority(
  tx: Tx,
  binding: DeliveryManagerBinding,
  registration: CodexHostRegistration,
): Promise<EffectiveExecutionAuthority> {
  const version = binding.executionEpochVersion;
  requireValue(Number.isSafeInteger(version) && version >= 0);
  const base = {
    managerBindingId: binding.id,
    registrationId: registration.id,
    workspaceId: binding.workspaceId,
    buildId: binding.buildId,
    nativeThreadId: binding.nativeThreadId,
    leaseId: binding.leaseId,
    leaseGeneration: binding.leaseGeneration,
  };
  if (version === 0) {
    requireValue(
      binding.executionEpochRuntimeId === null &&
        binding.executionEpochEventId === null &&
        binding.executionEpochResumeEventId === null &&
        binding.serverInstanceId === registration.serverInstanceId &&
        binding.buildId === registration.buildId,
    );
    return {
      ...base,
      kind: "original",
      epochVersion: 0,
      serverInstanceId: binding.serverInstanceId,
    };
  }
  requireValue(
    binding.executionEpochRuntimeId &&
      binding.executionEpochEventId &&
      binding.executionEpochResumeEventId,
  );
  const receipt = await tx.codexGuardianOperationReceipt.findUnique({
    where: {
      ownerId_runtimeId_eventId: {
        ownerId: binding.ownerId,
        runtimeId: binding.executionEpochRuntimeId,
        eventId: binding.executionEpochEventId,
      },
    },
  });
  const resume = await tx.deliveryEvent.findUnique({
    where: { ownerId_id: { ownerId: binding.ownerId, id: binding.executionEpochResumeEventId } },
  });
  requireValue(
    receipt?.action === "native" && resume?.type === "account_maintenance_resume_requested",
  );
  const scope = maintenanceResumeScopeSchema.parse(resume.payload);
  const ownerIntent = await tx.codexGuardianOperationReceipt.findUnique({
    where: {
      ownerId_runtimeId_eventId: {
        ownerId: binding.ownerId,
        runtimeId: scope.ownerIntentRuntimeId,
        eventId: scope.ownerIntentEventId,
      },
    },
  });
  requireValue(ownerIntent?.action === "maintenance_resume_intent");
  const ownerScope = maintenanceOwnerResumeSchema.parse(
    (ownerIntent.response as Prisma.JsonObject).maintenance,
  );
  const retained = ownerScope.projects.find(
    (p) => p.preparationIntentId === binding.preparationIntentId,
  );
  requireValue(
    ownerScope.ownerId === binding.ownerId &&
      ownerScope.workspaceId === binding.workspaceId &&
      ownerScope.buildId === binding.buildId &&
      ownerScope.maintenanceId === scope.maintenanceId &&
      ownerScope.requestId === scope.ownerRequestId &&
      ownerScope.idleRuntimeId === scope.newRuntimeId &&
      ownerScope.maintenanceVersion === scope.maintenanceVersion &&
      ownerScope.parkedJournalDigest === scope.parkedJournalDigest &&
      retained &&
      retained.nativeThreadId === binding.nativeThreadId &&
      retained.leaseId === binding.leaseId &&
      retained.leaseGeneration === binding.leaseGeneration &&
      retained.checkoutDigest === scope.checkoutDigest &&
      retained.oldRuntimeId === scope.oldRuntimeId &&
      retained.oldBarrierId === scope.oldBarrierId &&
      retained.oldTreeReceiptId === scope.oldTreeReceiptId &&
      retained.oldTreeReceiptDigest === scope.oldTreeReceiptDigest &&
      retained.historyDigest === scope.parkedHistoryDigest,
  );
  const projected = nativeReceiptProjection.parse(receipt.response);
  const { runtime, admission } = projected;
  requireValue(
    scope.ownerId === binding.ownerId &&
      scope.managerBindingId === binding.id &&
      scope.previousEpochVersion === version - 1 &&
      scope.workspaceId === binding.workspaceId &&
      scope.buildId === binding.buildId &&
      scope.projectId === binding.projectId &&
      scope.preparationIntentId === binding.preparationIntentId &&
      scope.managerThreadId === binding.nativeThreadId &&
      scope.sourceSha === binding.sourceSha &&
      scope.leaseId === binding.leaseId &&
      scope.leaseGeneration === binding.leaseGeneration &&
      scope.slotId === registration.slotId &&
      scope.checkoutDigest === guardianDigest(projected.admission.checkoutBinding) &&
      scope.newRuntimeId === receipt.runtimeId &&
      scope.newNativeReceiptEventId === receipt.eventId &&
      scope.newRegistrationId === registration.id &&
      scope.newServerInstanceId === registration.serverInstanceId &&
      runtime.id === receipt.runtimeId &&
      runtime.ownerId === binding.ownerId &&
      runtime.workspaceId === binding.workspaceId &&
      runtime.buildId === binding.buildId &&
      runtime.slotId === registration.slotId &&
      runtime.serverInstanceId === registration.serverInstanceId &&
      runtime.hostKeyFingerprint === registration.hostKeyFingerprint &&
      runtime.generation === receipt.resultRuntimeGeneration &&
      admission.runtimeId === runtime.id &&
      admission.registrationId === registration.id &&
      admission.projectId === binding.projectId &&
      admission.preparationIntentId === binding.preparationIntentId &&
      admission.nativeThreadId === binding.nativeThreadId &&
      admission.leaseId === binding.leaseId &&
      admission.leaseGeneration === binding.leaseGeneration &&
      admission.metadataPinsDigest === scope.newMetadataPinsDigest &&
      admission.generation === receipt.resultAdmissionGeneration,
  );
  const current = await tx.codexGuardianRuntime.findUnique({
    where: { ownerId_id: { ownerId: binding.ownerId, id: runtime.id } },
  });
  const commits = await tx.deliveryEvent.findMany({
    where: {
      ownerId: binding.ownerId,
      type: "account_maintenance_epoch_committed",
      aggregateKey: `maintenance-epoch/${binding.id}`,
      aggregateVersion: version,
    },
    take: 2,
  });
  const committed = commits[0]?.payload as Record<string, unknown> | null;
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  requireValue(
    current?.phase === "open" &&
      current.producerApproved &&
      current.generation === runtime.generation &&
      current.serverInstanceId === runtime.serverInstanceId &&
      current.authorityUntil > clock.now &&
      registration.expiresAt > clock.now &&
      commits.length === 1 &&
      committed?.managerBindingId === binding.id &&
      committed.epochVersion === version &&
      committed.previousEpochVersion === version - 1 &&
      committed.resumeEventId === resume.id &&
      committed.newRuntimeId === receipt.runtimeId &&
      committed.newNativeReceiptEventId === receipt.eventId,
  );
  return {
    ...base,
    kind: "maintenance",
    epochVersion: version,
    serverInstanceId: registration.serverInstanceId,
    runtimeId: runtime.id,
    receiptEventId: receipt.eventId,
    resumeEventId: resume.id,
  };
}

/** Resolve NEW-effect identity without rewriting original conversation/history.
 * The installed caller already holds the checkout locks; repeated registration
 * locking also protects direct controller consumers against stale epoch reads. */
export async function currentExecutionActor(tx: Tx, binding: DeliveryManagerBinding) {
  if (binding.executionEpochVersion === 0) {
    requireValue(
      !binding.executionEpochRuntimeId &&
        !binding.executionEpochEventId &&
        !binding.executionEpochResumeEventId,
    );
    return {
      serverInstanceId: binding.serverInstanceId,
      buildId: binding.buildId,
      workspaceId: binding.workspaceId,
    };
  }
  requireValue(binding.executionEpochResumeEventId);
  const event = await tx.deliveryEvent.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: binding.ownerId, id: binding.executionEpochResumeEventId } },
  });
  const scope = maintenanceResumeScopeSchema.parse(event.payload);
  const { registration } = await lockActiveRegistration(tx, {
    ownerId: binding.ownerId,
    registrationId: scope.newRegistrationId,
  });
  return resolveEffectiveExecutionAuthority(tx, binding, registration);
}

/** Immutable actor lineage for factual seals. A prior actor is never returned as
 * runnable authority; every historical edge requires its actual closed tree. */
export async function executionActorHistory(tx: Tx, binding: DeliveryManagerBinding) {
  requireValue(binding.executionEpochVersion >= 0 && binding.executionEpochVersion <= 32);
  const actors = new Map<string, boolean>([[binding.serverInstanceId, false]]);
  if (binding.executionEpochVersion === 0) {
    requireValue(
      binding.executionEpochRuntimeId === null &&
        binding.executionEpochEventId === null &&
        binding.executionEpochResumeEventId === null,
    );
    return actors;
  }
  requireValue(
    binding.executionEpochRuntimeId &&
      binding.executionEpochEventId &&
      binding.executionEpochResumeEventId,
  );
  const commits = await tx.deliveryEvent.findMany({
    where: {
      ownerId: binding.ownerId,
      aggregateKey: `maintenance-epoch/${binding.id}`,
      type: "account_maintenance_epoch_committed",
    },
    orderBy: { aggregateVersion: "asc" },
    take: 33,
  });
  requireValue(commits.length === binding.executionEpochVersion);
  let previous = binding.serverInstanceId;
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index],
      data = commit.payload as Prisma.JsonObject;
    requireValue(
      commit.aggregateVersion === index + 1 &&
        data.epochVersion === index + 1 &&
        data.previousEpochVersion === index &&
        data.managerBindingId === binding.id &&
        typeof data.resumeEventId === "string",
    );
    const event = await tx.deliveryEvent.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: binding.ownerId, id: data.resumeEventId } },
    });
    const scope = maintenanceResumeScopeSchema.parse(event.payload);
    requireValue(
      event.type === "account_maintenance_resume_requested" &&
        scope.ownerId === binding.ownerId &&
        scope.managerBindingId === binding.id &&
        scope.previousEpochVersion === index &&
        scope.workspaceId === binding.workspaceId &&
        scope.buildId === binding.buildId &&
        scope.preparationIntentId === binding.preparationIntentId &&
        scope.managerThreadId === binding.nativeThreadId &&
        scope.newRuntimeId === data.newRuntimeId &&
        scope.newNativeReceiptEventId === data.newNativeReceiptEventId,
    );
    if (index === commits.length - 1)
      requireValue(
        data.resumeEventId === binding.executionEpochResumeEventId &&
          data.newRuntimeId === binding.executionEpochRuntimeId &&
          data.newNativeReceiptEventId === binding.executionEpochEventId,
      );
    const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: scope.oldRuntimeId },
    });
    const [tree] = await tx.$queryRaw<
      { id: string; owner_id: string; runtime_id: string; barrier_id: string; digest: string }[]
    >`
      SELECT receipt_id AS id,owner_id,runtime_id,barrier_id,digest FROM codex_guardian_tree_receipts WHERE receipt_id=${scope.oldTreeReceiptId}::uuid`;
    requireValue(tree);
    const barrier = await tx.codexGuardianBarrier.findUniqueOrThrow({
      where: { id: scope.oldBarrierId },
    });
    requireValue(
      runtime.ownerId === binding.ownerId &&
        runtime.workspaceId === binding.workspaceId &&
        runtime.buildId === binding.buildId &&
        runtime.serverInstanceId === previous &&
        runtime.phase === "tree_closed" &&
        runtime.closedBarrierId === barrier.id &&
        barrier.ownerId === binding.ownerId &&
        barrier.runtimeId === runtime.id &&
        barrier.purpose === "account-maintenance" &&
        barrier.maintenanceId === scope.maintenanceId &&
        tree.owner_id === binding.ownerId &&
        tree.runtime_id === runtime.id &&
        tree.barrier_id === barrier.id &&
        tree.digest === scope.oldTreeReceiptDigest,
    );
    actors.set(previous, true);
    requireValue(!actors.has(scope.newServerInstanceId));
    actors.set(scope.newServerInstanceId, false);
    previous = scope.newServerInstanceId;
  }
  return actors;
}

/** A closed historical actor contributes provenance only. Its own successful
 * native observation is still required; closure cannot manufacture a result. */
export async function requireHistoricalExecutionComplete(
  tx: Tx,
  binding: DeliveryManagerBinding,
  actors: Map<string, boolean>,
  member: Prisma.DeliveryAttemptGetPayload<Record<string, never>>,
  observed: Prisma.DeliveryEventGetPayload<Record<string, never>> | null,
) {
  const runtime = nativeRuntimeBindingSchema.parse(member.runtimeBinding);
  const fact = observed?.payload as {
    producer?: unknown;
    nativeSourceKind?: unknown;
    turnStatus?: unknown;
    bindingDigest?: unknown;
    source?: {
      parentTurnId?: unknown;
      spawnCallId?: unknown;
      childThreadId?: unknown;
      childTurnId?: unknown;
    };
  } | null;
  const claimed = await tx.deliveryEvent.findFirst({
    where: { ownerId: binding.ownerId, attemptId: member.id, type: "attempt_started" },
  });
  const claim = (
    claimed?.payload as {
      nativeClaim?: { managerThreadId?: unknown; parentTurnId?: unknown };
    } | null
  )?.nativeClaim;
  requireValue(
    actors.get(runtime.serverInstanceId) === true &&
      typeof member.effectiveModel === "string" &&
      member.effectiveModel.length > 0 &&
      member.effectiveModel.length <= 160 &&
      typeof member.effectiveEffort === "string" &&
      member.effectiveEffort.length > 0 &&
      member.effectiveEffort.length <= 40 &&
      ["reported", "succeeded"].includes(member.outcome) &&
      member.ownerId === binding.ownerId &&
      member.managerBindingId === binding.id &&
      runtime.workspaceId === binding.workspaceId &&
      runtime.buildId === binding.buildId &&
      runtime.managerThreadId === binding.nativeThreadId &&
      observed?.ownerId === binding.ownerId &&
      observed.attemptId === member.id &&
      observed.type === "native_attempt_observed" &&
      fact?.producer === NATIVE_OBSERVER_PRODUCER &&
      fact.nativeSourceKind === "turn_completed" &&
      fact.turnStatus === "completed" &&
      fact.bindingDigest === member.runtimeBindingDigest &&
      fact.source?.spawnCallId === runtime.operationId &&
      fact.source.childThreadId === runtime.nativeThreadId &&
      fact.source.childTurnId === runtime.nativeTurnId &&
      claim?.managerThreadId === binding.nativeThreadId &&
      claim.parentTurnId === fact.source.parentTurnId,
  );
}
