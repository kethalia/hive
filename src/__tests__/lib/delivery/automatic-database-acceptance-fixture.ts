import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect } from "vitest";
import { z } from "zod";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { completionServices } from "./acceptance-completion-fixture";
import { repairApplicationFixture } from "./acceptance-repair-fixture";
import type { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";

/** Same real signed manager/native/independent-evaluator completion flow used
 * for app-only delivery. Only the independent model's result is a local double. */
export async function completeAutomaticDatabaseAcceptance(
  db: PrismaClient,
  f: Awaited<ReturnType<typeof verifiedEpicPreviewFixture>>,
) {
  const step = await db.deliveryStep.findFirstOrThrow({
    where: { taskId: f.taskId, acceptancePhase: "activation_production" },
  });
  const application = await repairApplicationFixture(db, f),
    reservation = application.reservation();
  await application.store.reserve(f.guardian.scope, reservation);
  await application.store.commit(
    f.guardian.scope,
    reservation.applicationId,
    application.receipt(reservation),
  );
  const nextTurn = randomUUID(),
    boundary = f.sourceEnvelope(
      f.claim,
      {
        kind: "root_boundary",
        parentTurnId: f.parentTurnId,
        nextParentTurnId: nextTurn,
        cursorVersion: 1,
        observedAt: new Date(Date.now() - 1).toISOString(),
      },
      3,
      { sourceContext: application.accepted.sourceContext },
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
              stepId: step.id,
              expectedVersion: step.version,
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
            },
          },
          {
            nativeTurnId: nextTurn,
            sourceContext: application.accepted.sourceContext,
            continuation: {
              boundaryEventId: boundary.eventId,
              priorAttemptId: f.claim.attemptId,
              cursorVersion: 1,
              parentTurnId: f.parentTurnId,
              nextParentTurnId: nextTurn,
              sequence: 3,
            },
          },
        ),
      ),
    );
  const source = {
    ...f.source,
    parentTurnId: nextTurn,
    childThreadId: `production-db-${randomUUID()}`,
    childTurnId: randomUUID(),
    spawnCallId: randomUUID(),
  };
  await f.native.ingest(
    f.sourceEnvelope(
      claim,
      {
        ...source,
        kind: "started",
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
      4,
      { stepId: step.id, sourceContext: application.accepted.sourceContext },
    ),
  );
  await f.native.ingest(
    f.sourceEnvelope(claim, { ...source, kind: "turn_completed", status: "completed" }, 5, {
      stepId: step.id,
      sourceContext: application.accepted.sourceContext,
    }),
  );
  const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
    where: { id: claim.managerBindingId },
  });
  const services = completionServices(db, f);
  await services.service.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate }));
  const reviewed = await f.claimAndFinish(services.service, (job) => {
    const payload = job.payload as {
      artifacts: { entryId: string; digest: string; bytes: number }[];
    };
    const artifact = payload.artifacts.find((entry) => entry.entryId === "evidence:production");
    if (!artifact) throw Error("Missing production artifact");
    return {
      schemaVersion: 1,
      kind: "review",
      intentDigest: f.plan.intentDigest,
      planDigest: acceptanceDigest(f.plan),
      sourceSha: f.publication.headSha,
      inputDigest: job.inputDigest,
      outcome: "pass",
      requirements: f.plan.requirements.map((r) => ({
        id: r.id,
        meaningDigest: requireIntentDigest(r.meaning),
        outcome: r.phase === "activation_production" ? "pass" : "outside_step_scope",
        rationale:
          "Explicit independent result for scoped same-build/DB smoke plus immutable controlled migration history",
        citations:
          r.phase === "activation_production"
            ? [
                {
                  entryId: artifact.entryId,
                  artifactDigest: artifact.digest,
                  start: 0,
                  end: Math.min(10, artifact.bytes),
                },
              ]
            : [],
      })),
      unresolved: [],
      rationale: "Independent model-output double; no business inference from generic health",
    };
  });
  const job = await db.deliveryAcceptanceJob.findUniqueOrThrow({
    where: { id: reviewed.job.jobId },
  });
  expect(
    (job.material as { production: { database?: unknown } }).production.database,
  ).toBeDefined();
  const terminal = {
    ...f.terminal,
    stepId: step.id,
    attemptId: claim.attemptId,
    parentTurnId: nextTurn,
    cursorVersion: binding.cursorVersion,
    nativeSequence: binding.nativeSequence,
    observedAt: new Date().toISOString(),
    cohort: [
      ...f.terminal.cohort,
      {
        parentTurnId: nextTurn,
        spawnCallId: source.spawnCallId,
        childThreadId: source.childThreadId,
        childTurnId: source.childTurnId,
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
    ],
  };
  const completed = await services.service.dispatch(
    f.envelope({ action: "complete_verified", terminal }),
  );
  expect((completed.result as { phase: string }).phase).toBe("completed");
  return { completed, job, claim, step };
}
