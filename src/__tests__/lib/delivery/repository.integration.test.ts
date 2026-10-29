import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDeliveryTasks, readDeliveryTask } from "@/lib/delivery/reads";
import { DeliveryRepository } from "@/lib/delivery/repository";

// Never fall back to DATABASE_URL. The suite runs only against an explicitly
// provided disposable loopback database; absent configuration is an honest skip.
const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/hive_delivery_test"
  )
    throw new Error("Delivery integration tests require the isolated local fixture");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
const policy = {
  version: "fixture-policy-v1",
  trustedProducers: ["fixture-check"],
  maxAgeMs: 3600_000,
};
const repository = new DeliveryRepository(db, policy);
let ownerId: string;
let otherOwnerId: string;
const sha = "a".repeat(40);

async function task(twoSteps = false) {
  const project = await repository.bindProject(ownerId, {
    provider: "github",
    providerRepositoryId: String(Date.now()) + String(Math.floor(Math.random() * 100000)),
    providerAccountId: "123",
    fullName: "fixture/delivery",
  });
  const taskId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  await repository.createTask(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    id: taskId,
    projectId: project.id,
    outcome: "Synthetic persistence fixture",
    branch: "fixture",
    sourceSha: sha,
    steps: [first, ...(twoSteps ? [second] : [])].map((id) => ({
      id,
      kind: "validate",
      criterionIds: ["C1"],
      requiredEvidenceKinds: ["check"],
    })),
    dependencies: twoSteps ? [{ stepId: second, dependsOnStepId: first }] : [],
  });
  return { taskId, first, second, projectId: project.id };
}
async function lease(fixture: Awaited<ReturnType<typeof task>>) {
  return repository.claimStep(ownerId, {
    schemaVersion: 1,
    eventId: randomUUID(),
    taskId: fixture.taskId,
    stepId: fixture.first,
    expectedVersion: 0,
    leaseHolder: "fixture-agent",
  });
}
async function completion(
  fixture: Awaited<ReturnType<typeof task>>,
  attempt: Awaited<ReturnType<typeof lease>>,
) {
  const evidenceId = randomUUID();
  await repository.recordEvidence(ownerId, "fixture-check", {
    id: evidenceId,
    stepId: fixture.first,
    remoteId: randomUUID(),
    kind: "check",
    status: "passed",
    sourceSha: sha,
    verificationMode: "simulated",
    environment: "isolated-local-fixture",
    criterionIds: ["C1"],
    objectKey: `delivery/${ownerId}/fixture/check.json`,
    contentDigest: "b".repeat(64),
    observedAt: new Date(Date.now() - 1000),
  });
  return {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    taskId: fixture.taskId,
    stepId: fixture.first,
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    leaseGeneration: attempt.leaseGeneration,
    sourceSha: sha,
    evidenceIds: [evidenceId],
    report: {
      summary: "Local fixture checks completed",
      difficulty: "moderate" as const,
      difficultyReason: "Exercised atomic persistence",
      issues: [],
      remainingUncertainty: "No external integration or production validation",
      nextAction: "Review evidence",
    },
  };
}

describe.skipIf(!url)("delivery PostgreSQL persistence", () => {
  beforeAll(async () => {
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    for (const id of [ownerId, otherOwnerId])
      await db.user.create({
        data: {
          id,
          coderUrl: "https://fixture.invalid",
          coderUserId: randomUUID(),
          username: "fixture",
          email: "fixture@example.invalid",
        },
      });
  });
  afterAll(async () => db.$disconnect());

  it("keeps project identity stable through rename and account reconnection", async () => {
    const first = await repository.bindProject(ownerId, {
      provider: "github",
      providerRepositoryId: "42",
      providerAccountId: "123",
      fullName: "owner/before",
    });
    const changed = await repository.bindProject(ownerId, {
      provider: "github",
      providerRepositoryId: "42",
      providerAccountId: "456",
      fullName: "new-owner/after",
    });
    expect(changed.id).toBe(first.id);
    expect(changed.providerAccountId).toBe("456");
    expect(changed.fullName).toBe("new-owner/after");
  });

  it("handles racing duplicate task creation without swallowing unrelated conflicts", async () => {
    const project = await repository.bindProject(ownerId, {
      provider: "github",
      providerRepositoryId: "999",
      providerAccountId: "123",
      fullName: "fixture/race",
    });
    const input = {
      schemaVersion: 1,
      eventId: randomUUID(),
      id: randomUUID(),
      projectId: project.id,
      outcome: "Racing task",
      branch: "fixture",
      sourceSha: sha,
      steps: [
        {
          id: randomUUID(),
          kind: "validate",
          criterionIds: ["C1"],
          requiredEvidenceKinds: ["check"],
        },
      ],
    };
    const receipts = await Promise.all([
      repository.createTask(ownerId, input),
      repository.createTask(ownerId, input),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect(await db.deliveryTask.count({ where: { id: input.id } })).toBe(1);
    await expect(
      repository.createTask(ownerId, { ...input, id: randomUUID(), eventId: randomUUID() }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("handles racing evidence replay with a stable ID and rejects changed payloads", async () => {
    const fixture = await task();
    const input = {
      id: randomUUID(),
      stepId: fixture.first,
      remoteId: randomUUID(),
      kind: "check",
      status: "passed",
      verificationMode: "simulated",
      environment: "local-fixture",
      sourceSha: sha,
      criterionIds: ["C1"],
      objectKey: `delivery/${ownerId}/fixture/evidence.json`,
      contentDigest: "b".repeat(64),
      observedAt: new Date(Date.now() - 1000),
    };
    const records = await Promise.all([
      repository.recordEvidence(ownerId, "fixture-check", input),
      repository.recordEvidence(ownerId, "fixture-check", input),
    ]);
    expect(records[0].id).toBe(records[1].id);
    expect(await db.deliveryEvidence.count({ where: { id: input.id } })).toBe(1);
    await expect(
      repository.recordEvidence(ownerId, "fixture-check", {
        ...input,
        contentDigest: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "evidence_replay_conflict" });
  });
  it("isolates reads and rejects cross-owner references at the database boundary", async () => {
    const fixture = await task();
    expect(await repository.getTask(otherOwnerId, fixture.taskId)).toBeNull();
    await expect(
      db.deliveryTask.create({
        data: {
          ownerId: otherOwnerId,
          projectId: fixture.projectId,
          outcome: "Cross owner",
          branch: "fixture",
          sourceSha: sha,
        },
      }),
    ).rejects.toThrow();
    await expect(
      repository.claimStep(otherOwnerId, {
        schemaVersion: 1,
        eventId: randomUUID(),
        taskId: fixture.taskId,
        stepId: fixture.first,
        expectedVersion: 0,
        leaseHolder: "wrong-owner",
      }),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });
  it("preserves native thread identity while rebinding a verified runtime generation", async () => {
    const fixture = await task();
    const workspaceId = randomUUID();
    const nativeThreadId = randomUUID();
    const input = {
      projectId: fixture.projectId,
      workspaceId,
      nativeThreadId,
      buildId: randomUUID(),
      serverInstanceId: "server-1",
    };
    const first = await repository.bindConversation(ownerId, input);
    const rebound = await repository.bindConversation(ownerId, {
      ...input,
      buildId: randomUUID(),
      serverInstanceId: "server-2",
    });
    expect(rebound.id).toBe(first.id);
    expect(rebound.nativeThreadId).toBe(nativeThreadId);
    expect(rebound.buildId).not.toBe(first.buildId);
    expect(rebound.nativePath).toBeNull();
    await expect(repository.bindConversation(otherOwnerId, input)).rejects.toMatchObject({
      code: "project_not_found",
    });
  });
  it("enforces same-task dependencies before leasing", async () => {
    const fixture = await task(true);
    await expect(
      repository.claimStep(ownerId, {
        schemaVersion: 1,
        eventId: randomUUID(),
        taskId: fixture.taskId,
        stepId: fixture.second,
        expectedVersion: 0,
        leaseHolder: "fixture",
      }),
    ).rejects.toMatchObject({ code: "dependencies_pending" });
    const other = await task();
    await expect(
      db.deliveryStepDependency.create({
        data: {
          ownerId,
          taskId: fixture.taskId,
          stepId: fixture.second,
          dependsOnStepId: other.first,
        },
      }),
    ).rejects.toThrow();
  });
  it("permits only one concurrent lease winner", async () => {
    const fixture = await task();
    const outcomes = await Promise.allSettled([lease(fixture), lease(fixture)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.deliveryAttempt.count({ where: { ownerId, stepId: fixture.first } })).toBe(1);
  });

  it("requires reconciliation instead of scheduling a second execution after lease receipt replay", async () => {
    const fixture = await task();
    const request = {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: fixture.taskId,
      stepId: fixture.first,
      expectedVersion: 0,
      leaseHolder: "fixture",
    };
    const first = await repository.claimStep(ownerId, request);
    const again = await repository.claimStep(ownerId, request);
    expect(first.canRun).toBe(false);
    expect(again).toMatchObject({
      attemptId: first.attemptId,
      replayed: true,
      canRun: false,
      needsReconciliation: true,
    });
    expect(await db.deliveryAttempt.count({ where: { ownerId, stepId: fixture.first } })).toBe(1);
  });
  it("atomically writes one completion event, report, evidence links and outbox across duplicate replay", async () => {
    const fixture = await task();
    const attempt = await lease(fixture);
    const input = await completion(fixture, attempt);
    const receipts = await Promise.all([
      repository.completeStep(ownerId, input),
      repository.completeStep(ownerId, input),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
    expect(receipts[0].reportId).toBe(receipts[1].reportId);
    const replayFile = process.env.HIVE_DELIVERY_TEST_REPLAY_FILE;
    if (replayFile) {
      if (!replayFile.startsWith("/tmp/hive-delivery-pg-"))
        throw new Error("Use the private disposable fixture for replay evidence");
      writeFileSync(
        replayFile,
        JSON.stringify({ ownerId, input, policy, reportId: receipts[0].reportId }),
        { mode: 0o600 },
      );
    }
    expect(await db.deliveryOutbox.count({ where: { ownerId, eventId: input.eventId } })).toBe(1);
    const snapshot = await repository.getTask(ownerId, fixture.taskId);
    expect(snapshot?.steps[0].state).toBe("succeeded");
    expect(snapshot?.steps[0].reports[0].evidence[0].evidenceId).toBe(input.evidenceIds[0]);
    await expect(
      repository.completeStep(ownerId, {
        ...input,
        report: { ...input.report, summary: "Altered replay" },
      }),
    ).rejects.toMatchObject({ code: "event_replay_conflict" });
    const reconnectedDb = new PrismaClient({ datasourceUrl: url });
    try {
      expect(
        (await new DeliveryRepository(reconnectedDb, policy).completeStep(ownerId, input)).replayed,
      ).toBe(true);
    } finally {
      await reconnectedDb.$disconnect();
    }
  });
  it("rolls back the state/event/report if the outbox insert fails", async () => {
    const fixture = await task();
    const input = await completion(fixture, await lease(fixture));
    await db.$executeRawUnsafe(
      `CREATE FUNCTION delivery_fixture_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id = '${input.eventId}'::uuid THEN RAISE EXCEPTION 'fixture outbox failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER delivery_fixture_outbox BEFORE INSERT ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION delivery_fixture_fail_outbox()",
    );
    try {
      await expect(repository.completeStep(ownerId, input)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER delivery_fixture_outbox ON delivery_outbox");
      await db.$executeRawUnsafe("DROP FUNCTION delivery_fixture_fail_outbox()");
    }
    expect((await repository.getTask(ownerId, fixture.taskId))?.steps[0].state).toBe("running");
    expect(await db.deliveryEvent.count({ where: { id: input.eventId } })).toBe(0);
    expect(await db.deliveryStepReport.count({ where: { eventId: input.eventId } })).toBe(0);
    expect(await db.deliveryOutbox.count({ where: { eventId: input.eventId } })).toBe(0);
    expect((await repository.completeStep(ownerId, input)).replayed).toBe(false);
  });

  it("keeps accepted events and reports immutable at the database boundary", async () => {
    const fixture = await task();
    const input = await completion(fixture, await lease(fixture));
    const receipt = await repository.completeStep(ownerId, input);
    await expect(
      db.deliveryEvent.update({ where: { id: receipt.eventId }, data: { type: "forged" } }),
    ).rejects.toThrow();
    await expect(
      db.deliveryStepReport.update({
        where: { id: receipt.reportId },
        data: { summary: "forged" },
      }),
    ).rejects.toThrow();
    await expect(
      db.deliveryEvidence.update({
        where: { id: input.evidenceIds[0] },
        data: { producer: "manager-says-so" },
      }),
    ).rejects.toThrow();
    await db.deliveryEvidence.update({
      where: { id: input.evidenceIds[0] },
      data: { invalidatedAt: new Date() },
    });
    await expect(
      db.deliveryEvidence.update({
        where: { id: input.evidenceIds[0] },
        data: { invalidatedAt: null },
      }),
    ).rejects.toThrow();
  });

  it("rejects a same-owner report bound to another step's event via its composite foreign key", async () => {
    const first = await task();
    const second = await task();
    const eventId = randomUUID();
    await repository.claimStep(ownerId, {
      schemaVersion: 1,
      eventId,
      taskId: first.taskId,
      stepId: first.first,
      expectedVersion: 0,
      leaseHolder: "fixture",
    });
    const secondAttempt = await lease(second);
    await expect(
      db.deliveryStepReport.create({
        data: {
          ownerId,
          stepId: second.first,
          attemptId: secondAttempt.attemptId,
          eventId,
          summary: "Cross-step fixture",
          difficulty: "low",
          difficultyReason: "Fixture",
          issues: [],
          remainingUncertainty: "No production",
          nextAction: "Review",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
  it("rejects expired attempts, stale generations and wrong versions without advancing state", async () => {
    const fixture = await task();
    const attempt = await lease(fixture);
    const input = await completion(fixture, attempt);
    await expect(
      repository.completeStep(ownerId, { ...input, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "version_conflict" });
    await expect(
      repository.completeStep(ownerId, { ...input, leaseGeneration: 100 }),
    ).rejects.toMatchObject({ code: "stale_attempt" });
    await db.deliveryAttempt.update({
      where: { id: attempt.attemptId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await expect(repository.completeStep(ownerId, input)).rejects.toMatchObject({
      code: "stale_attempt",
    });
    expect((await repository.getTask(ownerId, fixture.taskId))?.steps[0].state).toBe("running");
  });
  it("rejects untrusted, cross-owner, stale-source and invalidated evidence", async () => {
    const fixture = await task();
    const input = await completion(fixture, await lease(fixture));
    await expect(repository.recordEvidence(ownerId, "manager-says-so", {})).rejects.toMatchObject({
      code: "untrusted_evidence_producer",
    });
    await expect(
      repository.completeStep(ownerId, { ...input, evidenceIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: "evidence_not_found" });
    await db.deliveryEvidence.update({
      where: { id: input.evidenceIds[0] },
      data: { invalidatedAt: new Date() },
    });
    await expect(repository.completeStep(ownerId, input)).rejects.toMatchObject({
      code: "invalid_evidence",
    });
    await db.deliveryTask.update({
      where: { id: fixture.taskId },
      data: { sourceSha: "c".repeat(40) },
    });
    await expect(repository.completeStep(ownerId, input)).rejects.toMatchObject({
      code: "source_revision_changed",
    });
  });
  it("pauses scheduling while accepting an in-flight completion then resumes dependencies", async () => {
    const fixture = await task(true);
    const attempt = await lease(fixture);
    await repository.setPaused(ownerId, {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: fixture.taskId,
      expectedVersion: 0,
      paused: true,
    });
    expect((await repository.getTask(ownerId, fixture.taskId))?.schedulingPaused).toBe(false);
    const next = {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: fixture.taskId,
      stepId: fixture.second,
      expectedVersion: 0,
      leaseHolder: "fixture",
    };
    await expect(repository.claimStep(ownerId, next)).rejects.toMatchObject({
      code: "task_paused",
    });
    await repository.completeStep(ownerId, await completion(fixture, attempt));
    expect((await repository.getTask(ownerId, fixture.taskId))?.schedulingPaused).toBe(true);
    await repository.setPaused(ownerId, {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: fixture.taskId,
      expectedVersion: 1,
      paused: false,
    });
    expect((await repository.claimStep(ownerId, next)).leaseGeneration).toBe(1);
  });
  it("keeps release authority disabled in persistence", async () => {
    const fixture = await task();
    expect((await repository.getTask(ownerId, fixture.taskId))?.releaseMode).toBe("disabled");
    await expect(
      db.deliveryTask.update({ where: { id: fixture.taskId }, data: { releaseMode: "enabled" } }),
    ).rejects.toThrow();
    await db.deliveryStep.update({ where: { id: fixture.first }, data: { kind: "release" } });
    await expect(lease(fixture)).rejects.toMatchObject({ code: "release_disabled" });
  });

  it("projects owner-only reports without source object keys, lease handles or event digests", async () => {
    const fixture = await task();
    const input = await completion(fixture, await lease(fixture));
    await repository.completeStep(ownerId, input);
    const detail = await readDeliveryTask(db, ownerId, fixture.taskId);
    expect(detail?.steps[0].reports[0].evidence[0].verificationMode).toBe("simulated");
    const serialized = JSON.stringify(detail);
    for (const key of [
      "objectKey",
      "leaseHolder",
      "leaseGeneration",
      "requestDigest",
      "contentDigest",
    ])
      expect(serialized).not.toContain(`"${key}"`);
    expect(serialized).not.toContain(`delivery/${ownerId}/fixture/check.json`);
    expect(serialized).not.toContain("fixture-agent");
    expect(await readDeliveryTask(db, otherOwnerId, fixture.taskId)).toBeNull();
    expect(
      (await listDeliveryTasks(db, ownerId))?.tasks.some((item) => item.id === fixture.taskId),
    ).toBe(true);
    expect((await listDeliveryTasks(db, otherOwnerId))?.tasks).toEqual([]);
    expect(await listDeliveryTasks(db, otherOwnerId, fixture.taskId)).toBeNull();
  });

  it("selects an older report by owner/task and refuses cross-task or cross-owner deep links", async () => {
    const fixture = await task();
    const input = await completion(fixture, await lease(fixture));
    const original = await repository.completeStep(ownerId, input);
    // Synthetic later report generation exercises the read contract independently
    // of the not-yet-enabled reopen/controller integration.
    const eventId = randomUUID();
    await db.deliveryEvent.create({
      data: {
        id: eventId,
        ownerId,
        taskId: fixture.taskId,
        stepId: fixture.first,
        attemptId: input.attemptId,
        aggregateKey: `step/${fixture.first}`,
        aggregateVersion: 3,
        type: "step_completed",
        requestDigest: "d".repeat(64),
      },
    });
    const recent = await db.deliveryStepReport.create({
      data: {
        ownerId,
        stepId: fixture.first,
        attemptId: input.attemptId,
        eventId,
        ...input.report,
        summary: "Synthetic recent report",
        createdAt: new Date(Date.now() + 1000),
      },
    });
    expect(
      (await readDeliveryTask(db, ownerId, fixture.taskId))?.steps[0].reports.map(
        (report) => report.id,
      ),
    ).toEqual([recent.id]);
    const pinned = await readDeliveryTask(db, ownerId, fixture.taskId, original.reportId);
    expect(pinned?.steps[0].reports.map((report) => report.id)).toEqual([
      recent.id,
      original.reportId,
    ]);
    expect(await readDeliveryTask(db, otherOwnerId, fixture.taskId, original.reportId)).toBeNull();
    const other = await task();
    expect(await readDeliveryTask(db, ownerId, other.taskId, original.reportId)).toBeNull();
  });
});
