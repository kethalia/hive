import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { PrismaRegistrationStore } from "@/lib/codex-session/registration-store.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { managerProofPayload } from "@/lib/delivery/manager-contracts";
import { DeliveryRepository } from "@/lib/delivery/repository";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local delivery fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const sha = "a".repeat(40);
const policy = {
  version: "manager-fixture-v1",
  trustedProducers: ["fixture-ci"],
  trustedRuntimeAdapters: ["fixture-runtime"],
  maxAgeMs: 60_000,
};
const report = {
  summary: "Synthetic result",
  difficulty: "low",
  difficultyReason: "Bounded fixture",
  issues: [],
  remainingUncertainty: "Not live native or production evidence",
  nextAction: "Review fixture",
};

async function fixture() {
  const user = await db.user.create({
    data: {
      coderUrl: "https://fixture.invalid",
      coderUserId: randomUUID(),
      username: "manager-fixture",
      email: "fixture@example.invalid",
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/manager",
    },
  });
  const keys = generateKeyPairSync("ed25519");
  const binding: RegistrationBinding = {
    coderOrigin: user.coderUrl,
    hiveUserId: user.id,
    ownerId: user.coderUserId,
    workspaceId: randomUUID(),
    buildId: randomUUID(),
    agentId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://fixture-app.invalid",
    appId: randomUUID(),
    projects: [{ projectId: project.id, repositoryId: "123" }],
  };
  const store = new PrismaRegistrationStore(db),
    registrationId = randomUUID(),
    serverInstanceId = randomUUID(),
    managerThreadId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const grantDigest = randomBytes(32).toString("hex");
  const generation = await store.reserve({ grantId: registrationId, binding, expiresAt: now + 60 });
  await store.seal({ grantId: registrationId, generation, grantDigest });
  expect(
    await store.consumeAndRegister({
      grantId: registrationId,
      grantDigest,
      expiresAt: now + 60,
      now,
      registration: {
        binding,
        serverInstanceId,
        protocolVersion: "0.165.0",
        threads: [{ projectId: project.id, repositoryId: "123", threadId: managerThreadId }],
        hostPublicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        generation,
        registeredAt: now,
        expiresAt: now + 60,
      },
    }),
  ).toBe(true);
  const reauthorize = async (value: RegistrationBinding) => value;
  const service = new DeliveryManagerService(db, { reauthorize, evidencePolicy: policy });
  const envelope = (command: unknown, overrides = {}) => {
    const value = {
      schemaVersion: 1,
      registrationId,
      serverInstanceId,
      eventId: randomUUID(),
      managerThreadId,
      nativeTurnId: randomUUID(),
      nativeCallId: randomUUID(),
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30_000,
      command,
      ...overrides,
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(managerProofPayload(value)), keys.privateKey).toString(
        "base64url",
      ),
    };
  };
  const taskId = randomUUID(),
    stepId = randomUUID();
  const definition = {
    id: taskId,
    outcome: "Synthetic manager task",
    branch: "fixture",
    sourceSha: sha,
    steps: [
      { id: stepId, kind: "validate", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
    ],
  };
  async function create() {
    await service.execute(envelope({ operation: "create_task", payload: definition }));
  }
  async function claim() {
    return (await service.execute(
      envelope({
        operation: "claim_step",
        payload: {
          taskId,
          stepId,
          expectedVersion: 0,
          requestedModel: "fixture-model",
          requestedEffort: "low",
        },
      }),
    )) as unknown as {
      attemptId: string;
      version: number;
      leaseGeneration: number;
      canRun: boolean;
    };
  }
  async function trustedEvidence(attempt: Awaited<ReturnType<typeof claim>>, settings = {}) {
    const repository = new DeliveryRepository(db, policy);
    const childThreadId = randomUUID(),
      spawnCallId = randomUUID();
    const bound = await repository.bindAttemptRuntime(user.id, "fixture-runtime", {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId,
      stepId,
      attemptId: attempt.attemptId,
      expectedRuntimeVersion: 0,
      binding: {
        coderOwnerId: user.coderUserId,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        serverInstanceId,
        managerThreadId,
        nativeThreadId: childThreadId,
        nativeTurnId: randomUUID(),
        operationId: spawnCallId,
        lifetimeId: randomUUID(),
        sourceSha: sha,
      },
    });
    await repository.recordNativeDelegation(user.id, "fixture-runtime", {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId,
      stepId,
      attemptId: attempt.attemptId,
      expectedRuntimeVersion: bound.runtimeVersion,
      bindingDigest: bound.bindingDigest,
      managerThreadId,
      parentTurnId: randomUUID(),
      spawnCallId,
      childThreadId,
      requestedModel: "fixture-model",
      requestedEffort: "low",
      effectiveModel: "fixture-model",
      effectiveEffort: "low",
      ...settings,
    });
    const evidenceId = randomUUID();
    await repository.recordEvidence(user.id, "fixture-ci", {
      id: evidenceId,
      stepId,
      remoteId: randomUUID(),
      kind: "check",
      status: "passed",
      verificationMode: "simulated",
      environment: "synthetic-manager-fixture",
      sourceSha: sha,
      criterionIds: ["C1"],
      objectKey: `delivery/${user.id}/fixture/check.json`,
      contentDigest: "b".repeat(64),
      observedAt: new Date(Date.now() - 100),
    });
    return {
      taskId,
      stepId,
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      leaseGeneration: attempt.leaseGeneration,
      sourceSha: sha,
      evidenceIds: [evidenceId],
      report,
    };
  }
  return {
    user,
    project,
    binding,
    keys,
    store,
    service,
    envelope,
    registrationId,
    taskId,
    stepId,
    definition,
    create,
    claim,
    trustedEvidence,
  };
}

describe.skipIf(!url)("registered manager/controller PostgreSQL transport", () => {
  it("atomically creates initial epic/task scoped to persisted native conversation and replays exactly", async () => {
    const f = await fixture(),
      epicId = randomUUID();
    const request = f.envelope({
      operation: "create_task",
      payload: {
        ...f.definition,
        epicId,
        initialEpic: { id: epicId, outcome: "Synthetic epic", criteria: ["C1"] },
      },
    });
    expect(await f.service.execute(request)).toMatchObject({ taskId: f.taskId, replayed: false });
    expect(await f.service.execute(request)).toMatchObject({ taskId: f.taskId, replayed: true });
    expect(await db.deliveryEpic.count({ where: { ownerId: f.user.id } })).toBe(1);
    const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } });
    expect(task.projectId).toBe(f.project.id);
    expect(task.conversationId).not.toBeNull();
    await expect(
      f.service.execute(
        f.envelope(
          { operation: "create_task", payload: { ...f.definition, outcome: "Changed" } },
          { eventId: request.eventId },
        ),
      ),
    ).rejects.toThrow("event_replay_conflict");
  });
  it("rejects signature/body changes, caller-owned scope, evidence producers and effective settings", async () => {
    const f = await fixture(),
      request = f.envelope({ operation: "create_task", payload: f.definition });
    await expect(f.service.execute({ ...request, nativeCallId: "tampered" })).rejects.toThrow();
    await expect(
      f.service.execute(
        f.envelope({
          operation: "create_task",
          payload: { ...f.definition, projectId: f.project.id },
        }),
      ),
    ).rejects.toThrow();
    await f.create();
    await expect(
      f.service.execute(
        f.envelope({
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            expectedVersion: 0,
            effectiveModel: "forged",
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.service.execute(
        f.envelope({
          operation: "record_evidence",
          payload: { producer: "fixture-ci", status: "passed" },
        }),
      ),
    ).rejects.toThrow();
  });
  it("denies cross-owner and unregistered native thread commands", async () => {
    const f = await fixture(),
      other = await fixture();
    await f.create();
    await expect(
      other.service.execute(
        other.envelope({
          operation: "claim_step",
          payload: { taskId: f.taskId, stepId: f.stepId, expectedVersion: 0 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.service.execute(
        f.envelope(
          { operation: "create_task", payload: f.definition },
          { managerThreadId: randomUUID() },
        ),
      ),
    ).rejects.toThrow();
  });
  it("rechecks revoked registration after external authorization and before any write", async () => {
    const f = await fixture();
    const service = new DeliveryManagerService(db, {
      reauthorize: async (binding) => {
        await db.codexHostRegistration.update({
          where: { id: f.registrationId },
          data: { revokedAt: new Date() },
        });
        return binding;
      },
    });
    await expect(
      service.execute(f.envelope({ operation: "create_task", payload: f.definition })),
    ).rejects.toThrow();
    expect(await db.deliveryTask.count({ where: { ownerId: f.user.id } })).toBe(0);
    await expect(
      f.service.execute(
        f.envelope(
          { operation: "create_task", payload: f.definition },
          { issuedAt: Date.now() - 120000, expiresAt: Date.now() - 60000 },
        ),
      ),
    ).rejects.toThrow();
  });
  it("records requested settings without inventing effective telemetry or execution authority", async () => {
    const f = await fixture();
    await f.create();
    const result = await f.claim();
    expect(result.canRun).toBe(false);
    const attempt = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
    expect(attempt).toMatchObject({
      requestedModel: "fixture-model",
      requestedEffort: "low",
      effectiveModel: null,
      effectiveEffort: null,
      runtimeBinding: null,
    });
  });
  it("serializes a registration revocation racing a task mutation and commits no stale writer", async () => {
    const f = await fixture();
    let release!: () => void, locked!: () => void, authorized!: () => void;
    const lockReady = new Promise<void>((resolve) => (locked = resolve)),
      allowRevoke = new Promise<void>((resolve) => (release = resolve)),
      reauthorized = new Promise<void>((resolve) => (authorized = resolve));
    const slot = await db.codexHostSlot.findFirstOrThrow({ where: { ownerId: f.user.id } });
    const revoke = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM codex_host_slots WHERE id=${slot.id}::uuid FOR UPDATE`;
      locked();
      await allowRevoke;
      await tx.codexHostRegistration.update({
        where: { id: f.registrationId },
        data: { revokedAt: new Date() },
      });
    });
    await lockReady;
    const service = new DeliveryManagerService(db, {
      reauthorize: async (binding) => {
        authorized();
        return binding;
      },
    });
    const outcome = service
      .execute(f.envelope({ operation: "create_task", payload: f.definition }))
      .then(
        () => "accepted",
        () => "rejected",
      );
    await reauthorized;
    let waiting = false;
    try {
      for (let i = 0; i < 40; i++) {
        const rows = await db.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%codex_host_slots%'`;
        if (rows[0].count > BigInt(0)) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
    }
    await revoke;
    expect(waiting).toBe(true);
    expect(await outcome).toBe("rejected");
    expect(await db.deliveryTask.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("accepts only separately trusted persisted evidence, yielding one immutable report/outbox on replay", async () => {
    const f = await fixture();
    await f.create();
    const attempt = await f.claim(),
      payload = await f.trustedEvidence(attempt);
    const noTrust = new DeliveryManagerService(db, { reauthorize: async (b) => b });
    await expect(
      noTrust.execute(f.envelope({ operation: "complete_step", payload })),
    ).rejects.toThrow("invalid_evidence");
    const request = f.envelope({ operation: "complete_step", payload }),
      first = await f.service.execute(request),
      replay = await f.service.execute(request);
    expect(replay).toMatchObject({ ...first, replayed: true });
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(1);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(1);
  });
  it("persists failure once without asserting native quiescence", async () => {
    const f = await fixture();
    await f.create();
    const attempt = await f.claim();
    const request = f.envelope({
      operation: "fail_attempt",
      payload: {
        taskId: f.taskId,
        stepId: f.stepId,
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        leaseGeneration: attempt.leaseGeneration,
        sourceSha: sha,
        reason: "Fixture blocked",
        disposition: "blocked",
        report,
      },
    });
    await f.service.execute(request);
    await f.service.execute(request);
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(1);
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } })).quiescedAt,
    ).toBeNull();
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(1);
  });
  it("keeps unavailable native settings unknown, pauses scheduling and fences conflicting native metadata", async () => {
    const f = await fixture();
    await f.create();
    const attempt = await f.claim();
    const payload = await f.trustedEvidence(attempt, {
      effectiveModel: null,
      effectiveEffort: null,
    });
    const row = await db.deliveryAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } });
    expect(row.effectiveModel).toBeNull();
    expect(row.effectiveEffort).toBeNull();
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    await expect(
      f.service.execute(f.envelope({ operation: "complete_step", payload })),
    ).rejects.toThrow("native_settings_unverified");
    const event = await db.deliveryEvent.findFirstOrThrow({
      where: { ownerId: f.user.id, type: "native_delegation_observed" },
    });
    const {
      producer: _producer,
      settingsMatch: _match,
      ...input
    } = event.payload as Record<string, unknown>;
    const repo = new DeliveryRepository(db, policy);
    expect(await repo.recordNativeDelegation(f.user.id, "fixture-runtime", input)).toMatchObject({
      replayed: true,
    });
    await expect(
      repo.recordNativeDelegation(f.user.id, "manager-self-asserted", input),
    ).rejects.toThrow("untrusted_runtime_adapter");
    await expect(
      repo.recordNativeDelegation(f.user.id, "fixture-runtime", {
        ...input,
        eventId: randomUUID(),
        expectedRuntimeVersion: row.runtimeVersion,
        childThreadId: randomUUID(),
      }),
    ).rejects.toThrow("native_delegation_binding_mismatch");
    await expect(
      repo.recordNativeDelegation(f.user.id, "fixture-runtime", {
        ...input,
        eventId: randomUUID(),
        expectedRuntimeVersion: row.runtimeVersion,
        effectiveModel: "fixture-model",
        effectiveEffort: "low",
      }),
    ).resolves.toMatchObject({ settingsMatch: true });
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
  });
});
