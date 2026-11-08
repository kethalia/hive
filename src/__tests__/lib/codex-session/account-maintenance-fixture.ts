import { randomUUID, sign } from "node:crypto";
import type { CodexGuardianRuntime, Prisma, PrismaClient } from "@hive/db";
import { expect } from "vitest";
import {
  type AccountMaintenanceStore,
  assertAccountMaintenanceAdmission,
} from "@/lib/codex-session/account-maintenance-store.server";
import { guardianCanonical, guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import { guardianOperationEnvelopeSchema } from "@/lib/codex-session/guardian-transport-contracts";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { prepareEpicRelease } from "@/lib/delivery/epic-closure.server";
import { resolveEffectiveExecutionAuthority } from "@/lib/delivery/execution-authority.server";
import type { guardianFixture } from "./guardian-fixture";

type Scope = {
  fixture: Awaited<ReturnType<typeof guardianFixture>>;
  binding: RegistrationBinding;
  runtime: CodexGuardianRuntime;
  store: AccountMaintenanceStore;
  input: {
    requestId: string;
    expectedVersion: number;
    runtimeId: string;
    runtimeGeneration: number;
  };
};
/** Real DB/receipt transition; native ECHILD/archive transport are explicit doubles. */
export async function resumeAccountMaintenanceFixture(
  db: PrismaClient,
  f: Scope,
  withTask: boolean | "successful",
) {
  await f.store.request(f.binding, f.input);
  const before = await db.deliveryAttempt.findMany({ where: { ownerId: f.binding.hiveUserId } });
  const admission = f.fixture.guardian.finalized.admission;
  const intent = await db.projectTaskIntent.findUniqueOrThrow({
    where: { id: admission.preparationIntentId },
  });
  const snapshot = {
    projectId: admission.projectId,
    admissionId: admission.id,
    admissionGeneration: admission.generation,
    managerThreadId: admission.nativeThreadId!,
    firstPromptRequestId: intent.requestId,
    firstPromptDigest: "f".repeat(64),
    observedAt: new Date(Date.now() - 100).toISOString(),
    historyDigest: "b".repeat(64),
    loadedInventoryDigest: "c".repeat(64),
    fullHistory: true as const,
    historyBytes: 20,
    rootTurns: 1,
    pendingHandlers: 0 as const,
    pendingObservers: 0 as const,
    unknownFacts: 0 as const,
    activeRoots: 0 as const,
    threadIds: [admission.nativeThreadId!],
  };
  const input = {
    ownerId: f.binding.hiveUserId,
    runtimeId: f.runtime.id,
    runtimeGeneration: f.runtime.generation,
    maintenanceId: f.input.requestId,
    barrierId: randomUUID(),
    ownershipDigest: "d".repeat(64),
    projectBindings: [
      { projectId: admission.projectId, bindingDigest: admission.preparationDigest },
    ],
    snapshots: [snapshot],
  };
  await expect(
    f.fixture.guardian.store.closeBarrier({ ...input, snapshots: [] }),
  ).rejects.toThrow();
  const closed = await f.fixture.guardian.store.closeMaintenanceBarrier(input);
  expect(await f.fixture.guardian.store.closeMaintenanceBarrier(input)).toEqual(closed);
  expect((await f.store.status(f.binding)).state).toBe("closing");
  const receipt = {
    schemaVersion: 1 as const,
    scope: "managed_native_tree_only" as const,
    cleanupAuthorized: false as const,
    guardianExited: true as const,
    receiptId: randomUUID(),
    lifetimeId: f.runtime.lifetimeId,
    bindingDigest: f.runtime.bindingDigest,
    ownershipDigest: input.ownershipDigest,
    projects: input.projectBindings,
    launchSetDigest: "a".repeat(64),
    guardianSha256: f.runtime.guardianElfSha256,
    guardianIdentity: {
      pid: 100,
      startTime: "100",
      bootId: randomUUID(),
      executable: "/fixture/guardian",
      device: "1",
      inode: "2",
    },
    generation: closed.runtimeGeneration,
    closedRequestId: 3,
    drainRequestId: 4,
    finalWaitResult: "ECHILD" as const,
    waitFlags: "__WALL" as const,
    reaped: 2,
    decisions: closed.decisions.map((d) => ({
      projectId: admission.projectId,
      bindingDigest: admission.preparationDigest,
      decisionId: d.decisionId,
    })),
    workerBarrier: {
      closed: true as const,
      lifetimeId: f.runtime.lifetimeId,
      generation: f.runtime.generation,
      ownershipDigest: input.ownershipDigest,
      barrierId: closed.barrierId,
    },
    workerPid: 101,
    packageManifestSha256: f.runtime.packageManifestSha256,
    workerSha256: "e".repeat(64),
    nodeSha256: f.runtime.nodeSha256,
  };
  const finish = {
    ownerId: f.binding.hiveUserId,
    runtimeId: f.runtime.id,
    runtimeGeneration: closed.runtimeGeneration,
    barrierId: closed.barrierId,
    receipt,
  };
  await expect(
    f.fixture.guardian.store.closeTree({
      ...finish,
      receipt: { ...receipt, guardianExited: false as never },
    }),
  ).rejects.toThrow();
  await f.fixture.guardian.store.closeTree(finish);
  const ready = await f.store.status(f.binding);
  expect(ready.state).toBe("ready");
  await f.fixture.guardian.store.closeTree(finish);
  expect(await f.store.status(f.binding)).toEqual(ready);
  expect(await db.deliveryAttempt.findMany({ where: { ownerId: f.binding.hiveUserId } })).toEqual(
    before,
  );
  const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
    where: { id: f.runtime.id },
  });
  await expect(prepareEpicRelease(db, runtime, admission.projectId)).rejects.toThrow(
    "epic_completion_closure_required",
  );
  await expect(
    db.$transaction((tx) =>
      assertAccountMaintenanceAdmission(tx, f.binding, { kind: "enroll", empty: false }),
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
  const emptyBinding = { ...f.binding, projects: [] };
  const configSha256 = f.fixture.guardian.expectedConfigSha256(emptyBinding);
  const idle = await f.fixture.guardian.store.reserveRuntime(emptyBinding, {
    lifetimeId: randomUUID(),
    bindingDigest: "7".repeat(64),
    outerPublicKeyPem: f.fixture.guardian.outer.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    packageManifestSha256: f.runtime.packageManifestSha256,
    guardianElfSha256: f.runtime.guardianElfSha256,
    nodeSha256: f.runtime.nodeSha256,
    policyDigest: f.runtime.policyDigest,
    metadataPolicyDigest: f.runtime.metadataPolicyDigest,
    configSha256,
  });
  const grant = {
    ownerId: f.binding.hiveUserId,
    runtimeId: idle.id,
    id: randomUUID(),
    tokenDigest: guardianDigest(randomUUID()),
    bindingDigest: "b".repeat(64),
    issuedAt: new Date(Date.now() - 100),
    expiresAt: new Date(Date.now() + 30000),
  };
  await f.fixture.guardian.store.sealGrant(grant);
  await f.fixture.guardian.store.enroll({
    ownerId: grant.ownerId,
    runtimeId: idle.id,
    grantId: grant.id,
    tokenDigest: grant.tokenDigest,
    bindingDigest: grant.bindingDigest,
    consumptionDigest: "c".repeat(64),
  });
  const resume = {
    requestId: randomUUID(),
    expectedVersion: ready.version,
    maintenanceId: f.input.requestId,
  };
  const intentBefore = await db.projectTaskIntent.findUniqueOrThrow({ where: { id: intent.id } });
  const archiveBody = {
    schemaVersion: 1,
    purpose: "account-maintenance-archive",
    ownerId: f.binding.hiveUserId,
    workspaceId: f.binding.workspaceId,
    buildId: f.binding.buildId,
    maintenanceId: f.input.requestId,
    maintenanceVersion: ready.version,
    runtimeId: idle.id,
    runtimeGeneration: 1,
    requestId: resume.requestId,
    issuedAt: Date.now() - 100,
    expiresAt: Date.now() + 29000,
    parkedJournalDigest: "e".repeat(64),
    projects: [
      {
        preparationIntentId: intent.id,
        nativeThreadId: admission.nativeThreadId,
        firstPromptRequestId: intent.requestId,
        firstPromptDigest: snapshot.firstPromptDigest,
        historyDigest: snapshot.historyDigest,
        checkoutDigest: guardianDigest(admission.checkoutBinding),
        leaseId: admission.leaseId,
        leaseGeneration: admission.leaseGeneration,
      },
    ],
  };
  const archive = {
    ...archiveBody,
    proof: sign(
      null,
      Buffer.from(`hive-account-maintenance-archive-v1\n${guardianCanonical(archiveBody)}`),
      f.fixture.guardian.outer.privateKey,
    ).toString("base64url"),
  };
  await expect(
    f.store.requestResume(emptyBinding, resume, {
      ...archive,
      parkedJournalDigest: "a".repeat(64),
    }),
  ).rejects.toThrow();

  await expect(
    f.store.requestResume({ ...emptyBinding, hiveUserId: randomUUID() }, resume, archive),
  ).rejects.toThrow();
  await expect(
    f.store.requestResume(emptyBinding, { ...resume, maintenanceId: randomUUID() }, archive),
  ).rejects.toThrow();
  const resumed = await f.store.requestResume(emptyBinding, resume, archive);
  expect(resumed.state).toBe("resuming");
  expect(await f.store.requestResume(emptyBinding, resume, archive)).toEqual(resumed);
  await expect(
    f.store.requestResume(
      emptyBinding,
      {
        ...resume,
        requestId: randomUUID(),
        expectedVersion: resumed.version,
      },
      archive,
    ),
  ).rejects.toThrow();
  const savedReceipt = await db.codexGuardianOperationReceipt.findMany({
    where: { ownerId: f.binding.hiveUserId, action: "maintenance_resume_intent" },
  });
  expect(savedReceipt).toHaveLength(1);
  const saved = savedReceipt[0];
  expect(
    guardianOperationEnvelopeSchema.safeParse({
      action: "maintenance_resume_intent",
      runtimeId: saved.runtimeId,
      eventId: saved.eventId,
    }).success,
  ).toBe(false);
  expect(saved.response).toMatchObject({
    maintenance: {
      requestId: resume.requestId,
      idleRuntimeId: idle.id,
      projects: [
        {
          preparationIntentId: intent.id,
          requestId: intent.requestId,
          firstPromptRequestId: intent.requestId,
          firstPromptDigest: snapshot.firstPromptDigest,
          nativeThreadId: admission.nativeThreadId,
        },
      ],
    },
  });
  expect(await db.projectTaskIntent.findUniqueOrThrow({ where: { id: intent.id } })).toEqual(
    intentBefore,
  );
  expect(await db.deliveryAttempt.findMany({ where: { ownerId: f.binding.hiveUserId } })).toEqual(
    before,
  );
  expect(await db.deliveryTask.count({ where: { ownerId: f.binding.hiveUserId } })).toBe(
    withTask ? 1 : 0,
  );
  const { committedAt: _at, ...rest } = saved;
  const raw = { ...rest, response: saved.response as Prisma.InputJsonObject };
  await expect(
    db.codexGuardianOperationReceipt.create({ data: { ...raw, eventId: randomUUID() } }),
  ).rejects.toThrow();
  await expect(
    db.codexGuardianOperationReceipt.create({
      data: { ...raw, eventId: randomUUID(), action: "maintenance_resume" },
    }),
  ).rejects.toThrow();

  // Storage-composed native re-enrollment: actual prepare/checkout/launch and
  // registration paths; namespace evidence remains an explicit fixture double.
  const newStore = f.fixture.guardian.store;
  const prepared = await newStore.prepare({
    ownerId: f.binding.hiveUserId,
    runtimeId: idle.id,
    runtimeGeneration: 1,
    preparation: f.fixture.guardian.preparation,
    preparationDigest: admission.preparationDigest,
  });
  const bound = await newStore.bindCheckout({
    ownerId: f.binding.hiveUserId,
    runtimeId: idle.id,
    runtimeGeneration: prepared.runtime.generation,
    checkout: f.fixture.guardian.checkout,
  });
  const nativeLaunchId = randomUUID();
  const launch = await newStore.reserveNativeLaunch({
    ownerId: f.binding.hiveUserId,
    runtimeId: idle.id,
    runtimeGeneration: prepared.runtime.generation,
    nativeLaunchId,
    launchIntentDigest: guardianDigest({
      runtimeId: idle.id,
      runtimeGeneration: prepared.runtime.generation,
      nativeLaunchId,
      inventory: [
        {
          admissionId: bound.admission.id,
          admissionGeneration: bound.admission.generation,
          checkout: f.fixture.guardian.checkout,
        },
      ],
    }),
    projectIds: [admission.projectId],
  });
  const serverInstanceId = randomUUID();
  const registrationId = await f.fixture.register(serverInstanceId);
  const nativeInput = {
    runtimeId: idle.id,
    runtimeGeneration: prepared.runtime.generation,
    scope: { ...f.fixture.guardian.scope, registrationId, serverInstanceId },
    metadata: {
      ...f.fixture.guardian.metadata,
      nativeLaunchId: launch.nativeLaunchId,
      launchIntentDigest: launch.launchIntentDigest,
    },
    maintenanceRebind: {
      maintenanceId: f.input.requestId,
      ownerIntentRuntimeId: saved.runtimeId,
      ownerIntentEventId: saved.eventId,
      parkedJournalDigest: archive.parkedJournalDigest,
      historyDigest: snapshot.historyDigest,
      leaseValidUntil: new Date(Date.now() + 30000).toISOString(),
    },
  };
  const operation = {
    ownerId: f.binding.hiveUserId,
    runtimeId: idle.id,
    eventId: randomUUID(),
    action: "native" as const,
    inputRuntimeGeneration: prepared.runtime.generation,
    requestDigest: guardianDigest(nativeInput),
  };
  const nativeStore = new GuardianAdmissionStore(db, {
    policy: f.fixture.guardian.policy,
    encryptionKey: "19".repeat(32),
    expectedConfigSha256: f.fixture.guardian.expectedConfigSha256,
    operation,
  });
  const originalBindings = await db.deliveryManagerBinding.findMany({
    where: { ownerId: f.binding.hiveUserId },
  });
  if (withTask === "successful") {
    const lateId = randomUUID();
    const lateInput = {
      ...nativeInput,
      maintenanceRebind: {
        ...nativeInput.maintenanceRebind,
        leaseValidUntil: new Date(Date.now() + 300).toISOString(),
      },
    };
    const lateStore = new GuardianAdmissionStore(db, {
      policy: f.fixture.guardian.policy,
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: f.fixture.guardian.expectedConfigSha256,
      operation: { ...operation, eventId: lateId, requestDigest: guardianDigest(lateInput) },
    });
    await db.$executeRawUnsafe(`CREATE FUNCTION pg_temp.hive_maintenance_receipt_delay() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN IF NEW.event_id='${lateId}'::uuid THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $body$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER hive_maintenance_receipt_delay BEFORE INSERT ON codex_guardian_operation_receipts
        FOR EACH ROW EXECUTE FUNCTION pg_temp.hive_maintenance_receipt_delay()`);
    try {
      await expect(lateStore.finalizeNative(lateInput)).rejects.toThrow();
      expect(
        await db.codexGuardianOperationReceipt.count({
          where: { ownerId: f.binding.hiveUserId, eventId: lateId },
        }),
      ).toBe(0);
      expect(
        (
          await db.deliveryManagerBinding.findUniqueOrThrow({
            where: { id: originalBindings[0].id },
          })
        ).executionEpochVersion,
      ).toBe(0);
      expect((await f.store.status(emptyBinding)).state).toBe("resuming");
    } finally {
      await db.$executeRawUnsafe(
        `DROP TRIGGER hive_maintenance_receipt_delay ON codex_guardian_operation_receipts`,
      );
      await db.$executeRawUnsafe(`DROP FUNCTION pg_temp.hive_maintenance_receipt_delay()`);
    }
  }
  const finalized = await nativeStore.finalizeNative(nativeInput);
  expect(await nativeStore.finalizeNative(nativeInput)).toEqual(finalized);
  expect((await f.store.status(emptyBinding)).state).toBe("finished");
  const readyInput = {
    ownerId: f.binding.hiveUserId,
    runtimeId: idle.id,
    runtimeGeneration: prepared.runtime.generation,
    maintenanceId: f.input.requestId,
    ownerIntentRuntimeId: saved.runtimeId,
    ownerIntentEventId: saved.eventId,
  };
  const authority = await newStore.maintenanceResumeReady(readyInput);
  expect(authority).toMatchObject({
    ready: true,
    maintenanceId: f.input.requestId,
    runnableProjectIds: withTask === true ? [] : [admission.projectId],
    authorizations: [
      {
        projectId: admission.projectId,
        nativeReceiptEventId: operation.eventId,
        runnable: withTask !== true,
        executionEpochVersion: withTask ? 1 : 0,
      },
    ],
  });
  for (const wrong of [
    { ...readyInput, ownerId: randomUUID() },
    { ...readyInput, ownerIntentEventId: randomUUID() },
    { ...readyInput, runtimeGeneration: readyInput.runtimeGeneration - 1 },
  ])
    await expect(newStore.maintenanceResumeReady(wrong)).rejects.toThrow();

  const bindings = await db.deliveryManagerBinding.findMany({
    where: { ownerId: f.binding.hiveUserId },
  });
  expect(bindings.length).toBe(withTask ? 1 : 0);
  if (withTask) {
    const original = originalBindings[0],
      current = bindings[0];
    expect(current).toMatchObject({
      id: original.id,
      bindingDigest: original.bindingDigest,
      conversationId: original.conversationId,
      serverInstanceId: original.serverInstanceId,
      nativeThreadId: original.nativeThreadId,
      activeAttemptId: original.activeAttemptId,
      currentAttemptId: original.currentAttemptId,
      cursorVersion: original.cursorVersion,
      nativeSequence: original.nativeSequence,
      executionEpochVersion: 1,
      executionEpochRuntimeId: idle.id,
      executionEpochEventId: operation.eventId,
    });
    const registration = await db.codexHostRegistration.findUniqueOrThrow({
      where: { id: registrationId },
    });
    expect(
      await db.$transaction((tx) => resolveEffectiveExecutionAuthority(tx, current, registration)),
    ).toMatchObject({
      kind: "maintenance",
      epochVersion: 1,
      serverInstanceId,
      managerBindingId: original.id,
      nativeThreadId: admission.nativeThreadId,
    });
    await expect(
      db.deliveryManagerBinding.update({
        where: { id: current.id },
        data: {
          executionEpochVersion: 0,
          executionEpochRuntimeId: null,
          executionEpochEventId: null,
          executionEpochResumeEventId: null,
        },
      }),
    ).rejects.toThrow();
    expect(await db.deliveryAttempt.findMany({ where: { ownerId: f.binding.hiveUserId } })).toEqual(
      before,
    );
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.binding.hiveUserId, type: "account_maintenance_epoch_committed" },
      }),
    ).toBe(1);
  }
  return {
    authority,
    newStore,
    readyInput,
    originalBindings,
    bindings,
    operation,
    admission,
    registrationId,
    serverInstanceId,
    emptyBinding,
    idle,
    prepared,
    resume,
    archive,
    saved,
  };
}
