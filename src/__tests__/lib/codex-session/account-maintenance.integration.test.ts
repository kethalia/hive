import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { accountMaintenanceStateSchema } from "@/lib/codex-session/account-maintenance-contracts";
import {
  AccountMaintenanceStore,
  assertAccountMaintenanceAdmission,
} from "@/lib/codex-session/account-maintenance-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { executionActorHistory } from "@/lib/delivery/execution-authority.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryStatusService } from "@/lib/delivery/status.server";
import { deliveryStatusProofPayload } from "@/lib/delivery/status-contracts";
import { resumeAccountMaintenanceFixture } from "./account-maintenance-fixture";
import { guardianFixture } from "./guardian-fixture";

const url = process.env.HIVE_ACCOUNT_MAINTENANCE_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/hive_account_maintenance_test"
  )
    throw Error("Owned local fixture only");
}
const db = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
afterAll(() => db.$disconnect());

describe.skipIf(!url)("account maintenance owner intent, actual PostgreSQL", () => {
  async function setup(withTask: boolean | "successful" = true) {
    const fixture = await guardianFixture(db);
    const nextStep = randomUUID();
    if (withTask === "successful") {
      const manager = new DeliveryManagerService(db, {
        ...fixture.dependencies,
        progressionProtocol: 1,
      });
      await manager.execute(
        fixture.managerEnvelope({
          operation: "create_task",
          payload: {
            ...fixture.definition,
            steps: [
              {
                id: fixture.stepId,
                kind: "understand",
                criterionIds: ["C1"],
                requiredEvidenceKinds: ["analysis"],
              },
              {
                id: nextStep,
                kind: "validate",
                criterionIds: ["C1"],
                requiredEvidenceKinds: ["check"],
              },
            ],
            dependencies: [{ stepId: nextStep, dependsOnStepId: fixture.stepId }],
          },
        }),
      );
      const first = (await manager.execute(
        fixture.managerEnvelope({
          operation: "claim_step",
          payload: {
            taskId: fixture.taskId,
            stepId: fixture.stepId,
            expectedVersion: 0,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        }),
      )) as { attemptId: string; version: number; leaseGeneration: number };
      await manager.execute(
        fixture.managerEnvelope({
          operation: "report_step",
          payload: {
            taskId: fixture.taskId,
            stepId: fixture.stepId,
            attemptId: first.attemptId,
            expectedVersion: first.version,
            leaseGeneration: first.leaseGeneration,
            sourceSha: fixture.context.revision,
            report: {
              summary: "Completed bounded understanding",
              difficulty: "low",
              difficultyReason: "Fixture",
              issues: [],
              remainingUncertainty: "Provider acceptance unproven",
              nextAction: "Validate",
            },
          },
        }),
      );
    } else if (withTask) {
      await fixture.create();
      await fixture.claim();
    }
    const binding = fixture.guardian.runtime.binding as unknown as RegistrationBinding;
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: fixture.guardian.runtime.id },
    });
    const store = new AccountMaintenanceStore(db);
    const input = {
      requestId: randomUUID(),
      expectedVersion: 0,
      runtimeId: runtime.id,
      runtimeGeneration: runtime.generation,
    };
    return { fixture, binding, runtime, store, input, nextStep };
  }
  it("persists one owner-confirmed cohort, pauses scheduling, retains unfinished attempts and exact writer fences", async () => {
    const f = await setup();
    const before = await db.deliveryAttempt.findMany({
      where: { ownerId: f.binding.hiveUserId },
      orderBy: { id: "asc" },
    });
    const state = await f.store.request(f.binding, f.input);
    expect(state).toMatchObject({
      state: "requested",
      version: 1,
      maintenanceId: f.input.requestId,
    });
    expect(await f.store.request(f.binding, f.input)).toEqual(state);
    const slot = await db.codexHostSlot.findFirstOrThrow({
      where: { ownerId: f.binding.hiveUserId },
    });
    const saved = accountMaintenanceStateSchema.parse(slot.accountMaintenance);
    expect(saved.projects).toHaveLength(1);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.treeReceiptDigests).toEqual([]);
    expect(
      await db.deliveryAttempt.findMany({
        where: { ownerId: f.binding.hiveUserId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: saved.tasks[0].taskId } });
    expect(task.pauseRequested).toBe(true);
    expect(task.sourceVersion).toBe(saved.tasks[0].sourceVersion);
    expect(
      await db.deliveryEvent.findMany({
        where: { ownerId: f.binding.hiveUserId, type: "pause_requested" },
      }),
    ).toHaveLength(1);
    const initial = await setup(false);
    const foreignInitial = {
      ...saved,
      ownerId: initial.binding.hiveUserId,
      coderOwnerId: initial.binding.ownerId,
      coderOrigin: initial.binding.coderOrigin,
      workspaceId: initial.binding.workspaceId,
      buildId: initial.binding.buildId,
      runtimes: saved.runtimes.map((r) => ({ ...r, buildId: initial.binding.buildId })),
      phase: "held",
    };
    await expect(db.$executeRaw`UPDATE codex_host_slots SET account_maintenance=${JSON.stringify(foreignInitial)}::jsonb,
      account_maintenance_version=1 WHERE owner_id=${initial.binding.hiveUserId}::uuid`).rejects.toThrow(
      "account_maintenance_initial_phase_rejected",
    );
    await expect(
      db.$transaction((tx) =>
        assertAccountMaintenanceAdmission(tx, f.binding, { kind: "enroll", empty: true }),
      ),
    ).rejects.toThrow();
    await expect(
      db.$transaction((tx) =>
        assertAccountMaintenanceAdmission(tx, f.binding, {
          kind: "native",
          runtimeId: f.runtime.id,
        }),
      ),
    ).rejects.toThrow();
  });
  it("rejects owner/build/generation substitution and cannot silently replace or clear a pending intent", async () => {
    const f = await setup();
    for (const binding of [
      { ...f.binding, hiveUserId: randomUUID() },
      { ...f.binding, ownerId: randomUUID() },
      { ...f.binding, buildId: randomUUID() },
    ]) {
      await expect(f.store.request(binding, f.input)).rejects.toThrow();
    }
    await expect(
      f.store.request(f.binding, { ...f.input, runtimeGeneration: f.input.runtimeGeneration + 1 }),
    ).rejects.toThrow();
    await f.store.request(f.binding, f.input);
    await expect(
      f.store.request(f.binding, { ...f.input, requestId: randomUUID(), expectedVersion: 1 }),
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE codex_host_slots SET account_maintenance=NULL,account_maintenance_version=account_maintenance_version+1 WHERE owner_id=${f.binding.hiveUserId}::uuid`,
    ).rejects.toThrow();
    const slot = await db.codexHostSlot.findFirstOrThrow({
      where: { ownerId: f.binding.hiveUserId },
    });
    await expect(
      db.$executeRaw`UPDATE codex_host_slots SET account_maintenance=${JSON.stringify({ ...accountMaintenanceStateSchema.parse(slot.accountMaintenance), id: randomUUID() })}::jsonb,account_maintenance_version=account_maintenance_version+1 WHERE id=${slot.id}::uuid`,
    ).rejects.toThrow();
    expect((await f.store.status(f.binding)).maintenanceId).toBe(f.input.requestId);
  });
  it.each([
    true,
    false,
    "successful" as const,
  ])("separates unfinished physical closure and resumes exact retained intent (delivery binding: %s)", async (withTask) => {
    const f = await setup(withTask);
    const {
      authority,
      newStore,
      readyInput,
      originalBindings,
      registrationId,
      serverInstanceId,
      emptyBinding,
      idle,
      resume,
      archive,
    } = await resumeAccountMaintenanceFixture(db, f, withTask);
    if (withTask === false) {
      const manager = new DeliveryManagerService(db, {
        ...f.fixture.dependencies,
        progressionProtocol: 1,
      });
      const actor = { registrationId, serverInstanceId, nativeTurnId: randomUUID() };
      await manager.execute(
        f.fixture.managerEnvelope(
          { operation: "create_task", payload: f.fixture.definition },
          actor,
        ),
      );
      const claimed = await manager.execute(
        f.fixture.managerEnvelope(
          {
            operation: "claim_step",
            payload: {
              taskId: f.fixture.taskId,
              stepId: f.fixture.stepId,
              expectedVersion: 0,
              requestedModel: "gpt-6.1-sol",
              requestedEffort: "low",
            },
          },
          actor,
        ),
      );
      expect(claimed).toMatchObject({ replayed: false, canRun: false, needsRuntimeBinding: true });
      expect(await newStore.maintenanceResumeReady(readyInput)).toEqual(authority);
      const newBinding = await db.deliveryManagerBinding.findFirstOrThrow({
        where: { ownerId: f.binding.hiveUserId },
      });
      expect(newBinding).toMatchObject({
        executionEpochVersion: 0,
        serverInstanceId,
        preparationIntentId: f.fixture.context.preparationIntentId,
      });
    }
    if (withTask === "successful") {
      const permit = authority.authorizations[0];
      expect(permit.claimContinuation).toBeTruthy();
      const prior = await db.deliveryAttempt.findUniqueOrThrow({
        where: { id: originalBindings[0].currentAttemptId! },
      });
      const statusBody = {
        schemaVersion: 1,
        action: "read_delivery_status",
        requestId: randomUUID(),
        registrationId,
        serverInstanceId,
        managerThreadId: f.fixture.managerThreadId,
        checkoutBinding: f.fixture.context,
        managerBindingId: originalBindings[0].id,
        taskId: f.fixture.taskId,
        stepId: prior.stepId,
        attemptId: prior.id,
        attemptLeaseGeneration: prior.leaseGeneration,
        inputSourceSha: prior.sourceSha,
        inputSourceContext: null,
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 30000,
      };
      const status = await new DeliveryStatusService(db, f.fixture.dependencies).read({
        ...statusBody,
        proof: sign(
          null,
          Buffer.from(deliveryStatusProofPayload(statusBody)),
          f.fixture.keys.privateKey,
        ).toString("base64url"),
      });
      expect(status.scope.attemptId).toBe(prior.id);
      expect(status.executionAuthorized).toBe(false);
      expect(status.blockers).toContain("attempt_not_running");
      const manager = new DeliveryManagerService(db, {
        ...f.fixture.dependencies,
        progressionProtocol: 1,
      });
      const command = {
        operation: "claim_step",
        payload: {
          taskId: f.fixture.taskId,
          stepId: f.nextStep,
          expectedVersion: 0,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      };
      const claim = f.fixture.managerEnvelope(command, {
        registrationId,
        serverInstanceId,
        nativeTurnId: randomUUID(),
        maintenanceContinuation: permit.claimContinuation,
      });
      for (const override of [
        undefined,
        { ...permit.claimContinuation, ownerIntentEventId: randomUUID() },
      ])
        await expect(
          manager.execute(
            f.fixture.managerEnvelope(command, {
              registrationId,
              serverInstanceId,
              nativeTurnId: randomUUID(),
              ...(override ? { maintenanceContinuation: override } : {}),
            }),
          ),
        ).rejects.toThrow();
      const late = f.fixture.managerEnvelope(command, {
        registrationId,
        serverInstanceId,
        nativeTurnId: randomUUID(),
        maintenanceContinuation: permit.claimContinuation,
        expiresAt: Date.now() + 300,
      });
      await db.$executeRawUnsafe(`CREATE FUNCTION pg_temp.hive_maintenance_claim_delay() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN IF NEW.type='account_maintenance_claim_consumed' AND NEW.payload->>'claimEventId'='${late.eventId}' THEN
          PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $body$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER hive_maintenance_claim_delay BEFORE INSERT ON delivery_events
        FOR EACH ROW EXECUTE FUNCTION pg_temp.hive_maintenance_claim_delay()`);
      try {
        await expect(manager.execute(late)).rejects.toThrow();
        expect(
          await db.deliveryEvent.count({
            where: { ownerId: f.binding.hiveUserId, type: "account_maintenance_claim_consumed" },
          }),
        ).toBe(0);
        expect(
          (
            await db.deliveryManagerBinding.findUniqueOrThrow({
              where: { id: originalBindings[0].id },
            })
          ).cursorVersion,
        ).toBe(1);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER hive_maintenance_claim_delay ON delivery_events`);
        await db.$executeRawUnsafe(`DROP FUNCTION pg_temp.hive_maintenance_claim_delay()`);
      }
      const result = (await manager.execute(claim)) as { attemptId: string; cursorVersion: number };
      expect(result.cursorVersion).toBe(2);
      expect(
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: originalBindings[0].id },
        }),
      ).toMatchObject({
        activeAttemptId: originalBindings[0].activeAttemptId,
        currentAttemptId: result.attemptId,
        executionEpochVersion: 1,
      });
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.binding.hiveUserId, type: "account_maintenance_claim_consumed" },
        }),
      ).toBe(1);
      // Exact replay is historical; a different event cannot consume the owner continuation again.
      expect(await manager.execute(claim)).toMatchObject({ replayed: true, canRun: false });
      await expect(
        manager.execute(
          f.fixture.managerEnvelope(command, {
            registrationId,
            serverInstanceId,
            nativeTurnId: randomUUID(),
            maintenanceContinuation: permit.claimContinuation,
          }),
        ),
      ).rejects.toThrow();
    }
    if (withTask === "successful") {
      const b = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: originalBindings[0].id },
      });
      const actors = await db.$transaction((tx) => executionActorHistory(tx, b));
      expect(actors.get(originalBindings[0].serverInstanceId)).toBe(true);
      expect(actors.get(serverInstanceId)).toBe(false);
      expect(actors.has(randomUUID())).toBe(false);
      const ownerReceipts = await db.codexGuardianOperationReceipt.findMany({
        where: { ownerId: f.binding.hiveUserId },
        orderBy: { eventId: "asc" },
      });
      const publicState = await f.store.status(emptyBinding);
      const currentRuntime = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: idle.id },
      });
      const finishedSlot = await db.codexHostSlot.findFirstOrThrow({
        where: { ownerId: f.binding.hiveUserId },
      });
      const finished = accountMaintenanceStateSchema.parse(finishedSlot.accountMaintenance);
      for (const phase of ["ready", "resuming", "requested"])
        await expect(db.$executeRaw`UPDATE codex_host_slots SET account_maintenance=${JSON.stringify({ ...finished, phase })}::jsonb,
          account_maintenance_version=account_maintenance_version+1 WHERE id=${finishedSlot.id}::uuid`).rejects.toThrow(
          "account_maintenance_finished_reentry_rejected",
        );
      await expect(db.$executeRaw`UPDATE codex_host_slots SET account_maintenance=${JSON.stringify({ ...finished, phase: "requested", id: randomUUID() })}::jsonb,
        account_maintenance_version=account_maintenance_version+1 WHERE id=${finishedSlot.id}::uuid`).rejects.toThrow(
        "account_maintenance_finished_reentry_rejected",
      );
      const second = await f.store.request(emptyBinding, {
        requestId: randomUUID(),
        expectedVersion: publicState.version,
        runtimeId: idle.id,
        runtimeGeneration: currentRuntime.generation,
      });
      expect(second.state).toBe("requested");
      expect(second.maintenanceId).not.toBe(f.input.requestId);
      expect(
        await db.codexGuardianOperationReceipt.findMany({
          where: { ownerId: f.binding.hiveUserId },
          orderBy: { eventId: "asc" },
        }),
      ).toEqual(ownerReceipts);
      expect(await db.deliveryManagerBinding.findUniqueOrThrow({ where: { id: b.id } })).toEqual(b);
      await expect(f.store.requestResume(emptyBinding, resume, archive)).rejects.toThrow();
    }
    // Old actor cannot make a new effect after the fresh registration replaced it.
    await expect(f.fixture.create()).rejects.toThrow();
  });
});
