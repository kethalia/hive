import { randomUUID } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ db: undefined as unknown, host: vi.fn() }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));

import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { productionAcceptanceStepMaterial } from "@/lib/delivery/acceptance-production.server";
import { createAutomaticReleaseTestStore } from "@/lib/delivery/release-automatic-host.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";
import { repositoryPolicyStore } from "@/lib/delivery/repository-policy.server";
import { automaticWorkerHealth } from "../../../../deploy/cloudflare/app/automatic-health";
import { hostProductionRelease } from "../../../../scripts/host-epic-merge";
import { completionServices } from "./acceptance-completion-fixture";
import { acceptanceFixtureKey, acceptanceFixtureProducer } from "./acceptance-fixture";
import { repairApplicationFixture } from "./acceptance-repair-fixture";
import { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";
import { automaticReleaseProviderFixture } from "./release-automatic-provider-fixture";

const url = process.env.HIVE_AUTOMATIC_RELEASE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/hive_acceptance_test_automatic_[a-z0-9_]+$/.test(new URL(url).pathname))
)
  throw Error("Owned local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_automatic_unused",
});
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mocks.host.mockReset();
});

/** Real PostgreSQL, signed manager/native/source/acceptance transitions and
 * independent-result validation. Provider reads, app health and model output
 * are explicit bounded local doubles; no account inference or provider writes. */
async function fixture(longReview = false, productionValidationOnly = true) {
  const f = await verifiedEpicPreviewFixture(db, {
    baseBranch: "main",
    activationRequirement: true,
    productionValidationOnly,
    ...(longReview ? { producer: { ...acceptanceFixtureProducer, maxDurationMs: 60000 } } : {}),
  });
  vi.stubEnv("ENCRYPTION_KEY", acceptanceFixtureKey);
  const version = await db.deliveryRepositoryPolicyVersion.findFirstOrThrow({
    where: { ownerId: f.user.id, projectId: f.project.id },
  });
  vi.stubEnv(
    "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
    JSON.stringify([
      {
        ownerId: f.user.id,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: f.project.fullName,
        policy: {
          schemaVersion: 1,
          source: version.sourcePolicy,
          evidenceGates: version.evidenceGates,
          acceptanceContracts: version.acceptanceContracts,
        },
      },
    ]),
  );
  const p = await automaticReleaseProviderFixture(db, f),
    buildUuid = randomUUID();
  let drift = false,
    probes = 0;
  const fetcher: typeof fetch = async (raw, init) => {
    const target = new URL(String(raw));
    if (target.origin === p.config.target.origin) {
      probes++;
      return automaticWorkerHealth(
        new Request(String(raw), init),
        {
          HIVE_NATIVE_HEALTH_ENABLED: "true",
          HIVE_NATIVE_MODE: "production",
          HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
          HIVE_PUBLIC_ORIGIN: p.config.target.origin,
          HIVE_NATIVE_BUILD_IDENTITY: {
            schemaVersion: 1,
            status: "available",
            provider: "cloudflare-builds",
            sourceSha: drift ? "0".repeat(40) : p.remote.mergeSha,
            buildUuid,
            branch: "main",
          },
        },
        async () => {
          await db.$queryRaw`SELECT 1`;
          return true;
        },
        async () => true,
      );
    }
    if (target.pathname === `/repos/${p.source.fullName}/commits/${p.remote.mergeSha}/check-runs`)
      return Response.json({
        total_count: 1,
        check_runs: [
          {
            id: 77,
            name: "Workers Builds: hive",
            head_sha: p.remote.mergeSha,
            app: { id: 85455, slug: "cloudflare-workers-and-pages" },
            external_id: buildUuid,
            status: "completed",
            conclusion: "success",
            details_url: `https://dash.cloudflare.com/${p.config.target.accountId}/workers/services/view/hive/production/builds/${buildUuid}`,
          },
        ],
      });
    return p.fetcher(raw, init);
  };
  vi.stubGlobal("fetch", fetcher);
  mocks.host.mockImplementation(async (_user, workspace, path, request, options) => {
    expect(workspace).toBe(f.host.workspaceId);
    expect(path).toBe("/projects/production-release");
    expect(options.expectedBuildId).toBe(f.host.buildId);
    return hostProductionRelease({ request, token: "explicit-fixture-connected-token" }, fetcher);
  });
  for (const [key, value] of Object.entries({
    HIVE_DELIVERY_RELEASE_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
    HIVE_NATIVE_MODE: "production",
    HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify(p.config),
  }))
    vi.stubEnv(key, value);
  const tested = createAutomaticReleaseTestStore(db, p.config, fetcher),
    signal = AbortSignal.timeout(60000),
    challenge = await tested.challenge(p.testRequest, p.token(p.testRequest), signal),
    { purpose: _purpose, ...rest } = p.testRequest,
    attestation = { ...rest, purpose: "release_test_attestation", ...challenge };
  await tested.submit(attestation, p.token(attestation), signal);
  const controller = createInstalledReleaseController(db, process.env, fetcher)!;
  await controller.scheduler.tick(signal);
  await controller.scheduler.tick(signal);
  const action = await db.deliveryReleaseAction.findFirstOrThrow({
    where: { release: { taskId: f.taskId } },
  });
  expect(await controller.step(f.user.id, action.id, signal)).toBe("observed");
  expect(await controller.observe(f.user.id, action.releaseId, signal)).toBe("observing");
  await db.$executeRaw`SELECT pg_sleep(1.05)`;
  expect(await controller.observe(f.user.id, action.releaseId, signal)).toBe("healthy");
  expect(
    (
      await db.deliveryReleaseTarget.findUniqueOrThrow({
        where: { targetDigest: action.targetDigest },
      })
    ).activeReleaseId,
  ).toBe(action.releaseId);
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
  const claimWire = () =>
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
    );
  async function claim() {
    const wire = claimWire();
    const next = z
      .object({
        attemptId: z.string(),
        managerBindingId: z.string(),
        leaseGeneration: z.number(),
        version: z.number(),
        nativeSequence: z.number(),
      })
      .parse(await f.manager.execute(wire));
    const source = {
      ...f.source,
      parentTurnId: nextTurn,
      childThreadId: `production-${randomUUID()}`,
      childTurnId: randomUUID(),
      spawnCallId: randomUUID(),
    };
    await f.native.ingest(
      f.sourceEnvelope(
        next,
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
      f.sourceEnvelope(next, { ...source, kind: "turn_completed", status: "completed" }, 5, {
        stepId: step.id,
        sourceContext: application.accepted.sourceContext,
      }),
    );
    const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: next.managerBindingId },
    });
    return {
      next,
      wire,
      source,
      terminal: {
        ...f.terminal,
        stepId: step.id,
        attemptId: next.attemptId,
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
      },
    };
  }
  const services = completionServices(db, f);
  async function review(
    outcome: "pass" | "insufficient" = "pass",
    citeProduction = true,
    beforeFinish?: () => Promise<void>,
  ) {
    await services.service.dispatch(
      f.envelope({ action: "prepare_review", candidate: f.candidate }),
    );
    return f.claimAndFinish(
      services.service,
      (job) => {
        const payload = job.payload as {
          artifacts: { entryId: string; digest: string; bytes: number }[];
        };
        const artifact = payload.artifacts.find(
          (entry) => entry.entryId === (citeProduction ? "evidence:production" : "source:0"),
        )!;
        return {
          schemaVersion: 1,
          kind: "review",
          intentDigest: f.plan.intentDigest,
          planDigest: acceptanceDigest(f.plan),
          sourceSha: f.publication.headSha,
          inputDigest: job.inputDigest,
          outcome,
          requirements: f.plan.requirements.map((requirement) => ({
            id: requirement.id,
            meaningDigest: requireIntentDigest(requirement.meaning),
            outcome: requirement.phase === "activation_production" ? outcome : "outside_step_scope",
            rationale:
              outcome === "pass"
                ? "Scoped independently observed production smoke only"
                : "Generic health cannot establish unobserved business behavior",
            citations:
              requirement.phase === "activation_production" && outcome === "pass"
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
          unresolved: outcome === "insufficient" ? ["Business observation absent"] : [],
          rationale: "Explicit independent model-output fixture; no inference",
        };
      },
      beforeFinish,
    );
  }
  return {
    ...f,
    p,
    controller,
    action,
    step,
    claim,
    claimWire,
    services,
    review,
    drift: () => {
      drift = true;
    },
    probes: () => probes,
  };
}

describe.skipIf(!url)("production semantic acceptance in the existing engine", () => {
  it("replays the exact signed production claim without a fresh probe, new attempt or runnable authority", async () => {
    const f = await fixture(),
      execution = await f.claim(),
      probes = f.probes();
    const result = await f.manager.execute(execution.wire);
    expect(result).toMatchObject({
      attemptId: execution.next.attemptId,
      replayed: true,
      canRun: false,
      needsReconciliation: true,
    });
    expect(f.probes()).toBe(probes);
    expect(await db.deliveryAttempt.count({ where: { stepId: f.step.id } })).toBe(1);
    const { proof: _proof, command: _command, ...metadata } = execution.wire;
    const altered = f.managerEnvelope(
      {
        operation: "claim_step",
        payload: {
          taskId: f.taskId,
          stepId: f.step.id,
          expectedVersion: f.step.version + 1,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      },
      metadata,
    );
    await expect(f.manager.execute(altered)).rejects.toThrow("event_replay_conflict");
    await db.deliveryRepositoryPolicyVersion.updateMany({
      where: { ownerId: f.user.id, projectId: f.project.id },
      data: { revokedAt: new Date() },
    });
    await expect(f.manager.execute(execution.wire)).rejects.toThrow();
    expect(f.probes()).toBe(probes);
    expect(await db.deliveryAttempt.count({ where: { stepId: f.step.id } })).toBe(1);
  }, 60000);
  it("collects a current serving observation before the first production claim after the old receipt expires", async () => {
    const f = await fixture();
    const latest = (
      await db.$queryRaw<{ evidence: { expiresAt: number } }[]>`
      SELECT evidence FROM delivery_release_observations WHERE release_id=${f.action.releaseId}::uuid
      AND kind='automatic_health' ORDER BY created_at DESC,id DESC LIMIT 1`
    )[0];
    await db.$executeRaw`SELECT pg_sleep(30.1)`;
    expect(latest.evidence.expiresAt).toBeLessThan(Date.now());
    const probes = f.probes(),
      execution = await f.claim();
    expect(f.probes()).toBeGreaterThan(probes);
    expect(
      await db.deliveryAttempt.findUniqueOrThrow({ where: { id: execution.next.attemptId } }),
    ).toMatchObject({
      sourceSha: f.publication.headSha,
      outputRevisionId: null,
      outcome: "running",
    });
    expect(await db.deliveryAttempt.count({ where: { stepId: f.step.id } })).toBe(1);
    expect(f.p.remote.writes).toBe(1);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.action.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(f.action.releaseId);
  }, 60000);
  it("retains unsupported, paused and serving-drift holds before admitting a production claim", async () => {
    const unsupported = await fixture(false, false),
      beforeUnsupported = unsupported.probes();
    await expect(unsupported.claim()).rejects.toThrow(
      "acceptance_production_observation_unavailable",
    );
    expect(unsupported.probes()).toBe(beforeUnsupported);
    expect(await db.deliveryAttempt.count({ where: { stepId: unsupported.step.id } })).toBe(0);
    const paused = await fixture(),
      beforePaused = paused.probes();
    await db.deliveryTask.update({ where: { id: paused.taskId }, data: { pauseRequested: true } });
    await expect(paused.claim()).rejects.toThrow("task_paused");
    expect(paused.probes()).toBe(beforePaused);
    const drift = await fixture();
    drift.drift();
    await expect(drift.claim()).rejects.toThrow("acceptance_production_observation_unavailable");
    expect(await db.deliveryAttempt.count({ where: { stepId: drift.step.id } })).toBe(0);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: drift.action.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(drift.action.releaseId);
  }, 60000);
  it("claims unchanged source, pins production input across refresh, independently completes once and releases only deployment fence", async () => {
    const f = await fixture(),
      execution = await f.claim(),
      reviewed = await f.review();
    const stored = await db.deliveryAcceptanceJob.findUniqueOrThrow({
      where: { id: reviewed.job.jobId },
    });
    expect(
      (stored.material as { production: { sourceSha: string; mergeSha: string } }).production,
    ).toMatchObject({ sourceSha: f.publication.headSha, mergeSha: f.p.remote.mergeSha });
    expect(
      await db.deliveryAttempt.findUniqueOrThrow({ where: { id: execution.next.attemptId } }),
    ).toMatchObject({ outputRevisionId: null, sourceSha: f.publication.headSha });
    const count = f.probes();
    const wire = () =>
      f.envelope({
        action: "complete_verified",
        terminal: { ...execution.terminal, observedAt: new Date().toISOString() },
      });
    const first = await f.services.service.dispatch(wire());
    expect(f.probes()).toBeGreaterThan(count);
    expect((first.result as { phase: string }).phase).toBe("completed");
    expect((await f.services.service.dispatch(wire())).result).toEqual(first.result);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.action.targetDigest },
        })
      ).activeReleaseId,
    ).toBeNull();
    expect(
      await db.deliveryAttempt.count({ where: { ownerId: f.user.id, quiescedAt: { not: null } } }),
    ).toBe(0);
    expect(
      await db.deliverySourceRevision.count({ where: { ownerId: f.user.id, taskId: f.taskId } }),
    ).toBe(1);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, repositoryPolicyStore(db), {
          ownerId: f.user.id,
          taskId: f.taskId,
          sourceSha: f.publication.headSha,
        }),
      ),
    ).toBe(true);
    expect(
      (await db.deliveryEvidence.findUniqueOrThrow({ where: { id: reviewed.job.jobId } }))
        .verificationMode,
    ).toBe("production");
  }, 60000);
  it("does not complete a reviewed source if the actual serving build drifts after review", async () => {
    const f = await fixture(),
      execution = await f.claim();
    await f.review();
    f.drift();
    await expect(
      f.services.service.dispatch(
        f.envelope({ action: "complete_verified", terminal: execution.terminal }),
      ),
    ).rejects.toThrow();
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: f.step.id } })).state).toBe(
      "running",
    );
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.action.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(f.action.releaseId);
  }, 60000);
  it("rolls back last-step completion writes when the final serving proof expires after earlier acceptance checks", async () => {
    const f = await fixture(),
      execution = await f.claim();
    await f.review();
    const beforeStep = await db.deliveryStep.findUniqueOrThrow({ where: { id: f.step.id } });
    let reachedCompletionWrites = false,
      projectedFinalClock = 0;
    const transact = db.$transaction.bind(db);
    const interception = vi.spyOn(db, "$transaction");
    // Inject only the database clock returned by the final freshness query,
    // after real step/attempt/report/success-event writes. Sleeping30s inside
    // the real10s transaction would test a timeout instead of this final gate.
    const injected = async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: object,
    ) =>
      transact(async (tx) => {
        let completionWritten = false;
        const wrapped = new Proxy(tx, {
          get(target, key) {
            if (key === "deliveryEvent")
              return new Proxy(target.deliveryEvent, {
                get(delegate, operation) {
                  if (operation !== "create") return Reflect.get(delegate, operation);
                  return async (args: Prisma.DeliveryEventCreateArgs) => {
                    const row = await delegate.create(args);
                    if (
                      args.data.type === "acceptance_success_completed" &&
                      args.data.stepId === f.step.id
                    ) {
                      completionWritten = true;
                      const step = await target.deliveryStep.findUniqueOrThrow({
                        where: { id: f.step.id },
                      });
                      const reports = await target.deliveryStepReport.count({
                        where: { stepId: f.step.id },
                      });
                      const attempt = await target.deliveryAttempt.findUniqueOrThrow({
                        where: { id: execution.next.attemptId },
                      });
                      reachedCompletionWrites =
                        step.state === "succeeded" &&
                        reports === 1 &&
                        attempt.outcome === "succeeded";
                    }
                    return row;
                  };
                },
              });
            if (key === "$queryRaw")
              return async (...args: Parameters<Prisma.TransactionClient["$queryRaw"]>) => {
                const rows = await target.$queryRaw(...args);
                const query = args[0];
                const sql = Array.isArray(query) ? query.join(" ").replace(/\s+/g, " ") : "";
                if (
                  completionWritten &&
                  sql.includes("clock_timestamp() AS now FROM delivery_release_observations")
                ) {
                  const clock = await target.$queryRaw<
                    { now: Date }[]
                  >`SELECT clock_timestamp()+interval '31 seconds' AS now`;
                  projectedFinalClock++;
                  return (rows as { now: Date }[]).map((row) => ({ ...row, now: clock[0].now }));
                }
                return rows;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return work(wrapped);
      }, options);
    interception.mockImplementation(injected as typeof db.$transaction);
    try {
      await expect(
        f.services.service.dispatch(
          f.envelope({
            action: "complete_verified",
            terminal: { ...execution.terminal, observedAt: new Date().toISOString() },
          }),
        ),
      ).rejects.toThrow("automatic_release_authority_unavailable");
    } finally {
      interception.mockRestore();
      // Prisma exposes this through a lazy proxy. Vitest's descriptor restore
      // can delete the callable property; explicitly restore the real bound
      // method so later cases keep using the actual transaction engine.
      Object.defineProperty(db, "$transaction", {
        value: transact,
        configurable: true,
        writable: true,
      });
    }
    expect(reachedCompletionWrites).toBe(true);
    expect(projectedFinalClock).toBe(1);
    expect(await db.deliveryStep.findUniqueOrThrow({ where: { id: f.step.id } })).toEqual(
      beforeStep,
    );
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: execution.next.attemptId } }))
        .outcome,
    ).toBe("running");
    expect(await db.deliveryStepReport.count({ where: { stepId: f.step.id } })).toBe(0);
    expect(
      await db.deliveryEvent.count({
        where: {
          taskId: f.taskId,
          stepId: f.step.id,
          type: { in: ["step_completed", "acceptance_success_completed"] },
        },
      }),
    ).toBe(0);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "production_acceptance_finalized" },
      }),
    ).toBe(0);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.action.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(f.action.releaseId);
  }, 60000);
  it("keeps the pinned review input valid when its first health observation expires during a longer independent review", async () => {
    const f = await fixture(true),
      execution = await f.claim();
    const reviewed = await f.review("pass", true, async () => {
      await db.$executeRaw`SELECT pg_sleep(30.1)`;
    });
    const job = await db.deliveryAcceptanceJob.findUniqueOrThrow({
      where: { id: reviewed.job.jobId },
    });
    expect(job.inputDigest).toBe(reviewed.job.inputDigest);
    const stored = job.material as { production: { observation: { expiresAt: number } } };
    expect(stored.production.observation.expiresAt).toBeLessThan(Date.now());
    const result = await f.services.service.dispatch(
      f.envelope({
        action: "complete_verified",
        terminal: { ...execution.terminal, observedAt: new Date().toISOString() },
      }),
    );
    expect((result.result as { phase: string }).phase).toBe("completed");
  }, 60000);
  it("keeps generic health insufficient for unobserved business semantics and rejects source-only production passes", async () => {
    const f = await fixture(),
      execution = await f.claim();
    await f.review("insufficient");
    await expect(
      f.services.service.dispatch(
        f.envelope({ action: "complete_verified", terminal: execution.terminal }),
      ),
    ).rejects.toThrow();
    expect(
      (await f.services.service.dispatch(f.envelope({ action: "repair_prepare" }))).result,
    ).toMatchObject({ phase: "held", reason: "production_semantics_unverified" });
    const g = await fixture();
    await g.claim();
    await expect(g.review("pass", false)).rejects.toThrow("acceptance_production_coverage_missing");
  }, 60000);
  it("rejects default-off claims, foreign task anchors, pauses and revoked repository authority", async () => {
    const f = await fixture();
    vi.stubEnv("HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED", "false");
    await expect(f.manager.execute(f.claimWire())).rejects.toThrow("release_disabled");
    vi.stubEnv("HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED", "true");
    await f.claim();
    const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } });
    const anchor = await db.$transaction((tx) =>
      productionAcceptanceStepMaterial(tx, {
        ownerId: f.user.id,
        taskId: f.taskId,
        stepId: f.step.id,
        sourceRevisionId: task.sourceRevisionId!,
        sourceSha: task.sourceSha,
      }),
    );
    await expect(
      db.$transaction((tx) =>
        productionAcceptanceStepMaterial(
          tx,
          {
            ownerId: f.user.id,
            taskId: randomUUID(),
            stepId: f.step.id,
            sourceRevisionId: task.sourceRevisionId!,
            sourceSha: task.sourceSha,
          },
          anchor,
        ),
      ),
    ).rejects.toThrow();
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: true } });
    await expect(
      f.services.service.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate })),
    ).rejects.toThrow();
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: false } });
    await db.deliveryRepositoryPolicyVersion.updateMany({
      where: { ownerId: f.user.id, projectId: f.project.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      f.services.service.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate })),
    ).rejects.toThrow();
  }, 60000);
});
