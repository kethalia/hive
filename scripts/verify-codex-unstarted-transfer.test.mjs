import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { guardianCanonical } from "../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";
import { openNativeGuardian } from "../templates/ai-dev-k8s/scripts/codex-native-guardian.mjs";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import { createProjectController } from "../templates/ai-dev-k8s/scripts/codex-project-controller.mjs";
import { recoveryDigest } from "../templates/ai-dev-k8s/scripts/codex-project-recovery.mjs";
import {
  effectiveUnstartedBuild,
  prepareUnstartedTransfer,
  prepareUnusedEpochHop,
  readUnstartedTransfer,
  readUnstartedTransferContinuation,
  unstartedLeaseAuthority,
  unstartedRecoveryGuardianAuthority,
  verifyUnstartedProject,
} from "../templates/ai-dev-k8s/scripts/codex-unstarted-transfer.mjs";
import { hostArchive } from "./build-codex-host-archive.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const mac = (state, key) =>
  Buffer.from(
    JSON.stringify({
      state,
      signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
    }),
  );
function fixture(t, { intermediate = false, currentPackageManifest = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "hive-unstarted-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".local/state/hive"),
    guard = join(root, "codex-host-guardian"),
    projects = join(root, "codex-project-controller"),
    native = join(root, "codex-project-supervisor");
  for (const p of [guard, projects, native]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const keys = { guard: randomBytes(32), projects: randomBytes(32), native: randomBytes(32) },
    keypair = generateKeyPairSync("ed25519");
  for (const [path, raw] of [
    [join(guard, "key"), keys.guard],
    [join(projects, "projects.key"), keys.projects],
    [join(native, "key"), keys.native],
    [
      join(guard, "controller-key.pem"),
      keypair.privateKey.export({ format: "pem", type: "pkcs8" }),
    ],
  ])
    writeFileSync(path, raw, { mode: 0o600 });
  for (const path of [
    join(guard, "guardian.lock"),
    join(projects, "controller.lock"),
    join(native, "supervisor.lock"),
  ])
    writeFileSync(path, "", { mode: 0o600 });
  const oldConfig = {
    binding: {
      ownerId: randomUUID(),
      hiveUserId: randomUUID(),
      workspaceId: randomUUID(),
      templateId: randomUUID(),
      buildId: randomUUID(),
      coderOrigin: "https://coder.invalid",
    },
    hiveOrigin: "https://hive.invalid",
    issuerKeyId: "test",
    issuerPublicKeyPem: "fixture",
    guardianEnabled: true,
    nativeIsolationEnabled: true,
  };
  const oldConfigRaw = Buffer.from(JSON.stringify(oldConfig)),
    config = structuredClone(oldConfig);
  config.binding.buildId = randomUUID();
  const configSha256 = intermediate ? sha(JSON.stringify(config)) : "e".repeat(64),
    packageManifestSha256 =
      currentPackageManifest ??
      (intermediate
        ? "b16854fee6f44c96652c5b8bd64b9b3025e28037f93ab4bfe86c9bd218dd4efe"
        : "f".repeat(64)),
    oldManifest = "7eb52d53f4c6664743d4da182ff35dbe042bde53017647d18209b4eb885180c7";
  const bindingDigest = sha(
    JSON.stringify({
      schemaVersion: 1,
      configSha256: sha(oldConfigRaw),
      packageManifestSha256: oldManifest,
    }),
  );
  const dead = {
    pid: 2147483000,
    startTime: "1",
    bootId: randomUUID(),
    executable: process.execPath,
    device: "1",
    inode: "1",
  };
  const startup = {
    lifetimeId: randomUUID(),
    generation: 1,
    projects: [],
    bindingDigest,
    packageManifestSha256: oldManifest,
    configSha256: sha(oldConfigRaw),
    guardianSha256: "a".repeat(64),
    nodeSha256: "b".repeat(64),
    outerIdentity: dead,
    guardianIdentity: { ...dead, pid: dead.pid + 1 },
    workerIdentity: { ...dead, pid: dead.pid + 2 },
  };
  const projectId = randomUUID(),
    taskId = randomUUID(),
    requestId = randomUUID(),
    leaseId = randomUUID();
  const request = {
    schemaVersion: 1,
    projectId,
    repositoryId: "123",
    expectedAccountId: "456",
    taskId,
    requestId,
    revision: "c".repeat(40),
    model: "gpt-6.1-sol",
    effort: "low",
    text: "original task text",
  };
  const prepared = {
    projectId,
    repositoryId: "123",
    taskId,
    leaseId,
    leaseGeneration: 1,
    model: request.model,
    effort: request.effort,
  };
  const preparation = {
    schemaVersion: 1,
    stage: "preparation",
    ownerId: oldConfig.binding.ownerId,
    workspaceId: oldConfig.binding.workspaceId,
    buildId: oldConfig.binding.buildId,
    projectId,
    repositoryId: "123",
    providerAccountId: "456",
    taskId,
    requestId,
    baseSha: request.revision,
    requestDigest: sha(JSON.stringify(request)),
  };
  const checkout = {
    projectId,
    preparationIntentId: taskId,
    repositoryId: "123",
    revision: request.revision,
    leaseId,
    leaseGeneration: 1,
    checkoutIncarnation: randomUUID(),
    checkoutIdentity: { device: "1", inode: "2" },
  };
  const admissionId = randomUUID(),
    approval = {
      projectId,
      repositoryId: "123",
      taskId,
      leaseId,
      leaseGeneration: 1,
      checkoutIncarnation: checkout.checkoutIncarnation,
      checkoutIdentity: checkout.checkoutIdentity,
      revision: request.revision,
      admissionId,
      admissionGeneration: 2,
      firstNative: true,
    };
  const identity = {
    lifetimeId: startup.lifetimeId,
    bindingDigest,
    outerPublicKeyPem: keypair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    packageManifestSha256: oldManifest,
    guardianElfSha256: startup.guardianSha256,
    nodeSha256: startup.nodeSha256,
    policyDigest: "d".repeat(64),
    metadataPolicyDigest: "e".repeat(64),
    configSha256: startup.configSha256,
  };
  const controller = {
    schemaVersion: 1,
    lifetimeId: startup.lifetimeId,
    runtimeId: randomUUID(),
    identityDigest: sha(guardianCanonical(identity)),
    generation: 2,
    projects: { [projectId]: { phase: "checkout", admissionId, admissionGeneration: 2, checkout } },
    applications: {},
    pending: null,
    hold: false,
    sequence: 13,
    chainDigest: "0".repeat(64),
    launch: {
      runtimeId: null,
      runtimeGeneration: 2,
      policyDigest: identity.policyDigest,
      metadataPolicyDigest: identity.metadataPolicyDigest,
      nativeLaunchId: randomUUID(),
      launchIntentDigest: "f".repeat(64),
      approvals: [approval],
    },
  };
  controller.launch.runtimeId = controller.runtimeId;
  const project = {
    schemaVersion: 1,
    ownerId: oldConfig.binding.ownerId,
    workspaceId: oldConfig.binding.workspaceId,
    guardianLifetimeId: startup.lifetimeId,
    hostProcess: startup.workerIdentity,
    projects: {
      [projectId]: {
        projectId,
        repositoryId: "123",
        expectedAccountId: "456",
        task: {
          taskId,
          request,
          digest: sha(JSON.stringify(request)),
          phase: "blocked",
          reason: "native_unavailable",
          nativeCreationAttempted: false,
          firstPromptSubmissionAttempted: false,
          nativeThreadId: null,
          terminalSessionName: null,
          prepared,
          guardianPreparation: preparation,
          guardianPrepared: {
            schemaVersion: 1,
            preparationDigest: sha(JSON.stringify(preparation)),
            projectId,
            repositoryId: "123",
            taskId,
            revision: request.revision,
            leaseId,
            leaseGeneration: 1,
            checkoutIncarnation: checkout.checkoutIncarnation,
            checkoutIdentity: checkout.checkoutIdentity,
          },
          guardianAdmission: { fixture: true },
          checkoutIdentity: checkout.checkoutIdentity,
          checkoutIncarnation: checkout.checkoutIncarnation,
        },
      },
    },
  };
  const supervisor = {
    schemaVersion: 1,
    ownerId: oldConfig.binding.ownerId,
    workspaceId: oldConfig.binding.workspaceId,
    buildId: oldConfig.binding.buildId,
    status: "starting",
    hostProcess: startup.workerIdentity,
    projects: {},
    nativeProcess: null,
    executionIdentity: null,
    metadataLaunch: {
      phase: "reservationRequested",
      projectsDigest: sha(JSON.stringify([prepared])),
    },
  };
  const admitted = {
    phase: "open",
    lifetimeId: startup.lifetimeId,
    generation: 2,
    bindingDigest,
    projects: [{ projectId, bindingDigest: sha(JSON.stringify(preparation)) }],
  };
  const outer = {
    schemaVersion: 1,
    bindingDigest,
    phase: "admissionAccepted",
    receipts: [],
    events: [
      "begin",
      "ready",
      "launchIntent",
      "open",
      "startupReady",
      "admissionIntent",
      "admissionAccepted",
    ].map((name, i) => ({
      name,
      at: i + 1,
      value: i === 4 ? startup : i === 6 ? admitted : { lifetimeId: startup.lifetimeId },
    })),
  };
  const save = () => {
    writeFileSync(join(guard, "lifetime.json"), mac(outer, keys.guard), { mode: 0o600 });
    writeFileSync(
      join(guard, "controller.json"),
      JSON.stringify({
        state: controller,
        signature: sign(
          null,
          Buffer.from(guardianCanonical(controller)),
          keypair.privateKey,
        ).toString("base64url"),
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(projects, "projects.json"), mac(project, keys.projects), { mode: 0o600 });
    writeFileSync(join(native, "registry.json"), mac(supervisor, keys.native), { mode: 0o600 });
  };
  save();
  const run = () =>
    prepareUnstartedTransfer({
      home,
      config,
      configSha256,
      packageManifestSha256,
      outerRaw: readFileSync(join(guard, "lifetime.json")),
      nextBindingDigest: sha(
        JSON.stringify({ schemaVersion: 1, configSha256, packageManifestSha256 }),
      ),
      oldConfigRaw,
    });
  return {
    home,
    root,
    guard,
    projects,
    native,
    config,
    project,
    controller,
    supervisor,
    outer,
    save,
    run,
    projectId,
    taskId,
    keys,
    keypair,
  };
}

test("reservation-only transfer preserves the exact task, lease and lock inodes before the new constructor", async (t) => {
  const f = fixture(t),
    original = JSON.stringify(f.project.projects[f.projectId].task),
    locks = [join(f.projects, "controller.lock"), join(f.native, "supervisor.lock")].map(
      (p) => lstatSync(p).ino,
    ),
    proof = f.run();
  assert.equal(readUnstartedTransfer(f.home).transferId, proof.transferId);
  assert.equal(existsSync(join(f.guard, "controller.json")), false);
  assert.equal(existsSync(join(f.native, "registry.json")), false);
  const held = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state;
  assert.equal(JSON.stringify(held.projects[f.projectId].task), original);
  assert.deepEqual(
    [join(f.projects, "controller.lock"), join(f.native, "supervisor.lock")].map(
      (p) => lstatSync(p).ino,
    ),
    locks,
  );
  assert.equal(
    verifyUnstartedProject(f.home, held, held.projects[f.projectId], f.config.binding.buildId)
      .transferId,
    proof.transferId,
  );
  assert.deepEqual(
    f.run(),
    proof,
    "interrupted active-file advancement replays exact archived bytes",
  );
  const guardian = {
    state: { phase: "open", lifetimeId: randomUUID(), generation: 1, projects: [] },
    admit() {
      throw Error("unexpected admit");
    },
    executionFence() {
      throw Error("unexpected fence");
    },
    assertAdmission() {
      throw Error("unexpected assert");
    },
  };
  const c = createProjectController(
    {
      stateDirectory: f.projects,
      ownerId: f.config.binding.ownerId,
      workspaceId: f.config.binding.workspaceId,
      model: "gpt-6.1-sol",
      effort: "low",
    },
    { guardian, guardianBuildId: f.config.binding.buildId },
  );
  await assert.rejects(c.handle("/projects/open", {}), /retry_not_available/);
  const after = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state;
  assert.equal(JSON.stringify(after.projects[f.projectId].task), original);
  await c.close();
});

test("single-project transfer descriptors leave the signed inspection inside the unchanged32KiB frame", (t) => {
  const f = fixture(t),
    proof = f.run();
  // Footprint only: widen supported descriptor values without claiming these
  // synthetic widths form a separately signed/authorized predecessor.
  const max = (value, key = "") =>
    Array.isArray(value)
      ? value.map((v) => max(v))
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, max(v, k)]))
        : ["device", "inode"].includes(key)
          ? "9".repeat(24)
          : ["repositoryId", "providerAccountId"].includes(key)
            ? "9".repeat(20)
            : value;
  const widened = max(proof);
  assert.ok(Buffer.byteLength(JSON.stringify(widened)) <= 16384);
  const response = {
    schemaVersion: 1,
    scope: {
      recoveryId: randomUUID(),
      ownerId: proof.ownerId,
      coderOwnerId: proof.coderOwnerId,
      projectId: proof.projectId,
      taskId: proof.taskId,
      workspaceId: proof.workspaceId,
      originalRequestId: proof.requestId,
      intentVersion: "v".repeat(64),
      intentDigest: "a".repeat(64),
      hostRequestDigest: proof.hostRequestDigest,
      repositoryId: "9".repeat(20),
      providerAccountId: "9".repeat(20),
      revision: proof.sourceSha,
    },
    inspection: {
      outcome: "existing_preexecution",
      taskFingerprint: "a".repeat(64),
      buildId: proof.newBuildId,
      lifetimeId: randomUUID(),
      guardianGeneration: 1,
    },
    identity: {
      schemaVersion: 1,
      nonce: "a".repeat(64),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30000,
      identity: {
        outerPublicKeyPem: "k".repeat(512),
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`boundedIdentity${i}`, "a".repeat(64)]),
        ),
      },
      startup: {
        ...f.outer.events[4].value,
        outerIdentity: {
          ...f.outer.events[4].value.outerIdentity,
          executable: `/${"x".repeat(511)}`,
        },
        guardianIdentity: {
          ...f.outer.events[4].value.guardianIdentity,
          executable: `/${"x".repeat(511)}`,
        },
        workerIdentity: {
          ...f.outer.events[4].value.workerIdentity,
          executable: `/${"x".repeat(511)}`,
        },
      },
      unstartedTransfer: widened,
      proof: "a".repeat(86),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 32768);
});

for (const mode of [
  "reserved",
  "native",
  "prompt",
  "thread",
  "project",
  "hold",
  "pending",
  "package",
  "key",
  "build",
  "history",
])
  test(`unstarted transfer holds ${mode} before advancing active journals`, (t) => {
    const f = fixture(t);
    if (mode === "reserved") f.supervisor.metadataLaunch.phase = "reserved";
    if (mode === "native") f.supervisor.nativeProcess = { pid: 123 };
    if (mode === "prompt")
      f.project.projects[f.projectId].task.firstPromptSubmissionAttempted = true;
    if (mode === "thread") f.project.projects[f.projectId].task.nativeThreadId = "already-started";
    if (mode === "project") f.supervisor.projects.unknown = {};
    if (mode === "hold") f.controller.hold = true;
    if (mode === "pending") f.controller.pending = { action: "launch" };
    if (mode === "package") f.outer.events[4].value.packageManifestSha256 = "0".repeat(64);
    if (mode === "build") f.supervisor.buildId = randomUUID();
    f.save();
    if (mode === "key")
      writeFileSync(
        join(f.guard, "controller-key.pem"),
        generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
      );
    if (mode === "history")
      writeFileSync(join(f.native, "registry-old.json"), "{}", { mode: 0o600 });
    const before = readFileSync(join(f.projects, "projects.json"));
    assert.throws(f.run, /unstarted_transfer_rejected/);
    assert.ok(readFileSync(join(f.projects, "projects.json")).equals(before));
    assert.equal(existsSync(join(f.guard, "unstarted-transfer.json")), false);
    assert.equal(existsSync(join(f.guard, "controller.json")), true);
  });

for (const name of [
  "outer.json",
  "controller.json",
  "project.json",
  "supervisor.json",
  "config.json",
  "proof.json",
])
  for (const mutation of ["tamper", "delete"])
    test(`current identity and recovery hold after archived ${name} ${mutation}`, async (t) => {
      const f = fixture(t),
        proof = f.run(),
        archive = join(f.guard, `unstarted-${proof.transferId}`),
        path = join(archive, name);
      const guardian = {
        state: { phase: "open", lifetimeId: randomUUID(), generation: 1, projects: [] },
        admit() {},
        executionFence() {},
        assertAdmission() {},
      };
      const controller = createProjectController(
        {
          stateDirectory: f.projects,
          ownerId: f.config.binding.ownerId,
          workspaceId: f.config.binding.workspaceId,
          model: "gpt-6.1-sol",
          effort: "low",
        },
        { guardian, guardianBuildId: f.config.binding.buildId },
      );
      if (mutation === "delete") rmSync(path);
      else writeFileSync(path, "{}");
      assert.throws(() => readUnstartedTransfer(f.home));
      const active = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state;
      assert.throws(() =>
        verifyUnstartedProject(
          f.home,
          active,
          active.projects[f.projectId],
          f.config.binding.buildId,
        ),
      );
      await controller.close();
    });

test("an exact live predecessor actor holds before any active journal changes", (t) => {
  const f = fixture(t);
  f.outer.events[4].value.outerIdentity = processIdentity(process.pid);
  f.save();
  assert.throws(f.run, /unstarted_transfer_rejected/);
  assert.equal(existsSync(join(f.guard, "unstarted-transfer.json")), false);
});

test("normal stop's exact controller-abort journal retires only the proven unused reservation", (t) => {
  const f = fixture(t),
    admitted = f.outer.events[6].value;
  f.outer.events.push({
    name: "indeterminate",
    at: 8,
    value: { ...admitted, reason: "guardian_controller_abort" },
  });
  f.outer.phase = "indeterminate";
  f.save();
  assert.equal(f.run().oldRuntimeId, f.controller.runtimeId);
});
test("other uncertain outer termination remains held", (t) => {
  const f = fixture(t),
    admitted = f.outer.events[6].value;
  f.outer.events.push({
    name: "indeterminate",
    at: 8,
    value: { ...admitted, reason: "guardian_admission_uncertain" },
  });
  f.outer.phase = "indeterminate";
  f.save();
  assert.throws(f.run, /unstarted_transfer_rejected/);
});

for (const failure of ["lease_ack", "admission", "fence", "remount_admission", "remount_fence"])
  test(`owner consume recovers ${failure} failure once without changing request or lease`, async (t) => {
    const f = fixture(t),
      original = structuredClone(f.project.projects[f.projectId].task),
      proof = f.run();
    const lifetimeId = randomUUID(),
      remount = failure.startsWith("remount_"),
      mode = failure.replace("remount_", "");
    let opens = 0,
      admits = 0,
      renewCalls = 0,
      leaseWrites = 0,
      fences = 0;
    const guardian = {
      state: {
        phase: "open",
        lifetimeId,
        generation: 1,
        projects: [],
        bindingDigest: "a".repeat(64),
        ownershipDigest: "b".repeat(64),
      },
      identity: async () => ({ identity: { lifetimeId }, startup: { generation: 1 } }),
      admit: async (value) => {
        admits++;
        if (mode === "admission" && admits === 1) throw Error("fixture_admission_failed");
        guardian.state.generation = 2;
        guardian.state.projects = [value];
        return {
          projectId: value.projectId,
          projectBindingDigest: value.bindingDigest,
          lifetimeId,
          generation: 2,
          bindingDigest: guardian.state.bindingDigest,
          ownershipDigest: guardian.state.ownershipDigest,
        };
      },
      executionFence: async (token) => {
        fences++;
        if (mode === "fence" && fences === 1) throw Error("fixture_fence_failed");
        return token;
      },
      assertAdmission() {},
    };
    const ready = {
      status: "ready",
      checkoutVerified: true,
      revision: original.request.revision,
      checkoutIncarnation: original.checkoutIncarnation,
      checkoutIdentity: original.checkoutIdentity,
      lease: {
        taskId: original.taskId,
        id: original.prepared.leaseId,
        generation: original.prepared.leaseGeneration,
        expiresAt: Date.now() / 1000 - 7200,
      },
    };
    const c = createProjectController(
      {
        stateDirectory: f.projects,
        ownerId: f.config.binding.ownerId,
        workspaceId: f.config.binding.workspaceId,
        model: "gpt-6.1-sol",
        effort: "low",
      },
      {
        guardian,
        guardianBuildId: f.config.binding.buildId,
        inspectCheckout: async () => ready,
        inspectUnstartedCheckout: async () => ready,
        revalidateUnstartedLease: async () => {
          renewCalls++;
          if (renewCalls === 1) leaseWrites++;
          if (mode === "lease_ack" && renewCalls === 1) throw Error("fixture_lease_ack_lost");
          return {
            ...ready,
            renewalSequence: 1,
            ...(remount ? { checkoutIdentity: ready.remount.mapping.current.checkout } : {}),
            lease: { ...ready.lease, expiresAt: Date.now() / 1000 + 3600 },
          };
        },
        openRuntime: async () => {
          opens++;
          throw Error("fixture_stop_before_native");
        },
      },
    );
    const scope = {
      recoveryId: randomUUID(),
      ownerId: proof.ownerId,
      coderOwnerId: proof.coderOwnerId,
      projectId: proof.projectId,
      taskId: proof.taskId,
      workspaceId: proof.workspaceId,
      originalRequestId: proof.requestId,
      intentVersion: "fixture-version",
      intentDigest: "a".repeat(64),
      hostRequestDigest: proof.hostRequestDigest,
      repositoryId: proof.repositoryId,
      providerAccountId: proof.providerAccountId,
      revision: proof.sourceSha,
    };
    const request = { schemaVersion: 1, scope };
    if (remount) {
      const old = original.checkoutIdentity,
        current = { ...old, device: String(Number(old.device) + 1) },
        mapping = {
          old: { root: { ...old, inode: "10" }, project: { ...old, inode: "11" }, checkout: old },
          current: {
            root: { ...current, inode: "10" },
            project: { ...current, inode: "11" },
            checkout: current,
          },
          oldRootRecordSha256: "d".repeat(64),
          oldProjectRecordSha256: "e".repeat(64),
          oldLeaseDigest: "f".repeat(64),
        };
      const volume = {
        pvcUid: randomUUID(),
        pvcName: "fixture-home",
        namespace: "coder",
        storageClass: "longhorn",
        capacity: "20Gi",
        boundVolumeName: "pvc-fixture",
        accessModes: ["ReadWriteOnce"],
        containerName: "dev",
        podVolumeName: "home",
        mountPath: "/home/coder",
        subPath: "",
        subPathExpr: "",
        readOnly: false,
        claimReadOnly: false,
      };
      request.continuity = {
        attestationDigest: "a".repeat(64),
        continuationDigest: "b".repeat(64),
        originalProofDigest: recoveryDigest(proof),
        recoveryId: scope.recoveryId,
        ownerId: scope.ownerId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        taskId: scope.taskId,
        final: {
          buildId: f.config.binding.buildId,
          lifetimeId,
          configSha256: proof.newConfigSha256,
          packageManifestSha256: proof.newPackageManifestSha256,
        },
        volume,
        mapping,
        expiresAt: Date.now() + 60000,
      };
      ready.remount = {
        attestationDigest: request.continuity.attestationDigest,
        continuationDigest: request.continuity.continuationDigest,
        mappingDigest: recoveryDigest(mapping),
        volumeDigest: recoveryDigest(volume),
        mapping,
      };
    }
    await assert.rejects(
      c.handle("/projects/tasks/recovery-inspect", request),
      /retry_not_available/,
    );
    assert.equal(admits, 0);
    assert.equal(opens, 0);
    guardian.state.unstartedTransfer = {
      transferId: proof.transferId,
      oldRuntimeId: proof.oldRuntimeId,
      proofDigest: recoveryDigest(proof),
    };
    const inspection = await c.handle("/projects/tasks/recovery-inspect", request);
    if (remount)
      assert.deepEqual(
        await c.handle("/projects/tasks/recovery-inspect", request),
        inspection,
        "lost inspection ACK replays exact stable continuity/inspection",
      );
    const authorization = {
      inspectionDigest: recoveryDigest(inspection.inspection),
      authorizedVersion: "fixture-authorized",
      buildId: f.config.binding.buildId,
      lifetimeId,
      expiresAt: Date.now() + 30000,
    };
    const consume = { schemaVersion: 1, scope, authorization };
    await assert.rejects(
      c.handle("/projects/tasks/recovery-consume", consume),
      /fixture_(?:lease_ack_lost|admission_failed|fence_failed)/,
    );
    const held = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state;
    assert.equal(Boolean(held.unstartedTransferConsumed), false);
    assert.equal(held.projects[f.projectId].recovery.phase, "held");
    assert.deepEqual(held.projects[f.projectId].task.request, original.request);
    if (mode !== "lease_ack") {
      assert.equal(
        held.projects[f.projectId].task.guardianPreparation.buildId,
        f.config.binding.buildId,
      );
      const altered = structuredClone(held);
      altered.projects[f.projectId].task.request.text = "substituted";
      assert.throws(() =>
        verifyUnstartedProject(
          f.home,
          altered,
          altered.projects[f.projectId],
          f.config.binding.buildId,
        ),
      );
    }
    if (mode === "fence" && !remount) {
      const projectPath = join(f.projects, "projects.json"),
        originalHeld = readFileSync(projectPath),
        consuming = structuredClone(held),
        runtimeId = randomUUID();
      consuming.projects[f.projectId].recovery.phase = "consuming";
      writeFileSync(projectPath, mac(consuming, f.keys.projects));
      const current = {
        lifetimeId,
        runtimeId,
        generation: 2,
        launch: null,
        hold: true,
        projects: {
          [f.projectId]: {
            phase: "checkout",
            preparationDigest: sha(
              JSON.stringify(consuming.projects[f.projectId].task.guardianPreparation),
            ),
            checkout: proof.checkout,
          },
        },
        pending: { action: "fence", runtimeId, runtimeGeneration: 2, projectId: f.projectId },
        unstartedTransferReceipt: guardian.state.unstartedTransfer,
      };
      const saveCurrent = () =>
        writeFileSync(
          join(f.guard, "controller.json"),
          JSON.stringify({
            state: current,
            signature: sign(
              null,
              Buffer.from(guardianCanonical(current)),
              f.keypair.privateKey,
            ).toString("base64url"),
          }),
          { mode: 0o600 },
        );
      saveCurrent();
      assert.equal(unstartedLeaseAuthority(f.home, f.projectId, process.pid).replayOnly, true);
      for (const action of ["native", "launch"]) {
        current.pending.action = action;
        saveCurrent();
        assert.throws(() => unstartedLeaseAuthority(f.home, f.projectId, process.pid));
      }
      current.pending.action = "fence";
      current.pending.projectId = randomUUID();
      saveCurrent();
      assert.throws(() => unstartedLeaseAuthority(f.home, f.projectId, process.pid));
      current.pending.projectId = f.projectId;
      saveCurrent();
      consuming.projects[f.projectId].recovery.authorization.expiresAt = Date.now() - 1;
      writeFileSync(projectPath, mac(consuming, f.keys.projects));
      assert.throws(() => unstartedLeaseAuthority(f.home, f.projectId, process.pid));
      writeFileSync(projectPath, originalHeld);
    }
    const receipt = await c.handle("/projects/tasks/recovery-consume", consume);
    assert.deepEqual(await c.handle("/projects/tasks/recovery-consume", consume), receipt);
    await c.close();
    const active = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state,
      task = active.projects[f.projectId].task;
    assert.deepEqual(task.request, original.request);
    assert.deepEqual(task.prepared, original.prepared);
    assert.equal(task.nativeCreationAttempted, false);
    assert.equal(task.firstPromptSubmissionAttempted, false);
    assert.equal(task.guardianPreparation.buildId, f.config.binding.buildId);
    assert.deepEqual(
      active.unstartedTransferHistory.guardianPreparation,
      original.guardianPreparation,
    );
    assert.equal(active.unstartedTransferConsumed, true);
    if (remount) {
      assert.deepEqual(task.checkoutIdentity, ready.remount.mapping.current.checkout);
      assert.deepEqual(task.guardianPrepared.checkoutIdentity, task.checkoutIdentity);
      assert.deepEqual(active.unstartedTransferHistory.remount, ready.remount);
    }
    assert.equal(admits, mode === "admission" ? 2 : 1);
    assert.equal(leaseWrites, 1);
    assert.equal(renewCalls, 2);
    assert.ok(opens <= 1);
  });

for (const tampered of [false, true])
  test(`interrupted project rename ${tampered ? "rejects tampered" : "finishes exact"} signed temporary bytes`, (t) => {
    const f = fixture(t),
      proof = f.run(),
      archive = join(f.guard, `unstarted-${proof.transferId}`),
      active = join(f.projects, "projects.json"),
      held = readFileSync(active),
      original = readFileSync(join(archive, "project.json"));
    writeFileSync(active, original);
    renameSync(join(archive, "controller-active.json"), join(f.guard, "controller.json"));
    renameSync(join(archive, "supervisor-active.json"), join(f.native, "registry.json"));
    writeFileSync(`${active}.unstarted-tmp`, tampered ? Buffer.from("{}") : held, { mode: 0o600 });
    if (tampered) {
      assert.throws(f.run, /unstarted_transfer_rejected/);
      assert.ok(readFileSync(active).equals(original));
      assert.ok(existsSync(`${active}.unstarted-tmp`));
    } else {
      assert.equal(f.run().transferId, proof.transferId);
      assert.ok(readFileSync(active).equals(held));
      assert.equal(existsSync(`${active}.unstarted-tmp`), false);
    }
  });

function unusedHopFixture(t) {
  const f = fixture(t, { intermediate: true }),
    proof = f.run(),
    oldConfigRaw = Buffer.from(JSON.stringify(f.config)),
    lifetimeId = randomUUID(),
    ps = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state,
    oldStart = {
      ...f.outer.events[4].value,
      lifetimeId,
      configSha256: sha(oldConfigRaw),
      packageManifestSha256: proof.newPackageManifestSha256,
      projects: [],
      ownershipDigest: sha(JSON.stringify([])),
    };
  ps.guardianLifetimeId = lifetimeId;
  writeFileSync(join(f.projects, "projects.json"), mac(ps, f.keys.projects));
  const state = {
    schemaVersion: 1,
    bindingDigest: oldStart.bindingDigest,
    phase: "startupReady",
    receipts: [],
    events: ["begin", "ready", "launchIntent", "open", "startupReady"].map((name) => ({
      name,
      value: oldStart,
    })),
  };
  writeFileSync(join(f.guard, "lifetime.json"), mac(state, f.keys.guard));
  const config = structuredClone(f.config);
  config.binding.buildId = randomUUID();
  const configRaw = Buffer.from(JSON.stringify(config)),
    args = {
      home: f.home,
      config,
      configSha256: sha(configRaw),
      packageManifestSha256: "d".repeat(64),
      outerRaw: readFileSync(join(f.guard, "lifetime.json")),
      oldConfigRaw,
    };
  return { ...f, proof, lifetimeId, args, configRaw, oldStart };
}
test("one unused held epoch preserves original proof and uses an independently observed final endpoint", (t) => {
  const f = unusedHopFixture(t),
    original = readFileSync(join(f.guard, "unstarted-transfer.json")),
    task = JSON.stringify(f.project.projects[f.projectId].task),
    hop = prepareUnusedEpochHop(f.args);
  assert.equal(hop.hop.buildId, f.proof.newBuildId);
  assert.equal(hop.hop.oldJournalDigests.supervisor, null);
  assert.equal(hop.hop.oldJournalDigests.controller, null);
  assert.deepEqual(readFileSync(join(f.guard, "unstarted-transfer.json")), original);
  const held = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state;
  assert.equal(JSON.stringify(held.projects[f.projectId].task), task);
  assert.equal(held.guardianLifetimeId, undefined);
  assert.equal(effectiveUnstartedBuild(f.home, f.proof), f.args.config.binding.buildId);
  assert.deepEqual(
    prepareUnusedEpochHop(f.args),
    hop,
    "exact pre-start archive replay is idempotent",
  );
  mkdirSync(join(f.home, ".config/hive"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.home, ".config/hive/codex-host.json"), f.configRaw, { mode: 0o600 });
  const final = {
      lifetimeId: randomUUID(),
      configSha256: f.args.configSha256,
      packageManifestSha256: f.args.packageManifestSha256,
    },
    wire = readUnstartedTransferContinuation(f.home, final);
  assert.equal(wire.originalProofDigest, recoveryDigest(f.proof));
  assert.equal(wire.finalSuccessor.lifetimeId, final.lifetimeId);
  assert.equal(Object.hasOwn(wire, "attestationDigest"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < 4096);
  assert.throws(
    () =>
      prepareUnusedEpochHop({
        ...f.args,
        config: { ...f.args.config, binding: { ...f.args.config.binding, buildId: randomUUID() } },
      }),
    /unstarted_transfer_rejected/,
  );
});
for (const bad of ["live-actor", "native-controller", "changed-task", "unknown-package"])
  test(`unused held epoch rejects ${bad} before changing original active project`, (t) => {
    const f = unusedHopFixture(t);
    if (bad === "live-actor") {
      const s = JSON.parse(f.args.outerRaw).state;
      s.events[4].value.outerIdentity = processIdentity(process.pid);
      f.args.outerRaw = mac(s, f.keys.guard);
    } else if (bad === "native-controller") {
      const c = {
        lifetimeId: f.lifetimeId,
        generation: 1,
        runtimeId: randomUUID(),
        pending: null,
        hold: false,
        launch: null,
        projects: {},
        applications: {},
      };
      writeFileSync(
        join(f.guard, "controller.json"),
        JSON.stringify({
          state: c,
          signature: sign(null, Buffer.from(guardianCanonical(c)), f.keypair.privateKey).toString(
            "base64url",
          ),
        }),
        { mode: 0o600 },
      );
    } else if (bad === "changed-task") {
      const state = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state;
      state.projects[f.projectId].task.nativeCreationAttempted = true;
      writeFileSync(join(f.projects, "projects.json"), mac(state, f.keys.projects));
    } else {
      f.args.oldConfigRaw = Buffer.from("{}");
    }
    const before = readFileSync(join(f.projects, "projects.json"));
    assert.throws(() => prepareUnusedEpochHop(f.args), /unstarted_transfer_rejected/);
    assert.deepEqual(readFileSync(join(f.projects, "projects.json")), before);
    assert.equal(existsSync(join(f.guard, "unstarted-epoch-hop.json")), false);
  });
test("unused epoch archive tampering holds identity construction", (t) => {
  const f = unusedHopFixture(t),
    hop = prepareUnusedEpochHop(f.args),
    file = join(f.guard, `unused-epoch-${hop.hop.lifetimeId}`, "project.json");
  writeFileSync(file, "{}");
  assert.throws(() => effectiveUnstartedBuild(f.home, f.proof), /unstarted_transfer_rejected/);
});

test("unused epoch replays a crash after authenticated empty controller move", (t) => {
  const f = unusedHopFixture(t),
    c = {
      schemaVersion: 1,
      lifetimeId: f.lifetimeId,
      generation: 1,
      runtimeId: null,
      pending: null,
      hold: false,
      launch: null,
      projects: {},
      applications: {},
    };
  writeFileSync(
    join(f.guard, "controller.json"),
    JSON.stringify({
      state: c,
      signature: sign(null, Buffer.from(guardianCanonical(c)), f.keypair.privateKey).toString(
        "base64url",
      ),
    }),
    { mode: 0o600 },
  );
  const result = prepareUnusedEpochHop(f.args);
  assert.equal(existsSync(join(f.guard, "controller.json")), false);
  assert.equal(typeof result.hop.oldJournalDigests.controller, "string");
  assert.deepEqual(
    prepareUnusedEpochHop(f.args),
    result,
    "same outer lifetime is still active before journal rename",
  );
});

test("v1 recovery and installed two-task reuse observe the official guardian while unknown nondumpable holders block", async (t) => {
  const nodeMetadata = (file) => {
    try {
      const path = realpathSync(file),
        s = statSync(path);
      return {
        path,
        uid: s.uid,
        mode: s.mode & 0o777,
        file: s.isFile(),
        safe: s.isFile() && s.uid === 0 && !(s.mode & 0o022),
      };
    } catch {
      return { path: file, safe: false };
    }
  };
  const currentNode = nodeMetadata(process.execPath);
  if (!currentNode.safe) {
    const candidates = ["/usr/local/bin/node", "/usr/bin/node"].map(nodeMetadata);
    const chosen = candidates.find((candidate) => {
      if (!candidate.safe) return false;
      try {
        const major = Number(
          execFileSync(candidate.path, ["-p", "process.versions.node.split('.')[0]"], {
            timeout: 2000,
          })
            .toString()
            .trim(),
        );
        candidate.major = major;
        return major >= 20;
      } catch {
        return false;
      }
    });
    assert.ok(
      chosen,
      `No supported root-owned non-writable fixture Node: ${JSON.stringify({ current: currentNode, candidates })}`,
    );
    t.diagnostic(
      `Fixture Node reexec: ${JSON.stringify(chosen)}; composition only, not production Node24 readiness`,
    );
    execFileSync(
      chosen.path,
      [
        "--test",
        "--test-name-pattern=^v1 recovery and installed two-task reuse",
        new URL(import.meta.url).pathname,
      ],
      { cwd: process.cwd(), stdio: "pipe", timeout: 30000 },
    );
    return;
  }
  assert.ok(Number(process.versions.node.split(".")[0]) >= 20, "Fixture requires Node20+ APIs");
  t.diagnostic(
    `Fixture Node major ${process.versions.node.split(".")[0]}, canonical UID ${currentNode.uid}, mode ${currentNode.mode.toString(8)}`,
  );
  const buildDirectory = mkdtempSync(join(tmpdir(), "hive-observer-package-"));
  t.after(() => rmSync(buildDirectory, { recursive: true, force: true }));
  const artifact = await hostArchive(resolve("."));
  const archive = join(buildDirectory, "host.tar.xz");
  writeFileSync(archive, artifact.compressed);
  const python = "/usr/bin/python3",
    manifest = JSON.parse(
      execFileSync(python, [
        "-I",
        "-c",
        "import lzma,tarfile,io,json,sys,hashlib;b=tarfile.open(fileobj=io.BytesIO(lzma.decompress(open(sys.argv[1],'rb').read()))).extractfile('package-manifest.json').read();print(json.dumps({'digest':hashlib.sha256(b).hexdigest()}))",
        archive,
      ]),
    );
  const f = fixture(t, { currentPackageManifest: manifest.digest }),
    original = f.project.projects[f.projectId].task,
    packageRoot = join(f.home, ".local/share/hive/codex-host"),
    managedSource = resolve("templates/ai-dev-k8s/scripts/managed-projects.py");
  const prepared = JSON.parse(
    execFileSync(
      python,
      [
        "-I",
        "-c",
        String.raw`import pathlib,sys,json,lzma,tarfile,io,hashlib,os,importlib.util,subprocess,time
p=json.load(sys.stdin);home=pathlib.Path(p['home']);raw=lzma.decompress(pathlib.Path(p['archive']).read_bytes());directory=home/'.local/share/hive/codex-host'/hashlib.sha256(raw).hexdigest();directory.mkdir(parents=True,mode=0o700);directory.parent.chmod(0o700)
with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
 for member in archive:
  assert member.isfile() and not member.name.startswith('/') and '..' not in pathlib.PurePath(member.name).parts
  dest=directory/member.name;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);dest.write_bytes(archive.extractfile(member).read());dest.chmod(0o400 if member.name.endswith('.json') else 0o500)
(home/'.local/state/hive/codex-host-install').mkdir(mode=0o700);(home/'.local/state/hive/codex-host-install/process.json').write_text(json.dumps({'archiveSha256':hashlib.sha256(raw).hexdigest()}));(home/'.local/state/hive/codex-host-install/process.json').chmod(0o600)
spec=importlib.util.spec_from_file_location('fixture_managed',p['source']);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m);manager=m.ManagedProjects(home)
with manager.lock():
 project,receipt=manager.paths('123');project.mkdir(parents=True,mode=0o700);checkout=project/'checkout';checkout.mkdir(mode=0o700)
 def git(*args):return subprocess.check_output(['git','-C',str(checkout),'-c','user.name=Fixture','-c','user.email=fixture@example.com',*args],stderr=subprocess.DEVNULL).decode().strip()
 git('init','-b','main');git('remote','add','origin','https://github.com/owner/repository.git');(checkout/'README.md').write_text('fixture\n');git('add','.');git('commit','-m','test: fixture');revision=git('rev-parse','HEAD')
 record={'provider':'github','repositoryId':'123','canonicalUrl':'https://github.com/owner/repository.git','projectIdentity':manager.identity(project),'checkoutIdentity':manager.identity(checkout),'checkoutIncarnation':p['incarnation'],'status':'ready','revision':revision,'leaseGeneration':p['generation'],'lease':{'id':p['leaseId'],'taskId':p['taskId'],'generation':p['generation'],'expiresAt':time.time()-7200},'renewalSequence':0,'lastTaskId':p['taskId'],'stages':[],'cleanupRequests':[],'gitConfigPolicy':1,'gitConfigDigest':manager.config_digest(checkout/'.git/config')}
 manager.write(receipt,record)
 print(json.dumps({'directory':str(directory),'revision':revision,'checkoutIdentity':{k:str(v) for k,v in record['checkoutIdentity'].items()},'recordFile':str(receipt)}))`,
      ],
      {
        input: JSON.stringify({
          home: f.home,
          archive,
          source: managedSource,
          taskId: original.taskId,
          leaseId: original.prepared.leaseId,
          generation: original.prepared.leaseGeneration,
          incarnation: original.checkoutIncarnation,
        }),
      },
    ),
  );
  original.request.revision = prepared.revision;
  original.digest = sha(JSON.stringify(original.request));
  original.guardianPreparation.baseSha = prepared.revision;
  original.guardianPreparation.requestDigest = original.digest;
  original.guardianPrepared.revision = prepared.revision;
  original.guardianPrepared.preparationDigest = sha(JSON.stringify(original.guardianPreparation));
  Object.assign(original.checkoutIdentity, prepared.checkoutIdentity);
  f.controller.projects[f.projectId].checkout.revision = prepared.revision;
  f.controller.launch.approvals[0].revision = prepared.revision;
  f.outer.events[6].value.projects[0].bindingDigest = sha(
    JSON.stringify(original.guardianPreparation),
  );
  f.save();
  const proof = f.run();
  const journalEvents = {},
    journal = Object.fromEntries(
      [
        "begin",
        "ready",
        "launchIntent",
        "admissionIntent",
        "admissionAccepted",
        "closeIntent",
        "acceptReceipt",
        "indeterminate",
      ].map((name) => [
        name,
        async (value) => {
          journalEvents[name] = value;
        },
      ]),
    ),
    node = process.execPath,
    guardianBinary = join(prepared.directory, "codex-native-guardian"),
    guardian = await openNativeGuardian({
      executable: guardianBinary,
      sha256: sha(readFileSync(guardianBinary)),
      bindingDigest: "a".repeat(64),
      projects: [],
      roots: [
        {
          id: "host-worker",
          role: "host",
          workerChannel: true,
          executable: node,
          sha256: sha(readFileSync(node)),
          cwd: packageRoot,
          args: [join(prepared.directory, "codex-workspace-host-worker.mjs")],
          env: { PATH: "/usr/bin:/bin" },
        },
      ],
      journal,
      authorizeDrain: async () => [],
    });
  try {
    const lifetimeId = guardian.state.lifetimeId,
      startup = {
        ...journalEvents.begin,
        lifetimeId,
        configSha256: proof.newConfigSha256,
        packageManifestSha256: proof.newPackageManifestSha256,
        guardianSha256: sha(readFileSync(guardianBinary)),
        nodeSha256: sha(readFileSync(node)),
        outerIdentity: { ...processIdentity(process.pid), parentPid: process.ppid },
        guardianIdentity: { ...guardian.state.guardianIdentity, parentPid: process.pid },
        workerIdentity: processIdentity(process.pid),
      },
      life = {
        schemaVersion: 1,
        bindingDigest: "a".repeat(64),
        phase: "startupReady",
        receipts: [],
        events: ["begin", "ready", "launchIntent", "open", "startupReady"].map((name) => ({
          name,
          value: startup,
        })),
      };
    writeFileSync(join(f.guard, "lifetime.json"), mac(life, f.keys.guard));
    const state = JSON.parse(readFileSync(join(f.projects, "projects.json"))).state,
      p = state.projects[f.projectId],
      scope = {
        recoveryId: randomUUID(),
        ownerId: proof.ownerId,
        coderOwnerId: proof.coderOwnerId,
        workspaceId: proof.workspaceId,
        projectId: proof.projectId,
        taskId: proof.taskId,
        hostRequestDigest: proof.hostRequestDigest,
        originalRequestId: proof.requestId,
        revision: proof.sourceSha,
      },
      inspection = {
        outcome: "existing_preexecution",
        taskFingerprint: recoveryDigest(p.task),
        buildId: proof.newBuildId,
        lifetimeId,
        guardianGeneration: 1,
      };
    state.hostProcess = processIdentity(process.pid);
    state.guardianLifetimeId = lifetimeId;
    p.recovery = {
      phase: "consuming",
      scope,
      inspection,
      authorization: {
        buildId: proof.newBuildId,
        lifetimeId,
        inspectionDigest: recoveryDigest(inspection),
        expiresAt: Date.now() + 30000,
      },
    };
    writeFileSync(join(f.projects, "projects.json"), mac(state, f.keys.projects));
    const current = {
      lifetimeId,
      runtimeId: randomUUID(),
      generation: 1,
      pending: null,
      hold: false,
      launch: null,
      projects: {},
      unstartedTransferReceipt: {
        transferId: proof.transferId,
        oldRuntimeId: proof.oldRuntimeId,
        proofDigest: recoveryDigest(proof),
      },
    };
    writeFileSync(
      join(f.guard, "controller.json"),
      JSON.stringify({
        state: current,
        signature: sign(
          null,
          Buffer.from(guardianCanonical(current)),
          f.keypair.privateKey,
        ).toString("base64url"),
      }),
      { mode: 0o600 },
    );
    const result = JSON.parse(
      execFileSync(
        python,
        [
          "-I",
          "-c",
          String.raw`import pathlib,importlib.util,sys,os,json,subprocess,copy
from unittest import mock
sys.dont_write_bytecode=True
p=json.load(sys.stdin);spec=importlib.util.spec_from_file_location('fixture_lease',p['leaseSource']);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);manager=m.managed.ManagedProjects(p['home']);authority=m.InstalledUnstartedAuthority(p['home'],os.getppid());checkout=pathlib.Path(p['checkout']);original=pathlib.Path(p['recordFile']).read_bytes();extra=None;real_iterdir=pathlib.Path.iterdir
# Test-owned process inventory only; production enumerates every process.
def inventory(path):
 if path==pathlib.Path('/proc'):return iter(path/str(v) for v in [os.getpid(),os.getppid(),p['guardianPid'],*([extra] if extra else [])])
 return real_iterdir(path)
with mock.patch.object(pathlib.Path,'iterdir',inventory):
 child=subprocess.Popen([sys.executable,'-I','-c',"import ctypes,sys,time;f=open(sys.argv[1]);assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0;print('ready',flush=True);time.sleep(30)",str(checkout/'README.md')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  assert child.stdout.readline().strip()=='ready';extra=child.pid
  try:manager._revalidate_unstarted_lease('123',p['projectId'],authority);raise AssertionError('unknown nondumpable holder admitted')
  except m.managed.ManagedError as error:assert str(error)=='process_inspection_unavailable'
  assert pathlib.Path(p['recordFile']).read_bytes()==original
 finally:child.terminate();child.wait(timeout=3);child.stdout.close();child.stderr.close();extra=None
 first=manager._revalidate_unstarted_lease('123',p['projectId'],authority);saved=pathlib.Path(p['recordFile']).read_bytes();second=manager._revalidate_unstarted_lease('123',p['projectId'],authority);assert first==second and pathlib.Path(p['recordFile']).read_bytes()==saved
 assert first['renewalSequence']==1 and first['lease']['id']==p['leaseId'] and first['lease']['generation']==p['generation'] and first['checkoutIncarnation']==p['incarnation']
 installed=m.managed.ManagedProjects.installed(p['home'])
 class Resolver:
  def resolve(self,repository):return m.managed.VerifiedRepository(repository,'https://github.com/owner/repository.git')
 installed.resolver=Resolver()
 lease=first['lease'];released=installed.release_lease('123',lease['taskId'],lease['id'],lease['generation'],first['revision']);after_release=pathlib.Path(p['recordFile']).read_bytes()
 assert installed.release_lease('123',lease['taskId'],lease['id'],lease['generation'],first['revision'])==released and pathlib.Path(p['recordFile']).read_bytes()==after_release
 for name in ['codex-unstarted-transfer.mjs','codex-process-identity.mjs']:
  member=pathlib.Path(p['leaseSource']).with_name(name);raw=member.read_bytes();mode=member.stat().st_mode&0o777
  try:
   member.chmod(0o700);member.write_bytes(raw+b'\n// stale fixture member\n')
   real_run=m.managed.subprocess.run
   def checked_run(command,*args,**kwargs):
    assert '--input-type=module' not in command,'unverified module executed'
    return real_run(command,*args,**kwargs)
   with mock.patch.object(m.managed.subprocess,'run',side_effect=checked_run):
    try:installed.prepare('123','second-task',first['revision']);raise AssertionError('changed package admitted')
    except m.managed.ManagedError as error:assert str(error)=='sealed_guardian_package_changed'
   assert pathlib.Path(p['recordFile']).read_bytes()==after_release
  finally:member.write_bytes(raw);member.chmod(mode)
 child=subprocess.Popen([sys.executable,'-I','-c',"import ctypes,sys,time;f=open(sys.argv[1]);assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0;print('ready',flush=True);time.sleep(30)",str(checkout/'README.md')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  assert child.stdout.readline().strip()=='ready';extra=child.pid
  try:installed.prepare('123','second-task',first['revision']);raise AssertionError('unknown holder bypassed ordinary prepare')
  except m.managed.ManagedError as error:assert str(error)=='process_inspection_unavailable'
  assert pathlib.Path(p['recordFile']).read_bytes()==after_release
 finally:child.terminate();child.wait(timeout=3);child.stdout.close();child.stderr.close();extra=None
 second_task=installed.prepare('123','second-task',first['revision'])
 assert second_task['lease']['taskId']=='second-task' and second_task['lease']['generation']>lease['generation'] and second_task['checkoutIdentity']==first['checkoutIdentity'] and second_task['checkoutIncarnation']==first['checkoutIncarnation']
 try:manager.no_consumers(checkout);raise AssertionError('plain manager acquired installed observer')
 except m.managed.ManagedError as error:assert str(error)=='process_inspection_unavailable'
 print(json.dumps({'nonRemountOwnerRecovery':True,'actualInstalledAuthority':True,'unknownNondumpableHeld':True,'oneRenewal':True,'noNativeOrPrompt':True,'installedReleaseReplay':True,'twoTaskCheckoutReuse':True,'plainManagerStrict':True,'packageTamperRejectedBeforeImport':True}))`,
        ],
        {
          input: JSON.stringify({
            leaseSource: join(prepared.directory, "codex-project-lease.py"),
            home: f.home,
            checkout: dirname(prepared.recordFile).replace(
              "/.local/state/hive/managed-projects",
              "/projects/.hive-managed/github/123/checkout",
            ),
            recordFile: prepared.recordFile,
            projectId: f.projectId,
            guardianPid: guardian.state.guardianIdentity.pid,
            leaseId: original.prepared.leaseId,
            generation: original.prepared.leaseGeneration,
            incarnation: original.checkoutIncarnation,
          }),
          timeout: 10000,
        },
      ),
    );
    assert.deepEqual(result, {
      nonRemountOwnerRecovery: true,
      actualInstalledAuthority: true,
      unknownNondumpableHeld: true,
      oneRenewal: true,
      noNativeOrPrompt: true,
      installedReleaseReplay: true,
      twoTaskCheckoutReuse: true,
      plainManagerStrict: true,
      packageTamperRejectedBeforeImport: true,
    });
    for (const invalid of ["continuity", "native", "expired"]) {
      const altered = structuredClone(state),
        task = altered.projects[f.projectId];
      if (invalid === "continuity")
        task.recovery.continuity = { attestationDigest: "a".repeat(64) };
      if (invalid === "native") task.task.nativeCreationAttempted = true;
      if (invalid === "expired") task.recovery.authorization.expiresAt = Date.now() - 1;
      writeFileSync(join(f.projects, "projects.json"), mac(altered, f.keys.projects));
      assert.throws(
        () => unstartedRecoveryGuardianAuthority(f.home, f.projectId, process.pid),
        /unstarted_transfer_rejected/,
      );
    }
    writeFileSync(join(f.projects, "projects.json"), mac(state, f.keys.projects));
  } finally {
    await guardian.abort();
  }
  const closedScan = execFileSync(
    python,
    [
      "-I",
      "-c",
      String.raw`import pathlib,importlib.util,sys,json,os
from unittest import mock
sys.dont_write_bytecode=True
p=json.load(sys.stdin);spec=importlib.util.spec_from_file_location('installed_managed',p['module']);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m);manager=m.ManagedProjects.installed(p['home']);real=pathlib.Path.iterdir
with mock.patch.object(pathlib.Path,'iterdir',lambda path:iter(path/str(pid) for pid in [os.getpid(),os.getppid()]) if path==pathlib.Path('/proc') else real(path)):
 assert manager._installed_observer() is None
 manager.no_consumers(pathlib.Path(p['checkout']))
 print('strict-scan-after-exit')`,
    ],
    {
      input: JSON.stringify({
        module: join(prepared.directory, "managed-projects.py"),
        home: f.home,
        checkout: join(f.home, "projects/.hive-managed/github/123/checkout"),
      }),
    },
  );
  assert.equal(closedScan.toString().trim(), "strict-scan-after-exit");
});
