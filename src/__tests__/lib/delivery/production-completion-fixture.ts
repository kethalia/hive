import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect, vi } from "vitest";
import { z } from "zod";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { createAutomaticReleaseTestStore } from "@/lib/delivery/release-automatic-host.server";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";
import { automaticWorkerHealth } from "../../../../deploy/cloudflare/app/automatic-health";
import { hostProductionRelease } from "../../../../scripts/host-epic-merge";
import { completionServices } from "./acceptance-completion-fixture";
import { acceptanceFixtureKey, acceptanceFixtureProducer } from "./acceptance-fixture";
import { repairApplicationFixture } from "./acceptance-repair-fixture";
import { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";
import { automaticReleaseProviderFixture } from "./release-automatic-provider-fixture";

/** Shared real acceptance protocol; only provider/model outputs are local doubles. */
export async function productionCompletionFixture(
  db: PrismaClient,
  host: ReturnType<typeof vi.fn>,
  options: NonNullable<Parameters<typeof verifiedEpicPreviewFixture>[1]> = {},
  longReview = false,
  productionValidationOnly = true,
) {
  const f = await verifiedEpicPreviewFixture(db, {
    ...options,
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
  host.mockImplementation(async (_user, workspace, path, request, options) => {
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
    previewClaim: f.claim,
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
