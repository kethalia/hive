import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AccountMaintenanceStore } from "@/lib/codex-session/account-maintenance-store.server";
import {
  expectedGuardianHostConfig,
  guardianConfigBytes,
} from "@/lib/codex-session/guardian-config.server";
import { authorizeEmptyRoot } from "@/lib/codex-session/guardian-empty-root.server";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import type { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import {
  guardianEnrollmentClaimsSchema,
  guardianTransportProofPayload,
} from "@/lib/codex-session/guardian-transport-contracts";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { epicDigest, epicPlanSchema } from "@/lib/delivery/epic-contracts";
import { resumeAccountMaintenanceFixture } from "../codex-session/account-maintenance-fixture";
import { acceptanceFixtureKey } from "./acceptance-fixture";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  host: vi.fn(),
  bucket: undefined as unknown,
}));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: { HIVE_DELIVERY_EVIDENCE: mocks.bucket } }),
}));

import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import {
  acknowledgeCheckoutCleanup,
  prepareCheckoutCleanup,
  signCheckoutCleanup,
} from "@/lib/delivery/checkout-cleanup.server";
import { checkoutCleanupClaimsSchema } from "@/lib/delivery/checkout-cleanup-contracts";
import {
  acknowledgeEpicArchive,
  prepareEpicRelease,
  submitEpicRelease,
} from "@/lib/delivery/epic-closure.server";
import { productionCompletionFixture } from "./production-completion-fixture";

const url =
  process.env.HIVE_CLEANUP_TEST_DATABASE_URL ?? process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    !["/hive_acceptance_test_automatic_cleanup_20261108", "/hive_delivery_test"].includes(
      new URL(url).pathname,
    ))
)
  throw Error("Owned cleanup fixture only");
const db = new PrismaClient({
  datasourceUrl:
    url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_automatic_cleanup_20261108",
});
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mocks.host.mockReset();
});
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function bucketFixture() {
  const objects = new Map<string, { bytes: Uint8Array; version: string }>();
  return {
    objects,
    put: async (key: string, bytes: Uint8Array) => {
      if (!objects.has(key)) objects.set(key, { bytes: bytes.slice(), version: randomUUID() });
    },
    get: async (key: string) => {
      const v = objects.get(key);
      return v
        ? {
            key,
            size: v.bytes.length,
            version: v.version,
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(v.bytes);
                c.close();
              },
            }),
          }
        : null;
    },
  };
}
async function completed(
  options: NonNullable<Parameters<typeof productionCompletionFixture>[2]> = {},
  afterCompletion?: (
    f: Awaited<ReturnType<typeof productionCompletionFixture>>,
  ) => Promise<{ store: GuardianAdmissionStore; runtimeId: string }>,
) {
  const f = await productionCompletionFixture(db, mocks.host, options),
    execution = await f.claim();
  await f.review();
  await f.services.service.dispatch(
    f.envelope({
      action: "complete_verified",
      terminal: { ...execution.terminal, observedAt: new Date().toISOString() },
    }),
  );
  const override = await afterCompletion?.(f),
    closeStore = override?.store ?? f.guardian.store;
  const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
      where: { id: override?.runtimeId ?? f.guardian.finalized.runtime.id },
    }),
    admission = await db.codexGuardianAdmission.findFirstOrThrow({
      where: { ownerId: f.user.id, runtimeId: runtime.id },
    }),
    binding = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: execution.next.managerBindingId },
    }),
    claim = await db.deliveryEvent.findFirstOrThrow({
      where: { ownerId: f.user.id, attemptId: binding.currentAttemptId, type: "attempt_started" },
    }),
    native = (claim.payload as { nativeClaim: { parentTurnId: string } }).nativeClaim;
  const projectBindings = [
      { projectId: admission.projectId, bindingDigest: admission.preparationDigest },
    ],
    ownershipDigest = guardianDigest(projectBindings);
  const closed = await closeStore.closeBarrier({
    ownerId: f.user.id,
    runtimeId: runtime.id,
    runtimeGeneration: runtime.generation,
    barrierId: randomUUID(),
    ownershipDigest,
    projectBindings,
    snapshots: [
      {
        projectId: admission.projectId,
        admissionId: admission.id,
        admissionGeneration: admission.generation,
        managerBindingId: binding.id,
        currentAttemptId: binding.currentAttemptId!,
        managerThreadId: admission.nativeThreadId!,
        parentTurnId: native.parentTurnId,
        cursorVersion: binding.cursorVersion,
        nativeSequence: binding.nativeSequence,
        observedAt: new Date(Date.now() - 1).toISOString(),
        historyDigest: "1".repeat(64),
        loadedInventoryDigest: "2".repeat(64),
        fullHistory: true,
        rootTurns: 2,
        historyBytes: 20,
        pendingHandlers: 0,
        pendingObservers: 0,
        unknownFacts: 0,
        activeRoots: 0,
      },
    ],
  });
  const tree = {
    schemaVersion: 1 as const,
    scope: "managed_native_tree_only" as const,
    cleanupAuthorized: false as const,
    guardianExited: true as const,
    receiptId: randomUUID(),
    lifetimeId: runtime.lifetimeId,
    bindingDigest: runtime.bindingDigest,
    ownershipDigest,
    projects: projectBindings,
    launchSetDigest: "3".repeat(64),
    guardianSha256: runtime.guardianElfSha256,
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
      lifetimeId: runtime.lifetimeId,
      generation: runtime.generation,
      ownershipDigest,
      barrierId: closed.barrierId,
    },
    workerPid: 101,
    packageManifestSha256: runtime.packageManifestSha256,
    workerSha256: "4".repeat(64),
    nodeSha256: runtime.nodeSha256,
  };
  await closeStore.closeTree({
    ownerId: f.user.id,
    runtimeId: runtime.id,
    runtimeGeneration: closed.runtimeGeneration,
    barrierId: closed.barrierId,
    receipt: tree,
  });
  const current = await db.codexGuardianRuntime.findUniqueOrThrow({ where: { id: runtime.id } }),
    bucket = bucketFixture();
  mocks.bucket = bucket;
  const prepared = await prepareEpicRelease(db, current, f.project.id),
    release = {
      schemaVersion: 1 as const,
      repositoryId: prepared.repositoryId,
      taskId: prepared.taskId,
      leaseId: prepared.leaseId,
      leaseGeneration: prepared.leaseGeneration,
      revision: prepared.acceptedSourceSha,
      checkoutIncarnation: prepared.checkoutIncarnation,
      checkoutIdentity: f.guardian.checkout.checkoutIdentity,
      releasedAt: Date.now(),
    };
  await submitEpicRelease(
    db,
    current,
    f.project.id,
    release,
    f.guardian.sessionConfig.privateKeyPem,
  );
  const controllerArchiveDigest = "5".repeat(64),
    sourceArchiveDigest = "6".repeat(64);
  await acknowledgeEpicArchive(
    db,
    current,
    f.project.id,
    controllerArchiveDigest,
    sourceArchiveDigest,
  );
  const request = {
    closedRuntimeId: current.id,
    projectId: f.project.id,
    binding: {
      repositoryId: prepared.repositoryId,
      taskId: prepared.taskId,
      revision: prepared.acceptedSourceSha,
      rootIdentity: { device: "123", inode: "100" },
      projectIdentity: { device: "123", inode: "101" },
      checkoutIdentity: release.checkoutIdentity,
      checkoutIncarnation: release.checkoutIncarnation,
      leaseGeneration: release.leaseGeneration,
      renewalSequence: 0,
      cleanupRequestId: randomUUID(),
    },
    controllerArchiveDigest,
    sourceArchiveDigest,
  };
  const pvcUid = randomUUID(),
    volume = {
      templateVersionId: randomUUID(),
      resourceId: randomUUID(),
      buildId: current.buildId,
      lifetimeId: current.lifetimeId,
      observedAt: Date.now(),
      volume: {
        pvcUid,
        pvcName: `coder-${current.workspaceId}-home`,
        namespace: "coder" as const,
        storageClass: "longhorn" as const,
        capacity: "20Gi",
        accessModes: ["ReadWriteOnce"] as ["ReadWriteOnce"],
        boundVolumeName: `pvc-${pvcUid}`,
        containerName: "dev" as const,
        podVolumeName: "home" as const,
        mountPath: "/home/coder" as const,
        subPath: "" as const,
        subPathExpr: "" as const,
        readOnly: false as const,
        claimReadOnly: false as const,
      },
      volumeDigest: "",
    };
  volume.volumeDigest = guardianDigest(volume.volume);
  return { ...f, current, request, volume, bucket, tree };
}
describe.skipIf(!url)("production-backed checkout cleanup, actual owned PostgreSQL", () => {
  it("standalone production completion retains exact closure and real-provider-shaped artifact version before issuing separate cleanup authority", async () => {
    const f = await completed({ native: { workspaceEnrollment: true } });
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
        resolveCleanupVolume: async () => f.volume,
      },
    );
    const frame = (action: string, fields: Record<string, unknown>) => {
      const body = {
        schemaVersion: 1,
        runtimeId: f.current.id,
        runtimeGeneration: f.current.generation,
        eventId: randomUUID(),
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 30000,
        action,
        ...fields,
      };
      return {
        ...body,
        proof: sign(
          null,
          Buffer.from(guardianTransportProofPayload(body as never)),
          f.guardian.outer.privateKey,
        ).toString("base64url"),
      };
    };
    await expect(
      service.execute(frame("cleanup_status", { projectId: f.project.id, request: f.request })),
    ).resolves.toEqual({ token: null });
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "checkout_cleanup_authorized" },
      }),
    ).toBe(0);
    const first = (await service.execute(
        frame("cleanup_prepare", { projectId: f.project.id, request: f.request }),
      )) as { token: string },
      claims = checkoutCleanupClaimsSchema.parse(
        JSON.parse(Buffer.from(first.token.split(".")[0], "base64url").toString()),
      );
    expect(claims.expiresAt - claims.issuedAt).toBeGreaterThan(20000);
    await expect(
      service.execute(frame("cleanup_status", { projectId: f.project.id, request: f.request })),
    ).resolves.toEqual(first);
    await expect(
      service.execute(
        frame("cleanup_status", {
          projectId: f.project.id,
          request: { ...f.request, controllerArchiveDigest: "0".repeat(64) },
        }),
      ),
    ).rejects.toThrow();
    expect(claims.binding).toEqual(f.request.binding);
    expect(claims.treeReceiptDigest).toBe(guardianDigest(f.tree));
    expect(claims.artifact.digest).toBe(
      `sha256:${sha(f.bucket.objects.get(claims.artifact.key)!.bytes)}`,
    );
    expect(claims.artifact.objectVersion).toBe(f.bucket.objects.get(claims.artifact.key)!.version);
    expect(claims.currentVolume).toEqual(f.volume);
    expect(
      await prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        { ...f.volume, observedAt: Date.now() },
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).toEqual(first);
    const receipt = {
      schemaVersion: 1 as const,
      authorizationId: claims.authorizationId,
      authorizationDigest: guardianDigest(claims),
      cleanupRequestId: claims.binding.cleanupRequestId,
      bindingDigest: guardianDigest(claims.binding),
      outcome: "checkout_removed" as const,
      currentVolumeDigest: guardianDigest(claims.currentVolume),
      recordDigests: { root: "a".repeat(64), project: "b".repeat(64) },
    };
    const ack = frame("cleanup_ack", { projectId: f.project.id, receipt });
    await expect(service.execute(ack)).resolves.toMatchObject({ cleanupRecorded: true });
    await expect(
      service.execute({ ...ack, proof: Buffer.alloc(64).toString("base64url") }),
    ).rejects.toThrow();
    await expect(
      acknowledgeCheckoutCleanup(db, f.current, receipt, f.project.id),
    ).resolves.toMatchObject({ cleanupRecorded: true });
    const leaseEvent = await db.deliveryEvent.findFirstOrThrow({
        where: { ownerId: f.user.id, taskId: f.taskId, type: "checkout_lease_released" },
      }),
      release = (
        leaseEvent.payload as unknown as { receipt: Parameters<typeof submitEpicRelease>[3] }
      ).receipt,
      original = await submitEpicRelease(
        db,
        f.current,
        f.project.id,
        release,
        f.guardian.sessionConfig.privateKeyPem,
      ),
      originalClaims = JSON.parse(
        Buffer.from(original.token.split(".")[0], "base64url").toString(),
      ),
      future = Date.now() + 50000,
      clock = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      const refreshed = await submitEpicRelease(
          db,
          f.current,
          f.project.id,
          release,
          f.guardian.sessionConfig.privateKeyPem,
        ),
        refreshedClaims = JSON.parse(
          Buffer.from(refreshed.token.split(".")[0], "base64url").toString(),
        );
      expect(originalClaims.expiresAt).toBeLessThan(future);
      expect(refreshedClaims).toEqual({ ...originalClaims, expiresAt: future + 45000 });
      expect(refreshed.token).not.toBe(original.token);
    } finally {
      clock.mockRestore();
    }
    expect(await db.deliveryEvent.findUniqueOrThrow({ where: { id: leaseEvent.id } })).toEqual(
      leaseEvent,
    );
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, taskId: f.taskId, type: "checkout_lease_released" },
      }),
    ).toBe(1);
  }, 60000);
  it("rejects altered owner/source/lease/incarnation/build and corrupt/missing R2 upload evidence before any cleanup authorization", async () => {
    const f = await completed(),
      key = Array.from(f.bucket.objects.keys())[0],
      original = f.bucket.objects.get(key)!;
    for (const request of [
      { ...f.request, binding: { ...f.request.binding, revision: "0".repeat(40) } },
      {
        ...f.request,
        binding: { ...f.request.binding, leaseGeneration: f.request.binding.leaseGeneration + 1 },
      },
      { ...f.request, binding: { ...f.request.binding, checkoutIncarnation: randomUUID() } },
      {
        ...f.request,
        binding: {
          ...f.request.binding,
          checkoutIdentity: { ...f.request.binding.checkoutIdentity, inode: "999" },
        },
      },
      { ...f.request, closedRuntimeId: randomUUID() },
    ])
      await expect(
        prepareCheckoutCleanup(
          db,
          f.current,
          request,
          f.volume,
          f.guardian.sessionConfig.privateKeyPem,
        ),
      ).rejects.toThrow();
    await expect(
      prepareCheckoutCleanup(
        db,
        { ...f.current, ownerId: randomUUID() },
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        { ...f.volume, buildId: randomUUID() },
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
    f.bucket.objects.set(key, { ...original, bytes: new Uint8Array([1, 2, 3]) });
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
    f.bucket.objects.set(key, { ...original, version: "" });
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
    f.bucket.objects.delete(key);
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "checkout_cleanup_authorized" },
      }),
    ).toBe(0);
  }, 60000);
  it("expiry during actual SQL rolls back identity and grant events; policy revocation and missing full acceptance remain holds", async () => {
    const f = await completed(),
      name = `cleanup_deadline_${f.user.id.replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id='${f.user.id}'::uuid AND NEW.type='checkout_cleanup_authorized' THEN PERFORM pg_sleep(1.2); END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON delivery_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    try {
      await expect(
        prepareCheckoutCleanup(
          db,
          f.current,
          f.request,
          f.volume,
          f.guardian.sessionConfig.privateKeyPem,
          undefined,
          Date.now() + 1000,
        ),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON delivery_events`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
    expect(
      await db.deliveryEvent.count({
        where: {
          ownerId: f.user.id,
          type: { in: ["checkout_cleanup_identity", "checkout_cleanup_authorized"] },
        },
      }),
    ).toBe(0);
    await db.deliveryRepositoryPolicyVersion.updateMany({
      where: { ownerId: f.user.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        { ...f.volume, observedAt: Date.now() },
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
  }, 60000);

  it("real installed cleanup preserves evidence and ACK replay, then exact empty remount permits an ordinary fresh checkout", async () => {
    const base = mkdtempSync(join(tmpdir(), "hive-f06-installed-")),
      taskId = randomUUID(),
      leaseId = randomUUID();
    const run = (operation: string, values: Record<string, unknown>) =>
      JSON.parse(
        execFileSync("python3", ["scripts/agents/cleanup-installed-fixture.py"], {
          input: JSON.stringify({ base, operation, ...values }),
          encoding: "utf8",
          maxBuffer: 65536,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    try {
      const physical = run("create", { taskId, leaseId });
      const user = await db.user.create({
          data: {
            coderUrl: "https://fixture.invalid",
            coderUserId: randomUUID(),
            username: "cleanup-fixture",
            email: "fixture@example.invalid",
          },
        }),
        project = await db.deliveryProject.create({
          data: {
            ownerId: user.id,
            provider: "github",
            providerRepositoryId: "123",
            providerAccountId: "456",
            fullName: "owner/repository",
          },
        });
      const f = await completed({
        headSha: physical.revision,
        native: {
          existing: { user, project, preparationIntentId: taskId, requestId: randomUUID() },
          physical: {
            revision: "a".repeat(40),
            leaseId: physical.prepared.lease.id,
            leaseGeneration: physical.prepared.lease.generation,
            checkoutIncarnation: physical.prepared.checkoutIncarnation,
            checkoutIdentity: physical.prepared.checkoutIdentity,
            gitIdentity: physical.gitIdentity,
          },
        },
      });
      const inspected = run("release", { taskId });
      f.request.binding = inspected.binding;
      const { token } = await prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      );
      const config = guardianConfigBytes(
        expectedGuardianHostConfig(f.host, f.guardian.sessionConfig, {
          HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
          HIVE_CODEX_MANAGER_EFFORT: "low",
          HIVE_DELIVERY_MANAGER_ENABLED: "true",
        }),
      );
      expect(createHash("sha256").update(config).digest("hex")).toBe(f.current.configSha256);
      const args = { token, tree: f.tree, configBytes: Buffer.from(config).toString("base64") };
      const claims = checkoutCleanupClaimsSchema.parse(
        JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()),
      );
      const body = token.split(".")[0];
      const wrongDomain = `${body}.${sign(null, Buffer.from(`hive-project-archive-v1\n${body}`), f.guardian.sessionConfig.privateKeyPem).toString("base64url")}`;
      const invalid = [
        wrongDomain,
        `${body}.${Buffer.alloc(64).toString("base64url")}`,
        signCheckoutCleanup(
          { ...claims, issuedAt: Date.now() - 5000, expiresAt: Date.now() - 1 },
          f.guardian.sessionConfig.privateKeyPem,
        ),
        signCheckoutCleanup(
          { ...claims, buildId: randomUUID() },
          f.guardian.sessionConfig.privateKeyPem,
        ),
      ];
      for (const denied of invalid) {
        expect(() => run("cleanup", { ...args, token: denied })).toThrow();
        expect(existsSync(physical.prepared.checkoutDirectory)).toBe(true);
      }
      const removed = run("cleanup", args);
      expect(removed.status).toBe("checkout_removed");
      expect(existsSync(physical.prepared.checkoutDirectory)).toBe(false);
      expect(existsSync(physical.prepared.projectDirectory)).toBe(true);
      expect(run("cleanup", args)).toEqual(removed);
      await expect(
        acknowledgeCheckoutCleanup(db, f.current, removed.cleanupReceipt, f.project.id),
      ).resolves.toMatchObject({ cleanupRecorded: true });
      {
        const newBinding = {
            ...f.host,
            projects: [],
            buildId: randomUUID(),
            agentId: randomUUID(),
          },
          newLifetime = randomUUID(),
          proposal = run("empty-inspect", { lifetimeId: newLifetime }),
          currentVolume = {
            ...f.volume,
            buildId: newBinding.buildId,
            lifetimeId: newLifetime,
            templateVersionId: randomUUID(),
            resourceId: randomUUID(),
            observedAt: Date.now(),
          },
          publicKey = createPublicKey(f.guardian.sessionConfig.privateKeyPem)
            .export({ format: "pem", type: "spki" })
            .toString();
        const foreignPvcUid = randomUUID(),
          foreignVolume = {
            ...currentVolume.volume,
            pvcUid: foreignPvcUid,
            boundVolumeName: `pvc-${foreignPvcUid}`,
          };
        await expect(
          authorizeEmptyRoot(
            db,
            newBinding,
            proposal,
            {
              ...currentVolume,
              volume: foreignVolume,
              volumeDigest: guardianDigest(foreignVolume),
            },
            publicKey,
          ),
        ).rejects.toThrow();
        const anchor = await authorizeEmptyRoot(db, newBinding, proposal, currentVolume, publicKey);
        expect(proposal.projects[0].cleanupReceipt).toEqual(removed.cleanupReceipt);
        const runtime = await f.guardian.store.reserveRuntime(newBinding, {
          lifetimeId: newLifetime,
          bindingDigest: "a".repeat(64),
          outerPublicKeyPem: f.current.outerPublicKeyPem,
          packageManifestSha256: f.current.packageManifestSha256,
          guardianElfSha256: f.current.guardianElfSha256,
          nodeSha256: f.current.nodeSha256,
          policyDigest: f.current.policyDigest,
          metadataPolicyDigest: f.current.metadataPolicyDigest,
          configSha256: f.guardian.expectedConfigSha256(newBinding),
        });
        const now = Math.floor(Date.now() / 1000),
          claims = guardianEnrollmentClaimsSchema.parse({
            iss: f.guardian.sessionConfig.hiveOrigin,
            aud: "hive:workspace-guardian",
            scope: "workspace:guardian:enroll",
            jti: randomUUID(),
            iat: now,
            exp: now + 30,
            runtimeId: runtime.id,
            hiveUserId: f.user.id,
            coderOwnerId: newBinding.ownerId,
            workspaceId: newBinding.workspaceId,
            agentId: newBinding.agentId,
            buildId: newBinding.buildId,
            appId: newBinding.appId,
            lifetimeId: newLifetime,
            outerKeyFingerprint: runtime.outerKeyFingerprint,
            bindingDigest: runtime.bindingDigest,
            identityDigest: "b".repeat(64),
            startupDigest: "c".repeat(64),
            emptyRoot: anchor,
          }),
          header = Buffer.from(
            JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: f.guardian.sessionConfig.keyId }),
          ).toString("base64url"),
          body = Buffer.from(JSON.stringify(claims)).toString("base64url"),
          enrollmentToken = `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), f.guardian.sessionConfig.privateKeyPem).toString("base64url")}`,
          tokenDigest = createHash("sha256").update(enrollmentToken).digest("hex");
        // Signed owner transport/native observations are explicit fixture doubles;
        // the cleanup ledger, authorizer, grant store, mapping and Git are real.
        expect(
          verify(
            null,
            Buffer.from(`${header}.${body}`),
            publicKey,
            Buffer.from(enrollmentToken.split(".")[2], "base64url"),
          ),
        ).toBe(true);
        await f.guardian.store.sealGrant({
          ownerId: f.user.id,
          runtimeId: runtime.id,
          id: claims.jti,
          tokenDigest,
          bindingDigest: guardianDigest(claims),
          issuedAt: new Date(now * 1000),
          expiresAt: new Date(claims.exp * 1000),
        });
        const mapped = run("empty-apply", {
          proposal,
          claims,
          enrollmentToken,
        });
        expect(mapped.mapping).toMatchObject({ revalidated: true, leaseRenewed: false });
        await f.guardian.store.enroll({
          ownerId: f.user.id,
          runtimeId: runtime.id,
          grantId: claims.jti,
          tokenDigest,
          bindingDigest: guardianDigest(claims),
          consumptionDigest: "d".repeat(64),
        });
        const fresh = run("empty-prepare", { nextTaskId: randomUUID() });
        expect(fresh.retainedProject).toBe(true);
        expect(fresh.cleanupReceipt).toEqual(removed.cleanupReceipt);
        expect(fresh.prepared.checkoutIncarnation).not.toBe(physical.prepared.checkoutIncarnation);
        expect(fresh.prepared.lease.taskId).not.toBe(taskId);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60000);

  it("concurrent same-request issuance commits one grant, and only a fresh never-started inspection can renew an expired unused grant", async () => {
    const f = await completed();
    const outcomes = await Promise.allSettled([
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
        undefined,
        Date.now() + 1800,
      ),
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
        undefined,
        Date.now() + 1800,
      ),
    ]);
    const winner = outcomes.find(
      (r): r is PromiseFulfilledResult<{ token: string }> => r.status === "fulfilled",
    );
    expect(winner).toBeTruthy();
    const replay = await prepareCheckoutCleanup(
      db,
      f.current,
      f.request,
      f.volume,
      f.guardian.sessionConfig.privateKeyPem,
    );
    expect(replay).toEqual(winner!.value);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "checkout_cleanup_authorized" },
      }),
    ).toBe(1);
    const original = checkoutCleanupClaimsSchema.parse(
      JSON.parse(Buffer.from(replay.token.split(".")[0], "base64url").toString()),
    );
    await new Promise((r) => setTimeout(r, Math.max(1, original.expiresAt - Date.now() + 20)));
    expect(
      await prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).toEqual(replay);
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        {
          ...f.request,
          retry: {
            previousAuthorizationDigest: guardianDigest(original),
            disposition: "deleting",
            observedAt: Date.now(),
          },
        },
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).rejects.toThrow();
    const retry = {
        previousAuthorizationDigest: guardianDigest(original),
        disposition: "not_started" as const,
        observedAt: Date.now(),
      },
      request = { ...f.request, retry };
    const renewed = await prepareCheckoutCleanup(
        db,
        f.current,
        request,
        { ...f.volume, observedAt: Date.now() },
        f.guardian.sessionConfig.privateKeyPem,
      ),
      claims = checkoutCleanupClaimsSchema.parse(
        JSON.parse(Buffer.from(renewed.token.split(".")[0], "base64url").toString()),
      );
    expect(claims.previousAuthorizationDigest).toBe(guardianDigest(original));
    expect(claims.authorizationId).not.toBe(original.authorizationId);
    expect(claims.expiresAt).toBeGreaterThan(original.expiresAt);
    expect(
      await prepareCheckoutCleanup(
        db,
        f.current,
        request,
        { ...f.volume, observedAt: Date.now() },
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).toEqual(renewed);
    const events = await db.deliveryEvent.findMany({
      where: { ownerId: f.user.id, type: "checkout_cleanup_authorized" },
      orderBy: { aggregateVersion: "asc" },
    });
    expect(events.map((e) => e.aggregateVersion)).toEqual([1, 2]);
    expect(events[0].payload).toEqual(original);
  }, 60000);

  it("an enrolled epic node follows real production claims and releases only its exact writer after source archive before cleanup", async () => {
    const coordinator = await completed(),
      user = coordinator.user,
      project = coordinator.project;
    const author = await db.deliveryTask.findUniqueOrThrow({ where: { id: coordinator.taskId } }),
      epic = await db.deliveryEpic.create({
        data: {
          ownerId: user.id,
          projectId: project.id,
          outcome: author.outcome,
          criteria: ["acceptance:behavior", "acceptance:activation"],
        },
      });
    await db.deliveryTask.update({ where: { id: author.id }, data: { epicId: epic.id } });
    const intentId = randomUUID(),
      requestId = randomUUID(),
      workspaceId = randomUUID(),
      buildId = randomUUID(),
      domain = `cleanup-${randomUUID()}`;
    const node = {
      intentId,
      requestId,
      workspaceId,
      expectedRevision: "a".repeat(40),
      textDigest: createHash("sha256")
        .update("Guardian storage synthetic task; no account inference")
        .digest("hex"),
      criteria: ["acceptance:behavior", "acceptance:activation"],
      dependsOn: [],
      role: "implementation",
      modelTier: "fixture",
      model: "gpt-6.1-sol",
      effort: "low",
    };
    const plan = epicPlanSchema.parse({
        schemaVersion: 1,
        epicId: epic.id,
        projectId: project.id,
        ownerIntentDigest: coordinator.plan.intentDigest,
        outcomeDigest: epicDigest(epic.outcome),
        criteria: node.criteria,
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
            dependsOn: [intentId],
          },
        ],
      }),
      digest = epicDigest(plan);
    await db.$executeRaw`INSERT INTO delivery_epic_plans(owner_id,epic_id,version,plan,plan_digest,authored_by_task_id) VALUES(${user.id}::uuid,${epic.id}::uuid,1,${JSON.stringify(plan)}::jsonb,${digest},${author.id}::uuid)`;
    await db.$executeRaw`INSERT INTO delivery_epic_plan_heads(owner_id,epic_id,version,plan_digest) VALUES(${user.id}::uuid,${epic.id}::uuid,1,${digest})`;
    await db.$executeRaw`INSERT INTO delivery_epic_start_intents(owner_id,epic_id,intent_id,plan_digest,workspace_id,build_id,isolation_domain,request_id,phase) VALUES(${user.id}::uuid,${epic.id}::uuid,${intentId}::uuid,${digest},${workspaceId}::uuid,${buildId}::uuid,${domain},${requestId}::uuid,'accepted')`;
    const f = await completed({
      headSha: "c".repeat(40),
      pullNumber: 8,
      pullRequestId: "901",
      native: {
        existing: { user, project, preparationIntentId: intentId, requestId, workspaceId, buildId },
      },
      epic: {
        id: epic.id,
        encryptionKey: acceptanceFixtureKey,
        isolationPolicy: {
          schemaVersion: 1,
          workspaces: [
            {
              ownerId: user.id,
              workspaceId,
              buildId,
              isolationDomain: domain,
              validUntil: Date.now() + 600000,
            },
          ],
        },
      },
    });
    const rows = await db.$queryRaw<
      { phase: string; release_evidence_digest: string }[]
    >`SELECT phase,release_evidence_digest FROM delivery_epic_writer_reservations WHERE owner_id=${user.id}::uuid AND intent_id=${intentId}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("released");
    await expect(
      prepareCheckoutCleanup(
        db,
        f.current,
        f.request,
        f.volume,
        f.guardian.sessionConfig.privateKeyPem,
      ),
    ).resolves.toMatchObject({ token: expect.any(String) });
    expect(
      await db.$queryRaw`SELECT phase,release_evidence_digest FROM delivery_epic_writer_reservations WHERE owner_id=${user.id}::uuid AND intent_id=${intentId}::uuid`,
    ).toEqual(rows);
  }, 60000);

  it("uses an actual committed maintenance actor and closed receipts while preserving original task and conversation identity", async () => {
    let originalBinding: unknown,
      oldBuild = "",
      oldRuntimeId = "";
    const f = await completed({}, async (g) => {
      originalBinding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: {
          id: (await db.deliveryTask.findUniqueOrThrow({ where: { id: g.taskId } }))
            .managerBindingId!,
        },
      });
      const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: g.guardian.finalized.runtime.id },
      });
      oldBuild = runtime.buildId;
      oldRuntimeId = runtime.id;
      const resumed = await resumeAccountMaintenanceFixture(
        db,
        {
          fixture: { ...g, claim: async () => g.previewClaim },
          binding: runtime.binding as unknown as RegistrationBinding,
          runtime,
          store: new AccountMaintenanceStore(db),
          input: {
            requestId: randomUUID(),
            expectedVersion: 0,
            runtimeId: runtime.id,
            runtimeGeneration: runtime.generation,
          },
        },
        "successful",
      );
      return { store: resumed.newStore, runtimeId: resumed.idle.id };
    });
    const current = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: (originalBinding as { id: string }).id },
    });
    expect(current.buildId).toBe(oldBuild);
    expect(f.current.id).not.toBe(oldRuntimeId);
    expect(current.executionEpochVersion).toBe(1);
    const permit = await prepareCheckoutCleanup(
      db,
      f.current,
      f.request,
      f.volume,
      f.guardian.sessionConfig.privateKeyPem,
    );
    expect(permit.token).toBeTruthy();
    expect(
      (await db.deliveryConversation.findUniqueOrThrow({ where: { id: current.conversationId } }))
        .buildId,
    ).toBe(oldBuild);
  }, 60000);
});
