import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { GuardianIdleSnapshot } from "@/lib/codex-session/guardian-contracts";
import { guardianDigest, preparationDigest } from "@/lib/codex-session/guardian-contracts";
import {
  GuardianAdmissionStore,
  lockProducerAdmission,
  lockProducerMetadata,
} from "@/lib/codex-session/guardian-store.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryNativeSourceService } from "@/lib/delivery/native.server";
import { nativeFixture } from "../delivery/native-fixture";
import { guardianFixture, guardianPairFixture } from "./guardian-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated loopback fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
describe.skipIf(!url)("independent guardian storage, actual local Postgres", () => {
  it("runs real enrollment→preparation→checkout→one-use launch→native registration/finalization", async () => {
    const f = await guardianFixture(db);
    expect(f.guardian.enrolled.phase).toBe("open");
    expect(f.guardian.bound.admission.phase).toBe("checkout");
    expect(f.guardian.finalized.admission.phase).toBe("native");
    const result = await db.$transaction((tx) =>
      lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy),
    );
    expect(result).toMatchObject({
      runtimeId: f.guardian.runtime.id,
      admissionId: f.guardian.bound.admission.id,
      runtimeGeneration: 2,
      admissionGeneration: 3,
      barrierGeneration: 0,
    });
    const metadata = await db.$transaction((tx) =>
      lockProducerMetadata(tx, f.guardian.scope, f.guardian.policy),
    );
    expect(metadata.metadataPins).toEqual(f.guardian.metadata.pins);
    await expect(
      f.guardian.store.reserveNativeLaunch({
        ownerId: f.user.id,
        runtimeId: result.runtimeId,
        runtimeGeneration: 2,
        nativeLaunchId: f.guardian.launch.nativeLaunchId,
        launchIntentDigest: f.guardian.launch.launchIntentDigest,
        projectIds: [f.project.id],
      }),
    ).rejects.toThrow();
  });
  it("rejects caller owner/thread/lease substitution and disabled producer authority", async () => {
    const f = await guardianFixture(db);
    for (const scope of [
      { ...f.guardian.scope, hiveUserId: randomUUID() },
      { ...f.guardian.scope, managerThreadId: randomUUID() },
      { ...f.guardian.scope, leaseId: randomUUID() },
    ])
      await expect(
        db.$transaction((tx) => lockProducerAdmission(tx, scope, f.guardian.policy)),
      ).rejects.toThrow();
    await expect(
      db.$transaction((tx) =>
        lockProducerAdmission(tx, f.guardian.scope, {
          ...f.guardian.policy,
          producerEnabled: false,
        }),
      ),
    ).rejects.toThrow();
  });
  it("seals final physical/native identity and retains unresolved runtime despite expired authority", async () => {
    const f = await guardianFixture(db);
    await expect(
      db.codexGuardianAdmission.update({
        where: { id: f.guardian.bound.admission.id },
        data: { leaseId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      db.codexGuardianRuntime.delete({ where: { id: f.guardian.runtime.id } }),
    ).rejects.toThrow();
    await db.codexGuardianRuntime.update({
      where: { id: f.guardian.runtime.id },
      data: { authorityUntil: new Date(Date.now() - 1000) },
    });
    await expect(
      db.$transaction((tx) => lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy)),
    ).rejects.toThrow();
    await expect(
      f.guardian.store.reserveRuntime(f.host, {
        lifetimeId: randomUUID(),
        bindingDigest: f.guardian.runtime.bindingDigest,
        outerPublicKeyPem: f.guardian.runtime.outerPublicKeyPem,
        packageManifestSha256: f.guardian.runtime.packageManifestSha256,
        guardianElfSha256: f.guardian.runtime.guardianElfSha256,
        nodeSha256: f.guardian.runtime.nodeSha256,
        policyDigest: f.guardian.runtime.policyDigest,
        metadataPolicyDigest: f.guardian.runtime.metadataPolicyDigest,
        configSha256: f.guardian.runtime.configSha256,
      }),
    ).rejects.toThrow();
  });
  it("all-terminal task state alone cannot close; a fresh exact idle receipt closes input but retains physical writer", async () => {
    const f = await guardianFixture(db);
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      guardianPolicy: f.guardian.policy,
      progressionProtocol: 1,
    });
    await manager.execute(
      f.managerEnvelope({
        operation: "create_task",
        payload: {
          ...f.definition,
          steps: [
            {
              id: f.stepId,
              kind: "understand",
              criterionIds: ["C1"],
              requiredEvidenceKinds: ["analysis"],
            },
          ],
        },
      }),
    );
    const claim = (await manager.execute(
      f.managerEnvelope({
        operation: "claim_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          expectedVersion: 0,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      }),
    )) as { attemptId: string; version: number; leaseGeneration: number; managerBindingId: string };
    const closeInput = {
      ownerId: f.user.id,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: 2,
      barrierId: randomUUID(),
      ownershipDigest: "a".repeat(64),
      projectBindings: [
        { projectId: f.project.id, bindingDigest: f.guardian.prepared.admission.preparationDigest },
      ],
      snapshots: [] as GuardianIdleSnapshot[],
    };
    await expect(f.guardian.store.closeBarrier(closeInput)).rejects.toThrow();
    const observation: GuardianIdleSnapshot = {
      projectId: f.project.id,
      admissionId: f.guardian.bound.admission.id,
      admissionGeneration: 3,
      managerBindingId: claim.managerBindingId,
      currentAttemptId: claim.attemptId,
      managerThreadId: f.managerThreadId,
      parentTurnId: f.parentTurnId,
      cursorVersion: 1,
      nativeSequence: 0,
      observedAt: new Date().toISOString(),
      historyDigest: "b".repeat(64),
      loadedInventoryDigest: "c".repeat(64),
      fullHistory: true,
      rootTurns: 1,
      historyBytes: 100,
      pendingHandlers: 0,
      pendingObservers: 0,
      unknownFacts: 0,
      activeRoots: 0,
    };
    await expect(
      f.guardian.store.closeBarrier({ ...closeInput, snapshots: [observation] }),
    ).rejects.toThrow();
    await manager.execute(
      f.managerEnvelope({
        operation: "report_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: claim.attemptId,
          expectedVersion: claim.version,
          leaseGeneration: claim.leaseGeneration,
          sourceSha: f.context.revision,
          report: {
            summary: "Synthetic completed analysis",
            difficulty: "low",
            difficultyReason: "Fixture",
            issues: [],
            remainingUncertainty: "Fixture only",
            nextAction: "Finish",
          },
        },
      }),
    );
    await expect(f.guardian.store.closeBarrier(closeInput)).rejects.toThrow();
    await expect(
      f.guardian.store.closeBarrier({
        ...closeInput,
        snapshots: [{ ...observation, nativeSequence: 1 }],
      }),
    ).rejects.toThrow();
    const result = await f.guardian.store.closeBarrier({
      ...closeInput,
      snapshots: [{ ...observation, observedAt: new Date().toISOString() }],
    });
    expect(result).toMatchObject({
      runtimeGeneration: 3,
      treeExited: false,
      cleanupAuthorized: false,
    });
    expect(result.decisions).toHaveLength(1);
    const deniedClaim = f.managerEnvelope({
      operation: "claim_step",
      payload: {
        taskId: f.taskId,
        stepId: f.stepId,
        expectedVersion: 0,
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
      },
    });
    await expect(manager.execute(deniedClaim)).rejects.toBeInstanceOf(RegistrationRejected);
    const reportReplay = f.managerEnvelope({
      operation: "report_step",
      payload: {
        taskId: f.taskId,
        stepId: f.stepId,
        attemptId: claim.attemptId,
        expectedVersion: claim.version,
        leaseGeneration: claim.leaseGeneration,
        sourceSha: f.context.revision,
        report: {
          summary: "Late report",
          difficulty: "low",
          difficultyReason: "Fixture",
          issues: [],
          remainingUncertainty: "Fixture",
          nextAction: "Finish",
        },
      },
    });
    await expect(manager.execute(reportReplay)).rejects.toBeInstanceOf(RegistrationRejected);
    const native = new DeliveryNativeSourceService(db, {
      ...f.dependencies,
      guardianPolicy: f.guardian.policy,
    });
    const boundary = f.sourceEnvelope(
      { ...claim, nativeSequence: 0 },
      {
        kind: "root_boundary",
        parentTurnId: f.parentTurnId,
        nextParentTurnId: randomUUID(),
        cursorVersion: 1,
        observedAt: new Date().toISOString(),
      },
      1,
    );
    await expect(native.ingest(boundary)).rejects.toBeInstanceOf(RegistrationRejected);
    const { guardianPolicy: _testPolicy, ...legacyDependencies } =
      f.dependencies as import("@/lib/delivery/manager.server").ManagerDependencies;
    await expect(
      new DeliveryManagerService(db, legacyDependencies).execute(deniedClaim),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(
      new DeliveryNativeSourceService(db, legacyDependencies).ingest(boundary),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    const unguarded = await nativeFixture(db);
    await expect(unguarded.create()).resolves.toHaveProperty("taskId");

    await expect(
      db.$transaction((tx) => lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy)),
    ).rejects.toThrow();
    const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: claim.managerBindingId },
    });
    expect(binding.activeAttemptId).toBe(claim.attemptId);
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } })).quiescedAt,
    ).toBeNull();
    await expect(
      db.codexGuardianBarrier.update({ where: { id: result.barrierId }, data: { generation: 4 } }),
    ).rejects.toThrow();
  });
  it("blocked original intent denies preparation replay, checkout replay and first-native reservation", async () => {
    let checks = 0;
    await guardianFixture(db, {
      beforeNativeLaunch: async (stage) => {
        const id = stage.preparation.taskId;
        await db.projectTaskIntent.update({ where: { id }, data: { phase: "blocked" } });
        await expect(
          stage.store.prepare({
            ownerId: stage.ownerId,
            runtimeId: stage.runtimeId,
            runtimeGeneration: stage.runtimeGeneration,
            preparation: stage.preparation,
            preparationDigest: preparationDigest(stage.preparation),
          }),
        ).rejects.toBeInstanceOf(RegistrationRejected);
        await expect(
          stage.store.bindCheckout({
            ownerId: stage.ownerId,
            runtimeId: stage.runtimeId,
            runtimeGeneration: stage.runtimeGeneration,
            checkout: stage.checkout,
          }),
        ).rejects.toBeInstanceOf(RegistrationRejected);
        const nativeLaunchId = randomUUID();
        const launchIntentDigest = guardianDigest({
          runtimeId: stage.runtimeId,
          runtimeGeneration: stage.runtimeGeneration,
          nativeLaunchId,
          inventory: [
            {
              admissionId: stage.bound.admission.id,
              admissionGeneration: stage.bound.admission.generation,
              checkout: stage.checkout,
            },
          ],
        });
        await expect(
          stage.store.reserveNativeLaunch({
            ownerId: stage.ownerId,
            runtimeId: stage.runtimeId,
            runtimeGeneration: stage.runtimeGeneration,
            nativeLaunchId,
            launchIntentDigest,
            projectIds: [stage.preparation.projectId],
          }),
        ).rejects.toBeInstanceOf(RegistrationRejected);
        checks = 3;
        await db.projectTaskIntent.update({ where: { id }, data: { phase: "queued" } });
      },
    });
    expect(checks).toBe(3);
  });
  it("revoked producer cannot renew a native execution fence and metadata replay is exact", async () => {
    const f = await guardianFixture(db);
    const input = {
      scope: f.guardian.scope,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: 2,
      metadata: f.guardian.metadata,
    };
    await expect(
      f.guardian.store.finalizeNative({
        ...input,
        metadata: {
          ...f.guardian.metadata,
          pins: { ...f.guardian.metadata.pins, git: { device: "123", inode: "999" } },
        },
      }),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(
      f.guardian.store.finalizeNative({
        ...input,
        metadata: { ...f.guardian.metadata, namespaceReceiptDigest: "b".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    await db.projectTaskIntent.update({
      where: { id: f.context.preparationIntentId },
      data: { phase: "blocked" },
    });
    await expect(f.guardian.store.finalizeNative(input)).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    await db.projectTaskIntent.update({
      where: { id: f.context.preparationIntentId },
      data: { phase: "running" },
    });
    const revoked = new GuardianAdmissionStore(db, {
      policy: { ...f.guardian.policy, producerEnabled: false },
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: f.guardian.expectedConfigSha256,
    });
    await expect(revoked.finalizeNative(input)).rejects.toBeInstanceOf(RegistrationRejected);
    const fence = {
      ownerId: f.user.id,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: 2,
      projectId: f.project.id,
      preparationDigest: f.guardian.prepared.admission.preparationDigest,
    };
    await expect(revoked.fence(fence)).rejects.toBeInstanceOf(RegistrationRejected);
    await db.codexGuardianRuntime.update({
      where: { id: f.guardian.runtime.id },
      data: { producerApproved: false },
    });
    await expect(f.guardian.store.fence(fence)).rejects.toBeInstanceOf(RegistrationRejected);
  });
  it("runtime identity replay cannot change an approved package or policy tuple", async () => {
    const f = await guardianFixture(db);
    const identity = {
      lifetimeId: f.guardian.runtime.lifetimeId,
      bindingDigest: f.guardian.runtime.bindingDigest,
      outerPublicKeyPem: f.guardian.runtime.outerPublicKeyPem,
      packageManifestSha256: f.guardian.runtime.packageManifestSha256,
      guardianElfSha256: f.guardian.runtime.guardianElfSha256,
      nodeSha256: f.guardian.runtime.nodeSha256,
      policyDigest: f.guardian.runtime.policyDigest,
      metadataPolicyDigest: f.guardian.runtime.metadataPolicyDigest,
      configSha256: f.guardian.runtime.configSha256,
    };
    await expect(f.guardian.store.reserveRuntime(f.host, identity)).resolves.toHaveProperty(
      "id",
      f.guardian.runtime.id,
    );
    for (const key of [
      "packageManifestSha256",
      "guardianElfSha256",
      "nodeSha256",
      "policyDigest",
      "metadataPolicyDigest",
    ]) {
      await expect(
        f.guardian.store.reserveRuntime(f.host, { ...identity, [key]: "f".repeat(64) }),
      ).rejects.toBeInstanceOf(RegistrationRejected);
    }
  });
  it("closed barrier serializes behind an in-flight producer transaction, then rejects later producers", async () => {
    const f = await guardianFixture(db);
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      guardianPolicy: f.guardian.policy,
      progressionProtocol: 1,
    });
    await manager.execute(
      f.managerEnvelope({
        operation: "create_task",
        payload: {
          ...f.definition,
          steps: [
            {
              id: f.stepId,
              kind: "understand",
              criterionIds: ["C1"],
              requiredEvidenceKinds: ["analysis"],
            },
          ],
        },
      }),
    );
    const claim = (await manager.execute(
      f.managerEnvelope({
        operation: "claim_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          expectedVersion: 0,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      }),
    )) as { attemptId: string; version: number; leaseGeneration: number; managerBindingId: string };
    await manager.execute(
      f.managerEnvelope({
        operation: "report_step",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: claim.attemptId,
          expectedVersion: claim.version,
          leaseGeneration: claim.leaseGeneration,
          sourceSha: f.context.revision,
          report: {
            summary: "Completed fixture",
            difficulty: "low",
            difficultyReason: "Fixture",
            issues: [],
            remainingUncertainty: "Synthetic only",
            nextAction: "Finish",
          },
        },
      }),
    );
    let entered: () => void = () => {},
      release: () => void = () => {};
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const producer = db.$transaction(
      async (tx) => {
        await lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy);
        entered();
        await gate;
      },
      { timeout: 5000 },
    );
    await started;
    const snapshot: GuardianIdleSnapshot = {
      projectId: f.project.id,
      admissionId: f.guardian.bound.admission.id,
      admissionGeneration: 3,
      managerBindingId: claim.managerBindingId,
      currentAttemptId: claim.attemptId,
      managerThreadId: f.managerThreadId,
      parentTurnId: f.parentTurnId,
      cursorVersion: 1,
      nativeSequence: 0,
      observedAt: new Date().toISOString(),
      historyDigest: "b".repeat(64),
      loadedInventoryDigest: "c".repeat(64),
      fullHistory: true,
      rootTurns: 1,
      historyBytes: 100,
      pendingHandlers: 0,
      pendingObservers: 0,
      unknownFacts: 0,
      activeRoots: 0,
    };
    let settled = false;
    const closing = f.guardian.store.closeBarrier({
      ownerId: f.user.id,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: 2,
      barrierId: randomUUID(),
      ownershipDigest: "a".repeat(64),
      projectBindings: [
        { projectId: f.project.id, bindingDigest: f.guardian.prepared.admission.preparationDigest },
      ],
      snapshots: [snapshot],
    });
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await new Promise((done) => setTimeout(done, 30));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await producer;
    expect(await closing).toMatchObject({ runtimeGeneration: 3, treeExited: false });
    await expect(
      db.$transaction((tx) => lockProducerAdmission(tx, f.guardian.scope, f.guardian.policy)),
    ).rejects.toBeInstanceOf(RegistrationRejected);
  });
  it("disabling the feature between actual registration and finalization cannot downgrade a pending guarded writer", async () => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "false");
    let checked = false;
    try {
      await guardianFixture(db, {
        beforeNativeFinalize: async ({ fixture: f, admissionId }) => {
          const pending = await db.codexGuardianAdmission.findUniqueOrThrow({
            where: { id: admissionId },
          });
          expect(pending.registrationId).toBeNull();
          expect(pending.phase).toBe("checkout");
          const manager = new DeliveryManagerService(db, {
            ...f.dependencies,
            guardianPolicy: undefined,
          });
          await expect(
            manager.execute(f.managerEnvelope({ operation: "create_task", payload: f.definition })),
          ).rejects.toBeInstanceOf(RegistrationRejected);
          expect(
            await db.deliveryManagerBinding.count({
              where: { ownerId: f.user.id, preparationIntentId: f.context.preparationIntentId },
            }),
          ).toBe(0);
          checked = true;
        },
      });
      expect(checked).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("shared producer revocation cannot be reopened by native replay or another project's first finalization", async () => {
    const f = await guardianPairFixture(db);
    await f.store.finalizeNative(f.inputs[0]);
    await db.codexGuardianRuntime.update({
      where: { id: f.runtime.id },
      data: { producerApproved: false },
    });
    await expect(f.store.finalizeNative(f.inputs[0])).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(f.store.finalizeNative(f.inputs[1])).rejects.toBeInstanceOf(RegistrationRejected);
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtime.id } }))
        .producerApproved,
    ).toBe(false);
    expect(
      (
        await db.codexGuardianAdmission.findUniqueOrThrow({
          where: { id: f.entries[1].bound.admission.id },
        })
      ).phase,
    ).toBe("checkout");
  });
});
