import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { accountMaintenanceStateSchema } from "@/lib/codex-session/account-maintenance-contracts";
import { AccountMaintenanceStore } from "@/lib/codex-session/account-maintenance-store.server";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  guardianCanonical,
  guardianDigest,
  preparationDigest,
} from "@/lib/codex-session/guardian-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import {
  guardianEnrollmentClaimsSchema,
  guardianIdentityProofPayload,
  guardianTransportProofPayload,
} from "@/lib/codex-session/guardian-transport-contracts";
import {
  guardianUnstartedTransferSchema,
  UNSTARTED_PREDECESSOR_MANIFEST,
} from "@/lib/codex-session/guardian-unstarted-contracts";
import { effectiveUnstartedSuccessor } from "@/lib/codex-session/guardian-unstarted-store.server";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { PrismaRegistrationStore } from "@/lib/codex-session/registration-store.server";
import { epicDigest, epicPlanSchema } from "@/lib/delivery/epic-contracts";
import { ProjectTaskIntents } from "@/lib/projects/task-intents.server";
import { ProjectTaskRecoveries } from "@/lib/projects/task-recovery-store.server";
import { guardianFixture } from "./guardian-fixture";

const url = process.env.HIVE_UNSTARTED_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_unstarted_test_20261108")
)
  throw Error("Owned local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_unstarted_test_20261108",
});
afterAll(() => db.$disconnect());
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(begin = true) {
  type Stage = Parameters<
    NonNullable<NonNullable<Parameters<typeof guardianFixture>[1]>["beforeNativeLaunch"]>
  >[0];
  let stage: Stage | undefined;
  const halted = Error("synthetic_pre_native_boundary");
  try {
    await guardianFixture(db, {
      workspaceEnrollment: true,
      packageManifestSha256: UNSTARTED_PREDECESSOR_MANIFEST,
      beforeNativeLaunch: async (value) => {
        stage = value;
        throw halted;
      },
    });
  } catch (e) {
    if (e !== halted) throw e;
  }
  if (!stage) throw Error("missing synthetic stage");
  const f = stage;
  const nativeLaunchId = randomUUID();
  const launchIntentDigest = guardianDigest({
    runtimeId: f.runtimeId,
    runtimeGeneration: f.runtimeGeneration,
    nativeLaunchId,
    inventory: [
      {
        admissionId: f.bound.admission.id,
        admissionGeneration: f.bound.admission.generation,
        checkout: f.checkout,
      },
    ],
  });
  const launch = await f.store.reserveNativeLaunch({
    ownerId: f.ownerId,
    runtimeId: f.runtimeId,
    runtimeGeneration: f.runtimeGeneration,
    nativeLaunchId,
    launchIntentDigest,
    projectIds: [f.preparation.projectId],
  });
  const old = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } }),
    oldBinding = old.binding as unknown as RegistrationBinding;
  const before = await db.projectTaskIntent.update({
    where: { id: f.preparation.taskId },
    data: {
      phase: "blocked",
      status: {
        schemaVersion: 1,
        projectId: f.preparation.projectId,
        taskId: f.preparation.taskId,
        phase: "blocked",
        reason: "native_unavailable",
        nativeThreadId: null,
        terminalSessionName: null,
      },
    },
  });
  const intents = new ProjectTaskIntents(db, "19".repeat(32)),
    recoveries = new ProjectTaskRecoveries(db, intents),
    recoveryInput = {
      ownerId: f.ownerId,
      coderOwnerId: f.preparation.ownerId,
      projectId: f.preparation.projectId,
      taskId: f.preparation.taskId,
      workspaceId: f.preparation.workspaceId,
      recoveryId: randomUUID(),
    };
  const recovery = begin ? await recoveries.begin(recoveryInput) : null;
  const newBinding = { ...oldBinding, buildId: randomUUID(), agentId: randomUUID(), projects: [] },
    newIdentity = {
      lifetimeId: randomUUID(),
      bindingDigest: "a".repeat(64),
      outerPublicKeyPem: old.outerPublicKeyPem,
      packageManifestSha256: "b".repeat(64),
      guardianElfSha256: old.guardianElfSha256,
      nodeSha256: old.nodeSha256,
      policyDigest: old.policyDigest,
      metadataPolicyDigest: old.metadataPolicyDigest,
      configSha256: "c".repeat(64),
    };
  const issuer = generateKeyPairSync("ed25519"),
    config = {
      privateKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      keyId: "unstarted-synthetic",
      hiveOrigin: "https://hive.invalid",
      softwareTemplateIds: [newBinding.templateId],
      appSlug: "codex-session",
      gatewayPort: 13341,
      cookieDomains: [],
    },
    env = {
      HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
      HIVE_CODEX_MANAGER_EFFORT: "low",
      HIVE_DELIVERY_MANAGER_ENABLED: "true",
    };
  newIdentity.configSha256 = guardianConfigSha256(
    expectedGuardianHostConfig(newBinding, config, env),
  );
  newIdentity.bindingDigest = hash(
    JSON.stringify({
      schemaVersion: 1,
      configSha256: newIdentity.configSha256,
      packageManifestSha256: newIdentity.packageManifestSha256,
    }),
  );
  const oldIdentity = {
    ...newIdentity,
    lifetimeId: old.lifetimeId,
    bindingDigest: old.bindingDigest,
    packageManifestSha256: old.packageManifestSha256,
    configSha256: old.configSha256,
  };
  const state = {
    schemaVersion: 1,
    lifetimeId: old.lifetimeId,
    identityDigest: guardianDigest(oldIdentity),
    runtimeId: old.id,
    generation: old.generation,
    projects: {
      [f.preparation.projectId]: {
        admissionId: f.bound.admission.id,
        admissionGeneration: f.bound.admission.generation,
        phase: "checkout",
        checkout: f.checkout,
        preparationDigest: f.bound.admission.preparationDigest,
        metadataPinsDigest: null,
      },
    },
    applications: {},
    launch,
    pending: null,
    hold: false,
    sequence: 6,
    chainDigest: "d".repeat(64),
  };
  const predecessorController = {
    state,
    signature: sign(null, Buffer.from(guardianCanonical(state)), f.outerPrivateKey).toString(
      "base64url",
    ),
  };
  const proof = guardianUnstartedTransferSchema.parse({
    schemaVersion: 1,
    transferId: randomUUID(),
    ownerId: f.ownerId,
    coderOwnerId: oldBinding.ownerId,
    workspaceId: old.workspaceId,
    templateId: oldBinding.templateId,
    projectId: f.preparation.projectId,
    taskId: f.preparation.taskId,
    requestId: f.preparation.requestId,
    hostRequestDigest: f.preparation.requestDigest,
    sourceSha: f.preparation.baseSha,
    repositoryId: f.preparation.repositoryId,
    providerAccountId: f.preparation.providerAccountId,
    oldRuntimeId: old.id,
    oldBuildId: old.buildId,
    oldLifetimeId: old.lifetimeId,
    oldIdentityDigest: guardianDigest(oldIdentity),
    oldConfigSha256: old.configSha256,
    oldPackageManifestSha256: old.packageManifestSha256,
    newBuildId: newBinding.buildId,
    newConfigSha256: newIdentity.configSha256,
    newPackageManifestSha256: newIdentity.packageManifestSha256,
    nativeLaunchId,
    launchIntentDigest,
    preparation: f.preparation,
    checkout: f.checkout,
    oldJournalDigests: {
      lifetime: "e".repeat(64),
      controller: hash(`${JSON.stringify(predecessorController)}\n`),
      project: "f".repeat(64),
      supervisor: "0".repeat(64),
    },
    predecessorController,
    neverStarted: {
      metadataPhase: "reservationRequested",
      status: "starting",
      nativeProcess: null,
      executionIdentity: null,
      projectCount: 0,
      nativeCreationAttempted: false,
      firstPromptSubmissionAttempted: false,
      nativeThreadId: null,
      terminalSessionName: null,
    },
  });
  const pin = {
    packageManifestSha256: old.packageManifestSha256,
    guardianElfSha256: old.guardianElfSha256,
    nodeSha256: old.nodeSha256,
    protocol: "guardian-v1" as const,
    policyDigest: old.policyDigest,
    metadataPolicyDigest:
      old.metadataPolicyDigest as "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
  };
  const policy = {
    enabled: true,
    producerEnabled: true,
    packages: [pin, { ...pin, packageManifestSha256: newIdentity.packageManifestSha256 }],
  };
  const store = new GuardianAdmissionStore(db, {
    policy,
    encryptionKey: "19".repeat(32),
    expectedConfigSha256: () => newIdentity.configSha256,
  });
  const reserve = (p = proof) => store.reserveRuntime(newBinding, newIdentity, p);
  return {
    f,
    old,
    before,
    intents,
    recoveries,
    recovery,
    recoveryInput,
    newBinding,
    newIdentity,
    proof,
    store,
    reserve,
    policy,
    config,
    env,
  };
}
function eventData(f: Awaited<ReturnType<typeof fixture>>) {
  const response = {
    runtime: { id: f.old.id, ownerId: f.old.ownerId, generation: f.old.generation },
    admission: {
      id: f.f.bound.admission.id,
      runtimeId: f.old.id,
      generation: f.f.bound.admission.generation,
      preparationIntentId: f.before.id,
    },
    retirement: {
      schemaVersion: 1,
      purpose: "unused-metadata-authorization",
      proofDigest: guardianDigest(f.proof),
      proof: f.proof,
      recoveryId: f.recoveryInput.recoveryId,
      intentDigest: f.before.requestDigest,
      newLifetimeId: f.newIdentity.lifetimeId,
      newBinding: f.newBinding,
      newIdentity: f.newIdentity,
      nativeTreeExited: false,
      cleanupAuthorized: false,
      writerReleased: false,
    },
  };
  return {
    ownerId: f.f.ownerId,
    runtimeId: f.old.id,
    eventId: f.proof.transferId,
    action: "authorization_retired",
    requestDigest: guardianDigest(f.proof),
    inputRuntimeGeneration: f.old.generation,
    resultRuntimeGeneration: f.old.generation,
    resultAdmissionGeneration: f.f.bound.admission.generation,
    response: response as unknown as Prisma.InputJsonObject,
    responseDigest: guardianDigest(response),
    lifetimeId: f.old.lifetimeId,
    buildId: f.old.buildId,
    configSha256: f.old.configSha256,
    outerKeyFingerprint: f.old.outerKeyFingerprint,
  };
}
function ownerService(f: Awaited<ReturnType<typeof fixture>>, stopped = true) {
  let enrollmentClaim: unknown;
  let service: GuardianService;
  service = new GuardianService(db, f.config, f.policy, "19".repeat(32), {
    env: f.env,
    resolveWorkspace: async (p) => {
      expect(p).toEqual({
        hiveUserId: f.f.ownerId,
        coderUserId: f.old.binding && f.newBinding.ownerId,
      });
      return f.newBinding;
    },
    async assertUnstartedPredecessorStopped(b, id) {
      expect(id).toBe(f.old.buildId);
      expect(b.buildId).toBe(f.newBinding.buildId);
      if (!stopped) throw Error("synthetic predecessor not stopped");
    },
    transport: {
      async identity(_b, nonce) {
        const kernel = {
          startTime: "100",
          bootId: randomUUID(),
          executable: "/usr/bin/node",
          device: "123",
          inode: "456",
        };
        const packet = {
          schemaVersion: 1 as const,
          nonce,
          issuedAt: Date.now() - 1,
          expiresAt: Date.now() + 30000,
          identity: f.newIdentity,
          unstartedTransfer: f.proof,
          startup: {
            schemaVersion: 1 as const,
            type: "ready" as const,
            phase: "open" as const,
            nonce: Buffer.alloc(32).toString("base64url"),
            configSha256: f.newIdentity.configSha256,
            packageManifestSha256: f.newIdentity.packageManifestSha256,
            nodeSha256: f.newIdentity.nodeSha256,
            workerSha256: "1".repeat(64),
            guardianSha256: f.newIdentity.guardianElfSha256,
            port: 13341,
            lifetimeId: f.newIdentity.lifetimeId,
            bindingDigest: f.newIdentity.bindingDigest,
            generation: 1,
            ownershipDigest: guardianDigest([]),
            projects: [],
            outerIdentity: { ...kernel, pid: 100, parentPid: 99 },
            guardianIdentity: {
              ...kernel,
              pid: 101,
              parentPid: 100,
              executable: "/package/guardian",
            },
            workerIdentity: { ...kernel, pid: 102, parentPid: 101 },
          },
          proof: "",
        };
        packet.proof = sign(
          null,
          Buffer.from(guardianIdentityProofPayload(packet)),
          f.f.outerPrivateKey,
        ).toString("base64url");
        return packet;
      },
      async bootstrap(_b, value) {
        const claims = guardianEnrollmentClaimsSchema.parse(
          JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()),
        );
        enrollmentClaim = claims.unstartedTransfer;
        const body = {
          schemaVersion: 1 as const,
          action: "enroll" as const,
          runtimeId: claims.runtimeId,
          eventId: randomUUID(),
          issuedAt: Date.now() - 1,
          expiresAt: Date.now() + 30000,
          grant: value,
        };
        return service.execute({
          ...body,
          proof: sign(
            null,
            Buffer.from(guardianTransportProofPayload(body)),
            f.f.outerPrivateKey,
          ).toString("base64url"),
        });
      },
    },
  });
  return {
    service,
    get enrollmentClaim() {
      return enrollmentClaim;
    },
    principal: { hiveUserId: f.f.ownerId, coderUserId: f.newBinding.ownerId },
  };
}
async function bindSyntheticSuccessor(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: { id: string; generation: number },
) {
  const preparation = { ...f.proof.preparation, buildId: f.newBinding.buildId };
  const prepared = await f.store.prepare({
    ownerId: f.f.ownerId,
    runtimeId: runtime.id,
    runtimeGeneration: runtime.generation,
    preparation,
    preparationDigest: preparationDigest(preparation),
  });
  const bound = await f.store.bindCheckout({
    ownerId: f.f.ownerId,
    runtimeId: runtime.id,
    runtimeGeneration: prepared.runtime.generation,
    checkout: f.proof.checkout,
  });
  const nativeLaunchId = randomUUID(),
    launchIntentDigest = guardianDigest({
      runtimeId: runtime.id,
      runtimeGeneration: prepared.runtime.generation,
      nativeLaunchId,
      inventory: [
        {
          admissionId: bound.admission.id,
          admissionGeneration: bound.admission.generation,
          checkout: f.proof.checkout,
        },
      ],
    });
  await f.store.reserveNativeLaunch({
    ownerId: f.f.ownerId,
    runtimeId: runtime.id,
    runtimeGeneration: prepared.runtime.generation,
    nativeLaunchId,
    launchIntentDigest,
    projectIds: [f.before.projectId],
  });
  const registration = new PrismaRegistrationStore(db),
    registrationId = randomUUID(),
    grantDigest = hash(randomUUID()),
    now = Math.floor(Date.now() / 1000),
    binding = {
      ...f.newBinding,
      projects: [{ projectId: f.before.projectId, repositoryId: f.before.repositoryId }],
    },
    native = generateKeyPairSync("ed25519"),
    serverInstanceId = randomUUID(),
    threadId = randomUUID();
  const generation = await registration.reserve({
    grantId: registrationId,
    binding,
    expiresAt: now + 60,
  });
  await registration.seal({ grantId: registrationId, generation, grantDigest });
  expect(
    await registration.consumeAndRegister({
      grantId: registrationId,
      grantDigest,
      expiresAt: now + 60,
      now,
      registration: {
        binding,
        serverInstanceId,
        protocolVersion: "0.165.0",
        threads: [{ ...binding.projects[0], threadId }],
        hostPublicKeyPem: native.publicKey.export({ format: "pem", type: "spki" }).toString(),
        generation,
        registeredAt: now,
        expiresAt: now + 60,
      },
    }),
  ).toBe(true);
  return f.store.finalizeNative({
    runtimeId: runtime.id,
    runtimeGeneration: prepared.runtime.generation,
    scope: {
      hiveUserId: f.f.ownerId,
      registrationId,
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      serverInstanceId,
      managerThreadId: threadId,
      projectId: f.before.projectId,
      preparationIntentId: f.before.id,
      repositoryId: f.before.repositoryId,
      leaseId: f.proof.checkout.leaseId,
      leaseGeneration: f.proof.checkout.leaseGeneration,
    },
    metadata: {
      pins: { checkout: f.proof.checkout.checkoutIdentity, git: { device: "123", inode: "777" } },
      namespaceReceiptDigest: "8".repeat(64),
      nativeLaunchId,
      launchIntentDigest,
      metadataPolicyDigest: f.newIdentity.metadataPolicyDigest,
    },
  });
}
async function addEpic(f: Awaited<ReturnType<typeof fixture>>) {
  const epic = await db.deliveryEpic.create({
    data: {
      ownerId: f.f.ownerId,
      projectId: f.before.projectId,
      outcome: "Synthetic recovered epic",
      criteria: ["acceptance:behavior"],
    },
  });
  const author = await db.deliveryTask.create({
    data: {
      ownerId: f.f.ownerId,
      projectId: f.before.projectId,
      epicId: epic.id,
      outcome: "Synthetic coordinator",
      sourceSha: f.before.sourceSha,
      branch: "fixture/recovery",
    },
  });
  const node = {
    intentId: f.before.id,
    requestId: f.before.requestId,
    workspaceId: f.old.workspaceId,
    expectedRevision: f.before.sourceSha,
    textDigest: "1".repeat(64),
    criteria: ["acceptance:behavior"],
    dependsOn: [],
    role: "implementation",
  };
  const plan = epicPlanSchema.parse({
    schemaVersion: 1,
    epicId: epic.id,
    projectId: f.before.projectId,
    ownerIntentDigest: "2".repeat(64),
    outcomeDigest: epicDigest(epic.outcome),
    criteria: ["acceptance:behavior"],
    version: 1,
    previousPlanDigest: null,
    maxConcurrentTasks: 1,
    tasks: [
      node,
      {
        ...node,
        intentId: randomUUID(),
        requestId: randomUUID(),
        workspaceId: randomUUID(),
        role: "integration",
        dependsOn: [node.intentId],
      },
    ],
  });
  const planDigest = epicDigest(plan);
  await db.$executeRaw`INSERT INTO delivery_epic_plans(owner_id,epic_id,version,plan,plan_digest,authored_by_task_id) VALUES(${f.f.ownerId}::uuid,${epic.id}::uuid,1,${JSON.stringify(plan)}::jsonb,${planDigest},${author.id}::uuid)`;
  await db.$executeRaw`INSERT INTO delivery_epic_plan_heads(owner_id,epic_id,version,plan_digest) VALUES(${f.f.ownerId}::uuid,${epic.id}::uuid,1,${planDigest})`;
  await db.$executeRaw`INSERT INTO delivery_epic_start_intents(owner_id,epic_id,intent_id,plan_digest,workspace_id,build_id,isolation_domain,request_id,phase) VALUES(${f.f.ownerId}::uuid,${epic.id}::uuid,${f.before.id}::uuid,${planDigest},${f.old.workspaceId}::uuid,${f.old.buildId}::uuid,${`fixture-${epic.id}`},${f.before.requestId}::uuid,'accepted')`;
  return epic;
}
describe.skipIf(!url)("unused metadata authority retirement, actual local PostgreSQL", () => {
  it("owner recovery atomically retires only old authorization, reserves once and preserves encrypted intent/history", async () => {
    const f = await fixture(),
      runtime = await f.reserve();
    expect(runtime.phase).toBe("reserved");
    expect((await f.reserve()).id).toBe(runtime.id);
    const retired = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } });
    expect({ ...retired, phase: f.old.phase }).toEqual(f.old);
    expect(retired.phase).toBe("authorization_retired");
    expect(await db.projectTaskIntent.findUnique({ where: { id: f.before.id } })).toEqual(f.before);
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: f.old.id, action: "authorization_retired" },
      }),
    ).toBe(1);
    expect(
      (
        await db.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM codex_guardian_tree_receipts WHERE runtime_id=${f.old.id}::uuid`
      )[0].count,
    ).toBe(BigInt(0));
    const grant = {
      ownerId: f.f.ownerId,
      runtimeId: runtime.id,
      id: randomUUID(),
      tokenDigest: hash(randomUUID()),
      bindingDigest: "3".repeat(64),
      issuedAt: new Date(Date.now() - 10),
      expiresAt: new Date(Date.now() + 30000),
    };
    await f.store.sealGrant(grant);
    await f.store.enroll({
      ownerId: grant.ownerId,
      runtimeId: runtime.id,
      grantId: grant.id,
      tokenDigest: grant.tokenDigest,
      bindingDigest: grant.bindingDigest,
      consumptionDigest: "4".repeat(64),
    });
    expect(
      await db.$transaction((tx) =>
        effectiveUnstartedSuccessor(tx, {
          ownerId: f.f.ownerId,
          taskId: f.before.id,
          workspaceId: f.old.workspaceId,
          oldBuildId: f.old.buildId,
          newBuildId: runtime.buildId,
          recoveryId: f.recovery!.id,
        }),
      ),
    ).toBe(true);
    expect(
      await db.$transaction((tx) =>
        effectiveUnstartedSuccessor(tx, {
          ownerId: f.f.ownerId,
          taskId: f.before.id,
          workspaceId: f.old.workspaceId,
          oldBuildId: f.old.buildId,
          newBuildId: randomUUID(),
        }),
      ),
    ).toBe(false);
    const epic = await addEpic(f);
    const inspection = {
      outcome: "existing_preexecution" as const,
      taskFingerprint: "5".repeat(64),
      buildId: runtime.buildId,
      lifetimeId: runtime.lifetimeId,
      guardianGeneration: runtime.generation,
    };
    const opened = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: runtime.id } });
    const authorized = await f.recoveries.authorize(
      f.recovery!,
      inspection,
      opened,
      async () => {},
    );
    const receipt = {
      schemaVersion: 1,
      recoveryId: f.recovery!.id,
      scopeDigest: guardianDigest(f.recovery!.scope),
      inspectionDigest: authorized.authorization!.inspectionDigest,
      authorizationDigest: guardianDigest(authorized.authorization),
      outcome: inspection.outcome,
      buildId: runtime.buildId,
      lifetimeId: runtime.lifetimeId,
    };
    await f.recoveries.finish(authorized, receipt);
    await f.recoveries.finish(authorized, receipt);
    expect(
      (
        await db.$queryRaw<
          { build_id: string }[]
        >`SELECT build_id FROM delivery_epic_start_intents WHERE owner_id=${f.f.ownerId}::uuid AND epic_id=${epic.id}::uuid`
      )[0].build_id,
    ).toBe(f.old.buildId);
    expect(
      await db.$queryRaw`SELECT * FROM delivery_epic_writer_reservations WHERE owner_id=${f.f.ownerId}::uuid`,
    ).toEqual([]);
    const after = await db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.before.id } });
    expect(after.ciphertext).toEqual(f.before.ciphertext);
    expect(after.requestDigest).toBe(f.before.requestDigest);
    const native = await bindSyntheticSuccessor(f, opened);
    const maintenance = await new AccountMaintenanceStore(db).request(f.newBinding, {
      requestId: randomUUID(),
      expectedVersion: 0,
      runtimeId: runtime.id,
      runtimeGeneration: native.runtime.generation,
    });
    expect(maintenance.state).toBe("requested");
    const slot = await db.codexHostSlot.findUniqueOrThrow({ where: { id: runtime.slotId } });
    expect(
      accountMaintenanceStateSchema.parse(slot.accountMaintenance).runtimes.map((r) => r.runtimeId),
    ).toEqual([runtime.id]);
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("authorization_retired");
    await expect(
      f.recoveries.begin({ ...f.recoveryInput, recoveryId: randomUUID() }),
    ).rejects.toThrow();
    await expect(f.recoveries.begin(f.recoveryInput)).resolves.toMatchObject({ phase: "consumed" });
  });
  it("requires preexisting exact owner recovery and rejects forged signature/source/unknown execution markers", async () => {
    const absent = await fixture(false);
    await expect(absent.reserve()).rejects.toThrow();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: absent.old.id } })).phase,
    ).toBe("open");
    const f = await fixture();
    for (const p of [
      { ...f.proof, newBuildId: randomUUID() },
      { ...f.proof, oldConfigSha256: "9".repeat(64) },
      {
        ...f.proof,
        predecessorController: { ...f.proof.predecessorController, signature: "A".repeat(86) },
      },
      { ...f.proof, neverStarted: { ...f.proof.neverStarted, metadataPhase: "reserved" } },
    ])
      await expect(f.reserve(p as typeof f.proof)).rejects.toThrow();
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: f.old.id, action: "authorization_retired" },
      }),
    ).toBe(0);
  });
  it("direct SQL cannot retire without an authenticated exact event; event insert rollback preserves old slot", async () => {
    const f = await fixture();
    await expect(
      db.codexGuardianRuntime.update({
        where: { id: f.old.id },
        data: { phase: "authorization_retired" },
      }),
    ).rejects.toThrow();
    // A failure after both event+phase writes rolls them back with the successor.
    await db.$executeRawUnsafe(
      `CREATE FUNCTION public.unstarted_fail_new_runtime() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.old.workspaceId}'::uuid AND NEW.build_id='${f.newBinding.buildId}'::uuid THEN RAISE EXCEPTION 'synthetic successor insert failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER unstarted_fail_new_runtime BEFORE INSERT ON codex_guardian_runtimes FOR EACH ROW EXECUTE FUNCTION public.unstarted_fail_new_runtime()",
    );
    try {
      await expect(f.reserve()).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(
        "DROP TRIGGER unstarted_fail_new_runtime ON codex_guardian_runtimes",
      );
      await db.$executeRawUnsafe("DROP FUNCTION public.unstarted_fail_new_runtime()");
    }
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: f.old.id, action: "authorization_retired" },
      }),
    ).toBe(0);
    expect((await f.reserve()).phase).toBe("reserved");
  });
  it("actual signed owner provision requires stopped predecessor and emits authenticated retirement enrollment acknowledgment", async () => {
    const f = await fixture(),
      blocked = ownerService(f, false);
    await expect(blocked.service.provision(blocked.principal, f.old.workspaceId)).rejects.toThrow();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
    const current = ownerService(f);
    await expect(
      current.service.provision(current.principal, f.old.workspaceId),
    ).resolves.toMatchObject({ enrolled: true });
    expect(current.enrollmentClaim).toEqual({
      transferId: f.proof.transferId,
      oldRuntimeId: f.old.id,
      proofDigest: guardianDigest(f.proof),
    });
  });
  it("concurrent duplicate transfer has one successor; competing transfer and post-retirement edits remain denied", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.reserve(), f.reserve()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const runtime = await f.reserve();
    expect(
      await db.codexGuardianRuntime.count({
        where: {
          ownerId: f.f.ownerId,
          workspaceId: f.old.workspaceId,
          buildId: f.newBinding.buildId,
        },
      }),
    ).toBe(1);
    await expect(f.reserve({ ...f.proof, transferId: randomUUID() })).rejects.toThrow();
    await expect(
      db.codexGuardianRuntime.update({
        where: { id: f.old.id },
        data: { authorityUntil: new Date(Date.now() + 60000) },
      }),
    ).rejects.toThrow();
    await expect(
      new AccountMaintenanceStore(db).request(f.newBinding, {
        requestId: randomUUID(),
        expectedVersion: 0,
        runtimeId: runtime.id,
        runtimeGeneration: runtime.generation,
      }),
    ).rejects.toThrow();
  });
  it("independent event INSERT guard rejects missing owner recovery, NULL proof fields and unknown outcomes", async () => {
    const absent = await fixture(false);
    await expect(
      db.codexGuardianOperationReceipt.create({ data: eventData(absent) }),
    ).rejects.toThrow();
    const f = await fixture();
    for (const field of [
      "oldRuntimeId",
      "oldIdentityDigest",
      "oldJournalDigests",
      "nativeLaunchId",
      "neverStarted",
      "predecessorController",
      "checkout",
    ]) {
      const data = eventData(f),
        response = structuredClone(data.response) as unknown as {
          retirement: { proof: Record<string, unknown> };
        };
      response.retirement.proof[field] = null;
      data.response = response as unknown as Prisma.InputJsonObject;
      data.responseDigest = guardianDigest(response);
      await expect(db.codexGuardianOperationReceipt.create({ data })).rejects.toThrow();
    }
    const foreign = eventData(f),
      foreignBody = structuredClone(foreign.response) as unknown as {
        retirement: { proof: Record<string, unknown> };
      };
    foreignBody.retirement.proof.workspaceId = randomUUID();
    foreign.response = foreignBody as unknown as Prisma.InputJsonObject;
    foreign.responseDigest = guardianDigest(foreignBody);
    await expect(db.codexGuardianOperationReceipt.create({ data: foreign })).rejects.toThrow();
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: f.old.id, action: "authorization_retired" },
      }),
    ).toBe(0);
  });
  it("phase transition rechecks inventory even when a separately inserted event became stale", async () => {
    const f = await fixture();
    await db.codexGuardianOperationReceipt.create({ data: eventData(f) });
    await db.codexGuardianRuntime.update({
      where: { id: f.old.id },
      data: { producerApproved: true },
    });
    await expect(
      db.codexGuardianRuntime.update({
        where: { id: f.old.id },
        data: { phase: "authorization_retired" },
      }),
    ).rejects.toThrow();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
  });
  it("serializes a native-authority change racing retirement under the same workspace fence", async () => {
    const f = await fixture();
    let signal!: () => void;
    const locked = new Promise<void>((r) => {
      signal = r;
    });
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const race = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hive-account-maintenance-v1:${f.f.ownerId}:${f.newBinding.coderOrigin}:${f.old.workspaceId}`},0))`;
      signal();
      await waiting;
      await tx.codexGuardianRuntime.update({
        where: { id: f.old.id },
        data: { producerApproved: true },
      });
    });
    await locked;
    const retirement = f.reserve();
    release();
    await race;
    await expect(retirement).rejects.toThrow();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: f.old.id, action: "authorization_retired" },
      }),
    ).toBe(0);
  });

  it("a real pending registration grant blocks unused retirement without consuming or deleting either intent", async () => {
    const f = await fixture(),
      registration = new PrismaRegistrationStore(db),
      grantId = randomUUID();
    await registration.reserve({
      grantId,
      binding: f.old.binding as unknown as RegistrationBinding,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    await expect(f.reserve()).rejects.toThrow();
    expect(await db.codexRegistrationGrant.findUnique({ where: { id: grantId } })).toBeTruthy();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: f.old.id, action: "authorization_retired" },
      }),
    ).toBe(0);
  });
  it("disabled producer or revoked predecessor pin cannot retire historical authority", async () => {
    const f = await fixture();
    for (const policy of [
      { ...f.policy, producerEnabled: false },
      { ...f.policy, packages: f.policy.packages.slice(1) },
    ]) {
      const store = new GuardianAdmissionStore(db, {
        policy,
        encryptionKey: "19".repeat(32),
        expectedConfigSha256: () => f.newIdentity.configSha256,
      });
      await expect(store.reserveRuntime(f.newBinding, f.newIdentity, f.proof)).rejects.toThrow();
    }
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
  });
});
