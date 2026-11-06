import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliveryOutbox, deliverClaim } from "@/lib/delivery/outbox";
import { readDeliveryTask } from "@/lib/delivery/reads";
import { DeliveryRepository } from "@/lib/delivery/repository";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/hive_delivery_test"
  )
    throw new Error("Outbox tests require the isolated local delivery fixture");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
const worker = new DeliveryOutbox(db);
const repository = new DeliveryRepository(db, {
  version: "fixture",
  trustedProducers: ["fixture"],
  maxAgeMs: 3600_000,
});
const sha = "a".repeat(40);

async function fixture(complete = true) {
  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      coderUrl: "https://fixture.invalid",
      coderUserId: randomUUID(),
      username: "fixture",
      email: "fixture@example.invalid",
    },
  });
  const project = await repository.bindProject(ownerId, {
    provider: "github",
    providerRepositoryId: "1",
    providerAccountId: "2",
    fullName: "fixture/notifications",
  });
  const taskId = randomUUID();
  const stepId = randomUUID();
  await repository.createTask(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    id: taskId,
    projectId: project.id,
    outcome: "Notification fixture",
    branch: "fixture",
    sourceSha: sha,
    steps: [
      { id: stepId, kind: "validate", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
    ],
  });
  if (!complete) return { ownerId, taskId, stepId, reportId: "" };
  const attempt = await repository.claimStep(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId,
    stepId,
    expectedVersion: 0,
    leaseHolder: "fixture",
  });
  const evidenceId = randomUUID();
  await repository.recordEvidence(ownerId, "fixture", {
    id: evidenceId,
    stepId,
    remoteId: randomUUID(),
    kind: "check",
    status: "passed",
    sourceSha: sha,
    verificationMode: "simulated",
    environment: "fixture",
    criterionIds: ["C1"],
    objectKey: `delivery/${ownerId}/fixture/check.json`,
    contentDigest: "b".repeat(64),
    observedAt: new Date(Date.now() - 1000),
  });
  const completed = await repository.completeStep(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId,
    stepId,
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    leaseGeneration: attempt.leaseGeneration,
    sourceSha: sha,
    evidenceIds: [evidenceId],
    report: {
      summary: "Synthetic check",
      difficulty: "moderate",
      difficultyReason: "Fixture",
      issues: [],
      remainingUncertainty: "No production verification",
      nextAction: "Read report",
    },
  });
  return { ownerId, taskId, stepId, reportId: completed.reportId };
}
async function expire(id: string) {
  await db.deliveryOutbox.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
}

describe.skipIf(!url)("delivery notification outbox PostgreSQL", () => {
  beforeAll(async () => db.$connect());
  afterAll(async () => db.$disconnect());

  it("delivers non-report blocked notices instead of silently exhausting retries", async () => {
    const f = await fixture(false);
    await repository.blockStep(f.ownerId, {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: f.taskId,
      stepId: f.stepId,
      expectedVersion: 0,
      reason: "Waiting for fixture input",
    });
    const [claim] = await worker.claim(f.ownerId);
    const message = await worker.notification(claim);
    expect(message?.payload.title).toBe("Step blocked");
    const detail = await readDeliveryTask(db, f.ownerId, f.taskId);
    expect(detail?.steps[0].waitingReason).toBe("Waiting for fixture input");
    expect(
      detail?.recentEvents.some(
        (event) => event.label === "Step blocked" && event.reason === "Waiting for fixture input",
      ),
    ).toBe(true);
    expect(await readDeliveryTask(db, randomUUID(), f.taskId)).toBeNull();
    expect(message?.payload.url).toBe(`/workspaces?panel=delivery&task=${f.taskId}`);
    expect(await deliverClaim(worker, claim, async () => "delivered")).toBe("delivered");
  });

  it("concurrent consumers claim a report once and cannot cross owners", async () => {
    const f = await fixture();
    const claims = (await Promise.all([worker.claim(f.ownerId), worker.claim(f.ownerId)])).flat();
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(await worker.notification({ ...claim, ownerId: randomUUID() })).toBeNull();
    expect(await worker.settle({ ...claim, ownerId: randomUUID() }, "delivered")).toBe(false);
    const message = await worker.notification(claim);
    expect(message?.payload.url).toBe(
      `/workspaces?panel=delivery&task=${f.taskId}&report=${f.reportId}`,
    );
    expect(message?.payload.kind).toBe("delivery");
    expect(await worker.settle(claim, "delivered")).toBe(true);
    expect(await worker.claim(f.ownerId)).toEqual([]);
    expect(await worker.settle(claim, "retry")).toBe(false);
  });

  it("preserves the original report revision after task source changes", async () => {
    const f = await fixture();
    // Simulate later aggregate revision, preserving immutable report/attempt rows.
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { sourceSha: "c".repeat(40) } });
    const [claim] = await worker.claim(f.ownerId);
    expect((await worker.notification(claim))?.payload.body).toContain("aaaaaaaa");
    expect((await worker.notification(claim))?.payload.body).not.toContain("cccccccc");
    await worker.settle(claim, "delivered");
  });

  it("recovers an expired claim with the same notification tag and fences the old worker", async () => {
    const f = await fixture();
    const [old] = await worker.claim(f.ownerId);
    const payload = (await worker.notification(old))?.payload;
    await expire(old.id);
    expect(await worker.settle(old, "delivered")).toBe(false);
    const restarted = new DeliveryOutbox(db);
    const [current] = await restarted.claim(f.ownerId);
    expect(current.attempt).toBe(2);
    expect((await restarted.notification(current))?.payload).toEqual(payload);
    expect(await worker.notification(old)).toBeNull();
    expect(await worker.settle(old, "failed")).toBe(false);
    expect(await restarted.settle(current, "delivered")).toBe(true);
  });

  it("backs off failures, stops after five attempts, and preserves readable reports", async () => {
    const f = await fixture();
    for (let i = 1; i <= 5; i++) {
      const [claim] = await worker.claim(f.ownerId);
      expect(claim.attempt).toBe(i);
      expect(
        await deliverClaim(worker, claim, async () => {
          throw new Error("transport unavailable");
        }),
      ).toBe(i === 5 ? "failed" : "retry");
      expect(await worker.claim(f.ownerId)).toEqual([]);
      if (i < 5) await expire(claim.id);
    }
    const row = await db.deliveryOutbox.findFirstOrThrow({ where: { ownerId: f.ownerId } });
    expect(row.status).toBe("failed");
    expect(
      (await readDeliveryTask(db, f.ownerId, f.taskId))?.recentEvents.some(
        (event) => event.reportId === f.reportId && event.notificationStatus === "failed",
      ),
    ).toBe(true);
    expect(await db.deliveryStepReport.findUnique({ where: { id: f.reportId } })).not.toBeNull();
  });

  it("a fifth crashed consumer is exhausted without another send", async () => {
    const f = await fixture();
    for (let i = 1; i <= 5; i++) {
      const [claim] = await worker.claim(f.ownerId);
      expect(claim.attempt).toBe(i);
      await expire(claim.id);
    }
    expect(await worker.claim(f.ownerId)).toEqual([]);
    expect(
      (await db.deliveryOutbox.findFirstOrThrow({ where: { ownerId: f.ownerId } })).status,
    ).toBe("failed");
  });

  it("disabled push can acknowledge the attempt without discarding the durable report", async () => {
    const f = await fixture();
    const [claim] = await worker.claim(f.ownerId);
    expect(await deliverClaim(worker, claim, async () => "delivered")).toBe("delivered");
    expect(await db.deliveryStepReport.findUnique({ where: { id: f.reportId } })).not.toBeNull();
  });
});
