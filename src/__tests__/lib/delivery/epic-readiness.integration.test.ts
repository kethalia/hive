import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: undefined as unknown, host: vi.fn() }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
// Only the external authenticated Coder/GitHub transport is doubled. The
// connected-reader schema, immutable plan/source, all gates, native launch,
// semantic/controller services and owner task enqueue are actual implementations.
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));

import { authorizeEpicClaim } from "@/lib/delivery/epic-claim.server";
import { epicDigest } from "@/lib/delivery/epic-contracts";
import {
  epicDependencyRelease,
  epicIntegrationDependency,
} from "@/lib/delivery/epic-dependency.server";
import { readEpicGitHubForTask } from "@/lib/delivery/epic-github-read.server";
import { observeEpicPreviewMerge } from "@/lib/delivery/epic-merge-observation.server";
import { expectedEpicIntent, writeEpicPlan } from "@/lib/delivery/epic-plan.server";
import { epicPreviewReadiness } from "@/lib/delivery/epic-readiness.server";
import { reserveEpicStart } from "@/lib/delivery/epic-start.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import { repositoryPolicyStore } from "@/lib/delivery/repository-policy.server";
import { startProjectTask } from "@/lib/projects/task.server";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import { acceptanceFixtureKey } from "./acceptance-fixture";
import { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";

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
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.host.mockReset();
});

describe.skipIf(!url)("actual preview child integration without production completion", () => {
  it("retains independent writers, observes an exact merge and schedules/claims a descendant only while current acceptance remains valid", async () => {
    const baseBranch = "epic/fixture",
      physical = "a".repeat(40),
      mergeSha = "c".repeat(40),
      integrated = "d".repeat(40);
    const root = await acceptanceCandidateFixture(db, undefined, {
      baseBranch,
      activationRequirement: true,
    });
    for (const flag of [
      "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
      "HIVE_DELIVERY_EXECUTION_ENABLED",
      "HIVE_DELIVERY_MANAGER_ENABLED",
      "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
      "HIVE_DELIVERY_EPICS_ENABLED",
    ])
      vi.stubEnv(flag, "true");
    vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(root.store.producer));
    vi.stubEnv("HIVE_CODEX_MANAGER_MODEL", "gpt-6.1-sol");
    vi.stubEnv("HIVE_CODEX_MANAGER_EFFORT", "low");
    vi.stubEnv("ENCRYPTION_KEY", acceptanceFixtureKey);
    const version = await db.deliveryRepositoryPolicyVersion.findFirstOrThrow({
      where: { ownerId: root.user.id, projectId: root.project.id },
    });
    vi.stubEnv(
      "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
      JSON.stringify([
        {
          ownerId: root.user.id,
          repositoryId: "123",
          providerAccountId: "456",
          fullName: root.project.fullName,
          policy: {
            schemaVersion: 1,
            source: version.sourcePolicy,
            evidenceGates: version.evidenceGates,
            acceptanceContracts: version.acceptanceContracts,
          },
        },
      ]),
    );
    const epicId = randomUUID(),
      childRequest = randomUUID(),
      integrationRequest = randomUUID();
    const childIntent = expectedEpicIntent(root.user.id, root.project.id, childRequest),
      integrationIntent = expectedEpicIntent(root.user.id, root.project.id, integrationRequest);
    const childWorkspace = randomUUID(),
      childBuild = randomUUID(),
      integrationWorkspace = randomUUID(),
      integrationBuild = randomUUID();
    const policy = {
      schemaVersion: 1,
      workspaces: [
        {
          ownerId: root.user.id,
          workspaceId: root.host.workspaceId,
          buildId: root.host.buildId,
          isolationDomain: `root-${epicId}`,
          validUntil: Date.now() + 120000,
        },
        {
          ownerId: root.user.id,
          workspaceId: childWorkspace,
          buildId: childBuild,
          isolationDomain: `child-${epicId}`,
          validUntil: Date.now() + 120000,
        },
        {
          ownerId: root.user.id,
          workspaceId: integrationWorkspace,
          buildId: integrationBuild,
          isolationDomain: `integration-${epicId}`,
          validUntil: Date.now() + 120000,
        },
      ],
    };
    vi.stubEnv("HIVE_DELIVERY_EPIC_ISOLATION_POLICY", JSON.stringify(policy));
    const outcome = "Assemble the independently verified fixture on an epic branch";
    const criteria = root.plan.requirements.map((requirement) => requirement.id);
    await db.deliveryEpic.create({
      data: { id: epicId, ownerId: root.user.id, projectId: root.project.id, outcome, criteria },
    });
    await db.deliveryTask.update({ where: { id: root.taskId }, data: { epicId } });
    const text = root.originalIntent,
      textDigest = createHash("sha256").update(text).digest("hex");
    const common = {
      expectedRevision: physical,
      textDigest,
      criteria,
      modelTier: "default",
      model: "gpt-6.1-sol",
      effort: "low",
    };
    const plan = {
      schemaVersion: 1,
      epicId,
      projectId: root.project.id,
      ownerIntentDigest: root.plan.intentDigest,
      outcomeDigest: epicDigest(outcome),
      criteria,
      version: 1,
      previousPlanDigest: null,
      maxConcurrentTasks: 1,
      tasks: [
        {
          ...common,
          intentId: childIntent,
          requestId: childRequest,
          workspaceId: childWorkspace,
          role: "implementation",
          dependsOn: [],
        },
        {
          ...common,
          intentId: integrationIntent,
          requestId: integrationRequest,
          workspaceId: integrationWorkspace,
          role: "integration",
          dependsOn: [childIntent],
        },
      ],
    };
    const inputs = [
      { intentId: childIntent, text },
      { intentId: integrationIntent, text },
    ];
    const first = await db.$transaction((tx) =>
      writeEpicPlan(tx, root.user.id, root.taskId, { plan, inputs }, acceptanceFixtureKey),
    );
    let branchSha = physical,
      merged = false,
      corrupt = false,
      invalidateDuringRead = false;
    let semanticEvidenceId: string | undefined;
    const repository = {
      provider: "github",
      providerRepositoryId: "123",
      nodeId: "R_123",
      fullName: root.project.fullName,
      owner: "fixture",
      name: "native",
      defaultBranch: "main",
      private: true,
      archived: false,
      htmlUrl: `https://github.com/${root.project.fullName}`,
      permissions: { pull: true, push: true, admin: false },
    };
    const builds = new Map([
      [root.host.workspaceId, root.host.buildId],
      [childWorkspace, childBuild],
      [integrationWorkspace, integrationBuild],
    ]);
    mocks.host.mockImplementation(async (user, workspace, path, request, options) => {
      expect(user).toEqual({ id: root.user.id, coderUserId: root.user.coderUserId });
      expect(builds.has(workspace)).toBe(true);
      if (path === "/projects/resolve")
        return {
          schemaVersion: 1,
          providerAccountId: "456",
          repository,
          defaultRevision: physical,
        };
      if (path === "/projects/resolve-ref") {
        expect(request.branch).toBe(baseBranch);
        return {
          schemaVersion: 1,
          providerAccountId: "456",
          repository,
          branch: baseBranch,
          revision: branchSha,
        };
      }
      expect(path).toBe("/projects/epic-read");
      expect(options.expectedBuildId).toBe(builds.get(workspace));
      const commonResult = {
        schemaVersion: 1,
        requestId: request.requestId,
        operation: request.operation,
        providerAccountId: "456",
        repository,
        baseBranch,
        headSha: corrupt ? "9".repeat(40) : request.headSha,
        branchHeadSha: branchSha,
      };
      if (invalidateDuringRead && request.operation === "observe_merge") {
        if (!semanticEvidenceId) throw Error("Fixture semantic evidence unavailable");
        await db.deliveryEvidence.update({
          where: { id: semanticEvidenceId },
          data: { invalidatedAt: new Date() },
        });
      }
      return request.operation === "observe_merge"
        ? {
            ...commonResult,
            pullRequestId: request.pullRequestId,
            pullNumber: request.pullNumber,
            sourceBranch: request.sourceBranch,
            merged,
            mergeSha: merged ? mergeSha : null,
          }
        : {
            ...commonResult,
            baseSha: request.baseSha,
            mergeBaseSha: request.baseSha,
            status: request.baseSha === request.headSha ? "identical" : "ahead",
          };
    });
    const principal = { id: root.user.id, coderUserId: root.user.coderUserId };
    await db.$transaction((tx) =>
      reserveEpicStart(tx, db, root.user.id, epicId, childIntent, policy),
    );
    await startProjectTask(principal, root.project.id, {
      workspaceId: childWorkspace,
      requestId: childRequest,
      expectedRevision: physical,
      text,
    });
    // The scheduler's existing accepted transition follows a successful enqueue.
    await db.$executeRaw`UPDATE delivery_epic_start_intents SET phase='accepted' WHERE owner_id=${root.user.id}::uuid AND epic_id=${epicId}::uuid AND intent_id=${childIntent}::uuid`;
    const child = await verifiedEpicPreviewFixture(db, {
      baseBranch,
      activationRequirement: true,
      headSha: "e".repeat(40),
      pullRequestId: "901",
      pullNumber: 8,
      epic: { id: epicId, isolationPolicy: policy, encryptionKey: acceptanceFixtureKey },
      native: {
        encryptionKey: acceptanceFixtureKey,
        existing: {
          user: root.user,
          project: root.project,
          preparationIntentId: childIntent,
          requestId: childRequest,
          workspaceId: childWorkspace,
          buildId: childBuild,
          reuseIntent: true,
        },
        physical: {
          revision: physical,
          leaseId: randomUUID(),
          leaseGeneration: 1,
          checkoutIncarnation: randomUUID(),
          checkoutIdentity: { device: "700", inode: "701" },
          gitIdentity: { device: "700", inode: "702" },
        },
      },
    });
    const store = repositoryPolicyStore(db),
      scope = { ownerId: root.user.id, epicId, intentId: childIntent };
    semanticEvidenceId = child.semanticEvidenceId;
    expect(
      await db.$transaction((tx) => epicPreviewReadiness(tx, store, root.user.id, child.taskId)),
    ).not.toBeNull();
    await expect(
      db.$transaction(async (tx) => {
        await tx.deliveryManagerBinding.update({
          where: { id: child.claim.managerBindingId },
          data: { blockedReason: "explicit-fixture-hold" },
        });
        expect(await epicPreviewReadiness(tx, store, root.user.id, child.taskId)).toBeNull();
        throw Error("rollback_fixture_hold");
      }),
    ).rejects.toThrow("rollback_fixture_hold");
    await expect(
      db.$transaction((tx) => epicIntegrationDependency(tx, store, scope)),
    ).rejects.toThrow("epic_dependencies_pending");
    await expect(
      db.$transaction((tx) =>
        reserveEpicStart(tx, db, root.user.id, epicId, integrationIntent, policy),
      ),
    ).rejects.toThrow("epic_wip_limit");
    expect(await observeEpicPreviewMerge(db, store, scope)).toBeNull();
    expect(
      await db.deliveryEvent.count({
        where: { taskId: child.taskId, type: "epic_preview_merge_observed" },
      }),
    ).toBe(0);
    merged = true;
    branchSha = integrated;
    corrupt = true;
    await expect(observeEpicPreviewMerge(db, store, scope)).rejects.toThrow(
      "epic_lineage_unverified",
    );
    corrupt = false;
    const observed = await observeEpicPreviewMerge(db, store, scope);
    expect(observed).toMatchObject({
      sourceSha: child.publication.headSha,
      mergeSha,
      branchHeadSha: integrated,
    });
    expect(await observeEpicPreviewMerge(db, store, scope)).toEqual(observed);
    const next = {
      ...plan,
      version: 2,
      previousPlanDigest: first.planDigest,
      tasks: [plan.tasks[0], { ...plan.tasks[1], expectedRevision: integrated }],
    };
    await db.$transaction((tx) =>
      writeEpicPlan(tx, root.user.id, root.taskId, { plan: next, inputs }, acceptanceFixtureKey),
    );
    const anchor = await db.$transaction((tx) => epicIntegrationDependency(tx, store, scope));
    if (anchor.milestone !== "implementation_preview") throw Error("Unexpected production claim");
    const lineageBegan = (
      await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const lineage = await readEpicGitHubForTask(
      db,
      { ownerId: root.user.id, taskId: child.taskId },
      { operation: "lineage", baseSha: anchor.integrationSha, headSha: integrated },
    );
    if (lineage.operation !== "lineage") throw Error("Fixture lineage scope");
    const proof = {
      dependency: childIntent,
      milestone: "implementation_preview",
      repositoryId: "123",
      base: lineage.baseSha,
      head: lineage.headSha,
      status: lineage.status,
      mergeBase: lineage.mergeBaseSha,
      readinessDigest: anchor.readiness.digest,
      completionEventId: anchor.readiness.completionEventId,
      sourceReceiptDigest: anchor.readiness.sourceReceiptDigest,
      mergeDigest: anchor.mergeDigest,
      observedAt: lineageBegan,
      expiresAt: lineageBegan + 30000,
    };
    for (const timing of [
      { observedAt: lineageBegan - 31000, expiresAt: lineageBegan - 1000 },
      { observedAt: lineageBegan + 1000, expiresAt: lineageBegan + 31000 },
    ])
      await expect(
        db.$transaction((tx) =>
          reserveEpicStart(tx, db, root.user.id, epicId, integrationIntent, policy, [
            { ...proof, ...timing },
          ]),
        ),
      ).rejects.toThrow("epic_lineage_unavailable");
    await db.$transaction((tx) =>
      reserveEpicStart(tx, db, root.user.id, epicId, integrationIntent, policy, [proof]),
    );
    branchSha = physical;
    await expect(
      startProjectTask(principal, root.project.id, {
        workspaceId: integrationWorkspace,
        requestId: integrationRequest,
        expectedRevision: integrated,
        text,
      }),
    ).rejects.toThrow("source_changed");
    expect(await db.projectTaskIntent.findUnique({ where: { id: integrationIntent } })).toBeNull();
    branchSha = integrated;
    await startProjectTask(principal, root.project.id, {
      workspaceId: integrationWorkspace,
      requestId: integrationRequest,
      expectedRevision: integrated,
      text,
    });
    expect(
      await db.projectTaskIntent.findUnique({ where: { id: integrationIntent } }),
    ).toMatchObject({ sourceSha: integrated, workspaceId: integrationWorkspace });
    await db.$executeRaw`UPDATE delivery_epic_start_intents SET phase='accepted' WHERE owner_id=${root.user.id}::uuid AND epic_id=${epicId}::uuid AND intent_id=${integrationIntent}::uuid`;
    // A real slow bootstrap outlives wire-capture freshness. The merge and
    // commit graph are durable facts; all current gates/leases still apply.
    await new Promise((done) => setTimeout(done, 31000));
    const afterBootstrap = (
      await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    expect(afterBootstrap).toBeGreaterThan(proof.expiresAt);
    expect(afterBootstrap).toBeGreaterThan(observed?.expiresAt ?? Number.POSITIVE_INFINITY);
    const eventsBeforeReplay = await db.deliveryEvent.count({
      where: { taskId: child.taskId, type: "epic_preview_merge_observed" },
    });
    expect(await observeEpicPreviewMerge(db, store, scope)).toEqual(observed);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: child.taskId, type: "epic_preview_merge_observed" },
      }),
    ).toBe(eventsBeforeReplay);
    const integration = await acceptanceCandidateFixture(db, undefined, {
      baseBranch,
      activationRequirement: true,
      headSha: "f".repeat(40),
      pullRequestId: "902",
      pullNumber: 9,
      epic: { id: epicId, isolationPolicy: policy, encryptionKey: acceptanceFixtureKey },
      native: {
        encryptionKey: acceptanceFixtureKey,
        existing: {
          user: root.user,
          project: root.project,
          preparationIntentId: integrationIntent,
          requestId: integrationRequest,
          workspaceId: integrationWorkspace,
          buildId: integrationBuild,
          reuseIntent: true,
        },
        physical: {
          revision: integrated,
          leaseId: randomUUID(),
          leaseGeneration: 1,
          checkoutIncarnation: randomUUID(),
          checkoutIdentity: { device: "800", inode: "801" },
          gitIdentity: { device: "800", inode: "802" },
        },
      },
    });
    expect(
      await db.$queryRaw`SELECT phase FROM delivery_epic_writer_reservations WHERE owner_id=${root.user.id}::uuid AND epic_id=${epicId}::uuid`,
    ).toEqual([{ phase: "held" }, { phase: "held" }]);
    expect(
      await db.deliveryRelease.count({ where: { ownerId: root.user.id, phase: "healthy" } }),
    ).toBe(0);
    await expect(epicDependencyRelease(db, root.user.id, child.taskId)).rejects.toThrow(
      "epic_dependency_release_pending",
    );
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, store, {
          ownerId: root.user.id,
          taskId: child.taskId,
          sourceSha: child.publication.headSha,
        }),
      ),
    ).toBe(false);
    expect(
      await db.deliveryStep.count({
        where: {
          taskId: { in: [child.taskId, integration.taskId] },
          acceptancePhase: "activation_production",
          state: "succeeded",
        },
      }),
    ).toBe(0);
    const current = await db.deliveryTask.findUniqueOrThrow({ where: { id: integration.taskId } });
    const observations = await db.deliveryEvent.count({
      where: { taskId: child.taskId, type: "epic_preview_merge_observed" },
    });
    invalidateDuringRead = true;
    await expect(observeEpicPreviewMerge(db, store, scope)).rejects.toThrow(
      "epic_dependencies_pending",
    );
    expect(
      await db.deliveryEvent.count({
        where: { taskId: child.taskId, type: "epic_preview_merge_observed" },
      }),
    ).toBe(observations);
    await expect(
      db.$transaction((tx) =>
        authorizeEpicClaim(tx, root.user.id, current, policy, db, {
          model: "gpt-6.1-sol",
          effort: "low",
        }),
      ),
    ).rejects.toThrow("epic_dependencies_pending");
    expect(
      await db.$queryRaw`SELECT phase FROM delivery_epic_start_intents WHERE owner_id=${root.user.id}::uuid AND epic_id=${epicId}::uuid`,
    ).toEqual([{ phase: "accepted" }, { phase: "accepted" }]);
  }, 50000);
});
