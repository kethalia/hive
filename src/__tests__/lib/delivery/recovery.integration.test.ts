import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliveryRepository } from "@/lib/delivery/repository";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/hive_delivery_test"
  )
    throw new Error("Use only the isolated local delivery fixture");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
const policy = {
  version: "recovery-fixture-v1",
  trustedProducers: ["fixture-check"],
  trustedRuntimeAdapters: ["fixture-runtime"],
  maxAgeMs: 3600_000,
  maxRuntimeObservationAgeMs: 60_000,
};
const repository = new DeliveryRepository(db, policy);
const sha = "a".repeat(40);
let ownerId: string;
let coderOwnerId: string;
let otherOwnerId: string;
let nextRepositoryId = 1000;

async function fixture(twoSteps = false) {
  const project = await repository.bindProject(ownerId, {
    provider: "github",
    providerRepositoryId: String(nextRepositoryId++),
    providerAccountId: "123",
    fullName: "fixture/recovery",
  });
  const native = {
    workspaceId: randomUUID(),
    buildId: randomUUID(),
    nativeThreadId: randomUUID(),
    serverInstanceId: randomUUID(),
  };
  const conversation = await repository.bindConversation(ownerId, {
    projectId: project.id,
    ...native,
  });
  const taskId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  await repository.createTask(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    id: taskId,
    projectId: project.id,
    conversationId: conversation.id,
    outcome: "Synthetic native recovery fixture",
    sourceSha: sha,
    branch: "fixture",
    steps: [first, ...(twoSteps ? [second] : [])].map((id) => ({
      id,
      kind: "validate",
      criterionIds: ["C1"],
      requiredEvidenceKinds: ["check"],
    })),
    dependencies: twoSteps ? [{ stepId: second, dependsOnStepId: first }] : [],
  });
  return { taskId, first, second, native };
}
async function claim(task: Awaited<ReturnType<typeof fixture>>, version = 0, stepId = task.first) {
  return repository.claimStep(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId: task.taskId,
    stepId,
    expectedVersion: version,
    leaseHolder: "fixture-native-adapter",
  });
}
async function bind(
  task: Awaited<ReturnType<typeof fixture>>,
  attempt: Awaited<ReturnType<typeof claim>>,
  stepId = task.first,
) {
  const input = {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId: task.taskId,
    stepId,
    attemptId: attempt.attemptId,
    expectedRuntimeVersion: 0,
    binding: {
      coderOwnerId,
      workspaceId: task.native.workspaceId,
      buildId: task.native.buildId,
      serverInstanceId: task.native.serverInstanceId,
      managerThreadId: task.native.nativeThreadId,
      nativeThreadId: randomUUID(),
      nativeTurnId: randomUUID(),
      operationId: randomUUID(),
      lifetimeId: randomUUID(),
      sourceSha: sha,
    },
  };
  return { input, receipt: await repository.bindAttemptRuntime(ownerId, "fixture-runtime", input) };
}
async function observe(
  task: Awaited<ReturnType<typeof fixture>>,
  attempt: Awaited<ReturnType<typeof claim>>,
  binding: Awaited<ReturnType<typeof bind>>,
  overrides = {},
) {
  const input = {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId: task.taskId,
    stepId: binding.input.stepId,
    attemptId: attempt.attemptId,
    expectedRuntimeVersion: binding.receipt.runtimeVersion,
    bindingDigest: binding.receipt.bindingDigest,
    remoteId: randomUUID(),
    proofDigest: "c".repeat(64),
    observedAt: new Date(Date.now() - 1000),
    nativeTurn: "quiescent",
    backgroundProcesses: "quiescent",
    externalOperations: "quiescent",
    externalEffects: "none",
    ...overrides,
  };
  return {
    input,
    receipt: await repository.observeAttemptRuntime(ownerId, "fixture-runtime", input),
  };
}
const report = {
  summary: "Synthetic fixture result",
  difficulty: "moderate",
  difficultyReason: "Recovery fault drill",
  issues: [],
  remainingUncertainty: "No real native adapter or production effects verified",
  nextAction: "Review synthetic evidence",
};
async function completion(
  task: Awaited<ReturnType<typeof fixture>>,
  attempt: Awaited<ReturnType<typeof claim>>,
  sourceSha = sha,
  stepId = task.first,
) {
  const evidenceId = randomUUID();
  await repository.recordEvidence(ownerId, "fixture-check", {
    id: evidenceId,
    stepId,
    remoteId: randomUUID(),
    kind: "check",
    status: "passed",
    verificationMode: "simulated",
    environment: "local-fixture",
    sourceSha,
    criterionIds: ["C1"],
    objectKey: `delivery/${ownerId}/recovery/check.json`,
    contentDigest: "b".repeat(64),
    observedAt: new Date(Date.now() - 1000),
  });
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId: task.taskId,
    stepId,
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    leaseGeneration: attempt.leaseGeneration,
    sourceSha,
    evidenceIds: [evidenceId],
    report,
  };
}
const control = (
  task: Awaited<ReturnType<typeof fixture>>,
  expectedVersion: number,
  stepId = task.first,
) => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  taskId: task.taskId,
  stepId,
  expectedVersion,
  reason: "Explicit fixture recovery decision",
});

describe.skipIf(!url)("delivery recovery PostgreSQL", () => {
  beforeAll(async () => {
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    coderOwnerId = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        coderUrl: "https://fixture.invalid",
        coderUserId: coderOwnerId,
        username: "recovery",
        email: "recovery@example.invalid",
      },
    });
    await db.user.create({
      data: {
        id: otherOwnerId,
        coderUrl: "https://fixture.invalid",
        coderUserId: randomUUID(),
        username: "other-recovery",
        email: "other@example.invalid",
      },
    });
  });
  afterAll(async () => db.$disconnect());

  it("requires persisted Coder owner/runtime identity instead of trusting caller-owned JSON", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    expect(attempt.canRun).toBe(false);
    const registered = await bind(task, attempt);
    expect(registered.receipt.canRun).toBe(true);
    const otherTask = await fixture();
    const otherAttempt = await claim(otherTask);
    await expect(
      repository.bindAttemptRuntime(ownerId, "manager", {
        ...registered.input,
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "untrusted_runtime_adapter" });
    await expect(
      repository.bindAttemptRuntime(ownerId, "fixture-runtime", {
        ...registered.input,
        taskId: otherTask.taskId,
        stepId: otherTask.first,
        attemptId: otherAttempt.attemptId,
        eventId: randomUUID(),
        binding: { ...registered.input.binding, coderOwnerId: ownerId },
      }),
    ).rejects.toMatchObject({ code: "runtime_binding_unregistered" });
    await expect(
      repository.bindAttemptRuntime(otherOwnerId, "fixture-runtime", registered.input),
    ).rejects.toMatchObject({ code: "task_not_found" });
    await expect(
      db.deliveryAttempt.update({
        where: { id: attempt.attemptId },
        data: { runtimeBinding: { forged: true } },
      }),
    ).rejects.toThrow();
  });

  it("never takes over an expired lease based only on a finished native turn", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    await db.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    const observed = await observe(task, attempt, binding, { backgroundProcesses: "running" });
    const input = {
      ...control(task, attempt.version),
      attemptId: attempt.attemptId,
      quiescenceEventId: observed.receipt.eventId,
    };
    await expect(
      repository.reconcileExpiredAttempt(ownerId, "fixture-runtime", input),
    ).rejects.toMatchObject({ code: "native_not_quiescent" });
    await expect(
      repository.reconcileExpiredAttempt(ownerId, "manager", input),
    ).rejects.toMatchObject({ code: "untrusted_runtime_adapter" });
    await expect(claim(task, attempt.version)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    expect(await db.deliveryAttempt.count({ where: { ownerId, stepId: task.first } })).toBe(1);
  });

  it("requires explicit retry after trusted expiry reconciliation and fences old results", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    const staleResult = await completion(task, attempt);
    await db.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    const observed = await observe(task, attempt, binding);
    const reconciled = await repository.reconcileExpiredAttempt(ownerId, "fixture-runtime", {
      ...control(task, attempt.version),
      attemptId: attempt.attemptId,
      quiescenceEventId: observed.receipt.eventId,
    });
    await expect(claim(task, reconciled.version)).rejects.toMatchObject({ code: "step_not_ready" });
    const retried = await repository.retryStep(ownerId, control(task, reconciled.version));
    const next = await claim(task, retried.version);
    expect(next.attemptId).not.toBe(attempt.attemptId);
    expect(next.leaseGeneration).toBeGreaterThan(attempt.leaseGeneration);
    await expect(
      repository.completeStep(ownerId, { ...staleResult, expectedVersion: next.version }),
    ).rejects.toMatchObject({ code: "stale_attempt" });
  });

  it("does not release a failed actor until its whole native lifetime is confirmed quiescent", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    const failed = await repository.failAttempt(ownerId, {
      ...control(task, attempt.version),
      attemptId: attempt.attemptId,
      leaseGeneration: attempt.leaseGeneration,
      sourceSha: sha,
      disposition: "failed",
      report,
    });
    await expect(
      repository.retryStep(ownerId, control(task, failed.version)),
    ).rejects.toMatchObject({ code: "native_not_quiescent" });
    await observe(task, attempt, binding);
    const retried = await repository.retryStep(ownerId, control(task, failed.version));
    expect((await claim(task, retried.version)).attemptId).not.toBe(attempt.attemptId);
  });

  it("supports explicit blocking before execution without inventing a completed report", async () => {
    const task = await fixture();
    const blocked = await repository.blockStep(ownerId, control(task, 0));
    expect((await repository.getTask(ownerId, task.taskId))?.steps[0].state).toBe("blocked");
    expect(await db.deliveryStepReport.count({ where: { ownerId, stepId: task.first } })).toBe(0);
    const retried = await repository.retryStep(ownerId, control(task, blocked.version));
    expect((await claim(task, retried.version)).version).toBe(retried.version + 1);
  });

  it("reopens completion visibly, invalidates descendants, and preserves original report/outbox", async () => {
    const task = await fixture(true);
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    await observe(task, attempt, binding);
    const input = await completion(task, attempt);
    const receipt = await repository.completeStep(ownerId, input);
    const second = await claim(task, 0, task.second);
    const secondBinding = await bind(task, second, task.second);
    await observe(task, second, secondBinding);
    const secondResult = await completion(task, second, sha, task.second);
    await repository.completeStep(ownerId, secondResult);
    const reopened = await repository.reopenStep(ownerId, control(task, receipt.version));
    const snapshot = await repository.getTask(ownerId, task.taskId);
    expect(snapshot?.steps.find((step) => step.id === task.first)?.state).toBe("ready");
    expect(snapshot?.steps.find((step) => step.id === task.second)?.state).toBe("pending");
    expect(await db.deliveryStepReport.count({ where: { id: receipt.reportId } })).toBe(1);
    expect(await db.deliveryOutbox.count({ where: { ownerId, eventId: input.eventId } })).toBe(1);
    expect(
      (await db.deliveryEvidence.findUniqueOrThrow({ where: { id: input.evidenceIds[0] } }))
        .invalidatedAt,
    ).not.toBeNull();
    const again = await claim(task, reopened.version);
    const againBinding = await bind(task, again);
    await observe(task, again, againBinding);
    const reCompleted = await repository.completeStep(ownerId, await completion(task, again));
    expect(reCompleted.reportId).not.toBe(receipt.reportId);
    expect(await db.deliveryStepReport.count({ where: { ownerId, stepId: task.first } })).toBe(2);
  });

  it("source change fences old writers and invalidates evidence atomically without freeing them", async () => {
    const task = await fixture(true);
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    const stale = await completion(task, attempt);
    const changed = await repository.changeSource(ownerId, {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: task.taskId,
      expectedVersion: 0,
      sourceSha: "d".repeat(40),
      reason: "Reviewed new source revision",
    });
    const snapshot = await repository.getTask(ownerId, task.taskId);
    expect(snapshot?.pauseRequested).toBe(true);
    expect(snapshot?.schedulingPaused).toBe(false);
    expect(snapshot?.steps.find((step) => step.id === task.first)?.state).toBe("blocked");
    expect(
      (await db.deliveryEvidence.findUniqueOrThrow({ where: { id: stale.evidenceIds[0] } }))
        .invalidatedAt,
    ).not.toBeNull();
    await repository.setPaused(ownerId, {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: task.taskId,
      expectedVersion: changed.version,
      paused: false,
    });
    const current = snapshot?.steps.find((step) => step.id === task.first);
    await expect(
      repository.retryStep(ownerId, control(task, current?.version ?? -1)),
    ).rejects.toMatchObject({ code: "native_not_quiescent" });
    await observe(task, attempt, binding);
    const retried = await repository.retryStep(ownerId, control(task, current?.version ?? -1));
    const next = await claim(task, retried.version);
    expect(next.leaseGeneration).toBeGreaterThan(attempt.leaseGeneration);
    await expect(
      repository.completeStep(ownerId, { ...stale, expectedVersion: next.version }),
    ).rejects.toMatchObject({ code: "stale_attempt" });
  });

  it("new conflicting/unknown runtime facts revoke old quiescence and pause scheduling", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    const settled = await observe(task, attempt, binding);
    await repository.observeAttemptRuntime(ownerId, "fixture-runtime", {
      ...settled.input,
      eventId: randomUUID(),
      remoteId: randomUUID(),
      expectedRuntimeVersion: settled.receipt.runtimeVersion,
      backgroundProcesses: "unknown",
    });
    const snapshot = await repository.getTask(ownerId, task.taskId);
    expect(snapshot?.pauseRequested).toBe(true);
    expect(snapshot?.schedulingPaused).toBe(false);
    await db.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await expect(
      repository.reconcileExpiredAttempt(ownerId, "fixture-runtime", {
        ...control(task, attempt.version),
        attemptId: attempt.attemptId,
        quiescenceEventId: settled.receipt.eventId,
      }),
    ).rejects.toMatchObject({ code: "native_not_quiescent" });
  });

  it("does not treat settled-but-unreconciled external effects as permission to retry", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    await db.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    const observed = await observe(task, attempt, binding, {
      externalEffects: "requires_reconciliation",
    });
    await expect(
      repository.reconcileExpiredAttempt(ownerId, "fixture-runtime", {
        ...control(task, attempt.version),
        attemptId: attempt.attemptId,
        quiescenceEventId: observed.receipt.eventId,
      }),
    ).rejects.toMatchObject({ code: "native_not_quiescent" });
  });

  it("replays native binding receipts without authorizing a duplicate start", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    const binding = await bind(task, attempt);
    expect(
      await repository.bindAttemptRuntime(ownerId, "fixture-runtime", binding.input),
    ).toMatchObject({ replayed: true, canRun: false, needsReconciliation: true });
    await expect(
      repository.bindAttemptRuntime(ownerId, "fixture-runtime", {
        ...binding.input,
        binding: { ...binding.input.binding, nativeTurnId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "event_replay_conflict" });
    await expect(
      repository.observeAttemptRuntime(ownerId, "fixture-runtime", {
        schemaVersion: 1,
        eventId: randomUUID(),
        taskId: task.taskId,
        stepId: task.first,
        attemptId: attempt.attemptId,
        expectedRuntimeVersion: 1,
        bindingDigest: "f".repeat(64),
        remoteId: randomUUID(),
        proofDigest: "c".repeat(64),
        observedAt: new Date(),
        nativeTurn: "quiescent",
        backgroundProcesses: "quiescent",
        externalOperations: "quiescent",
        externalEffects: "none",
      }),
    ).rejects.toMatchObject({ code: "runtime_binding_mismatch" });
  });

  it("rolls source/evidence/attempt transitions back together if their audit write fails", async () => {
    const task = await fixture();
    const attempt = await claim(task);
    await bind(task, attempt);
    const result = await completion(task, attempt);
    const eventId = randomUUID();
    const before = await db.deliveryEvent.count({ where: { ownerId, taskId: task.taskId } });
    await db.$executeRawUnsafe(
      `CREATE FUNCTION delivery_recovery_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${eventId}'::uuid THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER delivery_recovery_audit_failure BEFORE INSERT ON delivery_events FOR EACH ROW EXECUTE FUNCTION delivery_recovery_fail_event()",
    );
    try {
      await expect(
        repository.changeSource(ownerId, {
          schemaVersion: 1,
          eventId,
          taskId: task.taskId,
          expectedVersion: 0,
          sourceSha: "d".repeat(40),
          reason: "Fixture audit rollback",
        }),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER delivery_recovery_audit_failure ON delivery_events");
      await db.$executeRawUnsafe("DROP FUNCTION delivery_recovery_fail_event()");
    }
    const snapshot = await repository.getTask(ownerId, task.taskId);
    expect(snapshot?.sourceSha).toBe(sha);
    expect(snapshot?.version).toBe(0);
    expect(snapshot?.steps[0].version).toBe(attempt.version);
    expect(snapshot?.steps[0].state).toBe("running");
    expect(snapshot?.steps[0].attempts[0].outcome).toBe("running");
    expect(
      (await db.deliveryEvidence.findUniqueOrThrow({ where: { id: result.evidenceIds[0] } }))
        .invalidatedAt,
    ).toBeNull();
    expect(await db.deliveryEvent.count({ where: { ownerId, taskId: task.taskId } })).toBe(before);
    expect(await db.deliveryOutbox.count({ where: { eventId } })).toBe(0);
  });

  it("keeps retry budgets and aggregate versions explicit while preserving older receipts", async () => {
    const task = await fixture();
    const first = await claim(task);
    const binding = await bind(task, first);
    const failedInput = {
      ...control(task, first.version),
      attemptId: first.attemptId,
      leaseGeneration: first.leaseGeneration,
      sourceSha: sha,
      disposition: "failed",
      report,
    };
    const failed = await repository.failAttempt(ownerId, failedInput);
    await observe(task, first, binding);
    const retried = await repository.retryStep(ownerId, control(task, failed.version));
    const second = await claim(task, retried.version);
    const secondBinding = await bind(task, second);
    await observe(task, second, secondBinding);
    const completed = await repository.completeStep(ownerId, await completion(task, second));
    expect((await repository.failAttempt(ownerId, failedInput)).replayed).toBe(true);
    expect((await repository.getTask(ownerId, task.taskId))?.steps[0].state).toBe("succeeded");
    const events = await db.deliveryEvent.findMany({
      where: { ownerId, aggregateKey: `step/${task.first}` },
      orderBy: { aggregateVersion: "asc" },
    });
    expect(events.map((event) => event.aggregateVersion)).toEqual(
      Array.from({ length: completed.version }, (_, index) => index + 1),
    );
    const exhausted = await fixture();
    const only = await claim(exhausted);
    const onlyBinding = await bind(exhausted, only);
    await db.deliveryStep.update({ where: { id: exhausted.first }, data: { attemptBudget: 1 } });
    const terminal = await repository.failAttempt(ownerId, {
      ...control(exhausted, only.version),
      attemptId: only.attemptId,
      leaseGeneration: only.leaseGeneration,
      sourceSha: sha,
      disposition: "failed",
      report,
    });
    await observe(exhausted, only, onlyBinding);
    await expect(
      repository.retryStep(ownerId, control(exhausted, terminal.version)),
    ).rejects.toMatchObject({ code: "attempt_budget_exhausted" });
    expect(await db.deliveryAttempt.count({ where: { ownerId, stepId: exhausted.first } })).toBe(1);
  });
});
