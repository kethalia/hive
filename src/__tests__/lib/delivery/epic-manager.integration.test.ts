import { randomUUID } from "node:crypto";
import { type DeliveryAcceptanceJob, type Prisma, PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// This test isolates manager transport; physical source application has its own guardian tests.
vi.mock("@/lib/codex-session/guardian-application-gate.server", () => ({
  requireAppliedSourceForAction: async () => ({ guarded: true, applied: true }),
}));

import {
  acceptancePlanResultSchema,
  requireIntentDigest,
} from "@/lib/delivery/acceptance-contracts";
import { bindEpicAcceptance } from "@/lib/delivery/epic-acceptance";
import { reserveEpicStart } from "@/lib/delivery/epic-start.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!url)("signed manager epic planning", () => {
  it("returns owned planning context and accepts a concise DAG while rejecting a foreign owner", async () => {
    const f = await acceptanceCandidateFixture(db);
    for (const name of [
      "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
      "HIVE_DELIVERY_EXECUTION_ENABLED",
      "HIVE_DELIVERY_MANAGER_ENABLED",
      "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
    ])
      vi.stubEnv(name, "true");
    vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(f.store.producer));
    const epicId = randomUUID(),
      workspaceId = randomUUID(),
      expires = Date.now() + 60000;
    await db.deliveryEpic.create({
      data: {
        id: epicId,
        ownerId: f.user.id,
        projectId: f.project.id,
        outcome: "Fixture goal",
        criteria: ["acceptance:behavior"],
      },
    });
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { epicId } });
    const isolation = {
      schemaVersion: 1,
      workspaces: [
        {
          ownerId: f.user.id,
          workspaceId: f.host.workspaceId,
          buildId: f.host.buildId,
          isolationDomain: `author-${randomUUID()}`,
          validUntil: expires,
        },
        {
          ownerId: f.user.id,
          workspaceId,
          buildId: randomUUID(),
          isolationDomain: `worker-${randomUUID()}`,
          validUntil: expires,
        },
      ],
    };
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      guardianPolicy: f.guardian.policy,
      epicPlanEncryptionKey: "19".repeat(32),
      epicIsolationPolicy: isolation,
    });
    const task = await db.deliveryTask.findUniqueOrThrow({
      where: { id: f.taskId },
      include: { currentSourceRevision: true },
    });
    const revision = task.currentSourceRevision;
    if (!revision) throw Error("fixture source unavailable");
    const overrides = {
      sourceContext: {
        revisionId: revision.id,
        version: revision.version,
        headSha: revision.headSha,
      },
    };
    const context = (await manager.execute(
      f.managerEnvelope(
        { operation: "read_epic_context", payload: { taskId: f.taskId } },
        overrides,
      ),
    )) as unknown as {
      epicId: string;
      expectedPlanVersion: number;
      expectedPlanDigest: string | null;
      workspaces: string[];
      modelTiers: { tier: string }[];
    };
    expect(context).toMatchObject({
      epicId,
      expectedPlanVersion: 0,
      expectedPlanDigest: null,
      workspaces: [workspaceId],
      modelTiers: [{ tier: "default" }],
    });
    const proposal = {
      taskId: f.taskId,
      expectedPlanVersion: context.expectedPlanVersion,
      expectedPlanDigest: context.expectedPlanDigest,
      maxConcurrentTasks: 1,
      tasks: [
        {
          key: "build",
          workspaceId,
          expectedRevision: f.context.revision,
          text: "Implement behavior",
          criteria: ["acceptance:behavior"],
          dependsOn: [],
          role: "implementation",
          modelTier: "default",
        },
        {
          key: "integrate",
          workspaceId,
          expectedRevision: f.context.revision,
          text: "Integrate behavior",
          criteria: ["acceptance:behavior"],
          dependsOn: ["build"],
          role: "integration",
          modelTier: "default",
        },
      ],
    };
    expect(
      await manager.execute(
        f.managerEnvelope({ operation: "plan_epic", payload: proposal }, overrides),
      ),
    ).toMatchObject({ version: 1, replayed: false });
    expect(
      await manager.execute(
        f.managerEnvelope({ operation: "plan_epic", payload: proposal }, overrides),
      ),
    ).toMatchObject({ version: 1, replayed: true });
    const altered = {
      ...proposal,
      tasks: [{ ...proposal.tasks[0], text: "Changed behavior" }, proposal.tasks[1]],
    };
    await expect(
      manager.execute(f.managerEnvelope({ operation: "plan_epic", payload: altered }, overrides)),
    ).rejects.toThrow("epic_plan_version_conflict");
    const recovered = (await manager.execute(
      f.managerEnvelope(
        { operation: "read_epic_context", payload: { taskId: f.taskId } },
        overrides,
      ),
    )) as unknown as {
      currentTasks: { managerKey: string; intentId: string; requestId: string; text: string }[];
    };
    const child = recovered.currentTasks.find((item) => item.managerKey === "build");
    if (!child) throw Error("child context unavailable");
    expect(child.text).toContain("Owner acceptance requirements");
    await db.$transaction((tx) =>
      reserveEpicStart(tx, db, f.user.id, epicId, child.intentId, isolation),
    );
    const original = await db.projectTaskIntent.findUniqueOrThrow({
      where: { id: f.context.preparationIntentId },
    });
    const requestDigest = "f".repeat(64);
    const hostRequest = {
      schemaVersion: 1 as const,
      projectId: f.project.id,
      repositoryId: "123",
      expectedAccountId: "456",
      taskId: child.intentId,
      requestId: child.requestId,
      revision: f.context.revision,
      model: "gpt-6.1-sol",
      effort: "low",
      text: child.text,
    };
    await db.$transaction(async (tx) => {
      const row = await tx.projectTaskIntent.create({
        data: {
          id: child.intentId,
          ownerId: f.user.id,
          projectId: f.project.id,
          workspaceId,
          requestId: child.requestId,
          requestDigest,
          repositoryId: "123",
          providerAccountId: "456",
          sourceSha: f.context.revision,
          repositoryPolicyVersionId: original.repositoryPolicyVersionId,
          repositoryPolicyDigest: original.repositoryPolicyDigest,
          intentTextDigest: requireIntentDigest(child.text),
        },
      });
      await f.store.captureIntent(
        tx,
        {
          ownerId: f.user.id,
          projectId: f.project.id,
          workspaceId,
          taskId: child.intentId,
          requestId: child.requestId,
          requestDigest,
          hostRequest,
        },
        row,
      );
    });
    const captured = await db.$transaction((tx) =>
      f.store.originalIntent(tx, f.user.id, child.intentId),
    );
    expect(captured.sealed.inheritedCriteria?.requirements).toMatchObject([
      { id: "acceptance:behavior", meaning: f.plan.requirements[0].meaning },
    ]);
    const job = await db.deliveryAcceptanceJob.findFirstOrThrow({
      where: { ownerId: f.user.id, intentId: child.intentId, kind: "plan" },
    });
    const store = f.store as unknown as {
      material(
        tx: Prisma.TransactionClient,
        job: DeliveryAcceptanceJob,
      ): Promise<{ payload: Record<string, unknown> }>;
    };
    const material = await db.$transaction((tx) => store.material(tx, job));
    expect(material.payload.inheritedCriteria).toEqual(captured.sealed.inheritedCriteria);
    const childPlan = acceptancePlanResultSchema.parse({
      schemaVersion: 1,
      kind: "plan",
      intentDigest: requireIntentDigest(child.text),
      outcome: "ready",
      requirements: [
        {
          id: "acceptance:child",
          meaning: "Independently phrased fixture behavior",
          phase: "implementation_preview",
          intentRanges: [{ start: 0, end: 1 }],
          verification: "Inspect source",
        },
        {
          id: "acceptance:extra",
          meaning: "Additional discovered requirement",
          phase: "implementation_preview",
          intentRanges: [{ start: 0, end: 1 }],
          verification: "Inspect source",
        },
      ],
      inheritedMappings: [
        { ownerCriterionId: "acceptance:behavior", childRequirementId: "acceptance:child" },
      ],
      unresolved: [],
      rationale: "Independent evaluator fixture",
    });
    if (!captured.sealed.inheritedCriteria) throw Error("inherited criteria unavailable");
    expect(bindEpicAcceptance(captured.sealed.inheritedCriteria, childPlan)).toEqual([
      { ownerCriterionId: "acceptance:behavior", childRequirementId: "acceptance:child" },
    ]);
    const other = await guardianFixture(db);
    const foreignManager = new DeliveryManagerService(db, {
      ...other.dependencies,
      guardianPolicy: other.guardian.policy,
      epicPlanEncryptionKey: "19".repeat(32),
      epicIsolationPolicy: isolation,
    });
    await expect(
      foreignManager.execute(
        other.managerEnvelope({ operation: "read_epic_context", payload: { taskId: f.taskId } }),
      ),
    ).rejects.toThrow();
  }, 30000);
});
