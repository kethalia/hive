import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { AcceptanceMaterialResolver } from "@/lib/delivery/acceptance-material.server";
import { AcceptanceRepairController } from "@/lib/delivery/acceptance-repair.server";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import type { SourceContext } from "@/lib/delivery/contracts";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import { repairApplicationFixture } from "./acceptance-repair-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !new URL(url).pathname.startsWith("/hive_acceptance_test"))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function fixture(outcome: "fail" | "insufficient" = "fail") {
  const f = await acceptanceCandidateFixture(db);
  vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_EXECUTION_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(f.store.producer));
  await f.reviewer.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate }));
  await f.claimAndFinish(f.reviewer, (job) => ({
    schemaVersion: 1,
    kind: "review",
    intentDigest: f.plan.intentDigest,
    planDigest: acceptanceDigest(f.plan),
    sourceSha: f.publication.headSha,
    inputDigest: job.inputDigest,
    outcome,
    requirements: [
      {
        id: "acceptance:behavior",
        meaningDigest: requireIntentDigest(f.plan.requirements[0].meaning),
        outcome,
        rationale:
          outcome === "fail"
            ? "The exact candidate fails the immutable requested behavior."
            : "The necessary unchanged-file context is unavailable.",
        citations: [],
      },
    ],
    unresolved: outcome === "insufficient" ? ["Unchanged source context unavailable"] : [],
    rationale: "Explicit controller-owned fixture evaluator result",
  }));
  return f;
}
describe.skipIf(!url)("controller-owned same-step repair reservations", () => {
  it("records immutable failure feedback once, retains writer and cannot ready unapplied source", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      f.reviewer.dispatch(f.envelope({ action: "repair_prepare" })),
      f.reviewer.dispatch(f.envelope({ action: "repair_prepare" })),
    ]);
    expect(first.result).toEqual(second.result);
    const value = first.result as {
      phase: string;
      reservation: {
        repairId: string;
        stepId: string;
        sourceContext: { headSha: string };
        ordinal: number;
      };
      eventId: string;
      reportId: string;
    };
    expect(value.phase).toBe("reserved");
    expect(value.reservation).toMatchObject({
      stepId: f.stepId,
      sourceContext: { headSha: f.publication.headSha },
      ordinal: 1,
    });
    const attempt = await db.deliveryAttempt.findUniqueOrThrow({
      where: { id: f.claim.attemptId },
    });
    expect(attempt.outcome).toBe("failed");
    expect(attempt.quiescedAt).toBeNull();
    const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: f.claim.managerBindingId },
    });
    expect(binding.activeAttemptId).toBe(f.claim.attemptId);
    expect(binding.currentAttemptId).toBe(f.claim.attemptId);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "acceptance_repair_reserved" },
      }),
    ).toBe(1);
    await expect(
      f.reviewer.dispatch(
        f.envelope({ action: "repair_ready", repairId: value.reservation.repairId }),
      ),
    ).rejects.toThrow("source_application_required");
  });
  it("applies the exact failed candidate, consumes one same-step repair claim and retains the original physical writer", async () => {
    const f = await fixture();
    const reserved = (await f.reviewer.dispatch(f.envelope({ action: "repair_prepare" })))
      .result as { reservation: { repairId: string } };
    const app = await repairApplicationFixture(db, f),
      input = app.reservation();
    await app.store.reserve(f.guardian.scope, input);
    await app.store.commit(f.guardian.scope, input.applicationId, app.receipt(input));
    const response = await f.reviewer.dispatch(
      f.envelope({ action: "repair_ready", repairId: reserved.reservation.repairId }),
    );
    const ready = response.result as { expectedVersion: number; reservation: unknown };
    expect(
      (
        await f.reviewer.dispatch(
          f.envelope({ action: "repair_ready", repairId: reserved.reservation.repairId }),
        )
      ).result,
    ).toEqual(ready);
    // The database does not accept a generic failed→running cursor update:
    // even a ready step needs the exact atomically consumed repair event.
    await expect(
      db.$transaction(async (tx) => {
        const step = await tx.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } });
        const next = await tx.deliveryAttempt.create({
          data: {
            ownerId: f.user.id,
            stepId: f.stepId,
            managerBindingId: f.claim.managerBindingId,
            leaseGeneration: step.leaseGeneration + 1,
            leaseHolder: "unapproved-fixture",
            leaseExpiresAt: new Date(Date.now() + 60000),
            sourceSha: f.publication.headSha,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        });
        await tx.deliveryStep.update({
          where: { id: f.stepId },
          data: {
            state: "running",
            version: { increment: 1 },
            leaseGeneration: { increment: 1 },
            attemptCount: { increment: 1 },
          },
        });
        await tx.deliveryManagerBinding.update({
          where: { id: f.claim.managerBindingId },
          data: { currentAttemptId: next.id, cursorVersion: 2 },
        });
      }),
    ).rejects.toThrow("Previous logical attempt must be terminal");
    // Direct SQL fence: all required reservation/ready/consumption/claim rows
    // are present. Only the task's current source differs in the negative case.
    // Roll back the positive control too, preserving the actual service claim.
    for (const drift of [false, true]) {
      await expect(
        db.$transaction(async (tx) => {
          const step = await tx.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } });
          const next = await tx.deliveryAttempt.create({
            data: {
              ownerId: f.user.id,
              stepId: f.stepId,
              managerBindingId: f.claim.managerBindingId,
              leaseGeneration: step.leaseGeneration + 1,
              leaseHolder: "sql-fence-fixture",
              leaseExpiresAt: new Date(Date.now() + 60000),
              sourceSha: f.publication.headSha,
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
            },
          });
          const claimEventId = randomUUID();
          const event = {
            ownerId: f.user.id,
            taskId: f.taskId,
            stepId: f.stepId,
            attemptId: next.id,
            aggregateVersion: 1,
            requestDigest: "a".repeat(64),
          };
          await tx.deliveryEvent.create({
            data: {
              ...event,
              id: claimEventId,
              aggregateKey: `sql-claim/${next.id}`,
              type: "attempt_started",
              payload: { nativeClaim: { managerThreadId: f.managerThreadId, cursorVersion: 2 } },
            },
          });
          await tx.deliveryEvent.create({
            data: {
              ...event,
              id: randomUUID(),
              aggregateKey: `repair-consumed/${reserved.reservation.repairId}`,
              type: "acceptance_repair_consumed",
              payload: { repairId: reserved.reservation.repairId, claimEventId },
            },
          });
          await tx.deliveryStep.update({
            where: { id: f.stepId },
            data: {
              state: "running",
              version: { increment: 1 },
              leaseGeneration: { increment: 1 },
              attemptCount: { increment: 1 },
            },
          });
          if (drift)
            await tx.$executeRaw`UPDATE delivery_tasks SET source_sha=${"c".repeat(40)} WHERE id=${f.taskId}::uuid`;
          await tx.$executeRaw`UPDATE delivery_manager_bindings SET current_attempt_id=${next.id}::uuid,cursor_version=2 WHERE id=${f.claim.managerBindingId}::uuid`;
          throw Error("sql_positive_control_rollback");
        }),
      ).rejects.toThrow(
        drift ? "Previous logical attempt must be terminal" : "sql_positive_control_rollback",
      );
    }
    const nextTurn = randomUUID(),
      boundary = f.sourceEnvelope(
        f.claim,
        {
          kind: "root_boundary",
          parentTurnId: f.parentTurnId,
          nextParentTurnId: nextTurn,
          cursorVersion: 1,
          observedAt: new Date(Date.now() - 10).toISOString(),
        },
        3,
        { sourceContext: app.accepted.sourceContext },
      );
    await f.native.ingest(boundary);
    const command = f.managerEnvelope(
      {
        operation: "claim_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          expectedVersion: ready.expectedVersion,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      },
      {
        nativeTurnId: nextTurn,
        sourceContext: app.accepted.sourceContext,
        continuation: {
          boundaryEventId: boundary.eventId,
          priorAttemptId: f.claim.attemptId,
          cursorVersion: 1,
          parentTurnId: f.parentTurnId,
          nextParentTurnId: nextTurn,
          sequence: 3,
        },
      },
    );
    const next = (await f.manager.execute(command)) as {
      attemptId: string;
      inputSourceSha: string;
    };
    expect(next.attemptId).not.toBe(f.claim.attemptId);
    expect(next.inputSourceSha).toBe(f.publication.headSha);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "acceptance_repair_consumed" },
      }),
    ).toBe(1);
    const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: f.claim.managerBindingId },
    });
    expect(binding.activeAttemptId).toBe(f.claim.attemptId);
    expect(binding.currentAttemptId).toBe(next.attemptId);
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } })).quiescedAt,
    ).toBeNull();
    await expect(
      f.reviewer.dispatch(
        f.envelope({ action: "repair_ready", repairId: reserved.reservation.repairId }),
      ),
    ).rejects.toThrow();
  });
  it("two repairs preserve original criteria and a third failure exhausts the budget", async () => {
    let f = await fixture(),
      prior: SourceContext | null = null;
    const initialAttempt = f.claim.attemptId,
      originalStep = await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } });
    for (let iteration = 1; iteration <= 2; iteration++) {
      const reserved = (await f.reviewer.dispatch(f.envelope({ action: "repair_prepare" })))
        .result as { reservation: { repairId: string; ordinal: number } };
      expect(reserved.reservation.ordinal).toBe(iteration);
      const app = await repairApplicationFixture(db, f, prior),
        input = app.reservation();
      await app.store.reserve(f.guardian.scope, input);
      await app.store.commit(f.guardian.scope, input.applicationId, app.receipt(input));
      const ready = (
        await f.reviewer.dispatch(
          f.envelope({ action: "repair_ready", repairId: reserved.reservation.repairId }),
        )
      ).result as { expectedVersion: number };
      const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.claim.managerBindingId },
        }),
        nextTurn = randomUUID();
      const boundary = f.sourceEnvelope(
        f.claim,
        {
          kind: "root_boundary",
          parentTurnId: f.parentTurnId,
          nextParentTurnId: nextTurn,
          cursorVersion: binding.cursorVersion,
          observedAt: new Date(Date.now() - 1).toISOString(),
        },
        binding.nativeSequence + 1,
        { sourceContext: app.accepted.sourceContext },
      );
      await f.native.ingest(boundary);
      const claim = z
        .object({
          attemptId: z.string(),
          managerBindingId: z.string(),
          leaseGeneration: z.number(),
          version: z.number(),
          nativeSequence: z.number(),
        })
        .parse(
          await f.manager.execute(
            f.managerEnvelope(
              {
                operation: "claim_step",
                payload: {
                  taskId: f.taskId,
                  stepId: f.stepId,
                  expectedVersion: ready.expectedVersion,
                  requestedModel: "gpt-6.1-sol",
                  requestedEffort: "low",
                },
              },
              {
                nativeTurnId: nextTurn,
                sourceContext: app.accepted.sourceContext,
                continuation: {
                  boundaryEventId: boundary.eventId,
                  priorAttemptId: f.claim.attemptId,
                  cursorVersion: binding.cursorVersion,
                  parentTurnId: f.parentTurnId,
                  nextParentTurnId: nextTurn,
                  sequence: binding.nativeSequence + 1,
                },
              },
            ),
          ),
        );
      const child = {
        parentTurnId: nextTurn,
        spawnCallId: `repair-${iteration}`,
        childThreadId: randomUUID(),
        childTurnId: randomUUID(),
        observedAt: new Date(Date.now() - 1).toISOString(),
      };
      await f.native.ingest(
        f.sourceEnvelope(
          claim,
          {
            ...child,
            kind: "started",
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
            effectiveModel: "gpt-6.1-sol",
            effectiveEffort: "low",
          },
          binding.nativeSequence + 2,
          { sourceContext: app.accepted.sourceContext },
        ),
      );
      await f.native.ingest(
        f.sourceEnvelope(
          claim,
          { ...child, kind: "turn_completed", status: "completed" },
          binding.nativeSequence + 3,
          { sourceContext: app.accepted.sourceContext },
        ),
      );
      const operationId = randomUUID(),
        publication = {
          ...f.publication,
          operationId,
          branch: `codex/delivery/${f.taskId}/${operationId}`,
          attemptId: claim.attemptId,
          sourceContext: app.accepted.sourceContext,
          expectedSourceVersion: app.accepted.sourceContext.version,
          expectedRevisionId: app.accepted.sourceContext.revisionId,
          expectedCursorVersion: binding.cursorVersion + 1,
          expectedNativeSequence: binding.nativeSequence + 3,
          leaseGeneration: claim.leaseGeneration,
          parentSha: app.accepted.sourceContext.headSha,
          headSha: (iteration === 1 ? "c" : "d").repeat(40),
          treeSha: "e".repeat(40),
          issuedAt: Date.now() - 1,
          expiresAt: Date.now() + 30000,
        };
      await new DeliverySourcePublicationService(db, {
        reauthorize: f.dependencies.reauthorize,
        authority: {
          verify: async () => ({ publication, proofDigest: acceptanceDigest(publication) }),
          authorizeTransaction: async () => {},
        },
      }).accept({ explicitTrustedFixture: true });
      await f.reviewer.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate }));
      await f.claimAndFinish(f.reviewer, (job) => ({
        schemaVersion: 1,
        kind: "review",
        intentDigest: f.plan.intentDigest,
        planDigest: acceptanceDigest(f.plan),
        sourceSha: publication.headSha,
        inputDigest: job.inputDigest,
        outcome: "fail",
        requirements: [
          {
            id: "acceptance:behavior",
            meaningDigest: requireIntentDigest(f.plan.requirements[0].meaning),
            outcome: "fail",
            rationale: "The same exact requirement remains unmet.",
            citations: [],
          },
        ],
        unresolved: [],
        rationale: "Explicit fixture failure",
      }));
      prior = app.accepted.sourceContext;
      f = { ...f, claim, publication, parentTurnId: nextTurn };
    }
    await expect(f.reviewer.dispatch(f.envelope({ action: "repair_prepare" }))).rejects.toThrow(
      "acceptance_repair_budget_exhausted",
    );
    const step = await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } });
    expect(step.attemptCount).toBe(3);
    expect(step.criterionIds).toEqual(originalStep.criterionIds);
    expect(step.attemptBudget).toBe(originalStep.attemptBudget);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "acceptance_repair_reserved" },
      }),
    ).toBe(2);
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.claim.managerBindingId },
        })
      ).activeAttemptId,
    ).toBe(initialAttempt);
  });
  for (const fresh of [true, false])
    it(`required CI failure is repairable only with current authenticated facts (fresh=${fresh})`, async () => {
      const f = await fixture(),
        evidenceId = randomUUID();
      await db.deliveryEvidence.create({
        data: {
          ownerId: f.user.id,
          producer: "fixture-ci",
          policyVersion: f.policy.version,
          requestDigest: "a".repeat(64),
          id: evidenceId,
          stepId: f.stepId,
          remoteId: randomUUID(),
          kind: "check",
          status: "failed",
          verificationMode: "simulated",
          environment: "explicit-provider-fixture",
          sourceSha: f.publication.headSha,
          criterionIds: ["repo:ci"],
          objectKey: `delivery/${f.user.id}/fixture/check.json`,
          contentDigest: "f".repeat(64),
          observedAt: new Date(Date.now() - (fresh ? 100 : 300000)),
        },
      });
      const material = new AcceptanceMaterialResolver(f.policies, async () => ({
        policy: f.policy,
        authorityDigest: "f".repeat(64),
        authorizeReferences: async (_tx, ids) => {
          expect(ids).toEqual([evidenceId]);
        },
      }));
      const service = new DeliveryAcceptanceService(db, f.store, {
        policies: f.policies,
        reauthorize: async (b) => b,
        guardianPolicy: f.guardian.policy,
        repair: new AcceptanceRepairController(material, f.store),
      });
      const result = (await service.dispatch(f.envelope({ action: "repair_prepare" }))).result;
      expect(result).toMatchObject(
        fresh
          ? {
              phase: "reserved",
              reservation: {
                feedback: {
                  reason: "required_check_failed",
                  failedEvidence: [
                    { id: evidenceId, contentDigest: "f".repeat(64), criterionIds: ["repo:ci"] },
                  ],
                },
              },
            }
          : { phase: "waiting", reason: "independent_checks_pending" },
      );
    });
  it("insufficient context holds instead of creating code-churn retries", async () => {
    const f = await fixture("insufficient");
    const result = await f.reviewer.dispatch(f.envelope({ action: "repair_prepare" }));
    expect(result.result).toMatchObject({
      phase: "held",
      reason: "acceptance_context_unavailable",
    });
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "acceptance_repair_reserved" },
      }),
    ).toBe(0);
  });
  for (const mutation of ["criteria", "lease", "producer", "pause", "registration"] as const)
    it(`reserved repair refuses changed ${mutation} without releasing its writer`, async () => {
      const f = await fixture();
      await f.reviewer.dispatch(f.envelope({ action: "repair_prepare" }));
      if (mutation === "criteria")
        await db.deliveryStep.update({
          where: { id: f.stepId },
          data: { criterionIds: ["acceptance:substituted"] },
        });
      if (mutation === "lease")
        await db.deliveryAttempt.update({
          where: { id: f.claim.attemptId },
          data: { leaseExpiresAt: new Date(Date.now() - 1) },
        });
      if (mutation === "producer") vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_ENABLED", "false");
      if (mutation === "pause")
        await db.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: true } });
      if (mutation === "registration")
        await db.codexHostRegistration.update({
          where: { id: f.registration().id },
          data: { revokedAt: new Date() },
        });
      await expect(f.reviewer.dispatch(f.envelope({ action: "repair_prepare" }))).rejects.toThrow();
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "acceptance_repair_reserved" },
        }),
      ).toBe(1);
      expect(
        (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } }))
          .quiescedAt,
      ).toBeNull();
    });
  it("cannot exceed the original attempt budget", async () => {
    const f = await fixture();
    await db.deliveryStep.update({ where: { id: f.stepId }, data: { attemptCount: 3 } });
    await expect(f.reviewer.dispatch(f.envelope({ action: "repair_prepare" }))).rejects.toThrow();
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "acceptance_repair_reserved" },
      }),
    ).toBe(0);
  });
});
