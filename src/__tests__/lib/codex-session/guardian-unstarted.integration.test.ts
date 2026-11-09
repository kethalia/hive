import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { accountMaintenanceStateSchema } from "@/lib/codex-session/account-maintenance-contracts";
import {
  AccountMaintenanceStore,
  lockAccountMaintenanceWorkspace,
} from "@/lib/codex-session/account-maintenance-store.server";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  guardianCanonical,
  guardianDigest,
  preparationDigest,
} from "@/lib/codex-session/guardian-contracts";
import {
  readRemountRecoveryTicket,
  resolveRemountAttestation,
  verifyRemountResources,
} from "@/lib/codex-session/guardian-remount.server";
import {
  guardianRemountAttestationSchema,
  guardianTransferContinuationSchema,
  UNUSED_INTERMEDIATE_MANIFEST,
} from "@/lib/codex-session/guardian-remount-contracts";
import { readRecoveryResumption } from "@/lib/codex-session/guardian-resumption.server";
import { guardianResumptionApprovalSchema } from "@/lib/codex-session/guardian-resumption-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import type { GuardianIdentityResponse } from "@/lib/codex-session/guardian-transport-contracts";
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

const url =
  process.env.HIVE_UNSTARTED_TEST_DATABASE_URL ?? process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ||
    !["/hive_unstarted_test_20261108", "/hive_delivery_test"].includes(new URL(url).pathname))
)
  throw Error("Owned local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_unstarted_test_20261108",
});
afterAll(() => db.$disconnect());
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function resumptionFixture(attestationMillis = 120000, resumptionMillis = 300000) {
  const f = await remountFixture();
  f.attestation.expiresAt = Date.now() + attestationMillis;
  const r = await f.reserve();
  // Historical fixture enrollment: insert its original consumed grant and perform
  // the one reserved->open transition. Never edit an already consumed timestamp.
  const enrolledAt = new Date(Date.now() - 240000),
    originalAuthorityUntil = new Date(enrolledAt.getTime() + 180000);
  const grant = await db.codexGuardianEnrollmentGrant.create({
    data: {
      id: randomUUID(),
      ownerId: f.f.ownerId,
      runtimeId: r.id,
      tokenDigest: hash(randomUUID()),
      bindingDigest: hash(randomUUID()),
      issuedAt: new Date(enrolledAt.getTime() - 1000),
      expiresAt: new Date(enrolledAt.getTime() + 59000),
      consumedAt: enrolledAt,
      consumptionDigest: hash(randomUUID()),
    },
  });
  const runtime = await db.codexGuardianRuntime.update({
    where: { id: r.id },
    data: { phase: "open", enrolledAt, authorityUntil: originalAuthorityUntil },
  });
  const approval = guardianResumptionApprovalSchema.parse({
    schemaVersion: 1,
    purpose: "unused-recovery-resumption",
    id: randomUUID(),
    ownerId: f.f.ownerId,
    coderOwnerId: f.newBinding.ownerId,
    workspaceId: f.newBinding.workspaceId,
    projectId: f.proof.projectId,
    taskId: f.proof.taskId,
    recoveryId: f.recoveryInput.recoveryId,
    runtimeId: r.id,
    retirementEventId: f.proof.transferId,
    attestationDigest: guardianDigest(f.attestation),
    continuationDigest: guardianDigest(f.continuation),
    final: f.continuation.finalSuccessor,
    originalAuthorityUntil: originalAuthorityUntil.getTime(),
    issuedAt: Date.now() - 100,
    expiresAt: Date.now() + resumptionMillis,
  });
  const env = {
    HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON: JSON.stringify([f.attestation]),
    HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON: JSON.stringify([approval]),
  };
  const owner = ownerService(f, true, env);
  await expect(
    owner.service.provision(owner.principal, f.newBinding.workspaceId),
  ).rejects.toThrow();
  const ticket = await owner.service.unusedRecoveryResumption(f.recovery!.scope);
  expect(ticket).toBeDefined();
  const inspection = {
    outcome: "existing_preexecution" as const,
    taskFingerprint: "a".repeat(64),
    buildId: r.buildId,
    lifetimeId: r.lifetimeId,
    guardianGeneration: 1,
    remount: {
      attestationDigest: approval.attestationDigest,
      continuationDigest: approval.continuationDigest,
      mappingDigest: guardianDigest(ticket!.mapping),
      volumeDigest: guardianDigest(ticket!.volume),
      mapping: ticket!.mapping,
    },
  };
  const identityIssuedAt = Date.now();
  const packet = {
    ...owner.lastIdentity!,
    issuedAt: identityIssuedAt,
    expiresAt: identityIssuedAt + 30000,
    nonce: guardianDigest({ scope: f.recovery!.scope, inspection }),
    unstartedTransferReceipt: {
      transferId: f.proof.transferId,
      oldRuntimeId: f.old.id,
      proofDigest: guardianDigest(f.proof),
      continuationDigest: approval.continuationDigest,
      attestationDigest: approval.attestationDigest,
    },
  };
  packet.proof = sign(
    null,
    Buffer.from(guardianIdentityProofPayload(packet)),
    f.f.outerPrivateKey,
  ).toString("base64url");
  const resume = () =>
    owner.service.verifyRecoveryIdentity(
      owner.principal,
      f.newBinding.workspaceId,
      packet,
      packet.nonce,
      { scope: f.recovery!.scope, inspection, authorize: async () => {} },
    );
  return { f, runtime, grant, approval, env, owner, ticket, inspection, packet, resume };
}

describe.skipIf(!url)("unused successor authority resumption", () => {
  it("renews once through signed service identity, preserves history and authorizes the same recovery", async () => {
    const v = await resumptionFixture(),
      { f } = v;
    const old = await db.codexGuardianOperationReceipt.findMany({ where: { runtimeId: f.old.id } });
    const first = await v.resume();
    expect({ ...first.runtime, authorityUntil: v.runtime.authorityUntil }).toEqual(v.runtime);
    expect(first.runtime.authorityUntil.getTime()).toBeGreaterThan(Date.now());
    expect((await v.resume()).runtime.authorityUntil).toEqual(first.runtime.authorityUntil);
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { runtimeId: v.runtime.id, action: "unused_recovery_resumed" },
      }),
    ).toBe(1);
    expect(
      await db.codexGuardianOperationReceipt.findMany({ where: { runtimeId: f.old.id } }),
    ).toEqual(old);
    expect(await db.codexGuardianEnrollmentGrant.findUnique({ where: { id: v.grant.id } })).toEqual(
      v.grant,
    );
    expect(
      await f.store.enrollmentReadback({
        ownerId: f.f.ownerId,
        runtimeId: v.runtime.id,
        runtimeGeneration: 1,
        grantId: v.grant.id,
        tokenDigest: v.grant.tokenDigest,
        claimsDigest: v.grant.bindingDigest,
        consumptionDigest: v.grant.consumptionDigest!,
      }),
    ).toEqual({
      enrolledAt: v.runtime.enrolledAt!.getTime(),
      authorityUntil: v.approval.originalAuthorityUntil,
    });
    expect(await readRemountRecoveryTicket(db, v.env, f.recovery!.scope)).toEqual(v.ticket);
    const recoveries = new ProjectTaskRecoveries(db, f.intents, v.env);
    const authorized = await recoveries.authorize(
      f.recovery!,
      v.inspection,
      first.runtime,
      async () => {},
    );
    expect(authorized.authorization!.expiresAt).toBeLessThanOrEqual(
      first.runtime.authorityUntil.getTime(),
    );
    expect(authorized.scope).toEqual(f.recovery!.scope);
    await expect(v.resume()).rejects.toThrow(); // persisted authorization is never reset
    const preparation = { ...f.proof.preparation, buildId: v.runtime.buildId };
    const prepared = await f.store.prepare({
      ownerId: f.f.ownerId,
      runtimeId: v.runtime.id,
      runtimeGeneration: 1,
      preparation,
      preparationDigest: preparationDigest(preparation),
    });
    const mapped = {
      ...f.proof.checkout,
      checkoutIdentity: f.attestation.mapping.current.checkout,
    };
    const bound = await f.store.bindCheckout({
      ownerId: f.f.ownerId,
      runtimeId: v.runtime.id,
      runtimeGeneration: prepared.runtime.generation,
      checkout: mapped,
    });
    expect(bound.admission.checkoutBinding).toEqual(mapped);
    expect(mapped.leaseId).toBe(f.proof.checkout.leaseId);
    expect(mapped.checkoutIncarnation).toBe(f.proof.checkout.checkoutIncarnation);
  });
  it("rejects revoked or changed operator approval and direct expired TTL updates", async () => {
    const v = await resumptionFixture();
    await expect(
      v.f.store.resumeUnusedRecovery(
        v.f.newBinding,
        v.packet,
        v.f.recovery!.scope,
        v.inspection,
        {},
        async () => {},
      ),
    ).rejects.toThrow();
    for (const changed of [
      { runtimeId: randomUUID() },
      { recoveryId: randomUUID() },
      { originalAuthorityUntil: v.approval.originalAuthorityUntil + 1 },
      { expiresAt: Date.now() - 1 },
    ]) {
      const env = {
        ...v.env,
        HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON: JSON.stringify([{ ...v.approval, ...changed }]),
      };
      await expect(
        v.f.store.resumeUnusedRecovery(
          v.f.newBinding,
          v.packet,
          v.f.recovery!.scope,
          v.inspection,
          env,
          async () => {},
        ),
      ).rejects.toThrow();
    }
    await expect(
      db.codexGuardianRuntime.update({
        where: { id: v.runtime.id },
        data: { authorityUntil: new Date(Date.now() + 60000) },
      }),
    ).rejects.toThrow();
    expect(await db.codexGuardianRuntime.findUnique({ where: { id: v.runtime.id } })).toEqual(
      v.runtime,
    );
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: v.runtime.id } }),
    ).toBe(0);
  });
  it("racing identical owner retries retain one deadline and deny a second grant", async () => {
    const v = await resumptionFixture();
    const results = await Promise.all([v.resume(), v.resume()]);
    expect(results[0].runtime.authorityUntil).toEqual(results[1].runtime.authorityUntil);
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: v.runtime.id } }),
    ).toBe(1);
    const another = {
      ...v.env,
      HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON: JSON.stringify([
        { ...v.approval, id: randomUUID() },
      ]),
    };
    await expect(
      v.f.store.resumeUnusedRecovery(
        v.f.newBinding,
        v.packet,
        v.f.recovery!.scope,
        v.inspection,
        another,
        async () => {},
      ),
    ).rejects.toThrow();
  });
  it("expired renewal cannot extend again and keeps original historical proof and empty-close eligibility", async () => {
    const v = await resumptionFixture(120000, 1200);
    const result = await v.resume();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, result.runtime.authorityUntil.getTime() - Date.now() + 20)),
    );
    await expect(v.resume()).rejects.toThrow();
    await expect(
      db.codexGuardianRuntime.update({
        where: { id: v.runtime.id },
        data: { authorityUntil: new Date(Date.now() + 60000) },
      }),
    ).rejects.toThrow();
    expect(
      await v.f.store.expiredEmptyReady({
        ownerId: v.f.f.ownerId,
        runtimeId: v.runtime.id,
        workspaceId: v.runtime.workspaceId,
        bindingDigest: guardianDigest(v.runtime.binding),
        configSha256: v.runtime.configSha256,
      }),
    ).toMatchObject({ runtimeId: v.runtime.id, generation: 1 });
    expect(
      (
        await v.f.store.enrollmentReadback({
          ownerId: v.f.f.ownerId,
          runtimeId: v.runtime.id,
          runtimeGeneration: 1,
          grantId: v.grant.id,
          tokenDigest: v.grant.tokenDigest,
          claimsDigest: v.grant.bindingDigest,
          consumptionDigest: v.grant.consumptionDigest!,
        })
      ).authorityUntil,
    ).toBe(v.approval.originalAuthorityUntil);
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: v.runtime.id } }))
        .authorityUntil,
    ).toEqual(result.runtime.authorityUntil);
  });
  it("bad host signature, wrong inspection and stale packet have no renewal effect", async () => {
    const v = await resumptionFixture();
    for (const packet of [
      { ...v.packet, proof: Buffer.alloc(64).toString("base64url") },
      { ...v.packet, expiresAt: Date.now() - 1 },
    ])
      await expect(
        v.owner.service.verifyRecoveryIdentity(
          v.owner.principal,
          v.f.newBinding.workspaceId,
          packet,
          packet.nonce,
          { scope: v.f.recovery!.scope, inspection: v.inspection, authorize: async () => {} },
        ),
      ).rejects.toThrow();
    await expect(
      v.f.store.resumeUnusedRecovery(
        v.f.newBinding,
        v.packet,
        v.f.recovery!.scope,
        { ...v.inspection, guardianGeneration: 2 },
        v.env,
        async () => {},
      ),
    ).rejects.toThrow();
    expect(await db.codexGuardianRuntime.findUnique({ where: { id: v.runtime.id } })).toEqual(
      v.runtime,
    );
  });
  it("explicit resumption works after the original attestation expires without replacing its digest", async () => {
    const v = await resumptionFixture(1200);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, v.f.attestation.expiresAt - Date.now() + 20)),
    );
    const original = guardianDigest(v.f.attestation);
    await expect(v.f.reserve()).rejects.toThrow(); // Ordinary expiry remains strict.
    await v.resume();
    expect((await readRecoveryResumption(db, v.env, v.f.recovery!.scope))!.ticket).toEqual(
      v.ticket,
    );
    expect(v.ticket!.attestationDigest).toBe(original);
    expect(v.ticket!.expiresAt).toBe(v.approval.expiresAt);
    expect(await readRemountRecoveryTicket(db, v.env, v.f.recovery!.scope)).toEqual(v.ticket);
    await expect(
      readRemountRecoveryTicket(
        db,
        { ...v.env, HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON: "[]" },
        v.f.recovery!.scope,
      ),
    ).rejects.toThrow();
    const changed = {
      ...v.env,
      HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON: JSON.stringify([
        { ...v.approval, expiresAt: v.approval.expiresAt + 1 },
      ]),
    };
    await expect(readRemountRecoveryTicket(db, changed, v.f.recovery!.scope)).rejects.toThrow();
  });
  it("deadline expiry during actual SQL rolls back the renewal event and runtime together", async () => {
    const v = await resumptionFixture();
    const approval = { ...v.approval, expiresAt: Date.now() + 1100 },
      env = { ...v.env, HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON: JSON.stringify([approval]) };
    const name = `resumption_expiry_${v.f.f.ownerId.replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${v.runtime.id}'::uuid THEN PERFORM pg_sleep(1.4); END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER zz_${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      const service = ownerService(v.f, true, env);
      await expect(
        service.service.verifyRecoveryIdentity(
          service.principal,
          v.f.newBinding.workspaceId,
          v.packet,
          v.packet.nonce,
          { scope: v.f.recovery!.scope, inspection: v.inspection, authorize: async () => {} },
        ),
      ).rejects.toThrow();
      expect(await db.codexGuardianRuntime.findUnique({ where: { id: v.runtime.id } })).toEqual(
        v.runtime,
      );
      expect(
        await db.codexGuardianOperationReceipt.count({ where: { runtimeId: v.runtime.id } }),
      ).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER zz_${name} ON codex_guardian_runtimes`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  });
  it.each([
    "registration",
    "intent",
  ])("a committed competing %s change is visible after the workspace advisory wait", async (kind) => {
    const v = await resumptionFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      acquired = new Promise<void>((r) => {
        entered = r;
      });
    const writer = db.$transaction(async (tx) => {
      await lockAccountMaintenanceWorkspace(tx, v.f.newBinding);
      if (kind === "intent")
        await tx.$executeRaw`UPDATE project_task_intents SET updated_at=clock_timestamp()
        WHERE owner_id=${v.f.f.ownerId}::uuid AND id=${v.f.proof.taskId}::uuid`;
      else
        await tx.codexRegistrationGrant.create({
          data: {
            id: randomUUID(),
            ownerId: v.f.f.ownerId,
            slotId: v.runtime.slotId,
            generation: 1,
            binding: v.f.newBinding as unknown as Prisma.InputJsonObject,
            bindingDigest: guardianDigest(v.f.newBinding),
            expiresAt: new Date(Date.now() + 60000),
          },
        });
      entered();
      await gate;
    });
    await acquired;
    const pending = v.resume();
    await new Promise((r) => setTimeout(r, 40));
    release();
    await writer;
    await expect(pending).rejects.toThrow();
    expect(await db.codexGuardianRuntime.findUnique({ where: { id: v.runtime.id } })).toEqual(
      v.runtime,
    );
  });
  it("independent SQL rejects null resumption scope and preserves the immutable renewal event", async () => {
    const v = await resumptionFixture();
    await v.resume();
    const [event] = await db.$queryRaw<
      { value: Record<string, unknown> }[]
    >`SELECT to_jsonb(e) AS value FROM codex_guardian_operation_receipts e
      WHERE owner_id=${v.f.f.ownerId}::uuid AND runtime_id=${v.runtime.id}::uuid AND action='unused_recovery_resumed'`;
    for (const field of [
      "approval",
      "scope",
      "ticket",
      "inspection",
      "authorityUntil",
      "retirementEventId",
    ]) {
      const changed = structuredClone(event.value) as {
        response: { resumption: Record<string, unknown> };
      };
      changed.response.resumption[field] = null;
      await expect(
        db.$queryRaw`SELECT hive_guardian_unused_resumption(jsonb_populate_record(NULL::codex_guardian_operation_receipts,${JSON.stringify(changed)}::jsonb)) IS NULL`,
      ).rejects.toThrow();
    }
    await expect(
      db.codexGuardianOperationReceipt.update({
        where: {
          ownerId_runtimeId_eventId: {
            ownerId: v.f.f.ownerId,
            runtimeId: v.runtime.id,
            eventId: v.approval.id,
          },
        },
        data: { response: {} },
      }),
    ).rejects.toThrow();
  });
});
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
async function remountFixture() {
  const f = await fixture();
  f.newIdentity.guardianElfSha256 = "8".repeat(64);
  f.policy.packages[1].guardianElfSha256 = f.newIdentity.guardianElfSha256;
  const heldBuildId = randomUUID(),
    heldLifetimeId = randomUUID();
  f.proof = guardianUnstartedTransferSchema.parse({
    ...f.proof,
    newBuildId: heldBuildId,
    newConfigSha256: "9".repeat(64),
    newPackageManifestSha256: UNUSED_INTERMEDIATE_MANIFEST,
  });
  const continuation = guardianTransferContinuationSchema.parse({
    schemaVersion: 2,
    originalProofDigest: guardianDigest(f.proof),
    unusedEpochHop: {
      schemaVersion: 1,
      buildId: heldBuildId,
      lifetimeId: heldLifetimeId,
      configSha256: f.proof.newConfigSha256,
      packageManifestSha256: UNUSED_INTERMEDIATE_MANIFEST,
      originalProofDigest: guardianDigest(f.proof),
      oldJournalDigests: {
        lifetime: "1".repeat(64),
        project: "2".repeat(64),
        config: "3".repeat(64),
        supervisor: null,
        controller: null,
      },
      neverEnrolled: true,
      nativeCreationAttempted: false,
      firstPromptSubmissionAttempted: false,
    },
    finalSuccessor: {
      buildId: f.newBinding.buildId,
      lifetimeId: f.newIdentity.lifetimeId,
      configSha256: f.newIdentity.configSha256,
      packageManifestSha256: f.newIdentity.packageManifestSha256,
    },
  });
  const oldCheckout = f.proof.checkout.checkoutIdentity;
  const old = {
    root: { device: oldCheckout.device, inode: "12" },
    project: { device: oldCheckout.device, inode: "13" },
    checkout: oldCheckout,
  };
  const pvcUid = randomUUID();
  const attestation = guardianRemountAttestationSchema.parse({
    schemaVersion: 1,
    purpose: "unused-checkout-remount",
    ownerId: f.f.ownerId,
    coderOwnerId: f.newBinding.ownerId,
    workspaceId: f.newBinding.workspaceId,
    templateId: f.newBinding.templateId,
    projectId: f.proof.projectId,
    taskId: f.proof.taskId,
    originalProofDigest: guardianDigest(f.proof),
    oldBuildId: f.old.buildId,
    oldLifetimeId: f.old.lifetimeId,
    held: {
      buildId: heldBuildId,
      lifetimeId: heldLifetimeId,
      configSha256: f.proof.newConfigSha256,
      packageManifestSha256: UNUSED_INTERMEDIATE_MANIFEST,
    },
    heldJournalDigests: continuation.unusedEpochHop.oldJournalDigests,
    final: continuation.finalSuccessor,
    finalTemplateVersionId: randomUUID(),
    volume: {
      pvcUid,
      pvcName: `coder-${f.newBinding.workspaceId}-home`,
      namespace: "coder",
      storageClass: "longhorn",
      capacity: "20Gi",
      accessModes: ["ReadWriteOnce"],
      boundVolumeName: `pvc-${pvcUid}`,
      containerName: "dev",
      podVolumeName: "home",
      mountPath: "/home/coder",
      subPath: "",
      subPathExpr: "",
      readOnly: false,
      claimReadOnly: false,
    },
    mapping: {
      old,
      current: Object.fromEntries(
        Object.entries(old).map(([k, v]) => [k, { ...v, device: "99999" }]),
      ),
      oldRootRecordSha256: "4".repeat(64),
      oldProjectRecordSha256: "5".repeat(64),
      oldLeaseDigest: "6".repeat(64),
    },
    expiresAt: Date.now() + 120000,
  });
  f.policy.packages.push({
    ...f.policy.packages[0],
    packageManifestSha256: UNUSED_INTERMEDIATE_MANIFEST,
  });
  const store = new GuardianAdmissionStore(db, {
    policy: f.policy,
    encryptionKey: "19".repeat(32),
    expectedConfigSha256: () => f.newIdentity.configSha256,
  });
  const reserve = () =>
    store.reserveRuntime(f.newBinding, f.newIdentity, f.proof, continuation, [attestation]);
  return { ...f, store, reserve, continuation, attestation };
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
function ownerService(
  f: Awaited<ReturnType<typeof fixture>> & {
    continuation?: ReturnType<typeof guardianTransferContinuationSchema.parse>;
    attestation?: ReturnType<typeof guardianRemountAttestationSchema.parse>;
  },
  stopped = true,
  extraEnv: Record<string, string> = {},
) {
  let enrollmentClaim: unknown;
  let identityBytes = 0;
  let lastIdentity: GuardianIdentityResponse | undefined;
  let service: GuardianService;
  service = new GuardianService(db, f.config, f.policy, "19".repeat(32), {
    env: {
      ...f.env,
      ...(f.attestation
        ? { HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON: JSON.stringify([f.attestation]) }
        : {}),
      ...extraEnv,
    },
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
          ...(f.continuation ? { unstartedTransferContinuation: f.continuation } : {}),
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
        identityBytes = Buffer.byteLength(JSON.stringify(packet));
        lastIdentity = packet;
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
    get identityBytes() {
      return identityBytes;
    },
    get lastIdentity() {
      return lastIdentity;
    },
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
  it("one unused epoch plus exact operator volume enrollment preserves original proof and yields one final successor", async () => {
    const f = await remountFixture();
    const state = f.proof.predecessorController.state;
    state.padding = "x".repeat(8192 - Buffer.byteLength(guardianCanonical(state)) - 15);
    f.proof.predecessorController.signature = sign(
      null,
      Buffer.from(guardianCanonical(state)),
      f.f.outerPrivateKey,
    ).toString("base64url");
    f.proof.oldJournalDigests.controller = hash(
      `${JSON.stringify(f.proof.predecessorController)}\n`,
    );
    f.continuation.originalProofDigest = guardianDigest(f.proof);
    f.continuation.unusedEpochHop.originalProofDigest = guardianDigest(f.proof);
    f.attestation.originalProofDigest = guardianDigest(f.proof);
    expect(guardianUnstartedTransferSchema.safeParse(f.proof).success).toBe(true);
    const before = structuredClone(f.proof),
      concurrent = await Promise.all([f.reserve(), f.reserve()]),
      r = concurrent[0];
    expect(concurrent[1].id).toBe(r.id);
    expect(r.guardianElfSha256).toBe(f.newIdentity.guardianElfSha256);
    expect(r.guardianElfSha256).not.toBe(f.old.guardianElfSha256);
    expect((await f.reserve()).id).toBe(r.id);
    const e = await db.codexGuardianOperationReceipt.findUniqueOrThrow({
      where: {
        ownerId_runtimeId_eventId: {
          ownerId: f.f.ownerId,
          runtimeId: f.old.id,
          eventId: f.proof.transferId,
        },
      },
    });
    const t = (e.response as Prisma.JsonObject).retirement as Prisma.JsonObject;
    expect(t.proof).toEqual(before);
    expect(t.continuation).toEqual(f.continuation);
    expect(t.attestationDigest).toBe(guardianDigest(f.attestation));
    expect(t.nativeTreeExited).toBe(false);
    expect(t.writerReleased).toBe(false);
    expect(
      await db.codexGuardianRuntime.count({
        where: { ownerId: f.f.ownerId, buildId: f.continuation.unusedEpochHop.buildId },
      }),
    ).toBe(0);
    const current = ownerService(f);
    await expect(
      current.service.provision(current.principal, f.old.workspaceId),
    ).resolves.toMatchObject({ enrolled: true });
    expect(current.identityBytes).toBeLessThan(32768);
    expect(current.identityBytes).toBeGreaterThan(10000);
    console.info(
      "Maximal predecessor controller with signed remount identity bytes:",
      current.identityBytes,
    );
    expect(current.enrollmentClaim).toMatchObject({
      continuationDigest: guardianDigest(f.continuation),
      attestationDigest: guardianDigest(f.attestation),
    });
    expect(
      await effectiveUnstartedSuccessor(db, {
        ownerId: f.f.ownerId,
        taskId: f.proof.taskId,
        workspaceId: f.proof.workspaceId,
        oldBuildId: f.old.buildId,
        newBuildId: f.newBinding.buildId,
        recoveryId: f.recoveryInput.recoveryId,
      }),
    ).toBe(true);
    const scope = f.recovery!.scope,
      env = { HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON: JSON.stringify([f.attestation]) };
    const ticket = await readRemountRecoveryTicket(db, env, scope);
    expect(ticket?.mapping).toEqual(f.attestation.mapping);
    expect(await readRemountRecoveryTicket(db, env, scope)).toEqual(ticket);
    await expect(readRemountRecoveryTicket(db, {}, scope)).rejects.toThrow();
    verifyRemountResources(
      [
        {
          id: randomUUID(),
          name: "workspace",
          type: "kubernetes_deployment_v1",
          agents: [{ id: f.newBinding.agentId } as never],
          metadata: [{ key: "hive_home_volume_v1", value: JSON.stringify(f.attestation.volume) }],
        },
      ],
      f.attestation,
      f.newBinding.agentId,
    );
    expect(await db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.before.id } })).toEqual(
      f.before,
    );
    const epic = await addEpic(f),
      recoveries = new ProjectTaskRecoveries(db, f.intents, env);
    const opened = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: r.id } });
    const inspection = {
      outcome: "existing_preexecution" as const,
      taskFingerprint: "5".repeat(64),
      buildId: opened.buildId,
      lifetimeId: opened.lifetimeId,
      guardianGeneration: opened.generation,
      remount: {
        attestationDigest: ticket!.attestationDigest,
        continuationDigest: ticket!.continuationDigest,
        mappingDigest: guardianDigest(ticket!.mapping),
        volumeDigest: guardianDigest(ticket!.volume),
        mapping: ticket!.mapping,
      },
    };
    await expect(
      recoveries.authorize(
        f.recovery!,
        { ...inspection, remount: { ...inspection.remount, mappingDigest: "0".repeat(64) } },
        opened,
        async () => {},
      ),
    ).rejects.toThrow();
    const authorized = await recoveries.authorize(f.recovery!, inspection, opened, async () => {});
    expect(authorized.authorization!.expiresAt).toBeLessThanOrEqual(f.attestation.expiresAt);
    const preparation = { ...f.proof.preparation, buildId: opened.buildId };
    const prepared = await f.store.prepare({
      ownerId: f.f.ownerId,
      runtimeId: opened.id,
      runtimeGeneration: opened.generation,
      preparation,
      preparationDigest: preparationDigest(preparation),
    });
    await expect(
      f.store.bindCheckout({
        ownerId: f.f.ownerId,
        runtimeId: opened.id,
        runtimeGeneration: prepared.runtime.generation,
        checkout: f.proof.checkout,
      }),
    ).rejects.toThrow();
    const mapped = {
      ...f.proof.checkout,
      checkoutIdentity: f.attestation.mapping.current.checkout,
    };
    await expect(
      f.store.bindCheckout({
        ownerId: f.f.ownerId,
        runtimeId: opened.id,
        runtimeGeneration: prepared.runtime.generation,
        checkout: { ...mapped, leaseGeneration: mapped.leaseGeneration + 1 },
      }),
    ).rejects.toThrow();
    await expect(
      f.store.bindCheckout({
        ownerId: f.f.ownerId,
        runtimeId: opened.id,
        runtimeGeneration: prepared.runtime.generation,
        checkout: mapped,
      }),
    ).resolves.toMatchObject({ admission: { checkoutBinding: mapped } });
    const receipt = {
      schemaVersion: 1,
      recoveryId: f.recovery!.id,
      scopeDigest: guardianDigest(scope),
      inspectionDigest: authorized.authorization!.inspectionDigest,
      authorizationDigest: guardianDigest(authorized.authorization),
      outcome: inspection.outcome,
      buildId: opened.buildId,
      lifetimeId: opened.lifetimeId,
    };
    await recoveries.finish(authorized, receipt);
    await recoveries.finish(authorized, receipt);
    expect(
      (
        await db.$queryRaw<
          { build_id: string }[]
        >`SELECT build_id FROM delivery_epic_start_intents WHERE owner_id=${f.f.ownerId}::uuid AND epic_id=${epic.id}::uuid`
      )[0].build_id,
    ).toBe(f.old.buildId);
  });
  it("missing, foreign, expired or changed volume enrollment cannot retire the old reservation", async () => {
    const f = await remountFixture();
    const resolve = (enrollments: unknown[]) =>
      resolveRemountAttestation({
        proof: f.proof,
        continuation: f.continuation,
        binding: f.newBinding,
        identity: f.newIdentity,
        policy: f.policy,
        enrollments: enrollments as [typeof f.attestation],
      });
    for (const entries of [
      [],
      [{ ...f.attestation, workspaceId: randomUUID() }],
      [{ ...f.attestation, expiresAt: Date.now() - 1 }],
      [{ ...f.attestation, final: { ...f.attestation.final, buildId: randomUUID() } }],
      [
        {
          ...f.attestation,
          mapping: {
            ...f.attestation.mapping,
            old: {
              ...f.attestation.mapping.old,
              checkout: { ...f.attestation.mapping.old.checkout, inode: "987" },
            },
          },
        },
      ],
    ])
      expect(() => resolve(entries)).toThrow();
    const resources = [
      {
        id: randomUUID(),
        name: "workspace",
        type: "kubernetes_deployment_v1",
        metadata: [
          {
            key: "hive_home_volume_v1",
            value: JSON.stringify({ ...f.attestation.volume, subPath: "foreign" }),
          },
        ],
      },
    ];
    expect(() => verifyRemountResources(resources, f.attestation, f.newBinding.agentId)).toThrow();
    expect(() =>
      verifyRemountResources(
        [
          {
            id: randomUUID(),
            name: "workspace",
            type: "kubernetes_deployment_v1",
            agents: [{ id: randomUUID() } as never],
            metadata: [{ key: "hive_home_volume_v1", value: JSON.stringify(f.attestation.volume) }],
          },
        ],
        f.attestation,
        f.newBinding.agentId,
      ),
    ).toThrow();
    await expect(
      f.store.reserveRuntime(f.newBinding, f.newIdentity, f.proof, f.continuation, []),
    ).rejects.toThrow();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
  });
  it("forward SQL rejects null/foreign hop envelopes atomically, and any intermediate runtime history holds", async () => {
    const f = await remountFixture();
    const event = eventData(f),
      base = structuredClone(event.response) as unknown as { retirement: Record<string, unknown> };
    Object.assign(base.retirement, {
      continuation: f.continuation,
      continuationDigest: guardianDigest(f.continuation),
      attestation: f.attestation,
      attestationDigest: guardianDigest(f.attestation),
    });
    const mutations = [
      (t: typeof base) => {
        (t.retirement.continuation as typeof f.continuation).unusedEpochHop.lifetimeId =
          null as unknown as string;
        (t.retirement.attestation as typeof f.attestation).held.lifetimeId =
          null as unknown as string;
      },
      (t: typeof base) => {
        for (const key of ["root", "project", "checkout"] as const)
          (t.retirement.attestation as typeof f.attestation).mapping.current[key].device =
            "nonnumeric";
      },
      (t: typeof base) => {
        t.retirement.continuation = null;
      },
      (t: typeof base) => {
        (t.retirement.continuation as typeof f.continuation).finalSuccessor.buildId = randomUUID();
      },
      (t: typeof base) => {
        (t.retirement.attestation as typeof f.attestation).volume.readOnly = true as false;
      },
      (t: typeof base) => {
        (t.retirement.attestation as typeof f.attestation).mapping.oldLeaseDigest =
          null as unknown as string;
      },
      (t: typeof base) => {
        (t.retirement.continuation as typeof f.continuation).unusedEpochHop.neverEnrolled =
          false as true;
      },
    ];
    for (const mutate of mutations) {
      const response = structuredClone(base);
      mutate(response);
      await expect(
        db.$transaction((tx) =>
          tx.codexGuardianOperationReceipt.create({
            data: {
              ...event,
              response: response as unknown as Prisma.InputJsonObject,
              responseDigest: guardianDigest(response),
            },
          }),
        ),
      ).rejects.toThrow();
    }
    await db.$transaction(async (tx) => {
      const slot = await tx.codexHostSlot.create({
        data: {
          ownerId: f.f.ownerId,
          coderOrigin: f.newBinding.coderOrigin,
          coderOwnerId: f.newBinding.ownerId,
          workspaceId: f.newBinding.workspaceId,
          agentId: randomUUID(),
        },
      });
      await tx.codexGuardianRuntime.create({
        data: {
          ...f.old,
          binding: {
            ...f.newBinding,
            agentId: slot.agentId,
            buildId: f.continuation.unusedEpochHop.buildId,
          } as unknown as Prisma.InputJsonObject,
          id: randomUUID(),
          slotId: slot.id,
          buildId: f.continuation.unusedEpochHop.buildId,
          lifetimeId: f.continuation.unusedEpochHop.lifetimeId,
          phase: "reserved",
          nativeLaunchId: null,
          nativeLaunchDigest: null,
          nativeLaunchAt: null,
          enrolledAt: null,
          generation: 1,
          serverInstanceId: null,
          hostKeyFingerprint: null,
          producerApproved: false,
        },
      });
    });
    await expect(f.reserve()).rejects.toThrow();
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { ownerId: f.f.ownerId, action: "authorization_retired" },
      }),
    ).toBe(0);
  });
  it("late SQL past operator continuity expiry rolls back intent and recovery authorization together", async () => {
    const f = await remountFixture();
    f.attestation.expiresAt = Date.now() + 1300;
    const current = ownerService(f);
    await current.service.provision(current.principal, f.old.workspaceId);
    const runtime = await db.codexGuardianRuntime.findFirstOrThrow({
      where: { ownerId: f.f.ownerId, lifetimeId: f.newIdentity.lifetimeId },
    });
    const env = { HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON: JSON.stringify([f.attestation]) },
      ticket = (await readRemountRecoveryTicket(db, env, f.recovery!.scope))!;
    const recoveries = new ProjectTaskRecoveries(db, f.intents, env),
      inspection = {
        outcome: "existing_preexecution",
        taskFingerprint: "5".repeat(64),
        buildId: runtime.buildId,
        lifetimeId: runtime.lifetimeId,
        guardianGeneration: runtime.generation,
        remount: {
          attestationDigest: ticket.attestationDigest,
          continuationDigest: ticket.continuationDigest,
          mappingDigest: guardianDigest(ticket.mapping),
          volumeDigest: guardianDigest(ticket.volume),
          mapping: ticket.mapping,
        },
      };
    await db.$executeRawUnsafe(
      `CREATE FUNCTION remount_expiry_${f.f.ownerId.replaceAll("-", "")}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.recovery!.id}'::uuid AND NEW.phase='authorized' THEN PERFORM pg_sleep(1.4); END IF; RETURN NEW; END $$`,
    );
    const name = `remount_expiry_${f.f.ownerId.replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON project_task_recoveries FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      await expect(
        recoveries.authorize(f.recovery!, inspection, runtime, async () => {}),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON project_task_recoveries`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
    expect(await db.projectTaskIntent.findUniqueOrThrow({ where: { id: f.before.id } })).toEqual(
      f.before,
    );
    expect(
      (
        await db.$queryRaw<
          { phase: string; authorization: unknown }[]
        >`SELECT phase,"authorization" FROM project_task_recoveries WHERE id=${f.recovery!.id}::uuid`
      )[0],
    ).toEqual({ phase: "inspecting", authorization: null });
  });
  it("workspace advisory serializes an intermediate authority commit before final retirement", async () => {
    const f = await remountFixture();
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      entered = new Promise<void>((r) => {
        ready = r;
      });
    const intermediate = db.$transaction(async (tx) => {
      await lockAccountMaintenanceWorkspace(tx, f.newBinding);
      const slot = await tx.codexHostSlot.create({
        data: {
          ownerId: f.f.ownerId,
          coderOrigin: f.newBinding.coderOrigin,
          coderOwnerId: f.newBinding.ownerId,
          workspaceId: f.newBinding.workspaceId,
          agentId: randomUUID(),
        },
      });
      await tx.codexGuardianRuntime.create({
        data: {
          ...f.old,
          binding: {
            ...f.newBinding,
            agentId: slot.agentId,
            buildId: f.continuation.unusedEpochHop.buildId,
          } as unknown as Prisma.InputJsonObject,
          id: randomUUID(),
          slotId: slot.id,
          buildId: f.continuation.unusedEpochHop.buildId,
          lifetimeId: f.continuation.unusedEpochHop.lifetimeId,
          phase: "reserved",
          nativeLaunchId: null,
          nativeLaunchDigest: null,
          nativeLaunchAt: null,
          enrolledAt: null,
          generation: 1,
          serverInstanceId: null,
          hostKeyFingerprint: null,
          producerApproved: false,
        },
      });
      ready();
      await gate;
    });
    await entered;
    let settled = false;
    const pending = f.reserve().then(
      () => {
        settled = true;
        return "unexpected";
      },
      () => {
        settled = true;
        return "held";
      },
    );
    try {
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await intermediate;
    expect(await pending).toBe("held");
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.old.id } })).phase,
    ).toBe("open");
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { ownerId: f.f.ownerId, action: "authorization_retired" },
      }),
    ).toBe(0);
  });
  it("final retirement wins against a queued stale ordinary intermediate reservation without resurrection", async () => {
    const f = await remountFixture();
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      entered = new Promise<void>((r) => {
        ready = r;
      });
    // Retain a real transaction just after all real store writes, before COMMIT.
    // No verifier/controller is replaced; only the commit scheduling is controlled.
    const delayed = new Proxy(db, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
          target.$transaction(async (tx) => {
            const result = await work(tx);
            ready();
            await gate;
            return result;
          }, options as never);
      },
    });
    const finalStore = new GuardianAdmissionStore(delayed, {
      policy: f.policy,
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: () => f.newIdentity.configSha256,
    });
    const final = finalStore.reserveRuntime(f.newBinding, f.newIdentity, f.proof, f.continuation, [
      f.attestation,
    ]);
    await entered;
    const h = f.continuation.unusedEpochHop,
      heldBinding = { ...f.newBinding, buildId: h.buildId, agentId: randomUUID() },
      heldIdentity = {
        ...f.newIdentity,
        lifetimeId: h.lifetimeId,
        configSha256: h.configSha256,
        packageManifestSha256: h.packageManifestSha256,
      };
    const intermediate = new GuardianAdmissionStore(db, {
      policy: f.policy,
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: () => h.configSha256,
    });
    let settled = false;
    const pending = intermediate.reserveRuntime(heldBinding, heldIdentity).then(
      () => {
        settled = true;
        return "unexpected";
      },
      () => {
        settled = true;
        return "held";
      },
    );
    try {
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const successor = await final;
    expect(await pending).toBe("held");
    await expect(intermediate.reserveRuntime(heldBinding, heldIdentity)).rejects.toThrow();
    await expect(
      new PrismaRegistrationStore(db).reserve({
        grantId: randomUUID(),
        binding: heldBinding,
        expiresAt: Math.floor(Date.now() / 1000) + 30,
      }),
    ).rejects.toThrow();
    expect(
      await db.codexGuardianRuntime.count({ where: { ownerId: f.f.ownerId, buildId: h.buildId } }),
    ).toBe(0);
    expect(
      await db.codexGuardianOperationReceipt.count({
        where: { ownerId: f.f.ownerId, action: "authorization_retired" },
      }),
    ).toBe(1);
    expect((await f.reserve()).id).toBe(successor.id);
    const registration = new PrismaRegistrationStore(db),
      grantId = randomUUID();
    const generation = await registration.reserve({
      grantId,
      binding: f.newBinding,
      expiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    await registration.seal({ grantId, generation, grantDigest: hash(randomUUID()) });
    await expect(
      db.codexRegistrationGrant.update({
        where: { id: grantId },
        data: { binding: heldBinding as unknown as Prisma.InputJsonObject },
      }),
    ).rejects.toThrow();
    await expect(
      db.codexGuardianRuntime.update({ where: { id: successor.id }, data: { buildId: h.buildId } }),
    ).rejects.toThrow();
  });
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
    const registered = await db.codexHostRegistration.findFirstOrThrow({
      where: { ownerId: f.f.ownerId, buildId: f.newBinding.buildId },
    });
    await expect(
      db.codexHostRegistration.update({
        where: { id: registered.id },
        data: { buildId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      db.codexHostRegistration.update({
        where: { id: registered.id },
        data: {
          binding: { ...f.newBinding, buildId: randomUUID() } as unknown as Prisma.InputJsonObject,
        },
      }),
    ).rejects.toThrow();

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
