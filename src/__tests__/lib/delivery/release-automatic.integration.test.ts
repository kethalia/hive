import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: undefined as unknown, host: vi.fn() }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));

import { epicMergePreparedSchema } from "@/lib/delivery/epic-merge-contracts";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  finalizeProductionAcceptance,
  readProductionAcceptanceAnchor,
  verifyProductionAcceptanceAnchor,
} from "@/lib/delivery/release-automatic-acceptance.server";
import {
  automaticReleaseForTask,
  createAutomaticReleaseTestStore,
} from "@/lib/delivery/release-automatic-host.server";
import { AutomaticReleaseLifecycle } from "@/lib/delivery/release-automatic-lifecycle.server";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";
import { repositoryPolicyStore } from "@/lib/delivery/repository-policy.server";
import { automaticWorkerHealth } from "../../../../deploy/cloudflare/app/automatic-health";
import { hostEpicMerge, hostProductionRelease } from "../../../../scripts/host-epic-merge";
import * as authDomain from "../../../../services/auth/src/auth/domain";
import { createFetchAuthHandler } from "../../../../services/auth/src/fetch-handler";
import { acceptanceFixtureKey } from "./acceptance-fixture";
import { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";
import { automaticReleaseProviderFixture } from "./release-automatic-provider-fixture";

const url = process.env.HIVE_AUTOMATIC_RELEASE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/hive_acceptance_test_automatic_[a-z0-9_]+$/.test(new URL(url).pathname))
)
  throw Error("Owned local fixture database only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_automatic_unused",
});
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.host.mockReset();
});
async function fixture(attestationLifetimeMs = 600000) {
  const f = await verifiedEpicPreviewFixture(db, {
    baseBranch: "main",
    activationRequirement: true,
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
    buildUuid = randomUUID(),
    signal = AbortSignal.timeout(30000);
  const authEnv: Record<string, string | undefined> = {
    ENCRYPTION_KEY: acceptanceFixtureKey,
    COOKIE_SECRET: "b".repeat(64),
    HIVE_CODER_OAUTH_ENABLED: "true",
    CODER_URL: "https://coder.example.invalid",
    HIVE_PUBLIC_ORIGIN: p.config.target.origin,
    HIVE_CODER_OAUTH_CLIENT_ID: "fixture-client",
    HIVE_CODER_OAUTH_CLIENT_SECRET: "fixture-client-secret",
  };
  let dispatchPreflightDelay = 0;
  let healthReady = true,
    wrongBuild = false,
    wrongApp = false;
  const fetcher: typeof fetch = async (raw, init) => {
    const target = new URL(String(raw));
    if (target.origin === p.config.target.origin)
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
            sourceSha: wrongBuild ? "0".repeat(40) : p.remote.mergeSha,
            buildUuid,
            branch: "main",
          },
        },
        async () => {
          await db.$queryRaw`SELECT 1`;
          return healthReady;
        },
        async () =>
          (
            await createFetchAuthHandler("a".repeat(64), {
              ...authDomain,
              readAuthenticationReadiness: (options) =>
                authDomain.readAuthenticationReadiness({ ...options, env: authEnv, db }),
            })(
              new Request("https://auth.internal/readiness", {
                headers: { Authorization: `Bearer ${"a".repeat(64)}` },
              }),
            )
          ).ok,
      );
    if (target.pathname === `/repos/${p.source.fullName}/commits/${p.remote.mergeSha}/check-runs`) {
      p.remote.reads.push(target.pathname + target.search);
      return Response.json({
        total_count: 1,
        check_runs: [
          {
            id: 77,
            name: "Workers Builds: hive",
            head_sha: p.remote.mergeSha,
            app: { id: wrongApp ? 1 : 85455, slug: "cloudflare-workers-and-pages" },
            external_id: buildUuid,
            status: "completed",
            conclusion: "success",
            details_url: `https://dash.cloudflare.com/${p.config.target.accountId}/workers/services/view/hive/production/builds/${buildUuid}`,
          },
        ],
      });
    }
    return p.fetcher(raw, init);
  };
  mocks.host.mockImplementation(async (user, workspace, path, request, options) => {
    expect(path).toBe("/projects/production-release");
    expect(user.id).toBe(f.user.id);
    expect(workspace).toBe(f.host.workspaceId);
    expect(options.expectedBuildId).toBe(f.host.buildId);
    let delayed = false;
    const connectedFetch: typeof fetch = async (raw, init) => {
      if (request.operation === "dispatch" && dispatchPreflightDelay && !delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, dispatchPreflightDelay));
      }
      return fetcher(raw, init);
    };
    const result = await hostProductionRelease(
      { request, token: "fixture-connected-secret" },
      connectedFetch,
    );
    expect(JSON.stringify(result)).not.toContain("fixture-connected-secret");
    if (request.operation === "dispatch" && p.remote.lose202)
      throw Error("Explicit lost ACK after accepted provider effect");
    return result;
  });
  const tested = createAutomaticReleaseTestStore(db, p.config, fetcher, attestationLifetimeMs),
    challenge = await tested.challenge(p.testRequest, p.token(p.testRequest), signal),
    { purpose: _purpose, ...rest } = p.testRequest,
    attestation = { ...rest, purpose: "release_test_attestation", ...challenge };
  await tested.submit(attestation, p.token(attestation), signal);
  const env = {
    HIVE_DELIVERY_RELEASE_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
    HIVE_NATIVE_MODE: "production",
    HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify(p.config),
  };
  const controller = createInstalledReleaseController(db, env, fetcher);
  if (!controller || !("observationScope" in controller.lifecycle))
    throw Error("Automatic fixture controller unavailable");
  const prepared = epicMergePreparedSchema.parse(
    await automaticReleaseForTask(
      db,
      p.config,
      { ownerId: f.user.id, taskId: f.taskId },
      { operation: "prepare" },
      signal,
    ),
  );
  return {
    ...f,
    ...p,
    env,
    controller: { ...controller, lifecycle: controller.lifecycle },
    tested,
    signal,
    prepared,
    fetcher,
    buildUuid,
    authEnv,
    setDispatchPreflightDelay: (value: number) => {
      dispatchPreflightDelay = value;
    },
    setHealth: (value: boolean) => {
      healthReady = value;
    },
    setWrongBuild: (value: boolean) => {
      wrongBuild = value;
    },
    setWrongApp: (value: boolean) => {
      wrongApp = value;
    },
  };
}
describe.skipIf(!url)("single Worker automatic Builds production journal", () => {
  it("uses connected merge then real health/DB and app85455 build identity without upload/promote or extra provider writes", async () => {
    const f = await fixture();
    expect(f.controller.builds).toBeNull();
    await f.controller.scheduler.tick(f.signal);
    let action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.taskId } },
    });
    expect(action.kind).toBe("merge");
    expect(action.phase).toBe("prepared");
    await f.controller.scheduler.tick(f.signal);
    action = await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(action.phase).toBe("held");
    expect(f.remote.writes).toBe(1);
    await f.controller.scheduler.tick(f.signal);
    await f.controller.scheduler.tick(f.signal);
    expect(f.remote.writes).toBe(1);
    const scope = await f.controller.lifecycle.observationScope(f.user.id, action.releaseId);
    expect(scope?.receipt.mergeSha).toBe(f.remote.mergeSha);
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("observing");
    await db.$executeRaw`SELECT pg_sleep(1.05)`;
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("healthy");
    const release = await db.deliveryRelease.findUniqueOrThrow({ where: { id: action.releaseId } });
    expect(release).toMatchObject({ phase: "healthy", purpose: "automatic_production" });
    expect(
      await db.deliveryReleaseAction.findMany({
        where: { releaseId: release.id },
        select: { kind: true },
      }),
    ).toEqual([{ kind: "merge" }]);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: release.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(release.id);
    const current = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } });
    const anchor = await db.$transaction((tx) =>
      readProductionAcceptanceAnchor(tx, f.config, {
        ownerId: f.user.id,
        taskId: f.taskId,
        sourceRevisionId: current.sourceRevisionId!,
        sourceSha: current.sourceSha,
      }),
    );
    expect(anchor?.mergeSha).toBe(f.remote.mergeSha);
    if (!anchor) throw Error("Expected real healthy anchor");
    expect(
      await db.$transaction((tx) =>
        verifyProductionAcceptanceAnchor(tx, f.config, anchor, { fresh: true }),
      ),
    ).toBe(true);
    expect(await db.$transaction((tx) => finalizeProductionAcceptance(tx, f.config, anchor))).toBe(
      false,
    );
    expect(await f.controller.observe(f.user.id, release.id, f.signal)).toBe("healthy");
    expect(
      githubSourceDigest(
        await db.$transaction((tx) => readProductionAcceptanceAnchor(tx, f.config, anchor)),
      ),
    ).toBe(githubSourceDigest(anchor));
    for (const patch of [
      { sourceSha: "0".repeat(40) },
      { buildDigest: "0".repeat(64) },
      { policyDigest: "0".repeat(64) },
    ])
      expect(
        await db.$transaction((tx) =>
          verifyProductionAcceptanceAnchor(tx, f.config, { ...anchor, ...patch }, { fresh: true }),
        ),
      ).toBe(false);
    expect(
      await db.deliveryAttempt.count({ where: { ownerId: f.user.id, quiescedAt: { not: null } } }),
    ).toBe(0);
    expect(
      (
        await db.deliveryStep.findMany({
          where: { taskId: f.taskId, acceptancePhase: "activation_production" },
        })
      ).every((step) => ["pending", "ready"].includes(step.state)),
    ).toBe(true);
    expect(
      createInstalledReleaseController(db, {
        ...f.env,
        HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "false",
      }),
    ).toBeNull();
  }, 30000);
  it("retains the attributed202 ACK after a sixteen-second actual read-only dispatch preflight", async () => {
    const f = await fixture();
    await f.controller.scheduler.tick(f.signal);
    f.setDispatchPreflightDelay(16000);
    const result = await f.controller.scheduler.tick(f.signal);
    expect(result).toMatchObject({ actions: 1, held: 0 });
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.taskId } },
    });
    expect(action).toMatchObject({ phase: "held", remoteReference: { provider: "github" } });
    expect(action.remoteReference).not.toBeNull();
    expect(f.remote.writes).toBe(1);
  }, 30000);
  it("keeps immutable tested-tree provenance after expiry without granting a new dispatch", async () => {
    const f = await fixture(5000),
      scope = { ownerId: f.user.id, taskId: f.taskId };
    const receipt = await f.tested.verifyFresh(f.user.id, f.taskId, f.prepared.request, f.signal);
    for (const prepared of [
      { ...f.prepared, testedTreeSha: "0".repeat(40) },
      { ...f.prepared, request: { ...f.prepared.request, headSha: "0".repeat(40) } },
    ])
      await expect(
        f.controller.lifecycle.open({
          id: randomUUID(),
          ...scope,
          prepared,
          testedAttestationDigest: receipt,
          observedAt: Date.now(),
        }),
      ).rejects.toThrow("automatic_release_authority_unavailable");
    const wrongPolicy = new AutomaticReleaseLifecycle(
      db,
      { ...f.config, policy: { ...f.config.policy, versionId: randomUUID() } },
      repositoryPolicyStore(db),
    );
    await expect(
      wrongPolicy.open({
        id: randomUUID(),
        ...scope,
        prepared: f.prepared,
        testedAttestationDigest: receipt,
        observedAt: Date.now(),
      }),
    ).rejects.toThrow("automatic_release_authority_unavailable");
    await f.controller.scheduler.tick(f.signal);
    await f.controller.scheduler.tick(f.signal);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.taskId } },
    });
    expect(f.remote.writes).toBe(1);
    const expiry = (
      await db.$queryRaw<
        { expires_at: Date }[]
      >`SELECT expires_at FROM delivery_release_test_attestations WHERE owner_id=${f.user.id}::uuid AND task_id=${f.taskId}::uuid`
    )[0].expires_at;
    const remaining = Math.max(0, expiry.getTime() - Date.now()) / 1000 + 0.05;
    await db.$executeRaw`SELECT pg_sleep(${remaining})`;
    await expect(
      f.tested.verifyFresh(f.user.id, f.taskId, f.prepared.request, f.signal),
    ).rejects.toThrow("release_test_attestation_unavailable");
    expect(await f.controller.step(f.user.id, action.id, f.signal)).toBe("observed");
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("observing");
    await db.$executeRaw`SELECT pg_sleep(1.05)`;
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("healthy");
    expect(f.remote.writes).toBe(1);
  }, 30000);
  it("cannot mark production healthy with missing auth crypto/OAuth configuration even though public liveness succeeds", async () => {
    const f = await fixture();
    await f.controller.scheduler.tick(f.signal);
    await f.controller.scheduler.tick(f.signal);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.taskId } },
    });
    expect(await f.controller.step(f.user.id, action.id, f.signal)).toBe("observed");
    expect(
      (await createFetchAuthHandler("a".repeat(64))(new Request("https://auth.internal/health")))
        .status,
    ).toBe(200);
    for (const [key, value] of [
      ["ENCRYPTION_KEY", undefined],
      ["ENCRYPTION_KEY", "malformed"],
      ["HIVE_CODER_OAUTH_CLIENT_ID", undefined],
      ["HIVE_CODER_OAUTH_CLIENT_SECRET", undefined],
      ["CODER_URL", "http://invalid"],
      ["COOKIE_SECRET", undefined],
    ] as const) {
      const saved = f.authEnv[key];
      f.authEnv[key] = value;
      expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe(
        "awaiting_build",
      );
      expect(
        await db.deliveryReleaseObservation.count({ where: { releaseId: action.releaseId } }),
      ).toBe(0);
      f.authEnv[key] = saved;
    }
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("observing");
    expect(f.remote.writes).toBe(1);
  }, 30000);
  it("denies actual effect begin after proof expiry and retains semantic holds", async () => {
    const f = await fixture(5000);
    await f.controller.scheduler.tick(f.signal);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.taskId } },
    });
    const expiry = (
      await db.$queryRaw<
        { expires_at: Date }[]
      >`SELECT expires_at FROM delivery_release_test_attestations WHERE owner_id=${f.user.id}::uuid AND task_id=${f.taskId}::uuid`
    )[0].expires_at;
    await db.$executeRaw`SELECT pg_sleep(${Math.max(0, expiry.getTime() - Date.now()) / 1000 + 0.05})`;
    expect(await f.controller.step(f.user.id, action.id, f.signal)).toBe("not_started");
    expect(f.remote.writes).toBe(0);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: action.id } })).phase,
    ).toBe("prepared");
    const evidence = await db.deliveryEvidence.findFirstOrThrow({
      where: { id: f.semanticEvidenceId },
    });
    await db.deliveryEvidence.update({
      where: { id: evidence.id },
      data: { invalidatedAt: new Date() },
    });
    expect(await f.controller.lifecycle.observationScope(f.user.id, action.releaseId)).toBeNull();
  }, 30000);
  it("holds wrong serving/build authority and semantic invalidation; cannot use epic capability to write main", async () => {
    const f = await fixture();
    await f.controller.scheduler.tick(f.signal);
    await f.controller.scheduler.tick(f.signal);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.taskId } },
    });
    expect(await f.controller.step(f.user.id, action.id, f.signal)).toBe("observed");
    f.setWrongApp(true);
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe(
      "awaiting_build",
    );
    f.setWrongApp(false);
    f.setWrongBuild(true);
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe(
      "awaiting_build",
    );
    f.setWrongBuild(false);
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("observing");
    f.setHealth(false);
    expect(await f.controller.observe(f.user.id, action.releaseId, f.signal)).toBe("held");
    expect(f.remote.writes).toBe(1);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: action.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(action.releaseId);
    expect(() =>
      hostEpicMerge(
        {
          token: "fixture-connected-secret",
          request: {
            schemaVersion: 1,
            requestId: randomUUID(),
            operation: "prepare",
            config: f.config,
            source: {},
            gates: {},
          },
        },
        f.fetcher,
      ),
    ).toThrow();
  }, 30000);
});
