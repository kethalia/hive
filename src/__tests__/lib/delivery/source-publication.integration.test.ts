import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveControllerGitHubManagerPolicy } from "@/lib/delivery/github-policy.server";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryOutbox } from "@/lib/delivery/outbox";
import { readDeliveryTask } from "@/lib/delivery/reads";
import { DeliveryRepository } from "@/lib/delivery/repository";
import {
  DeliverySourcePublicationService,
  type SourcePublication,
  sourcePublicationSchema,
} from "@/lib/delivery/source-publication.server";
import { resolveAttemptSource, resolveTaskSource } from "@/lib/delivery/source-resolver.server";
import { githubFixture } from "./github-fixture";
import { nativeFixture } from "./native-fixture";

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
const claimSchema = z.object({
  attemptId: z.string(),
  managerBindingId: z.string(),
  leaseGeneration: z.number(),
  version: z.number(),
  nativeSequence: z.number(),
});
const report = {
  summary: "Synthetic published-source result",
  difficulty: "low",
  difficultyReason: "Local authority fixture",
  issues: [],
  remainingUncertainty: "Not real broker/provider/native admission evidence",
  nextAction: "Review independent checks",
};
const publicationProof = (value: unknown) =>
  `hive-source-publication-fixture-v1\n${JSON.stringify(value)}`;

async function fixture(nativeComplete = true) {
  const f = await nativeFixture(db),
    nextStep = randomUUID(),
    finalStep = randomUUID();
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
          {
            id: finalStep,
            kind: "validate",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
        ],
        dependencies: [
          { stepId: nextStep, dependsOnStepId: f.stepId },
          { stepId: finalStep, dependsOnStepId: nextStep },
        ],
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
  if (nativeComplete)
    await f.native.ingest(
      f.sourceEnvelope(first, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
    );
  const producer = generateKeyPairSync("ed25519");
  let revoked = false,
    hook = async (_tx: Prisma.TransactionClient) => {};
  const authority = {
    async verify(receipt: unknown) {
      const value = z
        .object({ publication: sourcePublicationSchema, signature: z.string() })
        .strict()
        .parse(receipt);
      if (
        !verify(
          null,
          Buffer.from(publicationProof(value.publication)),
          producer.publicKey,
          Buffer.from(value.signature, "base64url"),
        )
      )
        throw new Error("Untrusted publication proof");
      return {
        publication: value.publication,
        proofDigest: createHash("sha256").update(publicationProof(value.publication)).digest("hex"),
      };
    },
    async authorizeTransaction(tx: Prisma.TransactionClient) {
      if (revoked) throw new Error("Producer revoked");
      await hook(tx);
    },
  };
  const service = new DeliverySourcePublicationService(db, {
    reauthorize: f.dependencies.reauthorize,
    authority,
  });
  function signed(input: SourcePublication) {
    return {
      publication: input,
      signature: sign(null, Buffer.from(publicationProof(input)), producer.privateKey).toString(
        "base64url",
      ),
    };
  }
  function publication(overrides: Partial<SourcePublication> = {}) {
    const operationId = overrides.operationId ?? randomUUID();
    return sourcePublicationSchema.parse({
      schemaVersion: 1,
      operationId,
      ownerId: f.user.id,
      taskId: f.taskId,
      stepId: f.stepId,
      attemptId: first.attemptId,
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      expectedSourceVersion: 0,
      expectedRevisionId: null,
      expectedCursorVersion: 1,
      expectedNativeSequence: 2,
      leaseGeneration: first.leaseGeneration,
      parentSha: f.context.revision,
      headSha: "b".repeat(40),
      treeSha: "d".repeat(40),
      manifestDigest: "e".repeat(64),
      repositoryId: f.project.providerRepositoryId,
      providerAccountId: f.project.providerAccountId,
      fullName: f.project.fullName,
      branch: `codex/delivery/${f.taskId}/${operationId}`,
      baseBranch: "main",
      pullRequestId: "900",
      pullNumber: 7,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      ...overrides,
    });
  }
  async function evidence(stepId: string, head: string, kind: "check" | "review" = "check") {
    const id = randomUUID();
    await new DeliveryRepository(db, f.policy).recordEvidence(f.user.id, "fixture-ci", {
      id,
      stepId,
      remoteId: randomUUID(),
      kind,
      status: "passed",
      verificationMode: "simulated",
      environment: "source-publication-fixture",
      sourceSha: head,
      criterionIds: ["C1"],
      objectKey: `delivery/${f.user.id}/fixture/check.json`,
      contentDigest: "f".repeat(64),
      observedAt: new Date(Date.now() - 100),
    });
    return id;
  }
  async function complete(
    attempt: z.infer<typeof claimSchema>,
    stepId: string,
    head: string,
    sourceContext: unknown,
    turn = f.parentTurnId,
  ) {
    const id = await evidence(stepId, head);
    return z.object({ reportId: z.string().uuid() }).parse(
      await manager.execute(
        f.managerEnvelope(
          {
            operation: "complete_step",
            payload: {
              taskId: f.taskId,
              stepId,
              attemptId: attempt.attemptId,
              leaseGeneration: attempt.leaseGeneration,
              expectedVersion: attempt.version,
              sourceSha: head,
              evidenceIds: [id],
              report,
            },
          },
          { sourceContext, nativeTurnId: turn },
        ),
      ),
    );
  }
  return {
    ...f,
    nextStep,
    finalStep,
    first,
    manager,
    producer,
    authority,
    service,
    signed,
    publication,
    evidence,
    complete,
    revoke: () => {
      revoked = true;
    },
    setHook: (value: typeof hook) => {
      hook = value;
    },
  };
}

describe.skipIf(!url)("internal source revision acceptance, synthetic independent producer", () => {
  it("replays immutable input facts after accepted output, but blocks novel post-publication input", async () => {
    const f = await fixture(),
      terminal = await db.deliveryEvent.findFirstOrThrow({
        where: {
          ownerId: f.user.id,
          attemptId: f.first.attemptId,
          type: "native_attempt_observed",
          payload: { path: ["nativeSourceKind"], equals: "turn_completed" },
        },
      });
    const receipt = await f.service.accept(f.signed(f.publication()));
    const original = f.sourceEnvelope(
      f.first,
      { ...f.source, kind: "turn_completed", status: "completed" },
      2,
      { eventId: terminal.id },
    );
    await expect(f.native.ingest(original)).resolves.toMatchObject({
      replayed: true,
      accepted: true,
      blocked: false,
    });
    await expect(
      f.native.ingest(
        f.sourceEnvelope(f.first, { ...f.source, kind: "turn_completed", status: "completed" }, 3, {
          sourceContext: { ...receipt.sourceContext, revisionId: randomUUID() },
        }),
      ),
    ).rejects.toThrow("source_context_stale");
    await expect(
      f.native.ingest(
        f.sourceEnvelope(f.first, { ...f.source, kind: "turn_completed", status: "completed" }, 3),
      ),
    ).resolves.toMatchObject({ blocked: true, accepted: false });
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.first.managerBindingId },
        })
      ).blockedReason,
    ).toBe("native_input_after_publication");
  });
  it("accepts output under the same writer, verifies output evidence and advances a second immutable source link", async () => {
    const f = await fixture(),
      oldEvidence = await f.evidence(f.stepId, f.context.revision),
      p = f.publication();
    const a = await f.service.accept(f.signed(p));
    expect(a).toMatchObject({
      sourceContext: { version: 1, headSha: p.headSha },
      inputSourceSha: f.context.revision,
      replayed: false,
      executionAuthorized: false,
    });
    expect(
      await db.deliveryEvidence.findUniqueOrThrow({ where: { id: oldEvidence } }),
    ).toMatchObject({ invalidatedAt: expect.any(Date) });
    const input = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.first.attemptId } });
    expect(input).toMatchObject({
      sourceSha: f.context.revision,
      outputRevisionId: a.sourceContext.revisionId,
      outcome: "running",
      quiescedAt: null,
    });
    expect(input.runtimeBinding).toMatchObject({ sourceSha: f.context.revision });
    await expect(
      f.manager.execute(
        f.managerEnvelope(
          {
            operation: "complete_step",
            payload: {
              taskId: f.taskId,
              stepId: f.stepId,
              attemptId: f.first.attemptId,
              leaseGeneration: f.first.leaseGeneration,
              expectedVersion: f.first.version,
              sourceSha: p.headSha,
              evidenceIds: [oldEvidence],
              report,
            },
          },
          { sourceContext: a.sourceContext },
        ),
      ),
    ).rejects.toThrow("invalid_evidence");
    const firstReport = await f.complete(f.first, f.stepId, p.headSha, a.sourceContext);
    const nextTurn = randomUUID(),
      boundary = f.sourceEnvelope(
        f.first,
        {
          kind: "root_boundary",
          parentTurnId: f.parentTurnId,
          nextParentTurnId: nextTurn,
          cursorVersion: 1,
          observedAt: new Date(Date.now() - 100).toISOString(),
        },
        3,
        { sourceContext: a.sourceContext },
      );
    await f.native.ingest(boundary);
    const second = claimSchema.parse(
      await f.manager.execute(
        f.managerEnvelope(
          {
            operation: "claim_step",
            payload: {
              taskId: f.taskId,
              stepId: f.nextStep,
              expectedVersion: 0,
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
            },
          },
          {
            nativeTurnId: nextTurn,
            sourceContext: a.sourceContext,
            continuation: {
              boundaryEventId: boundary.eventId,
              priorAttemptId: f.first.attemptId,
              cursorVersion: 1,
              parentTurnId: f.parentTurnId,
              nextParentTurnId: nextTurn,
              sequence: 3,
            },
          },
        ),
      ),
    );
    expect(
      await db.deliveryAttempt.findUniqueOrThrow({ where: { id: second.attemptId } }),
    ).toMatchObject({ sourceSha: p.headSha });
    const common = {
      ...f.source,
      parentTurnId: nextTurn,
      childThreadId: randomUUID(),
      childTurnId: randomUUID(),
      spawnCallId: "spawn-second",
    };
    await f.native.ingest(
      f.sourceEnvelope(
        second,
        {
          ...common,
          kind: "started",
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
          effectiveModel: "gpt-6.1-sol",
          effectiveEffort: "low",
        },
        4,
        { stepId: f.nextStep, sourceContext: a.sourceContext },
      ),
    );
    const secondTerminal = f.sourceEnvelope(
      second,
      { ...common, kind: "turn_completed", status: "completed" },
      5,
      { stepId: f.nextStep, sourceContext: a.sourceContext },
    );
    await f.native.ingest(secondTerminal);
    const secondOperation = randomUUID(),
      p2 = f.publication({
        operationId: secondOperation,
        stepId: f.nextStep,
        attemptId: second.attemptId,
        leaseGeneration: second.leaseGeneration,
        expectedSourceVersion: 1,
        expectedRevisionId: a.sourceContext.revisionId,
        sourceContext: a.sourceContext,
        expectedCursorVersion: 2,
        expectedNativeSequence: 5,
        parentSha: p.headSha,
        headSha: "c".repeat(40),
        branch: `codex/delivery/${f.taskId}/${secondOperation}`,
        pullNumber: 8,
        pullRequestId: "901",
      });
    const b = await f.service.accept(f.signed(p2));
    await expect(f.native.ingest(secondTerminal)).resolves.toMatchObject({
      accepted: true,
      replayed: true,
      blocked: false,
    });
    await expect(f.native.ingest(boundary)).resolves.toMatchObject({
      accepted: true,
      replayed: true,
      blocked: false,
    });
    expect(b.sourceContext).toMatchObject({ version: 2, headSha: p2.headSha });
    const secondReport = await f.complete(
      second,
      f.nextStep,
      p2.headSha,
      b.sourceContext,
      nextTurn,
    );
    const history = await readDeliveryTask(db, f.user.id, f.taskId);
    expect(history?.steps.find((s) => s.id === f.stepId)).toMatchObject({
      state: "succeeded",
      reports: [{ sourceSha: p.headSha }],
    });
    expect(history?.steps.find((s) => s.id === f.nextStep)?.reports[0].sourceSha).toBe(p2.headSha);
    const notifications = new DeliveryOutbox(db),
      claims = await notifications.claim(f.user.id, 10);
    const notices = await Promise.all(claims.map((c) => notifications.notification(c)));
    expect(
      notices.find((n) => n?.payload.url?.includes(String(firstReport.reportId)))?.payload.body,
    ).toContain("bbbbbbbb");
    expect(
      notices.find((n) => n?.payload.url?.includes(String(secondReport.reportId)))?.payload.body,
    ).toContain("cccccccc");
    expect(
      await db.deliverySourceRevision.findUniqueOrThrow({
        where: { id: b.sourceContext.revisionId },
      }),
    ).toMatchObject({ previousRevisionId: a.sourceContext.revisionId, inputSha: p.headSha });
    expect(
      await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.first.managerBindingId },
      }),
    ).toMatchObject({
      sourceSha: f.context.revision,
      activeAttemptId: f.first.attemptId,
      currentAttemptId: second.attemptId,
      leaseId: f.context.leaseId,
      leaseGeneration: f.context.leaseGeneration,
    });
    expect(
      await db.projectTaskIntent.findUniqueOrThrow({
        where: { id: f.context.preparationIntentId },
      }),
    ).toMatchObject({ sourceSha: f.context.revision });
    expect(await f.service.accept(f.signed(p))).toMatchObject({
      replayed: true,
      current: false,
      sourceContext: a.sourceContext,
    });
    const finalTurn = randomUUID(),
      finalBoundary = f.sourceEnvelope(
        second,
        {
          kind: "root_boundary",
          parentTurnId: nextTurn,
          nextParentTurnId: finalTurn,
          cursorVersion: 2,
          observedAt: new Date(Date.now() - 100).toISOString(),
        },
        6,
        { stepId: f.nextStep, sourceContext: b.sourceContext },
      );
    await f.native.ingest(finalBoundary);
    const finalClaim = await f.manager.execute(
      f.managerEnvelope(
        {
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.finalStep,
            expectedVersion: 0,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        },
        {
          nativeTurnId: finalTurn,
          sourceContext: b.sourceContext,
          continuation: {
            boundaryEventId: finalBoundary.eventId,
            priorAttemptId: second.attemptId,
            cursorVersion: 2,
            parentTurnId: nextTurn,
            nextParentTurnId: finalTurn,
            sequence: 6,
          },
        },
      ),
    );
    expect(finalClaim).toMatchObject({
      sourceContext: b.sourceContext,
      inputSourceSha: p2.headSha,
    });
    const finalAttempt = claimSchema.parse(finalClaim),
      finalNative = {
        ...f.source,
        parentTurnId: finalTurn,
        childThreadId: randomUUID(),
        childTurnId: randomUUID(),
        spawnCallId: "final-validation",
      };
    await f.native.ingest(
      f.sourceEnvelope(
        finalAttempt,
        {
          ...finalNative,
          kind: "started",
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
          effectiveModel: "gpt-6.1-sol",
          effectiveEffort: "low",
        },
        7,
        { stepId: f.finalStep, sourceContext: b.sourceContext },
      ),
    );
    await f.native.ingest(
      f.sourceEnvelope(
        finalAttempt,
        { ...finalNative, kind: "turn_completed", status: "completed" },
        8,
        { stepId: f.finalStep, sourceContext: b.sourceContext },
      ),
    );
    await f.complete(finalAttempt, f.finalStep, p2.headSha, b.sourceContext, finalTurn);
    const converged = await readDeliveryTask(db, f.user.id, f.taskId);
    expect(converged?.counts).toMatchObject({ total: 3, succeeded: 3 });
    expect(converged?.steps.map((s) => s.attemptCount)).toEqual([1, 1, 1]);
    expect(converged?.steps.find((s) => s.id === f.stepId)?.reports[0].sourceSha).toBe(p.headSha);
    expect(
      await f.native.ingest(
        f.sourceEnvelope(f.first, { ...f.source, kind: "turn_completed", status: "completed" }, 9, {
          sourceContext: b.sourceContext,
        }),
      ),
    ).toMatchObject({ blocked: true, activeAttemptHeld: true });
    expect(
      await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.first.managerBindingId },
      }),
    ).toMatchObject({
      blockedReason: "native_attempt_not_current",
      activeAttemptId: f.first.attemptId,
    });
  });
  it("reopens only pure prior-head verification and preserves completed implementation actions", async () => {
    const f = await fixture(),
      quality = randomUUID();
    await db.deliveryStep.create({
      data: {
        id: quality,
        ownerId: f.user.id,
        taskId: f.taskId,
        kind: "review",
        state: "succeeded",
        criterionIds: ["C1"],
        requiredEvidenceKinds: ["review"],
      },
    });
    const proof = await f.evidence(quality, f.context.revision, "review");
    await f.service.accept(f.signed(f.publication()));
    expect(await db.deliveryStep.findUniqueOrThrow({ where: { id: quality } })).toMatchObject({
      state: "pending",
      version: 1,
      reopenGeneration: 1,
    });
    expect(await db.deliveryEvidence.findUniqueOrThrow({ where: { id: proof } })).toMatchObject({
      invalidatedAt: expect.any(Date),
    });
    expect(await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } })).toMatchObject({
      state: "running",
      attemptCount: 1,
    });
  });
  it.each([
    "migrate",
    "backfill",
    "release",
    "observe",
    "validate-change",
    "implement-migration",
  ])("persists reconciliation pause without rescheduling completed external action %s or advancing source", async (kind) => {
    const f = await fixture(),
      action = randomUUID();
    await db.deliveryStep.create({
      data: {
        id: action,
        ownerId: f.user.id,
        taskId: f.taskId,
        kind: kind.split("-")[0],
        state: "succeeded",
        criterionIds: ["C1"],
        requiredEvidenceKinds: [
          kind.includes("migration")
            ? "migration"
            : kind.includes("change")
              ? "change"
              : "observation",
        ],
      },
    });
    const before = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } }),
      p = f.publication();
    await expect(f.service.accept(f.signed(p))).rejects.toThrow(
      "external_effects_require_reconciliation",
    );
    await expect(f.service.accept(f.signed(p))).rejects.toThrow(
      "external_effects_require_reconciliation",
    );
    await expect(f.service.accept(f.signed({ ...p, headSha: "c".repeat(40) }))).rejects.toThrow(
      "replay_conflict",
    );
    expect(await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({
      sourceSha: before.sourceSha,
      sourceVersion: 0,
      sourceRevisionId: null,
      pauseRequested: true,
      schedulingPaused: false,
      version: before.version + 1,
    });
    expect(await db.deliveryStep.findUniqueOrThrow({ where: { id: action } })).toMatchObject({
      state: "succeeded",
      version: 0,
    });
    expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(0);
    expect(
      await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.first.attemptId } }),
    ).toMatchObject({ outputRevisionId: null, outcome: "running", quiescedAt: null });
    expect(
      await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.first.managerBindingId },
      }),
    ).toMatchObject({ activeAttemptId: f.first.attemptId });
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "source_publication_held" },
      }),
    ).toBe(1);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(1);
  });
  it("serializes duplicate and competing publications with exact lost-ACK replay only", async () => {
    const f = await fixture(),
      p = f.publication(),
      frame = f.signed(p);
    const results = await Promise.all([f.service.accept(frame), f.service.accept(frame)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(1);
    expect(
      await db.deliveryEvent.count({ where: { ownerId: f.user.id, type: "source_advanced" } }),
    ).toBe(1);
    await expect(f.service.accept(f.signed({ ...p, headSha: "c".repeat(40) }))).rejects.toThrow(
      "replay_conflict",
    );
    const other = await fixture(),
      one = other.publication(),
      two = other.publication({ headSha: "c".repeat(40) });
    const race = await Promise.allSettled([
      other.service.accept(other.signed(one)),
      other.service.accept(other.signed(two)),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.deliverySourceRevision.count({ where: { ownerId: other.user.id } })).toBe(1);
  });
  it("rejects unactivated fixture receipts, model booleans, bad signatures and binding/producer scope swaps", async () => {
    const f = await fixture(),
      p = f.publication(),
      other = await fixture();
    const closed = new DeliverySourcePublicationService(db, {
      reauthorize: f.dependencies.reauthorize,
    });
    await expect(closed.accept(f.signed(p))).rejects.toThrow("unactivated");
    for (const value of [
      { fixtureOnly: true, freshAcceptanceAuthority: false },
      { publication: p, verified: true },
      { ...f.signed(p), signature: "A".repeat(86) },
    ])
      await expect(f.service.accept(value)).rejects.toThrow();
    for (const extra of [
      { ownerId: other.user.id },
      { attemptId: other.first.attemptId },
      { repositoryId: "999" },
      { providerAccountId: "999" },
      { headSha: p.parentSha },
      { expectedCursorVersion: 2 },
      { expectedNativeSequence: 3 },
      { branch: "main" },
      { expectedSourceVersion: 1 },
      { checkoutBinding: { ...f.context, leaseGeneration: 2 } },
    ])
      await expect(f.service.accept(f.signed(f.publication(extra)))).rejects.toThrow();
    expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("requires successful trusted child completion and does not turn publication into passed quality evidence", async () => {
    const f = await fixture(false);
    await expect(
      f.service.accept(f.signed(f.publication({ expectedNativeSequence: 1 }))),
    ).rejects.toThrow("execution_unverified");
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    expect(
      await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.first.attemptId } }),
    ).toMatchObject({ outcome: "running", quiescedAt: null });
  });
  it("checks revocation/expiry/pause inside mutation and never consumes a source version on rejection", async () => {
    const f = await fixture(),
      p = f.publication();
    f.revoke();
    await expect(f.service.accept(f.signed(p))).rejects.toThrow("revoked");
    const revoked = await fixture();
    revoked.setHook(async (tx) => {
      await tx.codexHostRegistration.update({
        where: { id: revoked.registration().id },
        data: { revokedAt: new Date() },
      });
    });
    await expect(revoked.service.accept(revoked.signed(revoked.publication()))).rejects.toThrow();
    expect(await db.deliverySourceRevision.count({ where: { ownerId: revoked.user.id } })).toBe(0);
    const paused = await fixture();
    await db.deliveryTask.update({ where: { id: paused.taskId }, data: { pauseRequested: true } });
    await expect(paused.service.accept(paused.signed(paused.publication()))).rejects.toThrow();
    const expired = await fixture();
    await db.deliveryAttempt.update({
      where: { id: expired.first.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 100) },
    });
    await expect(expired.service.accept(expired.signed(expired.publication()))).rejects.toThrow();
  });
  it("requires exact advanced source context across manager, native and GitHub source requests", async () => {
    const f = await fixture(),
      accepted = await f.service.accept(f.signed(f.publication()));
    await expect(
      f.manager.execute(
        f.managerEnvelope({
          operation: "complete_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            attemptId: f.first.attemptId,
            leaseGeneration: f.first.leaseGeneration,
            expectedVersion: f.first.version,
            sourceSha: accepted.sourceContext.headSha,
            evidenceIds: [randomUUID()],
            report,
          },
        }),
      ),
    ).rejects.toThrow("source_context_stale");
    await expect(
      f.native.ingest(
        f.sourceEnvelope(
          f.first,
          {
            kind: "root_boundary",
            parentTurnId: f.parentTurnId,
            nextParentTurnId: randomUUID(),
            cursorVersion: 1,
            observedAt: new Date(Date.now() - 100).toISOString(),
          },
          3,
        ),
      ),
    ).rejects.toThrow("source_context_stale");
    const data = githubFixture(),
      transport = new GitHubSourceTransport(
        db,
        {
          reauthorize: f.dependencies.reauthorize,
          resolveTargetPolicy: () => ({ pullNumber: 123, policy: data.policy }),
        },
        {
          writeAndVerify: async (_key, bytes, digest) => ({
            size: bytes.length,
            contentDigest: digest,
          }),
        },
      );
    function challenge(context?: unknown) {
      const value = {
        schemaVersion: 1,
        action: "collect_github_evidence",
        registrationId: f.registration().id,
        serverInstanceId: f.serverInstanceId,
        managerThreadId: f.managerThreadId,
        checkoutBinding: f.context,
        taskId: f.taskId,
        stepId: f.stepId,
        requestId: randomUUID(),
        issuedAt: Date.now() - 100,
        expiresAt: Date.now() + 30000,
        ...(context ? { sourceContext: context } : {}),
      };
      return {
        ...value,
        proof: sign(
          null,
          Buffer.from(githubTransportProofPayload("challenge", value)),
          f.keys.privateKey,
        ).toString("base64url"),
      };
    }
    await expect(transport.requestChallenge(challenge())).rejects.toThrow("source_context_stale");
    await expect(
      transport.requestChallenge(challenge({ ...accepted.sourceContext, version: 2 })),
    ).rejects.toThrow("source_context_stale");
    expect(
      (await transport.requestChallenge(challenge(accepted.sourceContext))).target,
    ).toMatchObject({ pullNumber: 7, expectedHeadSha: accepted.sourceContext.headSha });
  });
  it("protects append-only chain/input/output and cross-owner/cross-attempt pointers in PostgreSQL", async () => {
    const f = await fixture(),
      other = await fixture(),
      a = await f.service.accept(f.signed(f.publication())),
      b = await other.service.accept(other.signed(other.publication()));
    await expect(
      db.deliverySourceRevision.update({
        where: { id: a.sourceContext.revisionId },
        data: { headSha: "c".repeat(40) },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      db.deliverySourceRevision.delete({ where: { id: a.sourceContext.revisionId } }),
    ).rejects.toThrow("immutable");
    await expect(
      db.deliveryAttempt.update({
        where: { id: f.first.attemptId },
        data: { sourceSha: "c".repeat(40) },
      }),
    ).rejects.toThrow("input source is immutable");
    await expect(
      db.deliveryAttempt.update({
        where: { id: f.first.attemptId },
        data: { outputRevisionId: b.sourceContext.revisionId },
      }),
    ).rejects.toThrow();
    await expect(
      db.deliveryTask.update({
        where: { id: f.taskId },
        data: { sourceRevisionId: b.sourceContext.revisionId, sourceVersion: 2 },
      }),
    ).rejects.toThrow();
    const unbound = await fixture();
    await expect(
      db.deliveryAttempt.create({
        data: {
          ownerId: unbound.user.id,
          stepId: unbound.stepId,
          managerBindingId: unbound.first.managerBindingId,
          leaseGeneration: 2,
          leaseHolder: "forged-cross-attempt",
          leaseExpiresAt: new Date(Date.now() + 30000),
          sourceSha: unbound.context.revision,
          outputRevisionId: b.sourceContext.revisionId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await readDeliveryTask(db, other.user.id, f.taskId)).toBeNull();
    expect(await resolveAttemptSource(db, f.user.id, f.taskId, f.first.attemptId)).toMatchObject({
      inputSha: f.context.revision,
      acceptedSha: a.sourceContext.headSha,
    });
    await db.deliveryTask.update({
      where: { id: f.taskId },
      data: { sourceSha: "c".repeat(40), pauseRequested: true },
    });
    await expect(resolveTaskSource(db, f.user.id, f.taskId)).rejects.toThrow("chain_invalid");
  });
  it("holds new input after publication and rechecks a committed host revocation after producer verification", async () => {
    const f = await fixture(),
      accepted = await f.service.accept(f.signed(f.publication()));
    expect(
      await f.native.ingest(
        f.sourceEnvelope(
          f.first,
          {
            ...f.source,
            kind: "command_completed",
            itemId: "late-command",
            commandDigest: "a".repeat(64),
            outputDigest: "b".repeat(64),
            exitCode: 0,
            status: "completed",
          },
          3,
          { sourceContext: accepted.sourceContext },
        ),
      ),
    ).toMatchObject({ blocked: true, activeAttemptHeld: true });
    expect(
      await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.first.managerBindingId },
      }),
    ).toMatchObject({
      activeAttemptId: f.first.attemptId,
      blockedReason: "native_input_after_publication",
    });
    const revoked = await fixture();
    const service = new DeliverySourcePublicationService(db, {
      authority: revoked.authority,
      reauthorize: async (binding) => {
        await db.codexHostRegistration.update({
          where: { id: revoked.registration().id },
          data: { revokedAt: new Date() },
        });
        return binding;
      },
    });
    await expect(service.accept(revoked.signed(revoked.publication()))).rejects.toThrow();
    expect(await db.deliverySourceRevision.count({ where: { ownerId: revoked.user.id } })).toBe(0);
  });
  it("independently collects configured GitHub checks/review for the broker-recorded PR/output before completing", async () => {
    const f = await fixture(),
      publication = f.publication(),
      accepted = await f.service.accept(f.signed(publication));
    const data = githubFixture();
    data.snapshot.providerAccountId = f.project.providerAccountId;
    data.snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
    Object.assign(data.snapshot.pullRequest, {
      id: publication.pullRequestId,
      number: publication.pullNumber,
      headSha: publication.headSha,
      headRepositoryId: f.project.providerRepositoryId,
      baseRepositoryId: f.project.providerRepositoryId,
    });
    data.snapshot.workflowRuns[0].headSha = publication.headSha;
    data.snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
    data.snapshot.checks[0].headSha = publication.headSha;
    data.snapshot.reviews[0].commitId = publication.headSha;
    const marker = data.snapshot.reviewSummaries[0].marker;
    if (!marker) throw new Error("Missing fixture marker");
    marker.code_review.commit_sha = publication.headSha;
    const config = { pullNumber: 123, policy: data.policy },
      readConfig = () => JSON.stringify({ [f.taskId]: config });
    const source = new GitHubSourceTransport(
      db,
      { reauthorize: f.dependencies.reauthorize, resolveTargetPolicy: () => config },
      {
        writeAndVerify: async (_key, bytes, digest) => ({
          size: bytes.length,
          contentDigest: digest,
        }),
      },
    );
    function envelope(phase: "challenge" | "snapshot", extra: Record<string, unknown>) {
      const value = {
        schemaVersion: 1,
        action: "collect_github_evidence",
        registrationId: f.registration().id,
        serverInstanceId: f.serverInstanceId,
        managerThreadId: f.managerThreadId,
        checkoutBinding: f.context,
        taskId: f.taskId,
        stepId: f.stepId,
        sourceContext: accepted.sourceContext,
        issuedAt: Date.now() - 100,
        expiresAt: Date.now() + 30000,
        ...extra,
      };
      return {
        ...value,
        proof: sign(
          null,
          Buffer.from(githubTransportProofPayload(phase, value)),
          f.keys.privateKey,
        ).toString("base64url"),
      };
    }
    const challenge = await source.requestChallenge(
      envelope("challenge", { requestId: randomUUID() }),
    );
    expect(challenge.target).toMatchObject({
      expectedHeadSha: publication.headSha,
      pullNumber: publication.pullNumber,
    });
    const produced = await source.ingest(
      envelope("snapshot", {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        policyDigest: challenge.policyDigest,
        snapshot: data.snapshot,
      }),
    );
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      resolveEvidencePolicy: (scope) => resolveControllerGitHubManagerPolicy(scope, readConfig),
    });
    const completion = f.managerEnvelope(
      {
        operation: "complete_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: f.first.attemptId,
          expectedVersion: f.first.version,
          leaseGeneration: f.first.leaseGeneration,
          sourceSha: publication.headSha,
          evidenceIds: produced.evidenceIds,
          report,
        },
      },
      { sourceContext: accepted.sourceContext },
    );
    expect(await manager.execute(completion)).toMatchObject({ replayed: false });
    expect(
      (await readDeliveryTask(db, f.user.id, f.taskId))?.steps.find((s) => s.id === f.stepId)
        ?.reports[0].sourceSha,
    ).toBe(publication.headSha);
    expect(
      await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.first.attemptId } }),
    ).toMatchObject({ sourceSha: f.context.revision, quiescedAt: null });
  });
});
