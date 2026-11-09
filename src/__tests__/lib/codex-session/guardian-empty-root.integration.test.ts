import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceResource } from "@/lib/coder/types";
import { guardianCanonical, guardianDigest } from "@/lib/codex-session/guardian-contracts";
import {
  authorizeEmptyRoot,
  readEmptyRootResource,
} from "@/lib/codex-session/guardian-empty-root.server";
import { emptyRootProposalSchema } from "@/lib/codex-session/guardian-empty-root-contracts";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import {
  guardianIdentityProofPayload,
  guardianIdentityResponseSchema,
} from "@/lib/codex-session/guardian-transport-contracts";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";

const url =
  process.env.HIVE_EMPTY_ROOT_TEST_DATABASE_URL ?? process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ||
    !["/hive_empty_root_test", "/hive_delivery_test", "/hive_unused_bootstrap_test"].includes(
      new URL(url).pathname,
    ))
)
  throw Error("Owned local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_empty_root_test",
});
afterAll(() => db.$disconnect());
async function fixture(completed = true) {
  const keys = generateKeyPairSync("ed25519"),
    pub = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const user = await db.user.create({
    data: {
      coderUrl: "https://empty-root.invalid",
      coderUserId: randomUUID(),
      username: "fixture",
      email: "fixture@invalid",
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/empty",
    },
  });
  const task = await db.deliveryTask.create({
    data: {
      ownerId: user.id,
      projectId: project.id,
      outcome: "Explicit historical cleanup fixture",
      sourceSha: "a".repeat(40),
      branch: "fixture/empty",
    },
  });
  const binding: RegistrationBinding = {
    coderOrigin: user.coderUrl,
    hiveUserId: user.id,
    ownerId: user.coderUserId,
    workspaceId: randomUUID(),
    templateId: randomUUID(),
    buildId: randomUUID(),
    agentId: randomUUID(),
    appId: randomUUID(),
    appOrigin: "https://app.empty-root.invalid",
    projects: [],
  };
  const physical = { device: "100", inode: "200" },
    current = { device: "101", inode: "200" },
    volume = {
      pvcUid: randomUUID(),
      pvcName: `coder-${binding.workspaceId}-home`,
      namespace: "coder" as const,
      storageClass: "longhorn" as const,
      capacity: "20Gi",
      accessModes: ["ReadWriteOnce"] as ["ReadWriteOnce"],
      boundVolumeName: "",
      containerName: "dev" as const,
      podVolumeName: "home" as const,
      mountPath: "/home/coder" as const,
      subPath: "" as const,
      subPathExpr: "" as const,
      readOnly: false as const,
      claimReadOnly: false as const,
    };
  volume.boundVolumeName = `pvc-${volume.pvcUid}`;
  const now = Date.now(),
    oldVolume = {
      templateVersionId: randomUUID(),
      buildId: randomUUID(),
      lifetimeId: randomUUID(),
      resourceId: randomUUID(),
      observedAt: now - 600000,
      volume,
      volumeDigest: guardianDigest(volume),
    },
    newVolume = {
      ...oldVolume,
      templateVersionId: randomUUID(),
      buildId: binding.buildId,
      lifetimeId: randomUUID(),
      observedAt: now,
      resourceId: randomUUID(),
    };
  // The immutable rows below explicitly fixture an already completed F06 boundary.
  // This test does not claim to execute F06's semantic/closure workflow.
  const cleanupBinding = {
    taskId: randomUUID(),
    revision: "a".repeat(40),
    checkoutIdentity: physical,
    checkoutIncarnation: randomUUID(),
    leaseGeneration: 1,
    renewalSequence: 0,
    repositoryId: "123",
    cleanupRequestId: randomUUID(),
    rootIdentity: physical,
    projectIdentity: physical,
  };
  const claims = {
    schemaVersion: 1,
    purpose: "managed-checkout-cleanup",
    authorizationId: randomUUID(),
    ownerId: binding.ownerId,
    hiveUserId: user.id,
    workspaceId: binding.workspaceId,
    binding: cleanupBinding,
    currentVolume: oldVolume,
    deliveryTaskId: task.id,
    buildId: oldVolume.buildId,
    lifetimeId: oldVolume.lifetimeId,
    configSha256: "a".repeat(64),
    closedRuntimeId: randomUUID(),
    closedLifetimeId: randomUUID(),
    barrierId: randomUUID(),
    treeReceiptDigest: "b".repeat(64),
    projectId: project.id,
    sourceArchiveDigest: "c".repeat(64),
    controllerArchiveDigest: "d".repeat(64),
    preservationDigest: "e".repeat(64),
    leaseReleaseDigest: "f".repeat(64),
    completionEventId: randomUUID(),
    completionEventIds: [randomUUID()],
    policyVersion: randomUUID(),
    issuedAt: now - 600000,
    expiresAt: now - 550000,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url"),
    token =
      body +
      "." +
      sign(null, Buffer.from("hive-project-cleanup-v1\n" + body), keys.privateKey).toString(
        "base64url",
      );
  const receipt = {
    schemaVersion: 1 as const,
    authorizationId: claims.authorizationId,
    authorizationDigest: guardianDigest(claims),
    cleanupRequestId: cleanupBinding.cleanupRequestId,
    bindingDigest: guardianDigest(cleanupBinding),
    outcome: "checkout_removed" as const,
    currentVolumeDigest: guardianDigest(oldVolume),
    recordDigests: { root: "1".repeat(64), project: "2".repeat(64) },
  };
  for (const [kind, payload] of [
    ["authorized", claims],
    ...(completed ? [["completed", receipt]] : []),
  ] as [string, object][]) {
    await db.deliveryEvent.create({
      data: {
        id: randomUUID(),
        ownerId: user.id,
        taskId: task.id,
        aggregateKey: `fixture-cleanup-${kind}/${randomUUID()}`,
        aggregateVersion: 1,
        type: `checkout_cleanup_${kind}`,
        requestDigest: guardianDigest(payload),
        payload: payload as Prisma.InputJsonObject,
      },
    });
  }
  const proposal = emptyRootProposalSchema.parse({
    schemaVersion: 1,
    mode: "remount",
    root: {
      path: "/home/coder/projects/.hive-managed",
      old: physical,
      current,
      recordSha256: receipt.recordDigests.root,
      newRecordSha256: "3".repeat(64),
    },
    projects: [
      {
        repositoryId: "123",
        old: physical,
        current,
        recordSha256: receipt.recordDigests.project,
        newRecordSha256: "4".repeat(64),
        cleanupToken: token,
        cleanupReceipt: receipt,
      },
    ],
  });
  return { binding, newVolume, proposal, pub, keys };
}
async function prepareEnrollment(
  f: Awaited<ReturnType<typeof fixture>>,
  anchor: Awaited<ReturnType<typeof authorizeEmptyRoot>>,
) {
  const pin = {
    packageManifestSha256: "1".repeat(64),
    guardianElfSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    protocol: "guardian-v1" as const,
    policyDigest: "4".repeat(64),
    metadataPolicyDigest:
      "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b" as const,
  };
  const store = new GuardianAdmissionStore(db, {
    policy: { enabled: true, producerEnabled: false, packages: [pin] },
    encryptionKey: "11".repeat(32),
    expectedConfigSha256: () => "6".repeat(64),
  });
  const runtime = await store.reserveRuntime(f.binding, {
    packageManifestSha256: pin.packageManifestSha256,
    guardianElfSha256: pin.guardianElfSha256,
    nodeSha256: pin.nodeSha256,
    policyDigest: pin.policyDigest,
    metadataPolicyDigest: pin.metadataPolicyDigest,
    lifetimeId: f.newVolume.lifetimeId,
    bindingDigest: "7".repeat(64),
    outerPublicKeyPem: f.pub,
    configSha256: "6".repeat(64),
  });
  const now = Math.floor(Date.now() / 1000),
    claims = {
      iss: "https://hive.invalid",
      aud: "hive:workspace-guardian",
      agentId: f.binding.agentId,
      appId: f.binding.appId,
      lifetimeId: runtime.lifetimeId,
      outerKeyFingerprint: runtime.outerKeyFingerprint,
      bindingDigest: runtime.bindingDigest,
      identityDigest: "7".repeat(64),
      startupDigest: "8".repeat(64),
      scope: "workspace:guardian:enroll",
      jti: randomUUID(),
      runtimeId: runtime.id,
      hiveUserId: f.binding.hiveUserId,
      coderOwnerId: f.binding.ownerId,
      workspaceId: f.binding.workspaceId,
      buildId: f.binding.buildId,
      emptyRoot: anchor,
      iat: now,
      exp: now + 60,
    };
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "fixture" })).toString(
      "base64url",
    ),
    body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const token =
      header +
      "." +
      body +
      "." +
      sign(null, Buffer.from(header + "." + body), f.keys.privateKey).toString("base64url"),
    tokenDigest = createHash("sha256").update(token).digest("hex");
  await store.sealGrant({
    ownerId: f.binding.hiveUserId,
    runtimeId: runtime.id,
    id: claims.jti,
    tokenDigest,
    bindingDigest: guardianDigest(claims),
    issuedAt: new Date(now * 1000),
    expiresAt: new Date((now + 60) * 1000),
  });

  return { store, runtime, claims, token, tokenDigest };
}
describe.skipIf(!url)("empty retained-root issuer boundary", () => {
  it("uses actual immutable completed ledger + signed cleanup volume and fresh current tuple", async () => {
    const f = await fixture();
    const proof = await authorizeEmptyRoot(db, f.binding, f.proposal, f.newVolume, f.pub);
    expect(proof.records).toEqual({ root: "3".repeat(64), projects: { "123": "4".repeat(64) } });
    expect(proof.purpose).toBe("empty-managed-root");
    expect(proof.currentVolume).toEqual(f.newVolume);
    expect(proof).not.toHaveProperty("lease");
    expect(proof).not.toHaveProperty("nativeLaunchId");
  });
  it("corroborates a consumed real enrollment for the next epoch and refuses unconsumed anchors", async () => {
    const f = await fixture(),
      anchor = await authorizeEmptyRoot(db, f.binding, f.proposal, f.newVolume, f.pub);
    const { store, runtime, claims, token, tokenDigest } = await prepareEnrollment(f, anchor);
    const p = structuredClone(f.proposal);
    p.previousEnrollment = token;
    p.root.old = { ...p.root.current };
    p.root.current.device = "102";
    p.root.recordSha256 = anchor.records.root;
    p.root.newRecordSha256 = "8".repeat(64);
    p.projects[0].old = { ...p.projects[0].current };
    p.projects[0].current.device = "102";
    p.projects[0].recordSha256 = anchor.records.projects["123"];
    p.projects[0].newRecordSha256 = "9".repeat(64);
    const binding = { ...f.binding, buildId: randomUUID() },
      volume = { ...f.newVolume, buildId: binding.buildId, lifetimeId: randomUUID() };
    await expect(authorizeEmptyRoot(db, binding, p, volume, f.pub)).rejects.toThrow();
    await store.enroll({
      ownerId: f.binding.hiveUserId,
      runtimeId: runtime.id,
      grantId: claims.jti,
      tokenDigest,
      bindingDigest: guardianDigest(claims),
      consumptionDigest: "a".repeat(64),
    });
    const next = await authorizeEmptyRoot(db, binding, p, volume, f.pub);
    expect(next.records.root).toBe("8".repeat(64));
    expect(next.identities.root.device).toBe("102");
    const missing = structuredClone(p);
    missing.projects = [];
    await expect(authorizeEmptyRoot(db, binding, missing, volume, f.pub)).rejects.toThrow();
    p.projects[0].recordSha256 = "b".repeat(64);
    await expect(authorizeEmptyRoot(db, binding, p, volume, f.pub)).rejects.toThrow();
  });
  it("anchors a fresh root-only current observation before a later real enrolled epoch", async () => {
    const f = await fixture(),
      p = structuredClone(f.proposal);
    p.mode = "initial-current";
    p.projects = [];
    p.root.old = { ...p.root.current };
    p.root.recordSha256 = p.root.newRecordSha256;
    const anchor = await authorizeEmptyRoot(db, f.binding, p, f.newVolume, f.pub);
    expect(anchor.records.projects).toEqual({});
    const { store, runtime, claims, token, tokenDigest } = await prepareEnrollment(f, anchor);
    await store.enroll({
      ownerId: f.binding.hiveUserId,
      runtimeId: runtime.id,
      grantId: claims.jti,
      tokenDigest,
      bindingDigest: guardianDigest(claims),
      consumptionDigest: "a".repeat(64),
    });
    p.mode = "remount";
    p.previousEnrollment = token;
    p.root.old = { ...p.root.current };
    p.root.current.device = "102";
    p.root.recordSha256 = anchor.records.root;
    p.root.newRecordSha256 = "8".repeat(64);
    const binding = { ...f.binding, buildId: randomUUID() },
      volume = { ...f.newVolume, buildId: binding.buildId, lifetimeId: randomUUID() };
    expect((await authorizeEmptyRoot(db, binding, p, volume, f.pub)).records.root).toBe(
      "8".repeat(64),
    );
    delete p.previousEnrollment;
    await expect(authorizeEmptyRoot(db, binding, p, volume, f.pub)).rejects.toThrow();
    p.mode = "initial-current";
    await expect(authorizeEmptyRoot(db, binding, p, volume, f.pub)).rejects.toThrow();
  });
  it("bounds the maximum proposal inside the existing signed identity frame", async () => {
    const f = await fixture(),
      p = structuredClone(f.proposal);
    p.projects[0].cleanupToken = "a".repeat(12000);
    p.previousEnrollment = "a".repeat(100);
    p.previousEnrollment += "a".repeat(16384 - Buffer.byteLength(guardianCanonical(p)));
    expect(Buffer.byteLength(guardianCanonical(emptyRootProposalSchema.parse(p)))).toBe(16384);
    expect(() =>
      emptyRootProposalSchema.parse({ ...p, previousEnrollment: p.previousEnrollment + "a" }),
    ).toThrow();
    const hex = "a".repeat(64),
      pid = {
        pid: 1,
        parentPid: 0,
        startTime: "1",
        bootId: randomUUID(),
        executable: "/" + "a".repeat(511),
        device: "1",
        inode: "2",
      },
      lifetimeId = randomUUID();
    const packet = {
      schemaVersion: 1 as const,
      nonce: hex,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30000,
      identity: {
        lifetimeId,
        bindingDigest: hex,
        outerPublicKeyPem: f.pub,
        packageManifestSha256: hex,
        guardianElfSha256: hex,
        nodeSha256: hex,
        policyDigest: hex,
        metadataPolicyDigest: hex,
        configSha256: hex,
      },
      startup: {
        schemaVersion: 1 as const,
        type: "ready" as const,
        phase: "open" as const,
        nonce: "a".repeat(43),
        configSha256: hex,
        packageManifestSha256: hex,
        nodeSha256: hex,
        workerSha256: hex,
        guardianSha256: hex,
        port: 13341,
        lifetimeId,
        bindingDigest: hex,
        generation: 1,
        ownershipDigest: hex,
        projects: [],
        outerIdentity: pid,
        guardianIdentity: { ...pid, pid: 2, parentPid: 1 },
        workerIdentity: { ...pid, pid: 3, parentPid: 2 },
      },
      emptyRoot: p,
    };
    const frame = guardianIdentityResponseSchema.parse({
      ...packet,
      proof: sign(
        null,
        Buffer.from(guardianIdentityProofPayload(packet)),
        f.keys.privateKey,
      ).toString("base64url"),
    });
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(32768);
  });
  it("accepts only the exact current agent-bearing provider volume resource", async () => {
    const f = await fixture(),
      resource = {
        id: f.newVolume.resourceId,
        type: "kubernetes_deployment_v1",
        name: "workspace",
        agents: [{ id: f.binding.agentId }],
        metadata: [
          {
            key: "hive_home_volume_v1",
            value: JSON.stringify(f.newVolume.volume),
            sensitive: false,
          },
        ],
      } as unknown as WorkspaceResource;
    expect(readEmptyRootResource([resource], f.binding.agentId)).toEqual({
      resourceId: f.newVolume.resourceId,
      volume: f.newVolume.volume,
    });
    expect(() => readEmptyRootResource([resource], randomUUID())).toThrow();
    expect(() => readEmptyRootResource([resource, resource], f.binding.agentId)).toThrow();
    const hidden = structuredClone(resource);
    hidden.metadata![0].sensitive = true;
    expect(() => readEmptyRootResource([hidden], f.binding.agentId)).toThrow();
    const wrong = structuredClone(resource);
    wrong.metadata![0].value = JSON.stringify({ ...f.newVolume.volume, readOnly: true });
    expect(() => readEmptyRootResource([wrong], f.binding.agentId)).toThrow();
  });
  it("does not infer completed cleanup from signed authorization or absent directories", async () => {
    const f = await fixture(false);
    await expect(
      authorizeEmptyRoot(db, f.binding, f.proposal, f.newVolume, f.pub),
    ).rejects.toThrow();
  });
  it("rejects changed PVC, source receipt, owner, duplicate project, stale resource and replaced inode", async () => {
    const f = await fixture();
    for (const change of ["volume", "receipt", "owner", "duplicate", "stale", "inode"]) {
      const p = structuredClone(f.proposal),
        b = { ...f.binding },
        v = structuredClone(f.newVolume);
      if (change === "volume") {
        v.volume.pvcUid = randomUUID();
        v.volumeDigest = guardianDigest(v.volume);
      }
      if (change === "receipt") p.projects[0].cleanupReceipt.authorizationDigest = "f".repeat(64);
      if (change === "owner") b.hiveUserId = randomUUID();
      if (change === "duplicate") p.projects.push(p.projects[0]);
      if (change === "stale") v.observedAt -= 31000;
      if (change === "inode") p.root.current.inode = "201";
      await expect(authorizeEmptyRoot(db, b, p, v, f.pub)).rejects.toThrow();
    }
  });
});
