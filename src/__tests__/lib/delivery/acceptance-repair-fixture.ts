import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { GuardianSourceApplicationStore } from "@/lib/codex-session/guardian-application-store.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import type { SourceContext } from "@/lib/delivery/contracts";
import type { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
// Explicit synthetic foreground/barrier authority. Actual protected metadata
// application is separately exercised by the installed composition fixture.
export async function repairApplicationFixture(
  db: PrismaClient,
  f: Awaited<ReturnType<typeof acceptanceCandidateFixture>>,
  previousSourceContext: SourceContext | null = null,
) {
  const { claim } = f,
    operationId = f.publication.operationId;
  const revision = await db.deliverySourceRevision.findFirstOrThrow({
    where: { ownerId: f.user.id, operationId },
  });
  const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
    where: { id: claim.managerBindingId },
  });
  const accepted = {
    sourceContext: {
      revisionId: revision.id,
      version: revision.version,
      headSha: revision.headSha,
    },
  };
  const store = new GuardianSourceApplicationStore(db, {
    policy: f.guardian.policy,
    expectedRuntime: {
      id: f.guardian.runtime.id,
      generation: f.guardian.finalized.runtime.generation,
    },
  });
  function reservation() {
    const observedAt = new Date(Date.now() - 1).toISOString();
    return {
      projectId: f.project.id,
      applicationId: randomUUID(),
      publicationOperationId: operationId,
      expectedAppliedSourceContext: previousSourceContext,
      targetSourceContext: accepted.sourceContext,
      idleSnapshot: {
        projectId: f.project.id,
        admissionId: f.guardian.finalized.admission.id,
        admissionGeneration: f.guardian.finalized.admission.generation,
        managerBindingId: claim.managerBindingId,
        currentAttemptId: claim.attemptId,
        managerThreadId: f.managerThreadId,
        parentTurnId: f.parentTurnId,
        cursorVersion: binding.cursorVersion,
        nativeSequence: binding.nativeSequence,
        observedAt,
        historyDigest: "1".repeat(64),
        loadedInventoryDigest: "2".repeat(64),
        fullHistory: true,
        rootTurns: binding.cursorVersion,
        historyBytes: 100,
        pendingHandlers: 0,
        pendingObservers: 0,
        unknownFacts: 0,
        activeRoots: 0,
      },
      inputBarrier: {
        id: randomUUID(),
        generation: 1,
        projectId: f.project.id,
        observedAt,
        closed: true,
        rootCompleted: true,
        controllerJournalDigest: "3".repeat(64),
        supervisorJournalDigest: "4".repeat(64),
        commandInventoryDigest: "5".repeat(64),
        terminalInventoryDigest: "6".repeat(64),
        sourceSpoolDigest: "7".repeat(64),
        pendingCommands: 0,
        activeCli: 0,
        pendingInputs: 0,
        unknownInputs: 0,
      },
    };
  }
  function receipt(value: ReturnType<typeof reservation>) {
    return {
      schemaVersion: 1,
      applicationId: value.applicationId,
      publicationOperationId: operationId,
      sourceContext: accepted.sourceContext,
      previousSourceContext,
      inputBarrierId: value.inputBarrier.id,
      inputBarrierDigest: guardianDigest(value.inputBarrier),
      metadataPinsDigest: f.guardian.finalized.admission.metadataPinsDigest,
      namespaceReceiptDigest: f.guardian.metadata.namespaceReceiptDigest,
      managedReceiptDigest: "1".repeat(64),
      sourceOperationDigest: "2".repeat(64),
      controllerJournalDigest: "3".repeat(64),
      supervisorJournalDigest: "4".repeat(64),
      appliedHeadSha: accepted.sourceContext.headSha,
      appliedIndexDigest: "5".repeat(64),
      sourceUpdating: false,
      controllerSourceContext: accepted.sourceContext,
      supervisorSourceContext: accepted.sourceContext,
      observedAt: new Date(Date.now() - 1).toISOString(),
    };
  }
  return { store, reservation, receipt, accepted };
}
