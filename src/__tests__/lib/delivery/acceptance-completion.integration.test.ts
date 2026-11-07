import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AcceptanceSuccessController } from "@/lib/delivery/acceptance-completion.server";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { acceptedDatabasePlan } from "@/lib/delivery/database-job-store.server";
import { PostgresReleaseEffectJournal } from "@/lib/delivery/release-effect-journal.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import {
  databaseJobRequestSchema,
  verifyDatabaseResponse,
} from "../../../../services/migrate/src/delivery/wire.mjs";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import {
  collectCompletionProviderFacts,
  completionServices,
} from "./acceptance-completion-fixture";
import { databaseApprovalFixture } from "./database-job-approval-fixture";
import { openReleaseFromSignedEvidence } from "./release-autonomous-fixture";

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
async function fixture(realPolicy = false, activationRequirement = false) {
  const f = await acceptanceCandidateFixture(db, undefined, { activationRequirement });
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
    requirements: f.plan.requirements.map((requirement) => ({
      id: requirement.id,
      meaningDigest: requireIntentDigest(requirement.meaning),
      outcome: requirement.phase === "implementation_preview" ? "pass" : "outside_step_scope",
      rationale: "Exact reviewed source covers only the implementation milestone",
      citations:
        requirement.phase === "implementation_preview"
          ? [
              {
                entryId: "source:0",
                artifactDigest: f.candidate.manifest.files[0].contentDigest,
                start: 0,
                end: 10,
              },
            ]
          : [],
    })),
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
  it("allows an explicit premerge milestone while retaining production requirements and full-task holds", async () => {
    const f = await fixture(true, true);
    await collectCompletionProviderFacts(db, f, f.publication.operationId);
    const scope = { ownerId: f.user.id, taskId: f.taskId, sourceSha: f.publication.headSha };
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, f.policies, {
          ...scope,
          milestone: "implementation_preview",
        }),
      ),
    ).toBe(false);
    await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
    const verify = (milestone?: "implementation_preview" | "task_complete") =>
      db.$transaction((tx) => verifyReleaseEvidence(tx, f.policies, { ...scope, milestone }));
    const production = await db.deliveryStep.findFirstOrThrow({
      where: { taskId: f.taskId, acceptancePhase: "activation_production" },
    });
    expect(production.state).not.toBe("succeeded");
    expect(await verify("implementation_preview")).toBe(true);
    expect(await verify()).toBe(false);
    expect(await verify("task_complete")).toBe(false);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, f.policies, {
          ...scope,
          sourceSha: "a".repeat(40),
          milestone: "implementation_preview",
        }),
      ),
    ).toBe(false);
    expect(await db.deliveryStep.findUnique({ where: { id: production.id } })).toEqual(production);
    expect(await db.deliveryEvidence.count({ where: { stepId: production.id } })).toBe(0);

    // Exercise the actual opener -> factual capture -> lifecycle chain. Only
    // external GitHub/Cloudflare/health transports are doubled by this fixture;
    // no semantic, capture or journal verifier is replaced.
    const release = await openReleaseFromSignedEvidence(db, f);
    expect(
      await db.deliveryReleaseAuthorityFact.count({
        where: { ownerId: f.user.id, taskId: f.taskId },
      }),
    ).toBe(1);
    const actions = await db.$queryRaw<{ id: string; phase: string }[]>`
      SELECT id,phase FROM delivery_release_actions
      WHERE release_id=${release.releaseId}::uuid AND kind='merge'`;
    expect(actions).toHaveLength(1);
    expect(actions[0].phase).toBe("prepared");
    expect(await verify()).toBe(false);
    expect(await db.deliveryStep.findUnique({ where: { id: production.id } })).toEqual(production);
    expect(await db.deliveryEvidence.count({ where: { stepId: production.id } })).toBe(0);

    // The same exact-source semantic authority remains mandatory premerge.
    await db.deliveryEvidence.update({
      where: { id: f.evidence.id },
      data: { invalidatedAt: new Date() },
    });
    expect(await verify("implementation_preview")).toBe(false);
    expect(
      await new PostgresReleaseEffectJournal(db, f.user.id, release.authorize).begin(actions[0].id),
    ).toBeNull();
  }, 15000);

  it("approves a compatible migration plan from preview acceptance without granting execution or production completion", async () => {
    const f = await fixture(true, true);
    await collectCompletionProviderFacts(db, f, f.publication.operationId);
    await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
    const d = databaseApprovalFixture(db, f),
      signal = () => AbortSignal.timeout(15000);
    const approve = () => d.store.approve(d.request, d.token(d.request), signal());
    await expect(
      d.store.approve(d.request, d.token({ ...d.request, sourceSha: "0".repeat(40) }), signal()),
    ).rejects.toThrow("database_oidc_scope");
    d.failCompatibility();
    await expect(approve()).rejects.toThrow("database_job_authority_unavailable");
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_plan_approved" } }),
    ).toBe(0);
    d.passCompatibility();
    const production = await db.deliveryStep.findFirstOrThrow({
      where: { taskId: f.taskId, acceptancePhase: "activation_production" },
    });
    const approved = verifyDatabaseResponse(await approve(), d.request, d.catalog);
    expect(approved.data).toMatchObject({ executionAuthorized: false });
    const plan = await db.$transaction((tx) =>
      acceptedDatabasePlan(
        tx,
        {
          ownerId: f.user.id,
          taskId: f.taskId,
          sourceSha: f.publication.headSha,
        },
        d.catalog,
      ),
    );
    expect(approved.data.planEventId).toBe(plan.id);
    expect(approved.data.planDigest).toBe(plan.planDigest);
    expect(await db.deliveryStep.findUnique({ where: { id: production.id } })).toEqual(production);
    expect(await db.deliveryEvidence.count({ where: { stepId: production.id } })).toBe(0);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, f.policies, {
          ownerId: f.user.id,
          taskId: f.taskId,
          sourceSha: f.publication.headSha,
        }),
      ),
    ).toBe(false);

    const job = databaseJobRequestSchema.parse({
      schemaVersion: 1,
      purpose: "database_job",
      catalogId: d.catalog.id,
      ownerId: f.user.id,
      taskId: f.taskId,
      sourceSha: f.publication.headSha,
      githubRunId: "12",
      githubRunAttempt: 1,
      requestId: randomUUID(),
      releaseId: randomUUID(),
      targetDigest: d.catalog.targetDigest,
      generation: 1,
      planEventId: plan.id,
      operation: "authorize",
      action: "expand",
    });
    await expect(d.store.job(job, d.token(job), signal())).rejects.toThrow(
      "database_job_authority_unavailable",
    );
    await db.deliveryStep.update({ where: { id: production.id }, data: { state: "failed" } });
    await expect(approve()).rejects.toThrow("database_job_authority_unavailable");
    await db.deliveryStep.update({
      where: { id: production.id },
      data: { state: production.state },
    });
    await db.deliveryEvidence.update({
      where: { id: f.evidence.id },
      data: { invalidatedAt: new Date() },
    });
    await expect(approve()).rejects.toThrow("database_job_authority_unavailable");
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_plan_approved" } }),
    ).toBe(1);
  }, 15000);

  for (const state of ["failed", "canceled"] as const)
    it(`does not waive an explicit production ${state} hold for premerge`, async () => {
      const f = await fixture(true, true);
      await collectCompletionProviderFacts(db, f, f.publication.operationId);
      await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
      const scope = {
        ownerId: f.user.id,
        taskId: f.taskId,
        sourceSha: f.publication.headSha,
        milestone: "implementation_preview" as const,
      };
      expect(await db.$transaction((tx) => verifyReleaseEvidence(tx, f.policies, scope))).toBe(
        true,
      );
      const production = await db.deliveryStep.findFirstOrThrow({
        where: { taskId: f.taskId, acceptancePhase: "activation_production" },
      });
      // Explicit local provider-state fixture; no production operation runs.
      await db.deliveryStep.update({ where: { id: production.id }, data: { state } });
      expect(await db.$transaction((tx) => verifyReleaseEvidence(tx, f.policies, scope))).toBe(
        false,
      );
      expect(await db.deliveryStep.findUnique({ where: { id: production.id } })).toMatchObject({
        state,
      });
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
        expect(
          await db.$transaction((tx) =>
            verifyReleaseEvidence(tx, f.policies, {
              ownerId: f.user.id,
              taskId: f.taskId,
              sourceSha: f.publication.headSha,
            }),
          ),
        ).toBe(true);
        let release: Awaited<ReturnType<typeof openReleaseFromSignedEvidence>> | undefined;
        let actionId: string | undefined;
        if (process.env.HIVE_RELEASE_AUTONOMOUS_TEST === "true") {
          release = await openReleaseFromSignedEvidence(db, f);
          const actions = await db.$queryRaw<
            { id: string; phase: string }[]
          >`SELECT id,phase FROM delivery_release_actions WHERE release_id=${release.releaseId}::uuid AND kind='merge'`;
          expect(actions).toHaveLength(1);
          expect(actions[0].phase).toBe("prepared");
          actionId = actions[0].id;
        }
        const report = await db.deliveryStepReport.findFirstOrThrow({
          where: { attemptId: f.claim.attemptId },
        });
        expect(await db.deliveryReportEvidence.count({ where: { reportId: report.id } })).toBe(3);
        await db.deliveryEvidence.update({
          where: { id: f.evidence.id },
          data: { invalidatedAt: new Date() },
        });
        if (release && actionId)
          expect(
            await new PostgresReleaseEffectJournal(db, f.user.id, release.authorize).begin(
              actionId,
            ),
          ).toBeNull();
        expect(
          await db.$transaction((tx) =>
            verifyReleaseEvidence(tx, f.policies, {
              ownerId: f.user.id,
              taskId: f.taskId,
              sourceSha: f.publication.headSha,
            }),
          ),
        ).toBe(false);
      } else {
        await expect(request()).rejects.toThrow();
        expect(await db.deliveryStep.count({ where: { id: f.stepId, state: "succeeded" } })).toBe(
          0,
        );
      }
    });
  it.skipIf(process.env.HIVE_RELEASE_AUTONOMOUS_TEST !== "true")(
    "holds stale tested base, unrelated protection, missing intent and no actionable steps",
    async () => {
      const f = await fixture(true);
      await collectCompletionProviderFacts(db, f, f.publication.operationId);
      await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
      for (const defect of [
        "old_base",
        "unrelated_check",
        "control_path",
        "wrong_tree",
        "test_failed",
        "runner_config",
        "dependency_control",
      ] as const)
        await expect(openReleaseFromSignedEvidence(db, f, defect)).rejects.toThrow(
          "release_open_fixture_failed",
        );
      for (const defect of ["intent", "steps"] as const) {
        let authorized = true;
        await expect(
          db.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
            if (defect === "intent")
              await tx.$executeRaw`DELETE FROM delivery_acceptance_intents WHERE owner_id=${f.user.id}::uuid`;
            else
              await tx.$executeRaw`UPDATE delivery_steps SET kind='understand',required_evidence_kinds=ARRAY['analysis'] WHERE owner_id=${f.user.id}::uuid AND task_id=${f.taskId}::uuid`;
            authorized = await verifyReleaseEvidence(tx, f.policies, {
              ownerId: f.user.id,
              taskId: f.taskId,
              sourceSha: f.publication.headSha,
            });
            throw Error("rollback fixture mutation");
          }),
        ).rejects.toThrow("rollback fixture mutation");
        expect(authorized).toBe(false);
      }
    },
  );
  for (const scenario of ["ordinary_test", "pending_checks"] as const)
    it.skipIf(process.env.HIVE_RELEASE_AUTONOMOUS_TEST !== "true")(
      `accepts ${scenario} only after the trusted run and checks complete`,
      async () => {
        const f = await fixture(true);
        await collectCompletionProviderFacts(db, f, f.publication.operationId);
        await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
        const release = await openReleaseFromSignedEvidence(db, f, scenario);
        expect(release.releaseId).toBeTruthy();
      },
    );
  it.skipIf(process.env.HIVE_RELEASE_AUTONOMOUS_TEST !== "true")(
    "opens and reconciles a synthetic async merge from signed acceptance and repository evidence",
    async () => {
      const f = await fixture(true);
      await collectCompletionProviderFacts(db, f, f.publication.operationId);
      await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
      const release = await openReleaseFromSignedEvidence(db, f);
      const actions = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_actions WHERE release_id=${release.releaseId}::uuid AND kind='merge' AND phase='prepared'`;
      expect(actions).toHaveLength(1);
      expect(await release.simulateMerge(actions[0].id)).toEqual({
        first: "held",
        afterRestart: "observed",
        writes: 1,
      });
      expect(await release.simulateRollout()).toEqual({
        first: "held",
        recoveredAck: "observed",
        stage: "stage_ready",
        regression: "held",
        final: "recovered",
        cloudflareWrites: 4,
      });
    },
  );
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
