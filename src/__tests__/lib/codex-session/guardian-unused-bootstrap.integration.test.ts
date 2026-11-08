import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceResource } from "@/lib/coder/types";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  GUARDIAN_METADATA_POLICY_DIGEST,
  type GuardianPackagePin,
  type GuardianPolicy,
  guardianDigest,
} from "@/lib/codex-session/guardian-contracts";
import {
  authorizeUnusedBootstrapRoot,
  readEmptyRootResource,
  readHistoricalHomeIdentity,
} from "@/lib/codex-session/guardian-empty-root.server";
import { emptyRootProposalSchema } from "@/lib/codex-session/guardian-empty-root-contracts";
import { guardianVolumeSchema } from "@/lib/codex-session/guardian-remount-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import {
  type GuardianIdentityResponse,
  guardianIdentityProofPayload,
  guardianTransportProofPayload,
} from "@/lib/codex-session/guardian-transport-contracts";
import type { VerifiedHostBinding } from "@/lib/codex-session/registration.server";
import { PrismaRegistrationStore } from "@/lib/codex-session/registration-store.server";
import wire from "../../../../scripts/fixtures/unused-bootstrap-root.json";

const url = process.env.HIVE_UNUSED_BOOTSTRAP_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hive_unused_bootstrap_test")
)
  throw Error("Owned unused-bootstrap fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_unused_bootstrap_test",
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
    unusedBootstrap?: boolean;
    now?: number;
    nowFn?: () => number;
    clockWait?: (delay: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    corruptProof?: boolean;
    recoverEmptyClose?: (grant: string) => Promise<unknown>;
    beforeResolve?: () => Promise<void>;
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
  const proposal = emptyRootProposalSchema.parse({
    ...wire,
    unusedBootstrap: {
      ...wire.unusedBootstrap,
      coderOrigin: binding.coderOrigin,
      hiveUserId: user.id,
      ownerId: user.coderUserId,
      workspaceId: binding.workspaceId,
      templateId: binding.templateId,
      newBuildId: binding.buildId,
      newConfigSha256: configSha256,
      newPackageManifestSha256: pin.packageManifestSha256,
      oldPackageManifestSha256: pin.packageManifestSha256,
    },
  });
  const pvcUid = randomUUID(),
    oldResourceId = randomUUID();
  const physicalVolume = guardianVolumeSchema.parse({
    pvcUid,
    pvcName: `coder-${binding.workspaceId}-home`,
    namespace: "coder",
    storageClass: "longhorn",
    capacity: "4Gi",
    boundVolumeName: `pvc-${pvcUid}`,
    accessModes: ["ReadWriteOnce"],
    containerName: "dev",
    podVolumeName: "home",
    mountPath: "/home/coder",
    subPath: "",
    subPathExpr: "",
    readOnly: false,
    claimReadOnly: false,
  });
  const { boundVolumeName: _bound, ...historical } = physicalVolume;
  const volume = {
    buildId: binding.buildId,
    lifetimeId: identity.lifetimeId,
    resourceId: randomUUID(),
    templateVersionId: randomUUID(),
    volume: physicalVolume,
    volumeDigest: guardianDigest(physicalVolume),
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
    readEmptyRootVolume: async () => ({ ...volume, observedAt: Date.now() }),
    readUnusedBootstrapSource: async () => ({
      oldBuildId: proposal.unusedBootstrap!.oldBuildId,
      resourceId: oldResourceId,
      identity: historical,
      observedBoundVolumeName: null,
    }),
    resolveWorkspace: async (p) => {
      resolutions++;
      expect(p).toEqual(principal);
      await options?.beforeResolve?.();
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
        if (options?.unusedBootstrap) packet.emptyRoot = structuredClone(proposal);
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
    proposal,
    volume,
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

describe("unused bootstrap wire", () => {
  it("requires the explicit proof, exact root binding, and an empty inventory", () => {
    expect(emptyRootProposalSchema.parse(wire)).toEqual(wire);
    for (const change of [
      { unusedBootstrap: undefined },
      { mode: "initial-current" },
      { previousEnrollment: "a".repeat(100) },
      { root: { ...wire.root, recordSha256: "f".repeat(64) } },
      { unusedBootstrap: { ...wire.unusedBootstrap, unknown: true } },
    ])
      expect(emptyRootProposalSchema.safeParse({ ...wire, ...change }).success).toBe(false);
  });
});

describe.skipIf(!url)("unused bootstrap, owned PostgreSQL fixture", () => {
  const provision = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.service.provision(f.principal, f.binding.workspaceId);
  const rows = (f: Awaited<ReturnType<typeof fixture>>) =>
    db.codexGuardianRuntime.findMany({ where: { ownerId: f.user.id } });

  it("enrolls with an explicit unused proof and the same signed proposal", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    await expect(provision(f)).resolves.toMatchObject({ enrolled: true });
    const claims = JSON.parse(Buffer.from(f.grant.split(".")[1], "base64url").toString());
    expect(claims.emptyRoot.proposalDigest).toBe(guardianDigest(f.proposal));
    expect(claims.emptyRoot.unusedBootstrapDigest).toBe(guardianDigest(f.proposal.unusedBootstrap));
    expect(await rows(f)).toHaveLength(1);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { ownerId: f.user.id } })).toBe(1);
  });

  it("replays the exact original grant after mapping before enrollment acknowledgement", async () => {
    const tokens: string[] = [];
    const f = await fixture(
      undefined,
      async (value) => {
        tokens.push(value);
        if (tokens.length === 1) throw Error("fixture mapped root; acknowledgement lost");
        return value;
      },
      undefined,
      { unusedBootstrap: true },
    );
    await expect(provision(f)).rejects.toThrow();
    const before = (await rows(f))[0];
    expect(before.phase).toBe("reserved");
    const grantBefore = await db.codexGuardianEnrollmentGrant.findFirstOrThrow({
      where: { runtimeId: before.id },
    });
    await expect(provision(f)).resolves.toMatchObject({ enrolled: true });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    const grantAfter = await db.codexGuardianEnrollmentGrant.findFirstOrThrow({
      where: { runtimeId: before.id },
    });
    expect(grantAfter.id).toBe(grantBefore.id);
    expect(grantAfter.expiresAt).toEqual(grantBefore.expiresAt);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { runtimeId: before.id } })).toBe(
      1,
    );
  });

  it("confirms DB-open without issuing another grant before the host receives its acknowledgement", async () => {
    let deliveries = 0;
    const f = await fixture(
      undefined,
      async (value) => {
        deliveries++;
        return value;
      },
      undefined,
      { unusedBootstrap: true },
    );
    const first = await provision(f);
    const before = (await rows(f))[0];
    expect(await provision(f)).toEqual(first);
    expect(deliveries).toBe(1);
    expect((await rows(f))[0].authorityUntil).toEqual(before.authorityUntil);
  });

  it("rejects changed proof on reserved replay without changing the original grant", async () => {
    let changed = false;
    const f = await fixture(
      (p) => {
        if (changed) p.emptyRoot!.unusedBootstrap!.historyDigest = "b".repeat(64);
      },
      async () => {
        throw Error("lost transport");
      },
      undefined,
      { unusedBootstrap: true },
    );
    await expect(provision(f)).rejects.toThrow();
    const before = await db.codexGuardianEnrollmentGrant.findFirstOrThrow({
      where: { ownerId: f.user.id },
    });
    changed = true;
    await expect(provision(f)).rejects.toThrow();
    expect(
      await db.codexGuardianEnrollmentGrant.findMany({ where: { ownerId: f.user.id } }),
    ).toEqual([before]);
    expect(await rows(f)).toHaveLength(1);
  });

  it("rejects an unapproved predecessor package before creating any runtime or grant", async () => {
    const f = await fixture(
      (p) => {
        p.emptyRoot!.unusedBootstrap!.oldPackageManifestSha256 = "f".repeat(64);
      },
      undefined,
      undefined,
      { unusedBootstrap: true },
    );
    await expect(provision(f)).rejects.toThrow();
    expect(await rows(f)).toHaveLength(0);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { ownerId: f.user.id } })).toBe(0);
  });

  it("rolls back reservation and slot when grant creation fails", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    await expect(
      f.service.store.reserveUnusedBootstrap(
        { ...f.binding, projects: [] },
        f.identity,
        "c".repeat(64),
        Date.now(),
        () => {
          throw Error("fixture signing failure");
        },
      ),
    ).rejects.toThrow("fixture signing failure");
    expect(await rows(f)).toHaveLength(0);
    expect(await db.codexHostSlot.count({ where: { ownerId: f.user.id } })).toBe(0);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { ownerId: f.user.id } })).toBe(0);
  });

  it("rejects a historical runtime in another agent slot before granting anything", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    const oldStore = new GuardianAdmissionStore(db, {
      policy: f.policy,
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: () => f.identity.configSha256,
    });
    await oldStore.reserveRuntime(
      { ...f.binding, agentId: randomUUID(), projects: [] },
      { ...f.identity, lifetimeId: randomUUID() },
    );
    await expect(provision(f)).rejects.toThrow();
    expect(await rows(f)).toHaveLength(1);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { ownerId: f.user.id } })).toBe(0);
  });

  it("rejects an issued legacy registration grant across all agent slots", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    await new PrismaRegistrationStore(db).reserve({
      grantId: randomUUID(),
      binding: { ...f.binding, agentId: randomUUID(), projects: [] },
      expiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    await expect(provision(f)).rejects.toThrow();
    expect(await rows(f)).toHaveLength(0);
  });

  it("serializes competing first reservations across different agent slots", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    const signGrant = (
      runtime: { id: string },
      grant: { id: string; issuedAt: Date; expiresAt: Date },
    ) => ({
      token: JSON.stringify({ runtimeId: runtime.id, ...grant }),
      bindingDigest: "d".repeat(64),
    });
    const raceStore = new GuardianAdmissionStore(db, {
      policy: f.policy,
      encryptionKey: "19".repeat(32),
      expectedConfigSha256: () => f.identity.configSha256,
    });
    const calls = ["e", "f"].map((c) =>
      raceStore.reserveUnusedBootstrap(
        { ...f.binding, agentId: randomUUID(), projects: [] },
        { ...f.identity, lifetimeId: randomUUID() },
        c.repeat(64),
        Date.now(),
        signGrant,
      ),
    );
    const results = await Promise.allSettled(calls);
    expect(
      results.filter((r) => r.status === "fulfilled"),
      results.map((r) => (r.status === "rejected" ? String(r.reason) : "fulfilled")).join("\n"),
    ).toHaveLength(1);
    expect(await rows(f)).toHaveLength(1);
    expect(await db.codexGuardianEnrollmentGrant.count({ where: { ownerId: f.user.id } })).toBe(1);
  });

  it("holds an expired reserved grant without renewing its deadline", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    const binding = { ...f.binding, projects: [] };
    const signer = (
      runtime: { id: string },
      grant: { id: string; issuedAt: Date; expiresAt: Date },
    ) => ({
      token: JSON.stringify({ runtimeId: runtime.id, ...grant }),
      bindingDigest: "d".repeat(64),
    });
    const first = await f.service.store.reserveUnusedBootstrap(
      binding,
      f.identity,
      "7".repeat(64),
      Math.floor(Date.now() / 1000) * 1000 - 28000,
      signer,
    );
    const grant = await db.codexGuardianEnrollmentGrant.findFirstOrThrow({
      where: { runtimeId: first.runtime.id },
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, grant.expiresAt.getTime() - Date.now()) + 20),
    );
    await expect(
      f.service.store.reserveUnusedBootstrap(
        binding,
        f.identity,
        "7".repeat(64),
        Date.now(),
        signer,
      ),
    ).rejects.toThrow();
    expect(
      await db.codexGuardianEnrollmentGrant.findMany({ where: { runtimeId: first.runtime.id } }),
    ).toEqual([grant]);
    expect((await rows(f))[0].authorityUntil).toEqual(first.runtime.authorityUntil);
  });

  it("keeps incomplete historical metadata separate from current volume authority", async () => {
    const f = await fixture(undefined, undefined, undefined, { unusedBootstrap: true });
    const resource = {
      id: randomUUID(),
      type: "kubernetes_deployment_v1",
      name: "workspace",
      agents: [{ id: f.binding.agentId }],
      metadata: [
        {
          key: "hive_home_volume_v1",
          value: JSON.stringify({ ...f.volume.volume, boundVolumeName: "" }),
        },
      ],
    } as WorkspaceResource;
    const old = readHistoricalHomeIdentity([resource]);
    expect(old.identity).not.toHaveProperty("boundVolumeName");
    expect(() => readEmptyRootResource([resource], f.binding.agentId)).toThrow();
    const current = { ...f.volume, observedAt: Date.now() };
    const source = { ...old, oldBuildId: f.proposal.unusedBootstrap!.oldBuildId };
    expect(
      authorizeUnusedBootstrapRoot(
        { ...f.binding, projects: [] },
        f.proposal,
        current,
        f.identity,
        source,
      ).unusedBootstrapDigest,
    ).toBeTruthy();
    for (const mutation of [
      { ...source, identity: { ...source.identity, pvcUid: randomUUID() } },
      { ...source, oldBuildId: randomUUID() },
      { ...source, observedBoundVolumeName: `pvc-${randomUUID()}` },
    ])
      expect(() =>
        authorizeUnusedBootstrapRoot(
          { ...f.binding, projects: [] },
          f.proposal,
          current,
          f.identity,
          mutation,
        ),
      ).toThrow();
    expect(() =>
      authorizeUnusedBootstrapRoot(
        { ...f.binding, workspaceId: randomUUID(), projects: [] },
        f.proposal,
        current,
        f.identity,
        source,
      ),
    ).toThrow();
    expect(() =>
      authorizeUnusedBootstrapRoot(
        { ...f.binding, projects: [] },
        f.proposal,
        { ...current, observedAt: Date.now() - 31000 },
        f.identity,
        source,
      ),
    ).toThrow();
  });
});
