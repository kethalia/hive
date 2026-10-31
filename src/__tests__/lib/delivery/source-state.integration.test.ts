import { createHash, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GuardianSourceApplicationStore } from "@/lib/codex-session/guardian-application-store.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { lockProducerAdmission } from "@/lib/codex-session/guardian-store.server";
import { PrismaRegistrationStore } from "@/lib/codex-session/registration-store.server";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import {
  DeliverySourcePublicationService,
  sourcePublicationSchema,
} from "@/lib/delivery/source-publication.server";
import { DeliverySourceStateService } from "@/lib/delivery/source-state.server";
import { sourceStateProofPayload } from "@/lib/delivery/source-state-contracts";
import { guardianFixture } from "../codex-session/guardian-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
const claimSchema = z.object({
  attemptId: z.string(),
  leaseGeneration: z.number(),
  version: z.number(),
  managerBindingId: z.string(),
  nativeSequence: z.number(),
});
async function fixture() {
  const f = await guardianFixture(db),
    nextStep = randomUUID();
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_APPROVED_PACKAGES_JSON", JSON.stringify(f.guardian.policy.packages));
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
          {
            id: nextStep,
            kind: "implement",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
        ],
        dependencies: [{ stepId: nextStep, dependsOnStepId: f.stepId }],
      },
    }),
  );
  const first = claimSchema.parse(
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
      first,
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
    f.sourceEnvelope(first, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
  );
  // Explicit internal producer fixture seeds legitimate immutable source records.
  // This does not stand in for real provider transport/installed broker proof.
  const publisher = new DeliverySourcePublicationService(db, {
    reauthorize: f.dependencies.reauthorize,
    authority: {
      verify: async (publication) => ({
        publication,
        proofDigest: githubSourceDigest(publication),
      }),
      lockTransaction: async (tx) => {
        await lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy);
      },
      authorizeTransaction: async (tx) => {
        await lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy);
      },
    },
  });
  const reader = new DeliverySourceStateService(db, {
    reauthorize: f.dependencies.reauthorize,
    guardianPolicy: f.guardian.policy,
  });
  async function publish(
    attempt = first,
    stepId = f.stepId,
    sourceContext?: { revisionId: string; version: number; headSha: string },
    head = "b".repeat(40),
    ttl = 30000,
  ) {
    const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: first.managerBindingId },
      }),
      operationId = randomUUID(),
      now = Date.now();
    const publication = sourcePublicationSchema.parse({
      schemaVersion: 1,
      operationId,
      ownerId: f.user.id,
      taskId: f.taskId,
      stepId,
      attemptId: attempt.attemptId,
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      ...(sourceContext ? { sourceContext } : {}),
      expectedSourceVersion: sourceContext?.version ?? 0,
      expectedRevisionId: sourceContext?.revisionId ?? null,
      expectedCursorVersion: binding.cursorVersion,
      expectedNativeSequence: binding.nativeSequence,
      leaseGeneration: attempt.leaseGeneration,
      parentSha: sourceContext?.headSha ?? f.context.revision,
      headSha: head,
      treeSha: "d".repeat(40),
      manifestDigest: "e".repeat(64),
      repositoryId: f.project.providerRepositoryId,
      providerAccountId: f.project.providerAccountId,
      fullName: f.project.fullName,
      branch: `codex/delivery/${f.taskId}/${operationId}`,
      baseBranch: "main",
      pullRequestId: "900",
      pullNumber: 7,
      issuedAt: now - 1,
      expiresAt: now + ttl,
    });
    return { publication, result: await publisher.accept(publication) };
  }
  function request(operationId: string, extra: Record<string, unknown> = {}) {
    const value = {
      schemaVersion: 1,
      action: "read_source_state",
      requestId: randomUUID(),
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      taskId: f.taskId,
      operationId,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      ...extra,
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(sourceStateProofPayload(value)), f.keys.privateKey).toString(
        "base64url",
      ),
    };
  }
  async function complete(
    attempt: z.infer<typeof claimSchema>,
    stepId: string,
    sourceContext: { revisionId: string; version: number; headSha: string },
    turnId = f.parentTurnId,
  ) {
    const evidenceId = randomUUID();
    await new DeliveryRepository(db, f.policy).recordEvidence(f.user.id, "fixture-ci", {
      id: evidenceId,
      stepId: stepId,
      remoteId: randomUUID(),
      kind: "check",
      status: "passed",
      verificationMode: "simulated",
      environment: "read-state-fixture",
      sourceSha: sourceContext.headSha,
      criterionIds: ["C1"],
      objectKey: `delivery/${f.user.id}/fixture/check.json`,
      contentDigest: "f".repeat(64),
      observedAt: new Date(),
    });
    await manager.execute(
      f.managerEnvelope(
        {
          operation: "complete_step",
          payload: {
            taskId: f.taskId,
            stepId: stepId,
            attemptId: attempt.attemptId,
            leaseGeneration: attempt.leaseGeneration,
            expectedVersion: attempt.version,
            sourceSha: sourceContext.headSha,
            evidenceIds: [evidenceId],
            report: {
              summary: "Synthetic read-state source",
              difficulty: "low",
              difficultyReason: "Local storage fixture",
              issues: [],
              remainingUncertainty: "No real provider/native proof",
              nextAction: "Review",
            },
          },
        },
        { sourceContext, nativeTurnId: turnId },
      ),
    );
  }
  async function second(firstPublication: Awaited<ReturnType<typeof publish>>) {
    const sourceContext = firstPublication.result.sourceContext;
    await complete(first, f.stepId, sourceContext);
    // A synthetic closed input barrier/outer receipt is explicit fixture data.
    // The real application store must ACK B before this test can start C.
    const application = new GuardianSourceApplicationStore(db, {
      policy: f.guardian.policy,
      expectedRuntime: {
        id: f.guardian.runtime.id,
        generation: f.guardian.finalized.runtime.generation,
      },
    });
    const observedAt = new Date(Date.now() - 1).toISOString(),
      applicationId = randomUUID();
    const inputBarrier = {
      id: randomUUID(),
      generation: 1,
      projectId: f.project.id,
      observedAt,
      closed: true,
      rootCompleted: true,
      controllerJournalDigest: "1".repeat(64),
      supervisorJournalDigest: "2".repeat(64),
      commandInventoryDigest: "3".repeat(64),
      terminalInventoryDigest: "4".repeat(64),
      sourceSpoolDigest: "5".repeat(64),
      pendingCommands: 0,
      activeCli: 0,
      pendingInputs: 0,
      unknownInputs: 0,
    };
    await application.reserve(f.guardian.scope, {
      projectId: f.project.id,
      applicationId,
      publicationOperationId: firstPublication.publication.operationId,
      expectedAppliedSourceContext: null,
      targetSourceContext: sourceContext,
      inputBarrier,
      idleSnapshot: {
        projectId: f.project.id,
        admissionId: f.guardian.finalized.admission.id,
        admissionGeneration: f.guardian.finalized.admission.generation,
        managerBindingId: first.managerBindingId,
        currentAttemptId: first.attemptId,
        managerThreadId: f.managerThreadId,
        parentTurnId: f.parentTurnId,
        cursorVersion: 1,
        nativeSequence: 2,
        observedAt,
        historyDigest: "6".repeat(64),
        loadedInventoryDigest: "7".repeat(64),
        fullHistory: true,
        rootTurns: 1,
        historyBytes: 100,
        pendingHandlers: 0,
        pendingObservers: 0,
        unknownFacts: 0,
        activeRoots: 0,
      },
    });
    await application.commit(f.guardian.scope, applicationId, {
      schemaVersion: 1,
      applicationId,
      publicationOperationId: firstPublication.publication.operationId,
      sourceContext,
      previousSourceContext: null,
      inputBarrierId: inputBarrier.id,
      inputBarrierDigest: guardianDigest(inputBarrier),
      metadataPinsDigest: f.guardian.finalized.admission.metadataPinsDigest,
      namespaceReceiptDigest: f.guardian.metadata.namespaceReceiptDigest,
      managedReceiptDigest: "8".repeat(64),
      sourceOperationDigest: "9".repeat(64),
      controllerJournalDigest: "a".repeat(64),
      supervisorJournalDigest: "b".repeat(64),
      appliedHeadSha: sourceContext.headSha,
      appliedIndexDigest: "c".repeat(64),
      sourceUpdating: false,
      controllerSourceContext: sourceContext,
      supervisorSourceContext: sourceContext,
      observedAt,
    });

    const nextTurn = randomUUID(),
      boundary = f.sourceEnvelope(
        first,
        {
          kind: "root_boundary",
          parentTurnId: f.parentTurnId,
          nextParentTurnId: nextTurn,
          cursorVersion: 1,
          observedAt: new Date(Date.now() - 100).toISOString(),
        },
        3,
        { sourceContext },
      );
    await f.native.ingest(boundary);
    const claim = claimSchema.parse(
      await manager.execute(
        f.managerEnvelope(
          {
            operation: "claim_step",
            payload: {
              taskId: f.taskId,
              stepId: nextStep,
              expectedVersion: 0,
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
            },
          },
          {
            sourceContext,
            nativeTurnId: nextTurn,
            continuation: {
              boundaryEventId: boundary.eventId,
              priorAttemptId: first.attemptId,
              parentTurnId: f.parentTurnId,
              nextParentTurnId: nextTurn,
              cursorVersion: 1,
              sequence: 3,
            },
          },
        ),
      ),
    );
    const common = {
      ...f.source,
      parentTurnId: nextTurn,
      childThreadId: randomUUID(),
      childTurnId: randomUUID(),
      spawnCallId: randomUUID(),
      observedAt: new Date(Date.now() - 100).toISOString(),
    };
    await f.native.ingest(
      f.sourceEnvelope(
        claim,
        {
          ...common,
          kind: "started",
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
          effectiveModel: "gpt-6.1-sol",
          effectiveEffort: "low",
        },
        4,
        { stepId: nextStep, sourceContext },
      ),
    );
    await f.native.ingest(
      f.sourceEnvelope(claim, { ...common, kind: "turn_completed", status: "completed" }, 5, {
        stepId: nextStep,
        sourceContext,
      }),
    );
    return {
      ...(await publish(claim, nextStep, sourceContext, "c".repeat(40))),
      claim,
      parentTurnId: nextTurn,
    };
  }
  return { ...f, first, nextStep, reader, publisher, publish, request, second, complete };
}
async function digestRows(ownerId: string) {
  const rows = await Promise.all([
    db.deliveryTask.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.deliveryStep.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.deliveryAttempt.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.deliverySourceRevision.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.deliveryEvent.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.deliveryOutbox.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.codexGuardianRuntime.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.codexGuardianAdmission.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
    db.deliverySourceApplication.findMany({ where: { ownerId }, orderBy: { id: "asc" } }),
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
describe.skipIf(!url)(
  "fresh accepted-source state (real local guardian/store, synthetic source/native fixtures)",
  () => {
    it("reads accepted source after original publication wire expiry with no data writes or new authority", async () => {
      const f = await fixture(),
        published = await f.publish(undefined, undefined, undefined, undefined, 1000);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await expect(f.publisher.accept(published.publication)).rejects.toThrow();
      const before = await digestRows(f.user.id),
        input = f.request(published.publication.operationId),
        result = await f.reader.read(input);
      expect(result).toMatchObject({
        requestId: input.requestId,
        isCurrent: true,
        publicationAuthorized: false,
        executionAuthorized: false,
        accepted: { sourceContext: published.result.sourceContext, parentSha: f.context.revision },
        current: { physicalBase: f.context.revision, headSha: "b".repeat(40), version: 1 },
      });
      expect(result.expiresAt - result.observedAt).toBeLessThanOrEqual(30000);
      expect(result.metadata.pins).toEqual(f.guardian.metadata.pins);
      expect(result.admission.checkoutIncarnation).toBe(f.guardian.checkout.checkoutIncarnation);
      expect(await digestRows(f.user.id)).toBe(before);
    });
    it("rejects foreign owner/task/operation/revision/physical scope", async () => {
      const f = await fixture(),
        published = await f.publish(),
        other = await fixture(),
        foreign = await other.publish();
      await expect(f.reader.read(f.request(foreign.publication.operationId))).rejects.toMatchObject(
        { code: "source_state_not_found" },
      );
      await expect(
        f.reader.read(
          f.request(published.publication.operationId, {
            revisionId: foreign.result.sourceContext.revisionId,
          }),
        ),
      ).rejects.toMatchObject({ code: "source_revision_scope_mismatch" });
      await expect(
        f.reader.read(f.request(published.publication.operationId, { taskId: other.taskId })),
      ).rejects.toThrow();
      await expect(
        f.reader.read(
          f.request(published.publication.operationId, {
            checkoutBinding: { ...f.context, leaseId: randomUUID() },
          }),
        ),
      ).rejects.toThrow();
    });
    it("requires current independent producer authorization even for historical reads", async () => {
      const f = await fixture(),
        published = await f.publish();
      await db.codexGuardianRuntime.update({
        where: { id: f.guardian.runtime.id },
        data: { producerApproved: false },
      });
      await expect(f.reader.read(f.request(published.publication.operationId))).rejects.toThrow();
      vi.stubEnv("HIVE_GUARDIAN_ENABLED", "");
      const defaultReader = new DeliverySourceStateService(db, {
        reauthorize: f.dependencies.reauthorize,
      });
      await expect(
        defaultReader.read(f.request(published.publication.operationId)),
      ).rejects.toThrow();
      expect(
        (
          await db.deliveryManagerBinding.findUniqueOrThrow({
            where: { id: f.first.managerBindingId },
          })
        ).activeAttemptId,
      ).toBe(f.first.attemptId);
    });
    it("distinguishes first historical output from second current output without relabeling or rollback", async () => {
      const f = await fixture(),
        a = await f.publish(),
        b = await f.second(a),
        before = await digestRows(f.user.id),
        old = await f.reader.read(f.request(a.publication.operationId)),
        current = await f.reader.read(
          f.request(b.publication.operationId, { revisionId: b.result.sourceContext.revisionId }),
        );
      expect(old).toMatchObject({
        isCurrent: false,
        accepted: { sourceContext: a.result.sourceContext },
        current: { sourceContext: b.result.sourceContext, physicalBase: f.context.revision },
      });
      expect(current).toMatchObject({
        isCurrent: true,
        accepted: {
          sourceContext: b.result.sourceContext,
          previousRevisionId: a.result.sourceContext.revisionId,
          parentSha: a.result.sourceContext.headSha,
        },
      });
      expect(await digestRows(f.user.id)).toBe(before);
    });
    it("closed barrier remains closed for factual reads even after feature flags turn off", async () => {
      const f = await fixture(),
        a = await f.publish(),
        b = await f.second(a);
      await f.complete(b.claim, f.nextStep, b.result.sourceContext, b.parentTurnId);
      await f.guardian.store.closeBarrier({
        ownerId: f.user.id,
        runtimeId: f.guardian.runtime.id,
        runtimeGeneration: 2,
        barrierId: randomUUID(),
        ownershipDigest: "a".repeat(64),
        projectBindings: [
          {
            projectId: f.project.id,
            bindingDigest: f.guardian.prepared.admission.preparationDigest,
          },
        ],
        snapshots: [
          {
            projectId: f.project.id,
            admissionId: f.guardian.bound.admission.id,
            admissionGeneration: 3,
            managerBindingId: f.first.managerBindingId,
            currentAttemptId: b.claim.attemptId,
            managerThreadId: f.managerThreadId,
            parentTurnId: b.parentTurnId,
            cursorVersion: 2,
            nativeSequence: 5,
            observedAt: new Date(Date.now() - 100).toISOString(),
            historyDigest: "b".repeat(64),
            loadedInventoryDigest: "c".repeat(64),
            fullHistory: true,
            rootTurns: 2,
            historyBytes: 100,
            pendingHandlers: 0,
            pendingObservers: 0,
            unknownFacts: 0,
            activeRoots: 0,
          },
        ],
      });
      await expect(f.reader.read(f.request(a.publication.operationId))).rejects.toThrow();
      vi.stubEnv("HIVE_GUARDIAN_ENABLED", "");
      vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "");
      await expect(
        new DeliverySourceStateService(db, { reauthorize: f.dependencies.reauthorize }).read(
          f.request(b.publication.operationId),
        ),
      ).rejects.toThrow();
      expect(
        (
          await db.deliveryManagerBinding.findUniqueOrThrow({
            where: { id: f.first.managerBindingId },
          })
        ).activeAttemptId,
      ).toBe(f.first.attemptId);
    });
    it.skipIf(process.env.HIVE_SOURCE_FULL_EXPIRY_PROOF !== "true")(
      "actual61s recovery outlives original publication authority with real registration heartbeat",
      async () => {
        const f = await fixture(),
          published = await f.publish(undefined, undefined, undefined, undefined, 59000),
          store = new PrismaRegistrationStore(db),
          start = Date.now();
        const renew = async () => {
          const row = await db.codexHostRegistration.findUniqueOrThrow({
            where: { id: f.registration().id },
          });
          await store.renew({
            ownerId: f.user.id,
            registrationId: row.id,
            sequence: row.heartbeatSequence + 1,
            nonce: row.heartbeatNonce,
            serverInstanceId: f.serverInstanceId,
            binding: f.host,
          });
        };
        await new Promise((resolve) => setTimeout(resolve, 20000));
        await renew();
        await new Promise((resolve) => setTimeout(resolve, 20000));
        await renew();
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, start + 61000 - Date.now())),
        );
        expect(Date.now()).toBeGreaterThan(published.publication.expiresAt);
        await expect(f.publisher.accept(published.publication)).rejects.toThrow();
        const before = await digestRows(f.user.id),
          result = await f.reader.read(f.request(published.publication.operationId));
        expect(result.isCurrent).toBe(true);
        expect(result.accepted.sourceContext).toEqual(published.result.sourceContext);
        expect(result.publicationAuthorized).toBe(false);
        expect(result.executionAuthorized).toBe(false);
        expect(await digestRows(f.user.id)).toBe(before);
      },
      75000,
    );
  },
);
