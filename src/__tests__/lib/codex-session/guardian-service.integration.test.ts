import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  GUARDIAN_METADATA_POLICY_DIGEST,
  type GuardianPackagePin,
  type GuardianPolicy,
  guardianDigest,
  preparationDigest,
} from "@/lib/codex-session/guardian-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import {
  GUARDIAN_MAX_OPERATION_RECEIPTS,
  GuardianAdmissionStore,
} from "@/lib/codex-session/guardian-store.server";
import {
  type GuardianIdentityResponse,
  guardianIdentityProofPayload,
  guardianRuntimeIdentitySchema,
  guardianTransportProofPayload,
} from "@/lib/codex-session/guardian-transport-contracts";
import type { VerifiedHostBinding } from "@/lib/codex-session/registration.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { ProjectTaskIntents } from "@/lib/projects/task-intents.server";
import { guardianFixture } from "./guardian-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.pathname !== "/hive_delivery_test")
    throw new Error("Isolated fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture(
  patch?: (packet: GuardianIdentityResponse) => void,
  transformGrant?: (grant: string, service: GuardianService, key: KeyObject) => Promise<string>,
  onProvisionStage?: (
    stage: import("@/lib/codex-session/guardian-service.server").GuardianProvisionStage,
  ) => void,
  options?: {
    now?: number;
    nowFn?: () => number;
    clockWait?: (delay: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    corruptProof?: boolean;
    recoverEmptyClose?: (grant: string) => Promise<unknown>;
  },
) {
  const issuer = generateKeyPairSync("ed25519"),
    outer = generateKeyPairSync("ed25519");
  const user = await db.user.create({
    data: {
      coderUrl: "https://guardian-coder.invalid",
      coderUserId: randomUUID(),
      username: "guardian-service-fixture",
      email: "fixture@invalid",
    },
  });
  const binding: VerifiedHostBinding = {
    coderOrigin: user.coderUrl,
    hiveUserId: user.id,
    ownerId: user.coderUserId,
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    buildId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://guardian-app.invalid",
    appId: randomUUID(),
  };
  const config = {
    privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: "guardian-fixture",
    hiveOrigin: "https://hive.invalid",
    softwareTemplateIds: [binding.templateId],
    appSlug: "codex-session",
    gatewayPort: 13341,
    cookieDomains: [],
  };
  const env = {
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "low",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
  };
  const pin: GuardianPackagePin = {
    packageManifestSha256: "1".repeat(64),
    guardianElfSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    protocol: "guardian-v1" as const,
    policyDigest: "4".repeat(64),
    metadataPolicyDigest: GUARDIAN_METADATA_POLICY_DIGEST,
  };
  const policy: GuardianPolicy = { enabled: true, producerEnabled: true, packages: [pin] };
  const configSha256 = guardianConfigSha256(
    expectedGuardianHostConfig({ ...binding, projects: [] }, config, env),
  );
  const identity = {
    lifetimeId: randomUUID(),
    bindingDigest: sha(
      JSON.stringify({
        schemaVersion: 1,
        configSha256,
        packageManifestSha256: pin.packageManifestSha256,
      }),
    ),
    outerPublicKeyPem: outer.publicKey.export({ type: "spki", format: "pem" }).toString(),
    packageManifestSha256: pin.packageManifestSha256,
    guardianElfSha256: pin.guardianElfSha256,
    nodeSha256: pin.nodeSha256,
    policyDigest: pin.policyDigest,
    metadataPolicyDigest: pin.metadataPolicyDigest,
    configSha256,
  };
  const bootId = randomUUID(),
    kernel = { startTime: "100", bootId, executable: "/usr/bin/node", device: "123", inode: "456" };
  let service: GuardianService,
    grant = "",
    enrollment: unknown,
    runtimeId = "",
    resolutions = 0;
  const principal = { hiveUserId: user.id, coderUserId: user.coderUserId };
  const signFrame = (body: Record<string, unknown>, privateKey = outer.privateKey) => ({
    ...body,
    proof: sign(
      null,
      Buffer.from(guardianTransportProofPayload(body as never)),
      privateKey,
    ).toString("base64url"),
  });
  service = new GuardianService(db, config, policy, "19".repeat(32), {
    env,
    onProvisionStage,
    now: options?.nowFn ?? (options?.now === undefined ? undefined : () => options.now!),
    clockWait: options?.clockWait,
    signal: options?.signal,
    resolveWorkspace: async (p) => {
      resolutions++;
      expect(p).toEqual(principal);
      return structuredClone(binding);
    },
    transport: {
      async identity(b, nonce) {
        expect(b).toEqual(binding);
        const packet: GuardianIdentityResponse = {
          schemaVersion: 1 as const,
          nonce,
          issuedAt: Date.now() - 100,
          expiresAt: Date.now() + 30000,
          identity,
          startup: {
            schemaVersion: 1,
            type: "ready",
            phase: "open",
            nonce: Buffer.alloc(32).toString("base64url"),
            configSha256,
            packageManifestSha256: pin.packageManifestSha256,
            nodeSha256: pin.nodeSha256,
            workerSha256: "a".repeat(64),
            guardianSha256: pin.guardianElfSha256,
            port: 13341,
            lifetimeId: identity.lifetimeId,
            bindingDigest: identity.bindingDigest,
            generation: 1,
            ownershipDigest: "b".repeat(64),
            projects: [],
            outerIdentity: { ...kernel, pid: 100, parentPid: 99 },
            guardianIdentity: {
              ...kernel,
              pid: 101,
              parentPid: 100,
              executable: "/package/codex-native-guardian",
              inode: "457",
            },
            workerIdentity: { ...kernel, pid: 102, parentPid: 101 },
          },
          proof: "A".repeat(86),
        };
        patch?.(packet);
        packet.proof = sign(
          null,
          Buffer.from(guardianIdentityProofPayload(packet)),
          outer.privateKey,
        ).toString("base64url");
        if (options?.corruptProof) packet.proof = "A".repeat(86);
        return packet;
      },
      async recoverEmptyClose(_binding, grant) {
        return options?.recoverEmptyClose ? options.recoverEmptyClose(grant) : { accepted: true };
      },
      async bootstrap(_binding, value) {
        if (transformGrant) value = await transformGrant(value, service, issuer.privateKey);
        grant = value;
        const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
        runtimeId = claims.runtimeId;
        enrollment = signFrame({
          schemaVersion: 1,
          action: "enroll",
          runtimeId,
          eventId: randomUUID(),
          issuedAt: Date.now() - 100,
          expiresAt: Date.now() + 30000,
          grant: value,
        });
        return service.execute(enrollment);
      },
    },
  });
  return {
    service,
    principal,
    binding,
    identity,
    policy,
    outer,
    user,
    signFrame,
    get grant() {
      return grant;
    },
    get enrollment() {
      return enrollment;
    },
    get runtimeId() {
      return runtimeId;
    },
    get resolutions() {
      return resolutions;
    },
  };
}
async function operationFixture(options?: Parameters<typeof fixture>[3]) {
  const f = await fixture(undefined, undefined, undefined, options);
  const opened = await f.service.provision(f.principal, f.binding.workspaceId);
  const project = await db.deliveryProject.create({
    data: {
      ownerId: f.user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "owner/receipt-fixture",
    },
  });
  const taskId = randomUUID(),
    requestId = randomUUID(),
    hostRequest = {
      schemaVersion: 1 as const,
      projectId: project.id,
      repositoryId: "123",
      expectedAccountId: "456",
      taskId,
      requestId,
      revision: "a".repeat(40),
      model: "gpt-6.1-sol",
      effort: "low",
      text: "Private receipt fixture prompt",
    };
  await new ProjectTaskIntents(db, "19".repeat(32)).enqueue({
    ownerId: f.user.id,
    projectId: project.id,
    workspaceId: f.binding.workspaceId,
    taskId,
    requestId,
    requestDigest: sha(randomUUID()),
    hostRequest,
  });
  const preparation = {
    schemaVersion: 1 as const,
    stage: "preparation" as const,
    ownerId: f.binding.ownerId,
    workspaceId: f.binding.workspaceId,
    buildId: f.binding.buildId,
    projectId: project.id,
    repositoryId: "123",
    providerAccountId: "456",
    taskId,
    requestId,
    baseSha: hostRequest.revision,
    requestDigest: sha(JSON.stringify(hostRequest)),
  };
  const frame = (
    action: string,
    fields: Record<string, unknown>,
    generation = 1,
  ): Record<string, unknown> =>
    f.signFrame({
      schemaVersion: 1,
      runtimeId: opened.runtimeId,
      runtimeGeneration: generation,
      action,
      eventId: randomUUID(),
      issuedAt: Date.now() - 1,
      expiresAt: Date.now() + 30000,
      ...fields,
    });
  const prepare = frame("prepare", {
    preparation,
    preparationDigest: preparationDigest(preparation),
  });
  const readback = (
    originalRequest: Record<string, unknown>,
    patch: Record<string, unknown> = {},
  ) =>
    frame(
      "operation_readback",
      {
        nonce: sha(randomUUID()),
        lifetimeId: f.identity.lifetimeId,
        configSha256: f.identity.configSha256,
        originalRequest,
        ...patch,
      },
      originalRequest.runtimeGeneration as number,
    );
  const checkout = {
    projectId: project.id,
    preparationIntentId: taskId,
    repositoryId: "123",
    revision: hostRequest.revision,
    leaseId: randomUUID(),
    leaseGeneration: 1,
    checkoutIncarnation: randomUUID(),
    checkoutIdentity: { device: "123", inode: "456" },
  };
  return { ...f, project, taskId, frame, prepare, readback, checkout, preparation };
}
describe.skipIf(!url)("committed guardian operation receipts / actual PostgreSQL", () => {
  it("records exact prepare/checkout/fence responses atomically and reads historical facts without authority extension", async () => {
    const f = await operationFixture(),
      prepared = await f.service.execute(f.prepare),
      checkoutFrame = f.frame("checkout", { checkout: f.checkout }, 2),
      checked = await f.service.execute(checkoutFrame),
      fenceFrame = f.frame(
        "fence",
        {
          projectId: f.project.id,
          preparationDigest: (f.prepare as Record<string, unknown>).preparationDigest,
        },
        2,
      ),
      fenced = await f.service.execute(fenceFrame);
    for (const [original, result] of [
      [f.prepare, prepared],
      [checkoutFrame, checked],
      [fenceFrame, fenced],
    ] as const) {
      expect(await f.service.execute(original)).toEqual(result);
      const request = f.readback(original),
        receipt = await f.service.execute(request);
      expect(receipt).toMatchObject({
        accepted: true,
        historical: true,
        executionAuthorized: false,
        nonce: request.nonce,
        runtimeId: f.runtimeId,
        eventId: original.eventId,
        requestDigest: guardianDigest(original),
        action: original.action,
        inputRuntimeGeneration: original.runtimeGeneration,
        result,
      });
    }
    const before = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    await db.projectTaskIntent.update({ where: { id: f.taskId }, data: { phase: "blocked" } });
    await db.codexGuardianRuntime.update({
      where: { id: f.runtimeId },
      data: { authorityUntil: new Date(Date.now() - 1) },
    });
    const expired = { ...f.prepare, issuedAt: Date.now() - 120000, expiresAt: Date.now() - 90000 };
    // The original signature is part of the digest: altered historical timestamps
    // cannot stand in for the actual committed frame.
    await expect(f.service.execute(f.readback(expired))).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    const after = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    expect(await f.service.execute(f.readback(f.prepare))).toMatchObject({ result: prepared });
    expect(await f.service.execute(f.prepare)).toEqual(prepared);
    expect(await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).toEqual(
      after,
    );
    expect(after.generation).toBe(before.generation);
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtimeId } }),
    ).toBe(3);
  });
  it("rejects original-envelope collisions, missing receipts, wrong signatures and changed lifetime/config bindings", async () => {
    const f = await operationFixture();
    await expect(f.service.execute(f.readback(f.prepare))).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    await f.service.execute(f.prepare);
    const changed = f.signFrame({
      ...f.prepare,
      proof: undefined,
      expiresAt: Number(f.prepare.expiresAt) + 1,
    });
    await expect(f.service.execute(f.readback(changed))).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    await expect(f.service.execute(changed)).rejects.toBeInstanceOf(RegistrationRejected);
    for (const patch of [
      { lifetimeId: randomUUID() },
      { configSha256: "f".repeat(64) },
      { runtimeGeneration: 2 },
      { originalRequest: { ...f.prepare, proof: "A".repeat(86) } },
    ])
      await expect(f.service.execute(f.readback(f.prepare, patch))).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtimeId } }),
    ).toBe(1);
  });
  it("cannot retrofit receipts onto a pre-migration held lifetime", async () => {
    const f = await operationFixture();
    // Simulate the additive migration's false default on an existing lifetime.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.codexGuardianRuntime.update({
        where: { id: f.runtimeId },
        data: { operationReceiptsEnabled: false },
      });
    });
    await f.service.execute(f.prepare);
    await expect(f.service.execute(f.readback(f.prepare))).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtimeId } }),
    ).toBe(0);
    await expect(
      db.codexGuardianRuntime.update({
        where: { id: f.runtimeId },
        data: { operationReceiptsEnabled: true },
      }),
    ).rejects.toThrow();
  });
  it("records native finalization in its mutation transaction and replays facts after registration revocation", async () => {
    let original: Record<string, unknown> = {};
    const f = await guardianFixture(db, {
      workspaceEnrollment: true,
      nativeReceipt: (input, key) => {
        const body = {
          schemaVersion: 1 as const,
          runtimeId: input.runtimeId,
          runtimeGeneration: input.runtimeGeneration,
          action: "native" as const,
          eventId: randomUUID(),
          issuedAt: Date.now() - 1,
          expiresAt: Date.now() + 30000,
          projectId: input.scope.projectId,
          registrationId: input.scope.registrationId,
          managerThreadId: input.scope.managerThreadId,
          metadata: input.metadata,
        };
        original = {
          ...body,
          proof: sign(null, Buffer.from(guardianTransportProofPayload(body)), key).toString(
            "base64url",
          ),
        };
        return {
          ownerId: input.scope.hiveUserId,
          runtimeId: input.runtimeId,
          eventId: body.eventId,
          action: "native",
          inputRuntimeGeneration: input.runtimeGeneration,
          requestDigest: guardianDigest(original),
        };
      },
    });
    const service = new GuardianService(
      db,
      f.guardian.sessionConfig,
      f.guardian.policy,
      "19".repeat(32),
      {
        env: {
          HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
          HIVE_CODEX_MANAGER_EFFORT: "low",
          HIVE_DELIVERY_MANAGER_ENABLED: "true",
        },
        resolveWorkspace: async () => f.host,
      },
    );
    const stored = await db.codexGuardianOperationReceipt.findFirstOrThrow({
      where: { runtimeId: f.guardian.runtime.id },
    });
    expect(stored.response).toEqual(f.guardian.finalized);
    expect(stored.resultAdmissionGeneration).toBe(3);
    await db.codexHostRegistration.update({
      where: { id: f.registration().id },
      data: { revokedAt: new Date() },
    });
    expect(await service.execute(original)).toEqual(stored.response);
    const body = {
      schemaVersion: 1,
      runtimeId: f.guardian.runtime.id,
      runtimeGeneration: 2,
      action: "operation_readback",
      eventId: randomUUID(),
      issuedAt: Date.now() - 1,
      expiresAt: Date.now() + 30000,
      nonce: sha(randomUUID()),
      lifetimeId: f.guardian.runtime.lifetimeId,
      configSha256: f.guardian.runtime.configSha256,
      originalRequest: original,
    };
    const readback = {
      ...body,
      proof: sign(
        null,
        Buffer.from(guardianTransportProofPayload(body as never)),
        f.guardian.outer.privateKey,
      ).toString("base64url"),
    };
    expect(await service.execute(readback)).toMatchObject({
      historical: true,
      executionAuthorized: false,
      result: stored.response,
    });
    await expect(
      f.guardian.store.fence({
        ownerId: f.user.id,
        runtimeId: f.guardian.runtime.id,
        runtimeGeneration: 2,
        projectId: f.project.id,
        preparationDigest: f.guardian.prepared.admission.preparationDigest,
      }),
    ).rejects.toBeInstanceOf(RegistrationRejected);
  });
  it("reads an actually expired original frame using only a fresh signed challenge", async () => {
    const f = await operationFixture();
    const expiresAt = Date.now() + 250;
    const original = f.signFrame({ ...f.prepare, proof: undefined, expiresAt });
    const result = await f.service.execute(original);
    await new Promise((done) => setTimeout(done, expiresAt - Date.now() + 20));
    await expect(f.service.execute(original)).rejects.toBeInstanceOf(RegistrationRejected);
    const before = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    expect(await f.service.execute(f.readback(original))).toMatchObject({ result });
    expect(await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).toEqual(
      before,
    );
  });
  it.each([
    "deadline",
    "abort",
  ])("rolls back both receipt and preparation on %s during receipt insertion", async (mode) => {
    const controller = new AbortController();
    const f = await operationFixture({ signal: controller.signal }),
      name = `receipt_delay_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${name}',true); PERFORM pg_sleep(0.4); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} AFTER INSERT ON codex_guardian_operation_receipts FOR EACH ROW WHEN(NEW.runtime_id='${f.runtimeId}'::uuid) EXECUTE FUNCTION ${name}()`,
    );
    try {
      const request = f.signFrame({
        ...f.prepare,
        proof: undefined,
        expiresAt: Date.now() + (mode === "deadline" ? 200 : 30000),
      });
      const pending = f.service.execute(request);
      void pending.catch(() => {});
      await waitForDatabaseSleep(name);
      if (mode === "abort") controller.abort(new Error("cancelled_receipt"));
      if (mode === "deadline") await expect(pending).rejects.toBeInstanceOf(RegistrationRejected);
      else await expect(pending).rejects.toThrow("cancelled_receipt");
      expect(
        await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtimeId } }),
      ).toBe(0);
      expect(await db.codexGuardianAdmission.count({ where: { runtimeId: f.runtimeId } })).toBe(0);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } }))
          .generation,
      ).toBe(1);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_operation_receipts`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
  });
  it("concurrent exact requests cannot duplicate admission or manufacture a second receipt", async () => {
    const f = await operationFixture();
    const results = await Promise.allSettled([
      f.service.execute(f.prepare),
      f.service.execute(f.prepare),
    ]);
    const first = results.find((result) => result.status === "fulfilled");
    expect(first?.status).toBe("fulfilled");
    if (first?.status !== "fulfilled") throw new Error("No committed receipt");
    // A serializable loser may be rejected; a subsequent exact request reads the
    // winner's original result before its now-obsolete input generation check.
    expect(await f.service.execute(f.prepare)).toEqual(first.value);
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtimeId } }),
    ).toBe(1);
    expect(await db.codexGuardianAdmission.count({ where: { runtimeId: f.runtimeId } })).toBe(1);
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).generation,
    ).toBe(2);
  });
  it("bounds pool wait and transaction timeout by the remaining signed frame lifetime", async () => {
    const f = await operationFixture();
    const expiresAt = Date.now() + 1500;
    let observed: { timeout: number; maxWait: number } | undefined;
    const recording = {
      $transaction: (
        callback: (tx: unknown) => Promise<unknown>,
        options: { timeout: number; maxWait: number },
      ) => {
        observed = options;
        return db.$transaction(callback, options);
      },
    } as unknown as PrismaClient;
    const store = new GuardianAdmissionStore(recording, {
      policy: f.policy,
      encryptionKey: "19".repeat(32),
      authorizationExpiresAt: expiresAt,
      expectedConfigSha256: () => f.identity.configSha256,
    });
    await store.prepare({
      ownerId: f.user.id,
      runtimeId: f.runtimeId,
      runtimeGeneration: 1,
      preparation: f.preparation,
      preparationDigest: preparationDigest(f.preparation),
    });
    expect(observed?.timeout).toBeGreaterThan(0);
    expect(observed?.timeout).toBeLessThanOrEqual(1500);
    expect(observed?.maxWait).toBeGreaterThan(0);
    expect(observed?.maxWait).toBeLessThanOrEqual(1500);
    expect(Number(observed?.timeout) + Number(observed?.maxWait)).toBeLessThanOrEqual(1500);
  });
  it("holds new operations on durable receipt exhaustion while retaining every exact receipt and readback", async () => {
    const f = await operationFixture();
    const prepared = await f.service.execute(f.prepare);
    await db.$executeRaw`
      INSERT INTO codex_guardian_operation_receipts(owner_id,runtime_id,event_id,action,request_digest,
        input_runtime_generation,result_runtime_generation,result_admission_generation,response,response_digest,
        lifetime_id,build_id,config_sha256,outer_key_fingerprint)
      SELECT owner_id,runtime_id,gen_random_uuid(),action,request_digest,input_runtime_generation,result_runtime_generation,
        result_admission_generation,response,response_digest,lifetime_id,build_id,config_sha256,outer_key_fingerprint
      FROM codex_guardian_operation_receipts CROSS JOIN generate_series(1,${GUARDIAN_MAX_OPERATION_RECEIPTS - 1})
      WHERE runtime_id=${f.runtimeId}::uuid`;
    const before = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    const fence = f.frame(
      "fence",
      { projectId: f.project.id, preparationDigest: f.prepare.preparationDigest },
      2,
    );
    await expect(f.service.execute(fence)).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(f.service.execute(f.readback(fence))).rejects.toBeInstanceOf(RegistrationRejected);
    expect(await f.service.execute(f.prepare)).toEqual(prepared);
    expect(await f.service.execute(f.readback(f.prepare))).toMatchObject({ result: prepared });
    expect(await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).toEqual(
      before,
    );
    expect(
      await db.codexGuardianOperationReceipt.count({ where: { runtimeId: f.runtimeId } }),
    ).toBe(GUARDIAN_MAX_OPERATION_RECEIPTS);
  });
  it("retains immutable bounded receipts with append-only privileges for installed runtime roles", async () => {
    const f = await operationFixture();
    await f.service.execute(f.prepare);
    await expect(
      db.codexGuardianOperationReceipt.updateMany({
        where: { runtimeId: f.runtimeId },
        data: { requestDigest: "a".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      db.codexGuardianOperationReceipt.deleteMany({ where: { runtimeId: f.runtimeId } }),
    ).rejects.toThrow();
    const saved = await db.codexGuardianOperationReceipt.findFirstOrThrow({
      where: { runtimeId: f.runtimeId },
    });
    await expect(
      db.codexGuardianOperationReceipt.create({
        data: {
          ...saved,
          eventId: randomUUID(),
          response: { ...(saved.response as Record<string, string>), oversize: "x".repeat(65537) },
        },
      }),
    ).rejects.toThrow();
    const roles = await db.$queryRaw<
      { rolname: string }[]
    >`SELECT rolname FROM pg_roles WHERE rolname IN ('hive_app_runtime','hive_native_runtime')`;
    for (const { rolname } of roles) {
      const [privileges] = await db.$queryRaw<
        { read: boolean; append: boolean; mutate: boolean; remove: boolean }[]
      >`SELECT
        has_table_privilege(${rolname},'codex_guardian_operation_receipts','SELECT') AS read,
        has_table_privilege(${rolname},'codex_guardian_operation_receipts','INSERT') AS append,
        has_table_privilege(${rolname},'codex_guardian_operation_receipts','UPDATE') AS mutate,
        has_table_privilege(${rolname},'codex_guardian_operation_receipts','DELETE') AS remove`;
      expect(privileges).toEqual({ read: true, append: true, mutate: false, remove: false });
    }
  });
});
describe.skipIf(!url)("signed guardian bootstrap/service, actual local PostgreSQL", () => {
  it.each([
    "refresh",
    "still_future",
    "too_far",
    "cancel",
  ])("resamples a fresh signed transport clock without accepting future authority: %s", async (scenario) => {
    let current = Date.now();
    const waits: number[] = [],
      controller = new AbortController();
    const f = await fixture(undefined, undefined, undefined, {
      nowFn: () => current,
      signal: controller.signal,
      clockWait: async (delay) => {
        waits.push(delay);
        if (scenario === "cancel") controller.abort(new Error("transport_clock_cancelled"));
        if (scenario === "refresh") {
          await new Promise((done) => setTimeout(done, delay));
          current = Date.now();
        }
      },
    });
    await f.service.provision(f.principal, f.binding.workspaceId);
    current = Date.now();
    const before = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    const input = f.signFrame({
      schemaVersion: 1,
      action: "drain_ready",
      runtimeId: f.runtimeId,
      runtimeGeneration: 1,
      eventId: randomUUID(),
      issuedAt: current + (scenario === "too_far" ? 2000 : 100),
      expiresAt: current + 5000,
    });
    if (scenario === "refresh") {
      expect(await f.service.execute(input)).toMatchObject({ ready: false });
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBe(0);
      expect(waits[1]).toBeGreaterThan(0);
      expect(current).toBeGreaterThanOrEqual(Number((input as Record<string, unknown>).issuedAt));
    } else if (scenario === "cancel")
      await expect(f.service.execute(input)).rejects.toThrow("transport_clock_cancelled");
    else await expect(f.service.execute(input)).rejects.toBeInstanceOf(RegistrationRejected);
    expect(await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).toEqual(
      before,
    );
  });
  it("recovers only the exact committed enrollment as read-only historical evidence", async () => {
    let now = Date.now();
    const f = await fixture(undefined, undefined, undefined, { nowFn: () => now });
    const opened = await f.service.provision(f.principal, f.binding.workspaceId);
    const original = f.enrollment as { grant: string; runtimeId: string };
    const claims = JSON.parse(Buffer.from(original.grant.split(".")[1], "base64url").toString());
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: opened.runtimeId },
    });
    const grantsBefore = await db.codexGuardianEnrollmentGrant.count({
      where: { runtimeId: runtime.id },
    });
    now += 120000; // Original frame and grant are historical; only readback is fresh.
    const body = {
      schemaVersion: 1,
      action: "enrollment_readback",
      runtimeId: runtime.id,
      runtimeGeneration: 1,
      eventId: randomUUID(),
      issuedAt: now - 1,
      expiresAt: now + 30000,
      nonce: "a".repeat(64),
      grantId: claims.jti,
      tokenDigest: sha(original.grant),
      consumptionDigest: guardianDigest(original),
      identityDigest: claims.identityDigest,
      lifetimeId: claims.lifetimeId,
      configSha256: runtime.configSha256,
      startupDigest: claims.startupDigest,
      originalEnrollment: original,
    };
    const expected = {
      accepted: true,
      runtimeId: runtime.id,
      runtimeGeneration: 1,
      nonce: body.nonce,
      grantId: body.grantId,
      tokenDigest: body.tokenDigest,
      consumptionDigest: body.consumptionDigest,
      identityDigest: body.identityDigest,
      lifetimeId: body.lifetimeId,
      configSha256: body.configSha256,
      startupDigest: body.startupDigest,
      enrolledAt: runtime.enrolledAt!.getTime(),
      authorityUntil: runtime.authorityUntil.getTime(),
      empty: true,
    };
    expect(await f.service.execute(f.signFrame(body))).toEqual(expected);
    expect(await f.service.execute(f.signFrame(body))).toEqual(expected);
    await expect(
      f.service.execute(f.signFrame({ ...body, consumptionDigest: "0".repeat(64) })),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    await expect(
      f.service.execute(f.signFrame({ ...body, startupDigest: "0".repeat(64) })),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { runtimeId: runtime.id } })).toBe(
      grantsBefore,
    );
    const after = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: runtime.id } });
    expect(after.authorityUntil).toEqual(runtime.authorityUntil);
    expect(after.enrolledAt).toEqual(runtime.enrolledAt);
  });

  it("requires explicit owner authority to fence an expired empty runtime", async () => {
    let recoveryGrant = "";
    const f = await fixture(undefined, undefined, undefined, {
      recoverEmptyClose: async (grant) => {
        recoveryGrant = grant;
        return { accepted: true };
      },
    });
    const opened = await f.service.provision(f.principal, f.binding.workspaceId);
    const past = new Date(Date.now() - 181000);
    // Local superuser fixture advances retained timestamps without waiting three minutes.
    // SET LOCAL is confined to this transaction; production never bypasses triggers.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.codexGuardianRuntime.update({
        where: { id: opened.runtimeId },
        data: { enrolledAt: past, authorityUntil: new Date(past.getTime() + 180000) },
      });
      await tx.codexGuardianEnrollmentGrant.updateMany({
        where: { runtimeId: opened.runtimeId },
        data: { consumedAt: past },
      });
    });
    const close = {
      schemaVersion: 1,
      action: "close",
      runtimeId: opened.runtimeId,
      runtimeGeneration: 1,
      eventId: randomUUID(),
      issuedAt: Date.now() - 1,
      expiresAt: Date.now() + 30000,
      barrierId: randomUUID(),
      ownershipDigest: "b".repeat(64),
      projectBindings: [],
      snapshots: [],
    };
    await expect(f.service.execute(f.signFrame(close))).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    expect(
      await f.service.recoverExpiredEmpty(f.principal, f.binding.workspaceId, opened.runtimeId),
    ).toEqual({ accepted: true, treeExited: false, cleanupAuthorized: false });
    expect(recoveryGrant).not.toBe("");
    const signed = f.signFrame({ ...close, emptyCloseGrant: recoveryGrant });
    const accepted = await f.service.execute(signed);
    expect(accepted).toMatchObject({
      runtimeId: opened.runtimeId,
      runtimeGeneration: 2,
      barrierId: close.barrierId,
      treeExited: false,
      cleanupAuthorized: false,
    });
    expect(await f.service.execute(signed)).toEqual(accepted);
    await expect(
      f.service.execute(
        f.signFrame({ ...close, barrierId: randomUUID(), emptyCloseGrant: recoveryGrant }),
      ),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: opened.runtimeId },
    });
    expect(runtime.phase).toBe("barrier_closed");
    const receipts = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS count FROM codex_guardian_tree_receipts WHERE runtime_id=${runtime.id}::uuid`;
    expect(receipts[0].count).toBe(BigInt(0));
  });
  it("expiry during an observed row-lock wait rolls back empty closure but permits exact historical replay", async () => {
    let clockOffset = 0,
      recoveryGrant = "";
    const f = await fixture(undefined, undefined, undefined, {
      nowFn: () => Date.now() + clockOffset,
      recoverEmptyClose: async (grant) => {
        recoveryGrant = grant;
        return { accepted: true };
      },
    });
    const opened = await f.service.provision(f.principal, f.binding.workspaceId),
      past = new Date(Date.now() - 181000);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.codexGuardianRuntime.update({
        where: { id: opened.runtimeId },
        data: { enrolledAt: past, authorityUntil: new Date(past.getTime() + 180000) },
      });
      await tx.codexGuardianEnrollmentGrant.updateMany({
        where: { runtimeId: opened.runtimeId },
        data: { consumedAt: past },
      });
    });
    const issueShortGrant = async () => {
      // Exercise real expiration without waiting a minute. All verification and
      // database transaction checks run against the actual clock afterward.
      clockOffset = -57000;
      try {
        await f.service.recoverExpiredEmpty(f.principal, f.binding.workspaceId, opened.runtimeId);
      } finally {
        clockOffset = 0;
      }
      return (
        JSON.parse(Buffer.from(recoveryGrant.split(".")[1], "base64url").toString()).exp * 1000
      );
    };
    const grantExpiresAt = await issueShortGrant(),
      close = {
        schemaVersion: 1,
        action: "close",
        runtimeId: opened.runtimeId,
        runtimeGeneration: 1,
        eventId: randomUUID(),
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 30000,
        barrierId: randomUUID(),
        ownershipDigest: "b".repeat(64),
        projectBindings: [],
        snapshots: [],
      };
    let release!: () => void, acquired!: (pid: number) => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
      }),
      locked = new Promise<number>((resolve) => {
        acquired = resolve;
      }),
      blocker = db.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await tx.$queryRaw`SELECT id FROM codex_guardian_runtimes WHERE id=${opened.runtimeId}::uuid FOR UPDATE`;
          acquired(row.pid);
          await released;
        },
        { timeout: 10000 },
      );
    void blocker.catch(() => {});
    try {
      const pid = await locked,
        pending = f.service.execute(f.signFrame({ ...close, emptyCloseGrant: recoveryGrant }));
      void pending.catch(() => {});
      let observed = false;
      for (let n = 0; n < 200; n++) {
        const [row] = await db.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
        if (row.n > 0) {
          observed = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 5));
      }
      expect(observed).toBe(true);
      expect(Date.now()).toBeLessThan(grantExpiresAt);
      await new Promise((done) => setTimeout(done, grantExpiresAt - Date.now() + 30));
      release();
      await blocker;
      await expect(pending).rejects.toBeInstanceOf(RegistrationRejected);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: opened.runtimeId } }))
          .phase,
      ).toBe("open");
      expect(await db.codexGuardianBarrier.count({ where: { runtimeId: opened.runtimeId } })).toBe(
        0,
      );
    } finally {
      release();
      await blocker;
    }
    const replayGrantExpiresAt = await issueShortGrant(),
      signed = f.signFrame({ ...close, emptyCloseGrant: recoveryGrant }),
      accepted = await f.service.execute(signed);
    await new Promise((done) => setTimeout(done, replayGrantExpiresAt - Date.now() + 30));
    expect(Date.now()).toBeLessThan(close.expiresAt);
    expect(await f.service.execute(signed)).toEqual(accepted);
    await expect(
      f.service.execute(
        f.signFrame({
          ...close,
          barrierId: randomUUID(),
          emptyCloseGrant: recoveryGrant,
        }),
      ),
    ).rejects.toBeInstanceOf(RegistrationRejected);
  }, 15000);
  it("reports trusted transport, identity validation and reservation boundaries", async () => {
    const stages: string[] = [];
    const transportFailure = await fixture(
      () => {
        throw new RegistrationRejected();
      },
      undefined,
      (stage) => stages.push(stage),
    );
    await expect(
      transportFailure.service.provision(
        transportFailure.principal,
        transportFailure.binding.workspaceId,
      ),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    expect(stages.at(-1)).toBe("guardian_identity_transport");
    stages.length = 0;
    const invalidIdentity = await fixture(
      (packet) => {
        packet.startup.workerIdentity.parentPid = 999;
      },
      undefined,
      (stage) => stages.push(stage),
    );
    await expect(
      invalidIdentity.service.provision(
        invalidIdentity.principal,
        invalidIdentity.binding.workspaceId,
      ),
    ).rejects.toBeInstanceOf(RegistrationRejected);
    expect(stages.at(-1)).toBe("guardian_identity_process");
    stages.length = 0;
    const reservationFailure = await fixture(undefined, undefined, (stage) => stages.push(stage));
    const reserve = vi
      .spyOn(GuardianAdmissionStore.prototype, "reserveRuntime")
      .mockRejectedValueOnce(new RegistrationRejected());
    try {
      await expect(
        reservationFailure.service.provision(
          reservationFailure.principal,
          reservationFailure.binding.workspaceId,
        ),
      ).rejects.toBeInstanceOf(RegistrationRejected);
      expect(stages.at(-1)).toBe("guardian_runtime_reservation");
    } finally {
      reserve.mockRestore();
    }
  });
  it("reports granular identity failures without changing rejection semantics", async () => {
    const now = 1_800_000_000_000;
    const cases: Array<{
      stage: string;
      patch: (packet: GuardianIdentityResponse) => void;
      corruptProof?: boolean;
    }> = [
      {
        stage: "future",
        patch: (p) => {
          p.issuedAt = now + 1;
          p.expiresAt = now + 1000;
        },
      },
      {
        stage: "expired",
        patch: (p) => {
          p.issuedAt = now - 1000;
          p.expiresAt = now;
        },
      },
      {
        stage: "bounds",
        patch: (p) => {
          p.issuedAt = now - 60000;
          p.expiresAt = now + 1;
        },
      },
      {
        stage: "nonce",
        patch: (p) => {
          p.issuedAt = now - 1;
          p.expiresAt = now + 1000;
          p.nonce = "0".repeat(64);
        },
      },
      {
        stage: "pins",
        patch: (p) => {
          p.issuedAt = now - 1;
          p.expiresAt = now + 1000;
          p.identity.nodeSha256 = "9".repeat(64);
        },
      },
      {
        stage: "signature",
        patch: (p) => {
          p.issuedAt = now - 1;
          p.expiresAt = now + 1000;
        },
        corruptProof: true,
      },
      {
        stage: "config",
        patch: (p) => {
          p.issuedAt = now - 1;
          p.expiresAt = now + 1000;
          p.identity.configSha256 = "9".repeat(64);
        },
      },
    ];
    for (const item of cases) {
      const stages: string[] = [];
      const f = await fixture(item.patch, undefined, (stage) => stages.push(stage), {
        now,
        corruptProof: item.corruptProof,
      });
      await expect(f.service.provision(f.principal, f.binding.workspaceId)).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
      expect(stages.at(-1)).toBe(`guardian_identity_${item.stage}`);
    }
  });
  it("resamples the clock without accepting future identities or bypassing cancellation", async () => {
    const base = 1_800_000_000_000;
    for (const scenario of [
      "refresh",
      "wait",
      "too_far",
      "frozen",
      "cancel",
      "expired",
      "nonce",
      "signature",
    ] as const) {
      let current = base;
      const waits: number[] = [];
      const stages: string[] = [];
      const controller = new AbortController();
      const f = await fixture(
        (p) => {
          p.issuedAt = base + (scenario === "too_far" ? 1001 : 100);
          p.expiresAt = base + (scenario === "expired" ? 100 : 30000);
          if (scenario === "nonce") p.nonce = "0".repeat(64);
        },
        undefined,
        (stage) => stages.push(stage),
        {
          nowFn: () => current,
          signal: controller.signal,
          corruptProof: scenario === "signature",
          clockWait: async (delay) => {
            waits.push(delay);
            if (["refresh", "expired", "nonce", "signature"].includes(scenario))
              current = base + 100;
            if (scenario === "wait" && delay > 0) current = base + 101;
            if (scenario === "cancel") controller.abort(new Error("cancelled"));
          },
        },
      );
      const reserve = vi
        .spyOn(GuardianAdmissionStore.prototype, "reserveRuntime")
        .mockRejectedValueOnce(new RegistrationRejected());
      try {
        const result = f.service.provision(f.principal, f.binding.workspaceId);
        if (scenario === "cancel") await expect(result).rejects.toThrow("cancelled");
        else await expect(result).rejects.toBeInstanceOf(RegistrationRejected);
        expect(waits).toEqual(scenario === "wait" || scenario === "frozen" ? [0, 101] : [0]);
        if (scenario === "refresh" || scenario === "wait") {
          expect(stages.at(-1)).toBe("guardian_runtime_reservation");
          expect(reserve).toHaveBeenCalledOnce();
        } else {
          expect(reserve).not.toHaveBeenCalled();
          expect(f.grant).toBe("");
          if (scenario === "too_far" || scenario === "frozen")
            expect(stages.at(-1)).toBe("guardian_identity_future");
          if (["expired", "nonce", "signature"].includes(scenario))
            expect(stages.at(-1)).toBe(`guardian_identity_${scenario}`);
        }
      } finally {
        reserve.mockRestore();
      }
    }
  });
  it("interrupts the real clock timer on cancellation before reservation", async () => {
    const base = 1_800_000_000_000;
    const controller = new AbortController();
    const f = await fixture(
      (p) => {
        p.issuedAt = base + 500;
        p.expiresAt = base + 30000;
      },
      undefined,
      (stage) => {
        if (stage === "guardian_identity_schema")
          setTimeout(() => controller.abort(new Error("cancelled")), 0);
      },
      { now: base, signal: controller.signal },
    );
    const reserve = vi.spyOn(GuardianAdmissionStore.prototype, "reserveRuntime");
    try {
      await expect(f.service.provision(f.principal, f.binding.workspaceId)).rejects.toThrow(
        "cancelled",
      );
      expect(reserve).not.toHaveBeenCalled();
      expect(f.grant).toBe("");
    } finally {
      reserve.mockRestore();
    }
  });
  it("fresh owner-app identity issues a one-use key/lifetime grant and records real enrollment", async () => {
    const f = await fixture();
    expect(await f.service.provision(f.principal, f.binding.workspaceId)).toMatchObject({
      enrolled: true,
    });
    expect(f.grant.split(".")).toHaveLength(3);
    const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } });
    expect(runtime.phase).toBe("open");
    expect(runtime.outerPublicKeyPem).toBe(f.identity.outerPublicKeyPem);
    const consumed = await db.codexGuardianEnrollmentGrant.findFirstOrThrow({
      where: { runtimeId: runtime.id },
    });
    expect(consumed.consumedAt).not.toBeNull();
    await expect(f.service.execute(f.enrollment)).rejects.toBeInstanceOf(RegistrationRejected);
    // Retry uses a fresh signed owner-app identity, not another enrollment grant,
    // and cannot extend runtime authority merely by provisioning again.
    expect(await f.service.provision(f.principal, f.binding.workspaceId)).toEqual({
      enrolled: true,
      runtimeId: runtime.id,
    });
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { runtimeId: runtime.id } })).toBe(
      1,
    );
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: runtime.id } }))
        .authorityUntil,
    ).toEqual(runtime.authorityUntil);
    const expired = new Date(Date.now() - 1000);
    await db.codexGuardianRuntime.update({
      where: { id: runtime.id },
      data: { authorityUntil: expired },
    });
    await expect(f.service.provision(f.principal, f.binding.workspaceId)).rejects.toBeInstanceOf(
      RegistrationRejected,
    );
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: runtime.id } }))
        .authorityUntil,
    ).toEqual(expired);
  });
  it("existing native enrollment cannot revive revoked producer or stale registered lifetime", async () => {
    for (const kind of [
      "producer",
      "registration_revoked",
      "registration_expired",
      "registration_replaced",
    ] as const) {
      const f = await guardianFixture(db),
        runtime = f.guardian.runtime;
      const identity = guardianRuntimeIdentitySchema.parse(
        Object.fromEntries(
          [
            "lifetimeId",
            "bindingDigest",
            "outerPublicKeyPem",
            "packageManifestSha256",
            "guardianElfSha256",
            "nodeSha256",
            "policyDigest",
            "metadataPolicyDigest",
            "configSha256",
          ].map((key) => [key, runtime[key as keyof typeof runtime]]),
        ),
      );
      const before = await f.guardian.store.reserveRuntime(f.host, identity);
      expect(before.phase).toBe("open");
      if (kind === "producer")
        await db.codexGuardianRuntime.update({
          where: { id: runtime.id },
          data: { producerApproved: false },
        });
      else if (kind === "registration_replaced") await f.register(randomUUID());
      else {
        const registered = await db.codexHostRegistration.findUniqueOrThrow({
          where: { id: f.registration().id },
        });
        await db.codexHostRegistration.update({
          where: { id: f.registration().id },
          data:
            kind === "registration_revoked"
              ? { revokedAt: new Date() }
              : { expiresAt: new Date(registered.registeredAt.getTime() + 1) },
        });
      }
      await expect(f.guardian.store.reserveRuntime(f.host, identity)).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
      const after = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: runtime.id } });
      expect(after.authorityUntil).toEqual(before.authorityUntil);
      if (kind === "producer") expect(after.producerApproved).toBe(false);
      expect(after.phase).toBe("open");
    }
  });
  it("signed host package/config echoes cannot approve an unlisted or wrong-scope runtime", async () => {
    for (const patch of [
      (p: GuardianIdentityResponse) => {
        p.identity.nodeSha256 = "f".repeat(64);
        p.startup.nodeSha256 = "f".repeat(64);
      },
      (p: GuardianIdentityResponse) => {
        p.identity.configSha256 = "f".repeat(64);
        p.startup.configSha256 = "f".repeat(64);
      },
      (p: GuardianIdentityResponse) => {
        p.startup.workerIdentity.parentPid = 999;
      },
    ]) {
      const f = await fixture(patch);
      await expect(f.service.provision(f.principal, f.binding.workspaceId)).rejects.toBeInstanceOf(
        RegistrationRejected,
      );
      expect(await db.codexGuardianRuntime.count({ where: { ownerId: f.user.id } })).toBe(0);
    }
  });
  it("forged outer proof fails before fresh Coder resolution and old grant cannot switch keys", async () => {
    const f = await fixture();
    await f.service.provision(f.principal, f.binding.workspaceId);
    const before = f.resolutions;
    const forged = { ...(f.enrollment as object), eventId: randomUUID(), proof: "A".repeat(86) };
    await expect(f.service.execute(forged)).rejects.toBeInstanceOf(RegistrationRejected);
    expect(f.resolutions).toBe(before);
    const attacker = generateKeyPairSync("ed25519");
    const switched = f.signFrame({ ...forged, grant: f.grant }, attacker.privateKey);
    await expect(f.service.execute(switched)).rejects.toBeInstanceOf(RegistrationRejected);
    expect(
      (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } }))
        .outerPublicKeyPem,
    ).toBe(f.identity.outerPublicKeyPem);
  });
  it("issuer-grant expiry during enrollment SQL update rolls back consumption even while frame remains live", async () => {
    const name = `guardian_enroll_${randomUUID().replaceAll("-", "")}`;
    let installed = false,
      grantExpiresAt = 0;
    const f = await fixture(undefined, async (original, service, key) => {
      const parts = original.split("."),
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      const now = Math.floor(Date.now() / 1000);
      claims.jti = randomUUID();
      claims.iat = now;
      claims.exp = now + 2;
      grantExpiresAt = claims.exp * 1000;
      const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const grant = `${parts[0]}.${body}.${sign(null, Buffer.from(`${parts[0]}.${body}`), key).toString("base64url")}`;
      await service.store.sealGrant({
        ownerId: claims.hiveUserId,
        runtimeId: claims.runtimeId,
        id: claims.jti,
        tokenDigest: sha(grant),
        bindingDigest: guardianDigest(claims),
        issuedAt: new Date(now * 1000),
        expiresAt: new Date(claims.exp * 1000),
      });
      if (!/^[a-f0-9-]{36}$/.test(claims.runtimeId)) throw new Error("Fixture identity rejected");
      await db.$executeRawUnsafe(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${name}',true); PERFORM pg_sleep(2.3); RETURN NEW; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW WHEN(NEW.id='${claims.runtimeId}'::uuid AND NEW.phase='open') EXECUTE FUNCTION ${name}()`,
      );
      installed = true;
      return grant;
    });
    try {
      const pending = f.service.provision(f.principal, f.binding.workspaceId).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForDatabaseSleep(name);
      expect(Date.now()).toBeLessThan(grantExpiresAt);
      const failure = await pending;
      expect(Date.now()).toBeGreaterThanOrEqual(grantExpiresAt);
      if (failure && typeof failure === "object" && "code" in failure)
        throw new Error(`unexpected_fixture_database_failure:${String(failure.code)}`);
      expect(failure).toBeInstanceOf(RegistrationRejected);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: f.runtimeId } })).phase,
      ).toBe("reserved");
      const grants = await db.codexGuardianEnrollmentGrant.findMany({
        where: { runtimeId: f.runtimeId },
      });
      expect(grants).toHaveLength(2);
      expect(grants.every((g) => !g.consumedAt)).toBe(true);
    } finally {
      if (installed) {
        await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_runtimes`);
        await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
      }
    }
  });
});

async function sleepTrigger(runtimeId: string, seconds: number) {
  const name = `guardian_delay_${randomUUID().replaceAll("-", "")}`,
    marker = name;
  if (!/^[a-f0-9-]{36}$/.test(runtimeId) || ![0.4, 1.3].includes(seconds))
    throw new Error("Fixture identity rejected");
  await db.$executeRawUnsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('application_name','${marker}',true); PERFORM pg_sleep(${seconds}); RETURN NEW; END $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER ${name} BEFORE UPDATE ON codex_guardian_runtimes FOR EACH ROW WHEN(NEW.id='${runtimeId}'::uuid) EXECUTE FUNCTION ${name}()`,
  );
  return {
    marker,
    async close() {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON codex_guardian_runtimes`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    },
  };
}
async function waitForDatabaseSleep(marker: string) {
  for (let n = 0; n < 200; n++) {
    const rows = await db.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=${marker} AND wait_event='PgSleep'`;
    if (rows[0].n === 1) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Fixture SQL delay was not observed");
}
describe.skipIf(!url)("guardian signed lifetime at real transaction boundary", () => {
  it("expiry while SQL update is pending rolls back the authority extension", async () => {
    const f = await guardianFixture(db),
      before = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: f.guardian.runtime.id },
      });
    const delay = await sleepTrigger(before.id, 1.3);
    try {
      const store = new GuardianAdmissionStore(db, {
        policy: f.guardian.policy,
        encryptionKey: "19".repeat(32),
        expectedConfigSha256: f.guardian.expectedConfigSha256,
        authorizationExpiresAt: Date.now() + 1000,
      });
      const pending = store.fence({
        ownerId: f.user.id,
        runtimeId: before.id,
        runtimeGeneration: before.generation,
        projectId: f.project.id,
        preparationDigest: f.guardian.prepared.admission.preparationDigest,
      });
      void pending.catch(() => {});
      await waitForDatabaseSleep(delay.marker);
      await expect(pending).rejects.toBeInstanceOf(RegistrationRejected);
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: before.id } }))
          .authorityUntil,
      ).toEqual(before.authorityUntil);
    } finally {
      await delay.close();
    }
  });
  it("abort after SQL work starts rolls back and never reports cancellation as commit", async () => {
    const f = await guardianFixture(db),
      before = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: f.guardian.runtime.id },
      }),
      abort = new AbortController();
    const delay = await sleepTrigger(before.id, 0.4);
    try {
      const store = new GuardianAdmissionStore(db, {
        policy: f.guardian.policy,
        encryptionKey: "19".repeat(32),
        expectedConfigSha256: f.guardian.expectedConfigSha256,
        authorizationExpiresAt: Date.now() + 30000,
        signal: abort.signal,
      });
      const pending = store.fence({
        ownerId: f.user.id,
        runtimeId: before.id,
        runtimeGeneration: before.generation,
        projectId: f.project.id,
        preparationDigest: f.guardian.prepared.admission.preparationDigest,
      });
      void pending.catch(() => {});
      await waitForDatabaseSleep(delay.marker);
      abort.abort();
      await expect(pending).rejects.toThrow();
      expect(
        (await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: before.id } }))
          .authorityUntil,
      ).toEqual(before.authorityUntil);
    } finally {
      await delay.close();
    }
  });
});
