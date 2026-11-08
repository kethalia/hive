import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect, vi } from "vitest";
import { epicDigest } from "@/lib/delivery/epic-contracts";
import { expectedEpicIntent, writeEpicPlan } from "@/lib/delivery/epic-plan.server";
import { reserveEpicStart } from "@/lib/delivery/epic-start.server";
import { startProjectTask } from "@/lib/projects/task.server";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import { acceptanceFixtureKey } from "./acceptance-fixture";
import { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";

export async function admittedEpicMergeFixture(db: PrismaClient, host: ReturnType<typeof vi.fn>) {
  const baseBranch = `epic/fixture-${randomUUID()}`,
    physical = "a".repeat(40),
    mergeSha = "c".repeat(40);
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
  await db.$transaction((tx) =>
    writeEpicPlan(tx, root.user.id, root.taskId, { plan, inputs }, acceptanceFixtureKey),
  );
  const branchSha = physical,
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
  host.mockImplementation(async (user, workspace, path, request, options) => {
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

  return {
    root,
    child,
    epicId,
    childIntent,
    policy,
    plan,
    repository,
    builds,
    originalHost: host.getMockImplementation()!,
    scope: {
      ownerId: root.user.id,
      epicId,
      intentId: childIntent,
      readerWorkspaceId: root.host.workspaceId,
      readerBuildId: root.host.buildId,
    },
  };
}
