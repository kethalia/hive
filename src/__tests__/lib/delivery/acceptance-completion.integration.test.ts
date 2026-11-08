import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AccountMaintenanceStore } from "@/lib/codex-session/account-maintenance-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { AcceptanceSuccessController } from "@/lib/delivery/acceptance-completion.server";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { maintenanceExternalEffectsHeld } from "@/lib/delivery/account-maintenance-effects.server";
import { acceptedDatabasePlan } from "@/lib/delivery/database-job-store.server";
import { epicPreviewReadiness } from "@/lib/delivery/epic-readiness.server";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { PostgresReleaseEffectJournal } from "@/lib/delivery/release-effect-journal.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import {
  databaseJobRequestSchema,
  verifyDatabaseResponse,
} from "../../../../services/migrate/src/delivery/wire.mjs";
import { resumeAccountMaintenanceFixture } from "../codex-session/account-maintenance-fixture";
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
    !(
      new URL(url).pathname.startsWith("/hive_acceptance_test") ||
      (new URL(url).pathname === "/hive_account_maintenance_test" &&
        process.env.HIVE_ACCOUNT_MAINTENANCE_TEST_DATABASE_URL === url)
    ))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function fixture(
  realPolicy = false,
  activationRequirement = false,
  options: Parameters<typeof acceptanceCandidateFixture>[2] = {},
) {
  const f = await acceptanceCandidateFixture(db, undefined, { activationRequirement, ...options });
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
  const currentBinding = await db.deliveryManagerBinding.findUniqueOrThrow({
    where: { id: f.claim.managerBindingId },
  });
  const terminal = {
    schemaVersion: 1 as const,
    managerBindingId: f.claim.managerBindingId,
    taskId: f.taskId,
    stepId: f.stepId,
    attemptId: f.claim.attemptId,
    managerThreadId: f.managerThreadId,
    parentTurnId: f.parentTurnId,
    cursorVersion: currentBinding.cursorVersion,
    nativeSequence: currentBinding.nativeSequence,
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
  it("completes a fresh independent preview step and derives readiness after a physically closed maintenance epoch", async () => {
    let oldServer = "",
      oldAttemptId = "",
      oldAttempt: unknown;
    const f = await fixture(true, false, {
      beforeImplementation: async ({ fixture: g, manager, preludeStepId }) => {
        oldServer = g.serverInstanceId;
        const first = (await manager.execute(
          g.managerEnvelope({
            operation: "claim_step",
            payload: {
              taskId: g.taskId,
              stepId: preludeStepId,
              expectedVersion: 0,
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
            },
          }),
        )) as {
          attemptId: string;
          managerBindingId: string;
          leaseGeneration: number;
          version: number;
          nativeSequence: number;
        };
        oldAttemptId = first.attemptId;
        await g.native.ingest(
          g.sourceEnvelope(
            first,
            {
              ...g.source,
              kind: "started",
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
              effectiveModel: "gpt-6.1-sol",
              effectiveEffort: "low",
            },
            1,
            { stepId: preludeStepId },
          ),
        );
        await g.native.ingest(
          g.sourceEnvelope(first, { ...g.source, kind: "turn_completed", status: "completed" }, 2, {
            stepId: preludeStepId,
          }),
        );
        await manager.execute(
          g.managerEnvelope({
            operation: "report_step",
            payload: {
              taskId: g.taskId,
              stepId: preludeStepId,
              attemptId: first.attemptId,
              expectedVersion: first.version,
              leaseGeneration: first.leaseGeneration,
              sourceSha: g.context.revision,
              report: {
                summary: "Understood retained task",
                difficulty: "low",
                difficultyReason: "Fixture",
                issues: [],
                remainingUncertainty: "Preview pending",
                nextAction: "Implement",
              },
            },
          }),
        );
        oldAttempt = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: first.attemptId } });
        const binding = g.guardian.runtime.binding as unknown as RegistrationBinding;
        const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
          where: { id: g.guardian.runtime.id },
        });
        const store = new AccountMaintenanceStore(db);
        const result = await resumeAccountMaintenanceFixture(
          db,
          {
            fixture: g,
            binding,
            runtime,
            store,
            input: {
              requestId: randomUUID(),
              expectedVersion: 0,
              runtimeId: runtime.id,
              runtimeGeneration: runtime.generation,
            },
          },
          "successful",
        );
        const permit = result.authority.authorizations[0];
        expect(permit.runnable).toBe(true);
        expect(permit.claimContinuation).toBeTruthy();
        const managerWire = g.managerEnvelope,
          sourceWire = g.sourceEnvelope,
          acceptanceWire = g.envelope,
          registration = g.registration;
        const actor = {
          registrationId: result.registrationId,
          serverInstanceId: result.serverInstanceId,
        };
        g.managerEnvelope = (command, overrides = {}) =>
          managerWire(command, { ...actor, ...overrides });
        g.sourceEnvelope = (claim, source, sequence, overrides = {}) =>
          sourceWire(claim, source, sequence, { ...actor, ...overrides });
        g.envelope = (data) => acceptanceWire({ ...actor, ...data });
        g.registration = () => ({ ...registration(), serverInstanceId: actor.serverInstanceId });
        g.serverInstanceId = actor.serverInstanceId;
        g.parentTurnId = randomUUID();
        g.source = {
          ...g.source,
          parentTurnId: g.parentTurnId,
          spawnCallId: randomUUID(),
          childThreadId: randomUUID(),
          childTurnId: randomUUID(),
        };
        return {
          claimOverrides: {
            nativeTurnId: g.parentTurnId,
            maintenanceContinuation: permit.claimContinuation,
          },
        };
      },
    });
    await collectCompletionProviderFacts(db, f, f.publication.operationId);
    const original = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: oldAttemptId } });
    expect(original).toEqual(oldAttempt);
    expect((original.runtimeBinding as { serverInstanceId: string }).serverInstanceId).toBe(
      oldServer,
    );
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } }))
        .runtimeBinding,
    ).toMatchObject({ serverInstanceId: f.serverInstanceId });
    const response = await f.service.dispatch(
      f.envelope({ action: "complete_verified", terminal: f.terminal }),
    );
    expect(response.result).toMatchObject({ phase: "completed" });
    expect(
      await db.$transaction((tx) => epicPreviewReadiness(tx, f.policies, f.user.id, f.taskId)),
    ).toMatchObject({
      milestone: "implementation_preview",
      writerHeld: true,
      productionVerified: false,
    });
    expect(await db.deliveryAttempt.findUniqueOrThrow({ where: { id: oldAttemptId } })).toEqual(
      oldAttempt,
    );
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.claim.managerBindingId },
        })
      ).activeAttemptId,
    ).toBe(oldAttemptId);
    for (const settings of [{ effectiveModel: null }, { effectiveEffort: null }]) {
      await expect(
        db.$transaction(async (tx) => {
          await tx.deliveryAttempt.update({ where: { id: oldAttemptId }, data: settings });
          expect(await epicPreviewReadiness(tx, f.policies, f.user.id, f.taskId)).toBeNull();
          throw Error("rollback historical settings fixture");
        }),
      ).rejects.toThrow("rollback historical settings fixture");
    }
    await expect(
      db.$transaction(async (tx) => {
        await tx.deliveryEvent.create({
          data: {
            id: randomUUID(),
            ownerId: f.user.id,
            taskId: f.taskId,
            stepId: original.stepId,
            attemptId: oldAttemptId,
            aggregateKey: `attempt/${oldAttemptId}`,
            aggregateVersion: original.runtimeVersion + 1,
            type: "native_source_conflict",
            requestDigest: "a".repeat(64),
            policyVersion: f.policy.version,
            payload: {
              producer: "installed-codex-native-observer-v1",
              nativeSourceKind: "turn_completed",
              turnStatus: "failed",
            },
          },
        });
        expect(await epicPreviewReadiness(tx, f.policies, f.user.id, f.taskId)).toBeNull();
        throw Error("rollback historical fixture");
      }),
    ).rejects.toThrow("rollback historical fixture");
    expect(
      await db.$transaction((tx) => epicPreviewReadiness(tx, f.policies, f.user.id, f.taskId)),
    ).not.toBeNull();
  });

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
    const readiness = () =>
      db.$transaction((tx) => epicPreviewReadiness(tx, f.policies, f.user.id, f.taskId));
    expect(await readiness()).toBeNull();
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
    expect(await readiness()).toMatchObject({
      milestone: "implementation_preview",
      sourceSha: f.publication.headSha,
      sourceRevisionId: f.terminal.sourceContext.revisionId,
      writerHeld: true,
      productionVerified: false,
    });
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
    expect(await readiness()).toBeNull();
    expect(
      await new PostgresReleaseEffectJournal(db, f.user.id, release.authorize).begin(actions[0].id),
    ).toBeNull();
  }, 15000);

  it("fences prepared external effects against maintenance pause and holds started/lost-ACK actions until a receipt", async () => {
    const f = await fixture(true, true);
    await collectCompletionProviderFacts(db, f, f.publication.operationId);
    await f.service.dispatch(f.envelope({ action: "complete_verified", terminal: f.terminal }));
    const release = await openReleaseFromSignedEvidence(db, f);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: release.releaseId, kind: "merge" },
    });
    const held = () =>
      db.$transaction((tx) =>
        maintenanceExternalEffectsHeld(tx, f.user.id, [f.taskId], { lockTasks: true }),
      );
    expect(await held()).toBe(false); // prepared is known not started
    let authorizations = 0;
    const journal = new PostgresReleaseEffectJournal(db, f.user.id, async (tx, identity) => {
      authorizations++;
      return release.authorize(tx, identity);
    });
    let unlock!: () => void;
    let locked!: () => void;
    const releasePause = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const pauseLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const pause = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM delivery_tasks WHERE id=${f.taskId}::uuid FOR UPDATE`;
        await tx.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: true } });
        locked();
        await releasePause;
      },
      { timeout: 10000 },
    );
    await pauseLocked;
    const beginning = journal.begin(action.id);
    try {
      // Prove the actual begin is waiting on the owner's task lock before
      // releasing it; a sequential pause-only check cannot prove this race.
      await expect
        .poll(
          async () => {
            const [row] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%SELECT pause_requested,scheduling_paused%') AS waiting`;
            return row.waiting;
          },
          { timeout: 2000, interval: 20 },
        )
        .toBe(true);
    } finally {
      unlock();
    }
    await pause;
    expect(await beginning).toBeNull();
    expect(authorizations).toBe(0);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: action.id } })).phase,
    ).toBe("prepared");
    await db.deliveryTask.update({
      where: { id: f.taskId },
      data: { pauseRequested: false, schedulingPaused: true },
    });
    expect(await journal.begin(action.id)).toBeNull();
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { schedulingPaused: false } });
    const identity = await journal.begin(action.id);
    expect(identity).not.toBeNull();
    expect(await held()).toBe(true);
    // Provider ACK loss, no retained remote reference: never replay or infer
    // absence from an expired lease or a physically closed native tree.
    await journal.hold(identity!);
    expect(await held()).toBe(true);
    const evidence = { fixture: "independently reconciled external provider", actionId: action.id };
    expect(
      await journal.record(identity!, {
        requestDigest: identity!.requestDigest,
        receiptDigest: githubSourceDigest(evidence),
        evidence,
      }),
    ).toBe(true);
    expect(await held()).toBe(false);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: action.id } })).phase,
    ).toBe("observed");
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
