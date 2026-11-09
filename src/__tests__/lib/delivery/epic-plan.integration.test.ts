import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { epicDigest } from "@/lib/delivery/epic-contracts";
import { writeEpicPlan } from "@/lib/delivery/epic-plan.server";
import { projectTaskId } from "@/lib/projects/task.server";
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
describe.skipIf(!url)("versioned epic plan in PostgreSQL", () => {
  it("binds the independent owner plan, permits unstarted replan, and freezes reserved tasks", async () => {
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
      outcome = "Bound fixture outcome",
      criterion = "acceptance:behavior";
    await db.deliveryEpic.create({
      data: {
        id: epicId,
        ownerId: f.user.id,
        projectId: f.project.id,
        outcome,
        criteria: [criterion],
      },
    });
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { epicId } });
    const request1 = randomUUID(),
      request2 = randomUUID(),
      first = projectTaskId(f.user.id, f.project.id, request1),
      second = projectTaskId(f.user.id, f.project.id, request2),
      text1 = "Implement fixture behavior",
      text2 = "Integrate fixture behavior";
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const plan = {
      schemaVersion: 1,
      epicId,
      projectId: f.project.id,
      ownerIntentDigest: requireIntentDigest(f.originalIntent),
      outcomeDigest: epicDigest(outcome),
      criteria: [criterion],
      version: 1,
      previousPlanDigest: null,
      maxConcurrentTasks: 1,
      tasks: [
        {
          intentId: first,
          requestId: request1,
          workspaceId: randomUUID(),
          expectedRevision: "a".repeat(40),
          textDigest: hash(text1),
          criteria: [criterion],
          dependsOn: [],
          role: "implementation",
        },
        {
          intentId: second,
          requestId: request2,
          workspaceId: randomUUID(),
          expectedRevision: "a".repeat(40),
          textDigest: hash(text2),
          criteria: [criterion],
          dependsOn: [first],
          role: "integration",
        },
      ],
    };
    const inputs = [
        { intentId: first, text: text1 },
        { intentId: second, text: text2 },
      ],
      key = "19".repeat(32);
    const result = await db.$transaction((tx) =>
      writeEpicPlan(tx, f.user.id, f.taskId, { plan, inputs }, key),
    );
    expect(result.replayed).toBe(false);
    await db.$executeRaw`INSERT INTO delivery_epic_start_intents(owner_id,epic_id,intent_id,plan_digest,workspace_id,build_id,isolation_domain,request_id) VALUES (${f.user.id}::uuid,${epicId}::uuid,${first}::uuid,${result.planDigest},${plan.tasks[0].workspaceId}::uuid,${randomUUID()}::uuid,${`test-${randomUUID()}`},${request1}::uuid)`;
    const next = {
      ...plan,
      version: 2,
      previousPlanDigest: result.planDigest,
      tasks: [plan.tasks[0], { ...plan.tasks[1], expectedRevision: "b".repeat(40) }],
    };
    const changedStarted = {
      ...next,
      tasks: [{ ...next.tasks[0], expectedRevision: "c".repeat(40) }, next.tasks[1]],
    };
    await expect(
      db.$transaction((tx) =>
        writeEpicPlan(tx, f.user.id, f.taskId, { plan: changedStarted, inputs }, key),
      ),
    ).rejects.toThrow("epic_started_task_immutable");
    const updated = await db.$transaction((tx) =>
      writeEpicPlan(tx, f.user.id, f.taskId, { plan: next, inputs }, key),
    );
    expect(updated).toMatchObject({ version: 2, replayed: false });
    expect(
      (
        await db.$transaction((tx) =>
          writeEpicPlan(tx, f.user.id, f.taskId, { plan: next, inputs }, key),
        )
      ).replayed,
    ).toBe(true);
  }, 30000);
});

describe.skipIf(!url)("manager epic planning context", () => {
  it("derives stable task identities and model selection for the authenticated owner", async () => {
    const { managerEpicContext, compileManagerEpicProposal } = await import(
      "@/lib/delivery/epic-planning.server"
    );
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
      buildId = randomUUID();
    await db.deliveryEpic.create({
      data: {
        id: epicId,
        ownerId: f.user.id,
        projectId: f.project.id,
        outcome: "Fixture outcome",
        criteria: ["acceptance:behavior"],
      },
    });
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { epicId } });
    const policy = {
        schemaVersion: 1,
        workspaces: [
          {
            ownerId: f.user.id,
            workspaceId: f.host.workspaceId,
            buildId: f.host.buildId,
            isolationDomain: `coordinator-${randomUUID()}`,
            validUntil: Date.now() + 60000,
          },
          {
            ownerId: f.user.id,
            workspaceId,
            buildId,
            isolationDomain: `fixture-${randomUUID()}`,
            validUntil: Date.now() + 60000,
          },
          {
            ownerId: randomUUID(),
            workspaceId: randomUUID(),
            buildId: randomUUID(),
            isolationDomain: `foreign-${randomUUID()}`,
            validUntil: Date.now() + 60000,
          },
        ],
      },
      catalog = [
        { tier: "default", model: "gpt-6.1-sol", effort: "low" },
        { tier: "deep", model: "gpt-6-astra", effort: "high" },
      ];
    await expect(
      db.$transaction((tx) =>
        managerEpicContext(tx, randomUUID(), f.taskId, policy, catalog, "19".repeat(32)),
      ),
    ).rejects.toThrow("epic_planning_unavailable");
    const context = await db.$transaction((tx) =>
      managerEpicContext(tx, f.user.id, f.taskId, policy, catalog, "19".repeat(32)),
    );
    expect(context.workspaces).toEqual([workspaceId]);
    const proposal = {
      taskId: f.taskId,
      expectedPlanVersion: 0,
      expectedPlanDigest: null,
      maxConcurrentTasks: 1,
      tasks: [
        {
          key: "build",
          workspaceId,
          expectedRevision: "a".repeat(40),
          text: "Implement the behavior",
          criteria: ["acceptance:behavior"],
          dependsOn: [],
          role: "implementation",
          modelTier: "default",
        },
        {
          key: "integrate",
          workspaceId,
          expectedRevision: "a".repeat(40),
          text: "Integrate the behavior",
          criteria: ["acceptance:behavior"],
          dependsOn: ["build"],
          role: "integration",
          modelTier: "deep",
        },
      ],
    };
    const compiled = compileManagerEpicProposal(f.user.id, context, proposal);
    expect(compiled.plan.tasks[0]).toMatchObject({
      managerKey: "build",
      model: "gpt-6.1-sol",
      effort: "low",
    });
    expect(compiled.plan.tasks[1].dependsOn).toEqual([compiled.plan.tasks[0].intentId]);
    expect(compiled.plan.tasks[1]).toMatchObject({
      modelTier: "deep",
      model: "gpt-6-astra",
      effort: "high",
    });
    expect(compiled.inputs[1].text).toContain("model gpt-6-astra and reasoning effort high");
    expect(() =>
      compileManagerEpicProposal(f.user.id, context, {
        ...proposal,
        tasks: [{ ...proposal.tasks[0], modelTier: "unapproved" }, proposal.tasks[1]],
      }),
    ).toThrow("epic_plan_input_mismatch");
    expect(compileManagerEpicProposal(f.user.id, context, proposal).plan).toEqual(compiled.plan);
    expect(() => compileManagerEpicProposal(randomUUID(), context, proposal)).toThrow(
      "epic_author_unbound",
    );
    expect(() =>
      compileManagerEpicProposal(f.user.id, context, { ...proposal, expectedPlanVersion: 1 }),
    ).toThrow("epic_plan_version_conflict");
    await db.$transaction((tx) =>
      writeEpicPlan(tx, f.user.id, f.taskId, compiled, "19".repeat(32)),
    );
  }, 30000);
});
