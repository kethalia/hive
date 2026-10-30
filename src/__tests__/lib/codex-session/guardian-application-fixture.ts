import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { GuardianSourceApplicationStore } from "@/lib/codex-session/guardian-application-store.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import { guardianFixture } from "./guardian-fixture";

/** Actual local guardian/manager/source persistence. Publication verification is
 * an explicit injected fixture authority, never real GitHub/broker approval. */
export async function guardianApplicationFixture(
  db: PrismaClient,
  setPolicy: (policy: unknown) => void,
  material?: {
    guardian: Parameters<typeof guardianFixture>[1];
    operationId: string;
    headSha: string;
    treeSha: string;
    manifestDigest: string;
  },
) {
  const f = await guardianFixture(db, { workspaceEnrollment: true, ...material?.guardian });
  setPolicy(f.guardian.policy);
  const manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
  await manager.execute(
    f.managerEnvelope({
      operation: "create_task",
      payload: {
        ...f.definition,
        steps: [
          {
            id: f.stepId,
            kind: "implement",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
        ],
      },
    }),
  );
  const claim = z
    .object({
      attemptId: z.string(),
      managerBindingId: z.string(),
      leaseGeneration: z.number(),
      version: z.number(),
      nativeSequence: z.number(),
    })
    .parse(
      await manager.execute(
        f.managerEnvelope({
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            expectedVersion: 0,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        }),
      ),
    );
  await f.native.ingest(
    f.sourceEnvelope(
      claim,
      {
        ...f.source,
        kind: "started",
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
      1,
    ),
  );
  await f.native.ingest(
    f.sourceEnvelope(claim, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
  );
  const operationId = material?.operationId ?? randomUUID(),
    publication = {
      schemaVersion: 1,
      operationId,
      ownerId: f.user.id,
      taskId: f.taskId,
      stepId: f.stepId,
      attemptId: claim.attemptId,
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      expectedSourceVersion: 0,
      expectedRevisionId: null,
      expectedCursorVersion: 1,
      expectedNativeSequence: 2,
      leaseGeneration: claim.leaseGeneration,
      parentSha: f.context.revision,
      headSha: material?.headSha ?? "b".repeat(40),
      treeSha: material?.treeSha ?? "d".repeat(40),
      manifestDigest: material?.manifestDigest ?? "e".repeat(64),
      repositoryId: f.project.providerRepositoryId,
      providerAccountId: f.project.providerAccountId,
      fullName: f.project.fullName,
      branch: `codex/delivery/${f.taskId}/${operationId}`,
      baseBranch: "main",
      pullRequestId: "900",
      pullNumber: 7,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
    };
  const publisher = new DeliverySourcePublicationService(db, {
    reauthorize: f.dependencies.reauthorize,
    authority: {
      verify: async () => ({ publication, proofDigest: guardianDigest(publication) }),
      authorizeTransaction: async () => {},
    },
  });
  const accepted = z
    .object({
      sourceContext: z.object({
        revisionId: z.string().uuid(),
        version: z.number(),
        headSha: z.string(),
      }),
    })
    .parse(await publisher.accept({ explicitTrustedFixture: true }));
  const evidenceId = randomUUID();
  await new DeliveryRepository(db, f.policy).recordEvidence(f.user.id, "fixture-ci", {
    id: evidenceId,
    stepId: f.stepId,
    remoteId: randomUUID(),
    kind: "check",
    status: "passed",
    verificationMode: "simulated",
    environment: "source-application-fixture",
    sourceSha: accepted.sourceContext.headSha,
    criterionIds: ["C1"],
    objectKey: `delivery/${f.user.id}/fixture/check.json`,
    contentDigest: "f".repeat(64),
    observedAt: new Date(Date.now() - 100),
  });
  await manager.execute(
    f.managerEnvelope(
      {
        operation: "complete_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: claim.attemptId,
          leaseGeneration: claim.leaseGeneration,
          expectedVersion: claim.version,
          sourceSha: accepted.sourceContext.headSha,
          evidenceIds: [evidenceId],
          report: {
            summary: "Application fixture",
            difficulty: "low",
            difficultyReason: "Local persistence test",
            issues: [],
            remainingUncertainty: "No actual host metadata write",
            nextAction: "Retain physical hold",
          },
        },
      },
      { sourceContext: accepted.sourceContext },
    ),
  );
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
      expectedAppliedSourceContext: null,
      targetSourceContext: accepted.sourceContext,
      idleSnapshot: {
        projectId: f.project.id,
        admissionId: f.guardian.finalized.admission.id,
        admissionGeneration: f.guardian.finalized.admission.generation,
        managerBindingId: claim.managerBindingId,
        currentAttemptId: claim.attemptId,
        managerThreadId: f.managerThreadId,
        parentTurnId: f.parentTurnId,
        cursorVersion: 1,
        nativeSequence: 2,
        observedAt,
        historyDigest: "1".repeat(64),
        loadedInventoryDigest: "2".repeat(64),
        fullHistory: true,
        rootTurns: 1,
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
      previousSourceContext: null,
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
  return { ...f, manager, claim, accepted, operationId, store, reservation, receipt };
}
