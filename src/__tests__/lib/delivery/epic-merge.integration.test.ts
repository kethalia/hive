import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: undefined as unknown, host: vi.fn() }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));

import {
  epicMergeConfigSchema,
  epicMergePreparedSchema,
} from "@/lib/delivery/epic-merge-contracts";
import { createEpicMergeTestStore, epicMergeForTask } from "@/lib/delivery/epic-merge-host.server";
import { EpicPreviewMergeLifecycle } from "@/lib/delivery/epic-merge-lifecycle.server";
import { reconcileEpicPreviewMerge } from "@/lib/delivery/epic-merge-reconcile.server";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { releaseActionIdentitySchema } from "@/lib/delivery/release-action-journal";
import { PostgresReleaseEffectJournal } from "@/lib/delivery/release-effect-journal.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import { createInstalledReleaseTestStoreForRequest } from "@/lib/delivery/release-tested-installed.server";
import { repositoryPolicyStore } from "@/lib/delivery/repository-policy.server";
import { hostEpicMerge } from "../../../../scripts/host-epic-merge";
import { admittedEpicMergeFixture } from "./epic-merge-fixture";
import { epicMergeProviderFixture } from "./epic-merge-provider-fixture";

const url = process.env.HIVE_EPIC_MERGE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/hive_acceptance_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname))
)
  throw Error("Private owned fixture database only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_epic_merge_20261107",
});
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.host.mockReset();
});
async function fixture() {
  const f = await admittedEpicMergeFixture(db, mocks.host),
    p = await epicMergeProviderFixture(db, f);
  mocks.host.mockImplementation(async (user, workspace, path, request, options) => {
    if (path !== "/projects/epic-merge")
      return f.originalHost(user, workspace, path, request, options);
    expect(user).toEqual({ id: f.root.user.id, coderUserId: f.root.user.coderUserId });
    expect(options.expectedBuildId).toBe(f.builds.get(workspace));
    const result = await hostEpicMerge({ request, token: "fixture-connected-secret" }, p.fetcher);
    expect(JSON.stringify(result)).not.toContain("fixture-connected-secret");
    if (request.operation === "dispatch" && p.remote.lose202)
      throw Error("Explicit lost Coder acknowledgement after actual provider acceptance");
    return result;
  });
  const test = createEpicMergeTestStore(db, p.config, p.fetcher),
    signal = AbortSignal.timeout(30000);
  const challenge = await test.challenge(p.testRequest, p.token(p.testRequest), signal);
  const { purpose: _purpose, ...rest } = p.testRequest;
  const attestation = { ...rest, purpose: "release_test_attestation", ...challenge };
  await test.submit(attestation, p.token(attestation), signal);
  const env = {
    HIVE_DELIVERY_EPICS_ENABLED: "true",
    HIVE_DELIVERY_EPIC_MERGE_ENABLED: "true",
    HIVE_DELIVERY_EPIC_MERGE_CONFIG_JSON: JSON.stringify(p.config),
  };
  return { ...f, ...p, test, env, signal };
}
describe.skipIf(!url)("actual journaled preview integration via connected GitHub helper", () => {
  it("uses genuine OIDC/native/semantic authority and an attributed merge to finish only integration, keeping production and writers pending", async () => {
    const f = await fixture();
    const selected = await createInstalledReleaseTestStoreForRequest(
      db,
      f.testRequest,
      {
        ...f.env,
        HIVE_DELIVERY_RELEASE_ENABLED: "true",
        HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
      },
      f.fetcher,
    );
    if (!selected) throw Error("Fixture preview producer unavailable");
    expect(
      await selected.verifyFresh(
        f.child.user.id,
        f.child.taskId,
        epicMergePreparedSchema.parse(
          await epicMergeForTask(
            db,
            f.config,
            { ...f.scope, taskId: f.child.taskId },
            { operation: "prepare" },
            f.signal,
          ),
        ).request,
        f.signal,
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
    const store = repositoryPolicyStore(db),
      lifecycle = new EpicPreviewMergeLifecycle(db, f.config, store);
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("waiting");
    expect(f.remote.writes).toBe(1);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.child.taskId } },
    });
    expect(action).toMatchObject({
      phase: "held",
      kind: "merge",
      remoteReference: { provider: "github" },
    });
    await expect(
      db.deliveryRelease.update({ where: { id: action.releaseId }, data: { phase: "integrated" } }),
    ).rejects.toThrow("release_integration_receipt_required");
    await expect(
      db.deliveryRelease.update({
        where: { id: action.releaseId },
        data: { purpose: "deployment" },
      }),
    ).rejects.toThrow("release_transition");
    const identity = releaseActionIdentitySchema.parse({
      id: action.id,
      releaseId: action.releaseId,
      kind: action.kind,
      targetDigest: action.targetDigest,
      request: action.request,
      requestDigest: action.requestDigest,
      generation: action.generation,
    });
    // Current semantic invalidation blocks the real authorizer, even with a
    // correctly attributed pending provider request and a valid OIDC receipt.
    await expect(
      db.$transaction(async (tx) => {
        await tx.deliveryEvidence.update({
          where: { id: f.child.semanticEvidenceId },
          data: { invalidatedAt: new Date() },
        });
        expect(await lifecycle.authorize(tx, identity)).toBe(false);
        throw Error("rollback explicit local semantic invalidation");
      }),
    ).rejects.toThrow("rollback explicit local semantic invalidation");
    await db.deliveryTask.update({ where: { id: f.child.taskId }, data: { pauseRequested: true } });
    expect(
      await new PostgresReleaseEffectJournal(
        db,
        f.child.user.id,
        lifecycle.authorize,
      ).reconciliation(action.id),
    ).toBeNull();
    await db.deliveryTask.update({
      where: { id: f.child.taskId },
      data: { pauseRequested: false },
    });
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("integrated");
    expect(f.remote.writes).toBe(1);
    expect(f.remote.lookups).toBe(1);
    const release = await db.deliveryRelease.findUniqueOrThrow({ where: { id: action.releaseId } });
    expect(release).toMatchObject({ phase: "integrated", purpose: "epic_preview_integration" });
    expect(release.snapshot).not.toHaveProperty("baselines");
    expect(release.snapshot).not.toHaveProperty("observationWindowMs");
    expect(await db.deliveryReleaseObservation.count({ where: { releaseId: release.id } })).toBe(0);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: release.targetDigest },
        })
      ).activeReleaseId,
    ).toBeNull();
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.child.taskId, type: "release_integrated" },
      }),
    ).toBe(1);
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("integrated");
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.child.taskId, type: "release_integrated" },
      }),
    ).toBe(1);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, store, {
          ownerId: f.child.user.id,
          taskId: f.child.taskId,
          sourceSha: f.source.headSha,
        }),
      ),
    ).toBe(false);
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.child.claim.managerBindingId },
        })
      ).activeAttemptId,
    ).not.toBeNull();
    expect(
      await db.$queryRaw`SELECT phase FROM delivery_epic_writer_reservations WHERE task_id=${f.child.taskId}::uuid`,
    ).toEqual([{ phase: "held" }]);
    expect(
      await db.deliveryStep.count({
        where: {
          taskId: f.child.taskId,
          acceptancePhase: "activation_production",
          state: { not: "succeeded" },
        },
      }),
    ).toBeGreaterThan(0);
    await expect(
      db.deliveryRelease.update({ where: { id: release.id }, data: { phase: "healthy" } }),
    ).rejects.toThrow();
  }, 60000);
  it("never redispatches after a lost 202 acknowledgement and retains the target fence", async () => {
    const f = await fixture();
    f.remote.lose202 = true;
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("waiting");
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { release: { taskId: f.child.taskId } },
    });
    expect(action).toMatchObject({ phase: "held", remoteReference: null, receipt: null });
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("waiting");
    expect(f.remote.writes).toBe(1);
    expect(f.remote.lookups).toBe(0);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: action.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(action.releaseId);
  }, 60000);
  it("holds a prepared action when the base changes before dispatch; main/default/rules/check/control changes grant no write", async () => {
    const f = await fixture(),
      lifecycle = new EpicPreviewMergeLifecycle(db, f.config, repositoryPolicyStore(db));
    const scope = { ...f.scope, taskId: f.child.taskId };
    const prepared = epicMergePreparedSchema.parse(
      await epicMergeForTask(db, f.config, scope, { operation: "prepare" }, f.signal),
    );
    const proof = await f.test.verifyFresh(
      f.child.user.id,
      f.child.taskId,
      prepared.request,
      f.signal,
    );
    const opened = await lifecycle.open({
      id: randomUUID(),
      ownerId: f.child.user.id,
      taskId: f.child.taskId,
      prepared,
      testedAttestationDigest: proof,
      observedAt: Date.now(),
    });
    expect(await lifecycle.advance(f.child.user.id, opened.releaseId)).toBe("prepared");
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: opened.releaseId },
    });
    const original = mocks.host.getMockImplementation()!;
    mocks.host.mockImplementation(async (...args) => {
      if (args[2] === "/projects/epic-merge" && args[3].operation === "dispatch")
        f.remote.baseSha = "2".repeat(40);
      return original(...args);
    });
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("waiting");
    expect(f.remote.writes).toBe(0);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: action.id } })).phase,
    ).toBe("held");
    f.remote.baseSha = prepared.request.baseSha;
    expect(await reconcileEpicPreviewMerge(db, f.scope, f.signal, f.env)).toBe("waiting");
    expect(f.remote.writes).toBe(0);
    expect(
      epicMergeConfigSchema.safeParse({
        ...f.config,
        policy: { ...f.config.policy, baseBranch: "main" },
      }).success,
    ).toBe(false);
    for (const [field, bad, good] of [
      ["defaultBranch", f.source.baseBranch, "main"],
      ["failedRules", true, false],
      ["failedCheck", true, false],
      ["filename", "src/lib/delivery/release-evidence.server.ts", "src/fixture.ts"],
    ] as const) {
      Object.assign(f.remote, { [field]: bad });
      await expect(
        epicMergeForTask(db, f.config, scope, { operation: "prepare" }, f.signal),
      ).rejects.toThrow();
      Object.assign(f.remote, { [field]: good });
    }
    for (const path of [
      "src/lib/delivery/epic-merge-lifecycle.server.ts",
      "src/lib/delivery/epic-readiness.server.ts",
    ]) {
      f.remote.filename = path;
      await expect(
        epicMergeForTask(db, f.config, scope, { operation: "prepare" }, f.signal),
      ).rejects.toThrow();
      f.remote.filename = "src/ordinary.ts";
      f.remote.previousFilename = path;
      await expect(
        epicMergeForTask(db, f.config, scope, { operation: "prepare" }, f.signal),
      ).rejects.toThrow();
      f.remote.previousFilename = undefined;
    }
    expect(f.remote.writes).toBe(0);
    expect(githubSourceDigest(prepared.request)).toBe(action.requestDigest);
  }, 60000);
});
