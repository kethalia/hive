import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AcceptanceSuccessController } from "@/lib/delivery/acceptance-completion.server";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import {
  collectCompletionProviderFacts,
  completionServices,
} from "./acceptance-completion-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    !new URL(url).pathname.startsWith("/hive_acceptance_test"))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function fixture(realPolicy = false) {
  const f = await acceptanceCandidateFixture(db);
  for (const name of [
    "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
    "HIVE_DELIVERY_EXECUTION_ENABLED",
    "HIVE_DELIVERY_MANAGER_ENABLED",
    "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
  ])
    vi.stubEnv(name, "true");
  vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(f.store.producer));
  const reviewer = realPolicy ? completionServices(db, f).service : f.reviewer;
  await reviewer.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate }));
  const completed = await f.claimAndFinish(reviewer, (job) => ({
    schemaVersion: 1,
    kind: "review",
    intentDigest: f.plan.intentDigest,
    planDigest: acceptanceDigest(f.plan),
    sourceSha: f.publication.headSha,
    inputDigest: job.inputDigest,
    outcome: "pass",
    requirements: [
      {
        id: "acceptance:behavior",
        meaningDigest: requireIntentDigest(f.plan.requirements[0].meaning),
        outcome: "pass",
        rationale: "Exact reviewed source meets the immutable fixture requirement",
        citations: [
          {
            entryId: "source:0",
            artifactDigest: f.candidate.manifest.files[0].contentDigest,
            start: 0,
            end: 10,
          },
        ],
      },
    ],
    unresolved: [],
    rationale: "Explicit independent evaluator fixture",
  }));
  const evidence = await db.deliveryEvidence.findUniqueOrThrow({
    where: { id: completed.job.jobId },
  });
  const ci = await db.deliveryEvidence.create({
    data: {
      id: randomUUID(),
      ownerId: f.user.id,
      stepId: f.stepId,
      remoteId: randomUUID(),
      producer: "fixture-ci",
      policyVersion: evidence.policyVersion,
      kind: "check",
      status: "passed",
      verificationMode: "simulated",
      environment: "explicit-provider-double",
      sourceSha: f.publication.headSha,
      criterionIds: ["repo:ci"],
      objectKey: `delivery/${f.user.id}/fixture.json`,
      contentDigest: "f".repeat(64),
      requestDigest: "e".repeat(64),
      observedAt: new Date(Date.now() - 10),
    },
  });
  const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } });
  const terminal = {
    schemaVersion: 1 as const,
    managerBindingId: f.claim.managerBindingId,
    taskId: f.taskId,
    stepId: f.stepId,
    attemptId: f.claim.attemptId,
    managerThreadId: f.managerThreadId,
    parentTurnId: f.parentTurnId,
    cursorVersion: 1,
    nativeSequence: 2,
    sourceContext: {
      revisionId: task.sourceRevisionId!,
      version: task.sourceVersion,
      headSha: task.sourceSha,
    },
    observedAt: new Date().toISOString(),
    historyDigest: "1".repeat(64),
    loadedInventoryDigest: "2".repeat(64),
    sourceJournalDigest: "3".repeat(64),
    rootCompleted: true as const,
    pendingHandlers: 0 as const,
    pendingObservers: 0 as const,
    unknownInputs: 0 as const,
    cohort: [
      {
        parentTurnId: f.source.parentTurnId,
        spawnCallId: f.source.spawnCallId,
        childThreadId: f.source.childThreadId,
        childTurnId: f.source.childTurnId,
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
    ],
  };
  // Provider transport is explicitly doubled. Real independent semantic job/result
  // validation still runs; a separate case uses the full real repository resolver.
  const policy = {
    ...f.policy,
    version: evidence.policyVersion,
    trustedProducers: [evidence.producer, "fixture-ci"],
  };
  const full = async () => ({
    policy,
    authorityDigest: "f".repeat(64),
    mandatoryRepositoryGates: true as const,
    pendingRequirements: [],
    authorizeReferences: async (_tx: unknown, ids: string[], coverage: boolean) => {
      if (!coverage || !ids.includes(ci.id) || !ids.includes(evidence.id))
        throw Error("fixture_repository_gates_missing");
    },
  });
  const service = realPolicy
    ? reviewer
    : new DeliveryAcceptanceService(db, f.store, {
        policies: f.policies,
        reauthorize: async (b) => b,
        guardianPolicy: f.guardian.policy,
        success: new AcceptanceSuccessController(f.material, full),
      });
  return { ...f, service, terminal, ci, evidence, full };
}
describe.skipIf(!url)("controller factual completion", () => {
  it("completes exact verified source once without manager narrative or writer release", async () => {
    const f = await fixture(),
      wire = () => f.envelope({ action: "complete_verified", terminal: f.terminal });
    const [a, b] = await Promise.all([f.service.dispatch(wire()), f.service.dispatch(wire())]);
    expect(a.result).toEqual(b.result);
    const result = a.result as { phase: string; receipt: { reportId: string; eventId: string } };
    expect(result.phase).toBe("completed");
    expect(
      await db.deliveryStepReport.findUnique({ where: { id: result.receipt.reportId } }),
    ).toMatchObject({
      difficulty: "unknown",
      summary: `Controller recorded independent verification of accepted source ${f.publication.headSha}.`,
    });
    expect(await db.deliveryAttempt.findUnique({ where: { id: f.claim.attemptId } })).toMatchObject(
      { outcome: "succeeded", quiescedAt: null },
    );
    expect(
      await db.deliveryManagerBinding.findUnique({ where: { id: f.claim.managerBindingId } }),
    ).toMatchObject({ activeAttemptId: f.claim.attemptId, currentAttemptId: f.claim.attemptId });
    expect(
      await db.deliveryReportEvidence.count({ where: { reportId: result.receipt.reportId } }),
    ).toBe(2);
    expect(await db.deliveryOutbox.count({ where: { eventId: result.receipt.eventId } })).toBe(1);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "acceptance_success_completed" },
      }),
    ).toBe(1);
    await expect(
      f.service.dispatch(
        f.envelope({
          action: "complete_verified",
          terminal: { ...f.terminal, historyDigest: "9".repeat(64) },
        }),
      ),
    ).rejects.toThrow("acceptance_completion_replay_changed");
  });
  it("real full repository policy refuses semantic pass without independently authenticated repository gates", async () => {
    const f = await fixture();
    const service = new DeliveryAcceptanceService(db, f.store, {
      policies: f.policies,
      reauthorize: async (b) => b,
      guardianPolicy: f.guardian.policy,
      success: new AcceptanceSuccessController(
        f.material,
        repositoryPolicyAdapters(f.policies).resolveEvidencePolicy,
      ),
    });
    await expect(
      service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal })),
    ).rejects.toThrow();
    expect(await db.deliveryStep.count({ where: { id: f.stepId, state: "succeeded" } })).toBe(0);
  });
  for (const review of [true, false])
    it(`real signed provider+semantic evidence requires every mandatory family (review=${review})`, async () => {
      const f = await fixture(true);
      await collectCompletionProviderFacts(db, f, f.publication.operationId, { review });
      const request = () =>
        f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
      if (review) {
        expect((await request()).result).toMatchObject({ phase: "completed", writerHeld: true });
        const report = await db.deliveryStepReport.findFirstOrThrow({
          where: { attemptId: f.claim.attemptId },
        });
        expect(await db.deliveryReportEvidence.count({ where: { reportId: report.id } })).toBe(3);
      } else {
        await expect(request()).rejects.toThrow();
        expect(await db.deliveryStep.count({ where: { id: f.stepId, state: "succeeded" } })).toBe(
          0,
        );
      }
    });
  for (const drift of [
    "source",
    "cohort",
    "expiry",
    "pause",
    "registration",
    "semantic",
    "ci",
  ] as const)
    it(`rejects ${drift} before factual completion`, async () => {
      const f = await fixture();
      if (drift === "source") f.terminal.sourceContext.headSha = "d".repeat(40);
      if (drift === "cohort") f.terminal.cohort = [];
      if (drift === "expiry") f.terminal.observedAt = new Date(Date.now() - 31000).toISOString();
      if (drift === "pause")
        await db.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: true } });
      if (drift === "registration")
        await db.codexHostRegistration.update({
          where: { id: f.registration().id },
          data: { revokedAt: new Date() },
        });
      if (drift === "semantic" || drift === "ci")
        await db.deliveryEvidence.update({
          where: { id: drift === "ci" ? f.ci.id : f.evidence.id },
          data: { invalidatedAt: new Date() },
        });
      await expect(
        f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal })),
      ).rejects.toThrow();
      expect(await db.deliveryStep.count({ where: { id: f.stepId, state: "succeeded" } })).toBe(0);
    });
});
