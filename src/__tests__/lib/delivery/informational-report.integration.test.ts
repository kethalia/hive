import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryOutbox } from "@/lib/delivery/outbox";
import { listDeliveryTasks, readDeliveryTask } from "@/lib/delivery/reads";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { nativeFixture } from "./native-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const report = {
  summary: "Understanding and plan recorded",
  difficulty: "high",
  difficultyReason: "Several recovery paths remain uncertain",
  issues: [{ summary: "Missing live evidence", resolution: "Plan an isolated validation" }],
  remainingUncertainty: "Model-authored analysis, not independently verified",
  nextAction: "Implement after writer reconciliation",
};
async function fixture(understand = true) {
  const f = await nativeFixture(db),
    dependent = randomUUID();
  const definition = {
    ...f.definition,
    steps: [
      {
        ...f.definition.steps[0],
        kind: understand ? "understand" : "validate",
        requiredEvidenceKinds: understand ? ["analysis"] : ["check"],
      },
      { id: dependent, kind: "implement", criterionIds: ["C1"], requiredEvidenceKinds: ["change"] },
    ],
    dependencies: [{ stepId: dependent, dependsOnStepId: f.stepId }],
  };
  await f.create(definition);
  const attempt = await f.claim();
  const resolve = vi.fn(() => {
    throw new Error("A PR does not exist yet");
  });
  const service = new DeliveryManagerService(db, {
    ...f.dependencies,
    resolveEvidencePolicy: resolve,
  });
  const payload = {
    taskId: f.taskId,
    stepId: f.stepId,
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    leaseGeneration: attempt.leaseGeneration,
    sourceSha: f.context.revision,
    report,
  };
  const input = (overrides = {}, eventId = randomUUID()) =>
    f.managerEnvelope(
      { operation: "report_step", payload: { ...payload, ...overrides } },
      { eventId },
    );
  return {
    ...f,
    dependent,
    attempt,
    payload,
    input,
    service,
    resolve,
    repository: new DeliveryRepository(db, f.policy),
  };
}
describe.skipIf(!url)("informational Understand reports in PostgreSQL", () => {
  it("projects only an owner-scoped manager conversation identity for task navigation", async () => {
    const f = await fixture();
    const detail = await readDeliveryTask(db, f.user.id, f.taskId);
    const conversation = await db.deliveryConversation.findFirstOrThrow({
      where: { ownerId: f.user.id, projectId: f.project.id },
    });
    expect(detail?.manager).toEqual({
      projectId: f.project.id,
      conversationId: conversation.id,
      workspaceId: f.host.workspaceId,
      threadId: conversation.nativeThreadId,
    });
    expect(await readDeliveryTask(db, randomUUID(), f.taskId)).toBeNull();
    for (const hidden of ["leaseId", "bindingDigest", "nativePath", "serverInstanceId", "buildId"])
      expect(detail?.manager).not.toHaveProperty(hidden);
  });
  it("records model-authored difficulty/issues without GitHub or evidence and preserves the exact native writer", async () => {
    const f = await fixture(),
      before = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.attempt.attemptId } });
    const result = await f.service.execute(f.input());
    expect(result).toMatchObject({ informational: true, replayed: false });
    expect(f.resolve).not.toHaveBeenCalled();
    const attempt = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: before.id } });
    expect(attempt).toMatchObject({
      outcome: "reported",
      runtimeBinding: before.runtimeBinding,
      runtimeBindingDigest: before.runtimeBindingDigest,
      runtimeVersion: before.runtimeVersion,
      quiescedAt: before.quiescedAt,
    });
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.attempt.managerBindingId },
        })
      ).activeAttemptId,
    ).toBe(before.id);
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    const task = await readDeliveryTask(db, f.user.id, f.taskId);
    expect(task?.counts).toMatchObject({ total: 2, succeeded: 0, reported: 1 });
    expect(task?.steps.find((step) => step.id === f.stepId)).toMatchObject({
      state: "reported",
      reports: [{ informational: true, difficulty: "high", issues: report.issues, evidence: [] }],
    });
  });
  it("concurrent duplicate replay creates one immutable report/event/notification and changed content conflicts", async () => {
    const f = await fixture(),
      input = f.input(),
      results = await Promise.all([f.service.execute(input), f.service.execute(input)]);
    expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
    await expect(
      f.service.execute(
        f.input({ report: { ...report, summary: "Changed result" } }, input.eventId),
      ),
    ).rejects.toThrow("replay_conflict");
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(1);
    expect(
      await db.deliveryEvent.count({ where: { ownerId: f.user.id, type: "step_reported" } }),
    ).toBe(1);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(1);
  });
  it("satisfies dependency bookkeeping while the next native attempt is still held", async () => {
    const f = await fixture(),
      request = () => ({
        schemaVersion: 1,
        eventId: randomUUID(),
        taskId: f.taskId,
        stepId: f.dependent,
        expectedVersion: 0,
        leaseHolder: "fixture-dependent",
      });
    await expect(f.repository.claimStep(f.user.id, request())).rejects.toThrow(
      "dependencies_pending",
    );
    await f.service.execute(f.input());
    await expect(f.repository.claimStep(f.user.id, request())).rejects.toThrow(
      "native_reconciliation_required",
    );
    await expect(f.claim(f.taskId, f.dependent)).rejects.toThrow("checkout_writer_busy");
    expect(await db.deliveryAttempt.count({ where: { ownerId: f.user.id } })).toBe(1);
  });
  it("model evidence/producer/pass assertions and non-analysis/production outcomes cannot use reporting", async () => {
    const f = await fixture();
    for (const extra of [
      { evidenceIds: [] },
      { producer: "trusted" },
      { passed: true },
      { policy: {} },
    ])
      await expect(f.service.execute(f.input(extra))).rejects.toThrow();
    const code = await fixture(false);
    await expect(code.service.execute(code.input())).rejects.toThrow("informational_step_only");
    await db.deliveryStep.update({
      where: { id: f.stepId },
      data: { requiredEvidenceKinds: ["analysis", "review"] },
    });
    await expect(f.service.execute(f.input())).rejects.toThrow("informational_step_only");
    await db.deliveryStep.update({
      where: { id: f.stepId },
      data: { requiredEvidenceKinds: ["analysis"], acceptancePhase: "activation_production" },
    });
    await expect(f.service.execute(f.input())).rejects.toThrow("informational_step_only");
    expect(
      await db.deliveryStepReport.count({ where: { ownerId: { in: [f.user.id, code.user.id] } } }),
    ).toBe(0);
  });
  it("owner, version, generation, source and expired lease fences reject before any result is persisted", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const extra of [
      { taskId: other.taskId },
      { attemptId: other.attempt.attemptId },
      { expectedVersion: f.attempt.version + 1 },
      { leaseGeneration: f.attempt.leaseGeneration + 1 },
      { sourceSha: "b".repeat(40) },
    ])
      await expect(f.service.execute(f.input(extra))).rejects.toThrow();
    await db.deliveryAttempt.update({
      where: { id: f.attempt.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(f.service.execute(f.input())).rejects.toThrow("stale_attempt");
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("registration revocation after external authorization prevents the informational transaction", async () => {
    const f = await fixture(),
      service = new DeliveryManagerService(db, {
        ...f.dependencies,
        reauthorize: async (binding) => {
          await db.codexHostRegistration.update({
            where: { id: f.registration().id },
            data: { revokedAt: new Date() },
          });
          return binding;
        },
      });
    await expect(service.execute(f.input())).rejects.toThrow();
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("notification uses accepted-analysis wording, historic attempt SHA and owner-scoped report links", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.service.execute(f.input());
    const outbox = new DeliveryOutbox(db),
      [claim] = await outbox.claim(f.user.id);
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { sourceSha: "b".repeat(40) } });
    const notification = await outbox.notification(claim);
    expect(notification?.payload.title).toBe("Analysis report accepted");
    expect(notification?.payload.body).toContain("high difficulty");
    expect(notification?.payload.body).toContain("aaaaaaaa");
    expect(await outbox.notification({ ...claim, ownerId: other.user.id })).toBeNull();
    expect(await readDeliveryTask(db, other.user.id, f.taskId)).toBeNull();
    expect(
      (await listDeliveryTasks(db, other.user.id))?.tasks.some((task) => task.id === f.taskId),
    ).toBe(false);
  });
  it("explicit reopen/source invalidation preserve historical reports and keep writer reconciliation required", async () => {
    for (const operation of ["reopen", "source"] as const) {
      const f = await fixture();
      await f.service.execute(f.input());
      const step = await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } });
      if (operation === "reopen")
        await f.repository.reopenStep(f.user.id, {
          schemaVersion: 1,
          eventId: randomUUID(),
          taskId: f.taskId,
          stepId: f.stepId,
          expectedVersion: step.version,
          reason: "Reconsider analysis",
        });
      else
        await f.repository.changeSource(f.user.id, {
          schemaVersion: 1,
          eventId: randomUUID(),
          taskId: f.taskId,
          expectedVersion: 0,
          sourceSha: "b".repeat(40),
          reason: "New source requires fresh understanding",
        });
      const task = await readDeliveryTask(db, f.user.id, f.taskId);
      const analysis = task?.steps.find((step) => step.id === f.stepId);
      expect(analysis?.state).toBe("blocked");
      expect(task?.counts.reported).toBe(0);
      expect(analysis?.reports[0].informational).toBe(true);
      expect(analysis?.reports[0].sourceSha).toBe(f.context.revision);
      expect(
        (
          await db.deliveryManagerBinding.findUniqueOrThrow({
            where: { id: f.attempt.managerBindingId },
          })
        ).activeAttemptId,
      ).toBe(f.attempt.attemptId);
      expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    }
  });
  it("SQL rejects reported code-quality and NULL-evidence kinds despite legacy nullable arrays", async () => {
    const f = await fixture(false);
    await expect(
      db.$executeRaw`UPDATE delivery_steps SET state='reported' WHERE id=${f.stepId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE delivery_steps SET kind='understand', required_evidence_kinds=NULL, state='reported' WHERE id=${f.stepId}::uuid`,
    ).rejects.toThrow();
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } })).state).toBe(
      "running",
    );
  });
});
