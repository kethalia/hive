import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
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
const receipt = z.object({
  attemptId: z.string(),
  managerBindingId: z.string(),
  leaseGeneration: z.number(),
  version: z.number(),
  nativeSequence: z.number(),
  cursorVersion: z.number().optional(),
});
const report = {
  summary: "Synthetic progression result",
  difficulty: "low",
  difficultyReason: "Bounded fixture",
  issues: [],
  remainingUncertainty: "No native admission proof or production acceptance",
  nextAction: "Continue same writer",
};

async function fixture(protocol: 0 | 1 = 1) {
  const f = await nativeFixture(db),
    nextStep = randomUUID(),
    thirdStep = randomUUID();
  const manager = new DeliveryManagerService(db, {
    ...f.dependencies,
    ...(protocol ? { progressionProtocol: 1 as const } : {}),
  });
  const definition = {
    ...f.definition,
    steps: [
      {
        id: f.stepId,
        kind: "understand",
        criterionIds: ["C1"],
        requiredEvidenceKinds: ["analysis"],
      },
      { id: nextStep, kind: "validate", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
      { id: thirdStep, kind: "validate", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
    ],
    dependencies: [
      { stepId: nextStep, dependsOnStepId: f.stepId },
      { stepId: thirdStep, dependsOnStepId: nextStep },
    ],
  };
  await manager.execute(f.managerEnvelope({ operation: "create_task", payload: definition }));
  function claimInput(
    step = f.stepId,
    turn = f.parentTurnId,
    continuation?: unknown,
    overrides = {},
  ) {
    return f.managerEnvelope(
      {
        operation: "claim_step",
        payload: {
          taskId: f.taskId,
          stepId: step,
          expectedVersion: 0,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      },
      { nativeTurnId: turn, ...(continuation ? { continuation } : {}), ...overrides },
    );
  }
  const firstInput = claimInput(),
    first = receipt.parse(await manager.execute(firstInput));
  const reportInput = f.managerEnvelope({
    operation: "report_step",
    payload: {
      taskId: f.taskId,
      stepId: f.stepId,
      attemptId: first.attemptId,
      expectedVersion: first.version,
      leaseGeneration: first.leaseGeneration,
      sourceSha: f.context.revision,
      report,
    },
  });
  async function boundary(nextTurn = randomUUID(), sourceOverrides = {}, overrides = {}) {
    const input = f.sourceEnvelope(
      first,
      {
        kind: "root_boundary",
        parentTurnId: f.parentTurnId,
        nextParentTurnId: nextTurn,
        cursorVersion: 1,
        observedAt: new Date(Date.now() - 100).toISOString(),
        ...sourceOverrides,
      },
      1,
      overrides,
    );
    const result = await f.native.ingest(input);
    return {
      input,
      result,
      nextTurn,
      continuation: {
        boundaryEventId: input.eventId,
        priorAttemptId: first.attemptId,
        cursorVersion: 1,
        parentTurnId: f.parentTurnId,
        nextParentTurnId: nextTurn,
        sequence: 1,
      },
    };
  }
  return {
    ...f,
    manager,
    definition,
    nextStep,
    thirdStep,
    firstInput,
    first,
    reportInput,
    boundary,
    claimInput,
    repository: new DeliveryRepository(db, f.policy),
  };
}

describe.skipIf(!url)(
  "protocol-one server progression (synthetic signed host, not native ordering proof)",
  () => {
    it("advances analysis then two delegated attempts at one source while preserving the physical writer and immutable receipts", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      expect(await f.native.ingest(b.input)).toMatchObject({
        accepted: true,
        replayed: true,
        boundaryEventId: b.input.eventId,
      });
      const claim = f.claimInput(f.nextStep, b.nextTurn, b.continuation),
        second = receipt.parse(await f.manager.execute(claim));
      expect(second).toMatchObject({ cursorVersion: 2, nativeSequence: 1 });
      expect(await f.manager.execute(claim)).toMatchObject({
        attemptId: second.attemptId,
        replayed: true,
        cursorVersion: 2,
        nativeSequence: 1,
      });
      const source = {
        ...f.source,
        parentTurnId: b.nextTurn,
        childThreadId: randomUUID(),
        childTurnId: randomUUID(),
      };
      await f.native.ingest(
        f.sourceEnvelope(
          second,
          {
            ...source,
            kind: "started",
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
            effectiveModel: "gpt-6.1-sol",
            effectiveEffort: "low",
          },
          2,
          { stepId: f.nextStep },
        ),
      );
      await f.native.ingest(
        f.sourceEnvelope(second, { ...source, kind: "turn_completed", status: "completed" }, 3, {
          stepId: f.nextStep,
        }),
      );
      const evidenceId = randomUUID();
      await f.repository.recordEvidence(f.user.id, "fixture-ci", {
        id: evidenceId,
        stepId: f.nextStep,
        remoteId: randomUUID(),
        kind: "check",
        status: "passed",
        verificationMode: "simulated",
        environment: "synthetic-progression",
        sourceSha: f.context.revision,
        criterionIds: ["C1"],
        objectKey: `delivery/${f.user.id}/fixture/check.json`,
        contentDigest: "b".repeat(64),
        observedAt: new Date(Date.now() - 100),
      });
      await f.manager.execute(
        f.managerEnvelope(
          {
            operation: "complete_step",
            payload: {
              taskId: f.taskId,
              stepId: f.nextStep,
              attemptId: second.attemptId,
              expectedVersion: second.version,
              leaseGeneration: second.leaseGeneration,
              sourceSha: f.context.revision,
              evidenceIds: [evidenceId],
              report,
            },
          },
          { nativeTurnId: b.nextTurn },
        ),
      );
      const thirdTurn = randomUUID(),
        boundary = f.sourceEnvelope(
          second,
          {
            kind: "root_boundary",
            parentTurnId: b.nextTurn,
            nextParentTurnId: thirdTurn,
            cursorVersion: 2,
            observedAt: new Date(Date.now() - 100).toISOString(),
          },
          4,
          { stepId: f.nextStep },
        );
      await f.native.ingest(boundary);
      const third = receipt.parse(
        await f.manager.execute(
          f.claimInput(f.thirdStep, thirdTurn, {
            boundaryEventId: boundary.eventId,
            priorAttemptId: second.attemptId,
            cursorVersion: 2,
            parentTurnId: b.nextTurn,
            nextParentTurnId: thirdTurn,
            sequence: 4,
          }),
        ),
      );
      const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.first.managerBindingId },
      });
      expect(binding).toMatchObject({
        activeAttemptId: f.first.attemptId,
        currentAttemptId: third.attemptId,
        cursorVersion: 3,
        nativeSequence: 4,
        progressionProtocol: 1,
        blockedReason: null,
      });
      expect(await f.manager.execute(f.firstInput)).toMatchObject({
        attemptId: f.first.attemptId,
        cursorVersion: 1,
        nativeSequence: 0,
        replayed: true,
      });
      expect(await f.native.ingest(b.input)).toMatchObject({
        boundaryEventId: b.input.eventId,
        cursorVersion: 1,
        sequence: 1,
        replayed: true,
      });
      expect(await f.manager.execute(f.reportInput)).toMatchObject({
        informational: true,
        replayed: true,
      });
      expect(
        await db.deliveryAttempt.findUniqueOrThrow({ where: { id: second.attemptId } }),
      ).toMatchObject({ quiescedAt: null });
      expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(2);
      expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(2);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "native_boundary_consumed" },
        }),
      ).toBe(2);
      await expect(
        db.deliveryManagerBinding.update({
          where: { id: binding.id },
          data: { activeAttemptId: null },
        }),
      ).rejects.toThrow();
      await expect(
        db.deliveryManagerBinding.update({
          where: { id: binding.id },
          data: { progressionProtocol: 0 },
        }),
      ).rejects.toThrow("immutable");
    });
    it("requires a terminal result and exact fresh completed-parent/new-parent boundary; model assertions are rejected", async () => {
      const f = await fixture();
      await expect(f.boundary()).rejects.toThrow("native_boundary_not_ready");
      await f.manager.execute(f.reportInput);
      await expect(f.boundary(f.parentTurnId)).rejects.toThrow("native_boundary_not_ready");
      await expect(
        f.boundary(randomUUID(), { observedAt: new Date(Date.now() - 120000).toISOString() }),
      ).rejects.toThrow("native_boundary_not_ready");
      await expect(f.boundary(randomUUID(), { quiescent: true })).rejects.toThrow();
      await expect(f.manager.execute(f.claimInput(f.nextStep, randomUUID()))).rejects.toThrow(
        "continuation_boundary_required",
      );
      const b = await f.boundary();
      await expect(
        f.manager.execute(f.claimInput(f.nextStep, randomUUID(), b.continuation)),
      ).rejects.toThrow("continuation_boundary_required");
      await expect(
        f.manager.execute(
          f.managerEnvelope({
            operation: "claim_step",
            payload: {
              taskId: f.taskId,
              stepId: f.nextStep,
              expectedVersion: 0,
              continuation: b.continuation,
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(f.native.ingest({ ...b.input, proof: "A".repeat(86) })).rejects.toThrow();
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(1);
    });
    it("allows only one concurrent consumption and rejects changed exact-event replay", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      const input = f.claimInput(f.nextStep, b.nextTurn, b.continuation);
      const results = await Promise.all([f.manager.execute(input), f.manager.execute(input)]);
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      await expect(
        f.manager.execute(
          f.claimInput(
            f.nextStep,
            b.nextTurn,
            { ...b.continuation, sequence: 2 },
            { eventId: input.eventId, nativeCallId: input.nativeCallId },
          ),
        ),
      ).rejects.toThrow("replay_conflict");
      await expect(
        f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, b.continuation)),
      ).rejects.toThrow("continuation_boundary_required");
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(2);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "native_boundary_consumed" },
        }),
      ).toBe(1);
    });
    it("fails closed on missing boundary, sequence drift, owner/scope swap and changed source", async () => {
      const f = await fixture(),
        other = await fixture();
      await f.manager.execute(f.reportInput);
      await other.manager.execute(other.reportInput);
      const b = await f.boundary(),
        foreign = await other.boundary();
      for (const continuation of [
        { ...b.continuation, boundaryEventId: randomUUID() },
        { ...b.continuation, sequence: 2 },
        { ...b.continuation, boundaryEventId: foreign.input.eventId },
        { ...b.continuation, priorAttemptId: other.first.attemptId },
      ]) {
        await expect(
          f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, continuation)),
        ).rejects.toThrow();
      }
      await expect(
        f.manager.execute(
          f.claimInput(f.nextStep, b.nextTurn, b.continuation, {
            checkoutBinding: { ...f.context, revision: "b".repeat(40) },
          }),
        ),
      ).rejects.toThrow();
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(1);
    });
    it("revalidates revoked registration after signed boundary and keeps legacy protocol held", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      await f.register(randomUUID());
      await expect(
        f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, b.continuation)),
      ).rejects.toThrow();
      const legacy = await fixture(0);
      await legacy.manager.execute(legacy.reportInput);
      await expect(legacy.boundary()).rejects.toThrow("native_boundary_not_ready");
      await expect(legacy.manager.execute(legacy.claimInput(legacy.nextStep))).rejects.toThrow(
        "checkout_writer_busy",
      );
      const optInLater = new DeliveryManagerService(db, {
        ...legacy.dependencies,
        progressionProtocol: 1,
      });
      await optInLater.execute(
        legacy.managerEnvelope({
          operation: "create_task",
          payload: {
            ...legacy.definition,
            id: randomUUID(),
            steps: [
              {
                id: randomUUID(),
                kind: "understand",
                criterionIds: ["C1"],
                requiredEvidenceKinds: ["analysis"],
              },
            ],
            dependencies: [],
          },
        }),
      );
      expect(
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: legacy.first.managerBindingId },
        }),
      ).toMatchObject({
        progressionProtocol: 0,
        cursorVersion: 0,
        currentAttemptId: null,
        activeAttemptId: legacy.first.attemptId,
      });
    });
    it("does not exempt another task or an ordinary repository caller from held writers", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      await expect(
        f.repository.claimStep(f.user.id, {
          schemaVersion: 1,
          eventId: randomUUID(),
          taskId: f.taskId,
          stepId: f.nextStep,
          expectedVersion: 0,
          leaseHolder: "untrusted-continuation",
        }),
      ).rejects.toThrow("native_reconciliation_required");
      const taskId = randomUUID(),
        stepId = randomUUID();
      await f.manager.execute(
        f.managerEnvelope({
          operation: "create_task",
          payload: {
            ...f.definition,
            id: taskId,
            steps: [
              {
                id: stepId,
                kind: "understand",
                criterionIds: ["C1"],
                requiredEvidenceKinds: ["analysis"],
              },
            ],
            dependencies: [],
          },
        }),
      );
      await expect(
        f.manager.execute(
          f.managerEnvelope(
            {
              operation: "claim_step",
              payload: {
                taskId,
                stepId,
                expectedVersion: 0,
                requestedModel: "gpt-6.1-sol",
                requestedEffort: "low",
              },
            },
            { nativeTurnId: b.nextTurn, continuation: b.continuation },
          ),
        ),
      ).rejects.toThrow("continuation_boundary_mismatch");
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(1);
    });
    it("retains replay ACKs but a new delayed old-attempt frame holds the whole writer", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      await f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, b.continuation));
      expect(await f.native.ingest(b.input)).toMatchObject({ replayed: true, blocked: false });
      expect(
        await f.native.ingest(
          f.sourceEnvelope(
            f.first,
            { ...f.source, kind: "turn_completed", status: "completed" },
            2,
          ),
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
      expect(await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({
        pauseRequested: true,
        schedulingPaused: false,
      });
    });
    it("serializes distinct competing claims against the same boundary", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      const results = await Promise.allSettled([
        f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, b.continuation)),
        f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, b.continuation)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(2);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "native_boundary_consumed" },
        }),
      ).toBe(1);
    });
    it("does not turn an informational result into child completion or extend an expired lease", async () => {
      const f = await fixture();
      await f.native.ingest(
        f.sourceEnvelope(
          f.first,
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
      await f.manager.execute(f.reportInput);
      await expect(f.boundary(randomUUID(), {}, { sequence: 2 })).rejects.toThrow(
        "native_boundary_child_unfinished",
      );
      expect(
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.first.managerBindingId },
        }),
      ).toMatchObject({ nativeSequence: 1, cursorVersion: 1 });
      const expired = await fixture();
      await expired.manager.execute(expired.reportInput);
      await db.deliveryAttempt.update({
        where: { id: expired.first.attemptId },
        data: { leaseExpiresAt: new Date(Date.now() - 100) },
      });
      await expect(expired.boundary()).rejects.toThrow("native_boundary_not_ready");
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: expired.user.id, type: "native_root_boundary" },
        }),
      ).toBe(0);
    });
    it("rolls back boundary consumption if scheduling is paused after observation", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const b = await f.boundary();
      await db.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: true } });
      await expect(
        f.manager.execute(f.claimInput(f.nextStep, b.nextTurn, b.continuation)),
      ).rejects.toThrow("task_paused");
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(1);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "native_boundary_consumed" },
        }),
      ).toBe(0);
      expect(
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.first.managerBindingId },
        }),
      ).toMatchObject({ currentAttemptId: f.first.attemptId, cursorVersion: 1 });
    });
    it("keeps an old lifetime's physical anchor exclusive after a fresh registration/binding", async () => {
      const f = await fixture();
      await f.manager.execute(f.reportInput);
      const newServer = randomUUID();
      await f.register(newServer);
      const taskId = randomUUID(),
        stepId = randomUUID();
      await f.manager.execute(
        f.managerEnvelope(
          {
            operation: "create_task",
            payload: {
              ...f.definition,
              id: taskId,
              steps: [
                {
                  id: stepId,
                  kind: "understand",
                  criterionIds: ["C1"],
                  requiredEvidenceKinds: ["analysis"],
                },
              ],
              dependencies: [],
            },
          },
          { serverInstanceId: newServer },
        ),
      );
      await expect(
        f.manager.execute(
          f.managerEnvelope(
            {
              operation: "claim_step",
              payload: {
                taskId,
                stepId,
                expectedVersion: 0,
                requestedModel: "gpt-6.1-sol",
                requestedEffort: "low",
              },
            },
            { serverInstanceId: newServer, nativeTurnId: randomUUID() },
          ),
        ),
      ).rejects.toThrow("checkout_writer_reconciliation_required");
      expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(1);
      expect(
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.first.managerBindingId },
        }),
      ).toMatchObject({ activeAttemptId: f.first.attemptId });
    });
    it("enforces composite cursor ownership and immutable protocol/version at SQL level", async () => {
      const f = await fixture(),
        foreign = await fixture();
      const row = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.first.managerBindingId },
      });
      await expect(
        db.deliveryManagerBinding.update({ where: { id: row.id }, data: { cursorVersion: 2 } }),
      ).rejects.toThrow("cannot change without its attempt");
      await expect(
        db.deliveryManagerBinding.update({
          where: { id: row.id },
          data: { currentAttemptId: foreign.first.attemptId, cursorVersion: 2 },
        }),
      ).rejects.toThrow();
      const { createdAt: _created, updatedAt: _updated, ...identity } = row;
      await expect(
        db.deliveryManagerBinding.create({
          data: {
            ...identity,
            id: randomUUID(),
            bindingDigest: "e".repeat(64),
            activeAttemptId: foreign.first.attemptId,
            currentAttemptId: foreign.first.attemptId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      expect(
        await db.deliveryManagerBinding.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ currentAttemptId: f.first.attemptId, cursorVersion: 1 });
    });
  },
);
