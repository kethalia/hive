import { expect, it } from "vitest";
import { epicDigest, epicPlanSchema } from "@/lib/delivery/epic-contracts";
import { managerEnvelopeSchema } from "@/lib/delivery/manager-contracts";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan = {
  schemaVersion: 1,
  epicId: u(1),
  projectId: u(2),
  ownerIntentDigest: "a".repeat(64),
  outcomeDigest: "b".repeat(64),
  criteria: ["behavior", "integration"],
  version: 1,
  previousPlanDigest: null,
  maxConcurrentTasks: 2,
  tasks: [
    {
      intentId: u(3),
      requestId: u(4),
      workspaceId: u(5),
      expectedRevision: "c".repeat(40),
      textDigest: "d".repeat(64),
      criteria: ["behavior"],
      dependsOn: [],
      role: "implementation",
    },
    {
      intentId: u(6),
      requestId: u(7),
      workspaceId: u(8),
      expectedRevision: "c".repeat(40),
      textDigest: "e".repeat(64),
      criteria: ["behavior", "integration"],
      dependsOn: [u(3)],
      role: "integration",
    },
  ],
};
it("binds criteria, task identity, acyclic dependencies and integrated coverage", () => {
  expect(epicPlanSchema.safeParse(plan).success).toBe(true);
  for (const invalid of [
    { ...plan, tasks: [plan.tasks[0], { ...plan.tasks[1], dependsOn: [] }] },
    { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: [u(6)] }, plan.tasks[1]] },
    { ...plan, tasks: [plan.tasks[0], { ...plan.tasks[1], criteria: ["behavior"] }] },
    { ...plan, maxConcurrentTasks: 3 },
    { ...plan, version: 2 },
    { ...plan, tasks: [{ ...plan.tasks[1], dependsOn: [] }] },
  ])
    expect(epicPlanSchema.safeParse(invalid).success).toBe(false);
  expect(epicDigest({ b: 2, a: 1 })).toBe(epicDigest({ a: 1, b: 2 }));
});

it("accepts the model-facing context and bounded DAG commands", () => {
  const envelope = {
    schemaVersion: 2,
    registrationId: u(1),
    serverInstanceId: "host",
    eventId: u(2),
    managerThreadId: "manager",
    nativeTurnId: "turn",
    nativeCallId: "call",
    issuedAt: 1,
    expiresAt: 2,
    checkoutBinding: {
      projectId: u(3),
      preparationIntentId: u(4),
      repositoryId: "123",
      revision: "a".repeat(40),
      leaseId: u(5),
      leaseGeneration: 1,
    },
    proof: "A".repeat(86),
  };
  expect(
    managerEnvelopeSchema.safeParse({
      ...envelope,
      command: { operation: "read_epic_context", payload: { taskId: u(6) } },
    }).success,
  ).toBe(true);
  const task = {
    key: "build",
    workspaceId: u(7),
    expectedRevision: "b".repeat(40),
    text: "Implement behavior",
    criteria: ["behavior"],
    dependsOn: [],
    role: "implementation",
    modelTier: "default",
  };
  const command = {
    operation: "plan_epic",
    payload: {
      taskId: u(6),
      expectedPlanVersion: 0,
      expectedPlanDigest: null,
      maxConcurrentTasks: 1,
      tasks: [task, { ...task, key: "integrate", role: "integration", dependsOn: ["build"] }],
    },
  };
  expect(managerEnvelopeSchema.safeParse({ ...envelope, command }).success).toBe(true);
  expect(
    managerEnvelopeSchema.safeParse({
      ...envelope,
      command: {
        ...command,
        payload: { ...command.payload, tasks: [{ ...task, modelTier: "INVALID!" }] },
      },
    }).success,
  ).toBe(false);
});
