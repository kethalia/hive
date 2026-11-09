// Explicit synthetic native/input inventory, real fixed HMAC journals and outer
// reader. This fixture is never installed and grants no production authority.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GUARDIAN_CONTROLLER_POLICY_DIGEST,
  guardianCanonical,
  openGuardianController,
} from "../../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const metadataLaunch = (projectId, approval, material) => ({
  phase: "started",
  approval,
  pins: {
    metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
    pins: [{ projectId, checkout: material.checkoutIdentity, metadata: material.gitIdentity }],
  },
});
export function installedDeliveryHostFixture({
  f,
  home,
  material,
  config,
  configSha256,
  fetchImpl,
  inspect,
  diagnostics = /** @type {string[]} */ ([]),
}) {
  const projectId = f.project.id,
    nativeKey = f.keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const kernel = {
    pid: process.pid,
    startTime: "100",
    bootId: randomUUID(),
    executable: process.execPath,
    device: "1",
    inode: "2",
  };
  const startup = {
    phase: "open",
    configSha256,
    packageManifestSha256: f.guardian.runtime.packageManifestSha256,
    guardianSha256: f.guardian.runtime.guardianElfSha256,
    nodeSha256: f.guardian.runtime.nodeSha256,
    port: config.port,
    lifetimeId: f.guardian.runtime.lifetimeId,
    bindingDigest: f.guardian.runtime.bindingDigest,
    workerIdentity: { ...kernel, parentPid: 10 },
  };
  const request = {
    schemaVersion: 1,
    projectId,
    repositoryId: "123",
    expectedAccountId: "456",
    taskId: f.context.preparationIntentId,
    requestId: f.guardian.preparation.requestId,
    revision: material.revision,
    model: "gpt-6.1-sol",
    effort: "low",
    text: "Guardian storage synthetic task; no account inference",
  };
  assert.equal(sha(JSON.stringify(request)), f.guardian.preparation.requestDigest);
  const entry = Object.assign(Object.create(null), {
    threadId: f.managerThreadId,
    serverInstanceId: f.serverInstanceId,
  });
  const task = {
    taskId: f.context.preparationIntentId,
    phase: "running",
    request,
    guardianPreparation: f.guardian.preparation,
  };
  const controllerState = {
    schemaVersion: 1,
    ownerId: f.host.ownerId,
    workspaceId: f.host.workspaceId,
    guardianLifetimeId: f.guardian.runtime.lifetimeId,
    hostProcess: kernel,
    projects: { [projectId]: { projectId, repositoryId: "123", task } },
  };
  const native = {
    status: "ready",
    buildId: f.host.buildId,
    workspaceId: f.host.workspaceId,
    hostProcess: kernel,
    serverInstanceId: f.serverInstanceId,
    controllerPrivateKeyPem: nativeKey,
    controllerRegistration: { status: "registered", grantId: f.registration().id },
    projects: { [projectId]: entry },
    metadataLaunch: metadataLaunch(projectId, f.guardian.launch, material),
    executionIdentity: { mode: "isolated" },
  };
  const journal = (name, file, keyName, state, keyByte) => {
    const directory = join(home, ".local/state/hive", name),
      key = Buffer.alloc(32, keyByte);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, keyName), key, { mode: 0o600 });
    writeFileSync(
      join(directory, file),
      JSON.stringify({
        state,
        signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
      }),
      { mode: 0o600 },
    );
  };
  const save = () => journal("codex-project-supervisor", "registry.json", "key", native, 14);
  const saveController = () =>
    journal("codex-project-controller", "projects.json", "projects.key", controllerState, 13);
  save();
  saveController();
  const directory = join(home, "outer");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, "controller-key.pem"),
    f.guardian.outer.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const identity = {
    lifetimeId: startup.lifetimeId,
    bindingDigest: startup.bindingDigest,
    outerPublicKeyPem: f.guardian.outer.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    packageManifestSha256: startup.packageManifestSha256,
    guardianElfSha256: startup.guardianSha256,
    nodeSha256: startup.nodeSha256,
    policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
    metadataPolicyDigest: f.guardian.runtime.metadataPolicyDigest,
    configSha256,
  };
  const state = {
    schemaVersion: 1,
    lifetimeId: startup.lifetimeId,
    identityDigest: sha(guardianCanonical(identity)),
    runtimeId: f.guardian.runtime.id,
    generation: f.guardian.finalized.runtime.generation,
    projects: {
      [projectId]: {
        admissionId: f.guardian.finalized.admission.id,
        admissionGeneration: f.guardian.finalized.admission.generation,
        phase: "native",
        checkout: f.guardian.checkout,
        preparationDigest: f.guardian.finalized.admission.preparationDigest,
        metadataPinsDigest: f.guardian.finalized.admission.metadataPinsDigest,
      },
    },
    applications: {},
    launch: f.guardian.launch,
    pending: null,
    hold: false,
    sequence: 0,
    chainDigest: "0".repeat(64),
  };
  writeFileSync(
    join(directory, "controller.json"),
    JSON.stringify({
      state,
      signature: sign(
        null,
        Buffer.from(guardianCanonical(state)),
        f.guardian.outer.privateKey,
      ).toString("base64url"),
    }),
    { mode: 0o600 },
  );
  const actualGuardian = openGuardianController({
    config,
    configSha256,
    home,
    stateDirectory: directory,
    packageManifestSha256: startup.packageManifestSha256,
    guardianElfSha256: startup.guardianSha256,
    nodeSha256: startup.nodeSha256,
    startupAttestation: () => structuredClone(startup),
    fetchImpl,
  });
  const guardian = Object.fromEntries(
    ["currentMetadata", "applyReserve", "applyVerify", "applyCommit"].map((method) => [
      method,
      async (...args) => {
        try {
          return await actualGuardian[method](...args);
        } catch (error) {
          diagnostics.push(`${method}:${error.stack}`);
          throw error;
        }
      },
    ]),
  );
  const routing = {
    receiveSequence: 17,
    pendingObservers: 0,
    activeHandlers: 0,
    observerFailures: [],
  };
  const cli = { projectId, activeCli: 0, unknownInputs: 0 };
  let closedInputs = false;
  const terminals = () => ({
    projectId,
    closed: closedInputs,
    activeTerminals: 0,
    helpersPendingClose: 0,
    pendingInputs: 0,
    unknownInputs: 0,
  });
  const listeners = new Set(),
    continuations = [];
  const project = {
    projectId,
    repositoryId: "123",
    taskId: f.context.preparationIntentId,
    revision: material.revision,
    leaseId: material.leaseId,
    leaseGeneration: material.leaseGeneration,
  };
  const supervisor = {
    closed: false,
    config: { executionMode: "isolated", metadataReadOnly: true, projects: [project] },
    state: native,
    onRevoked: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    checkout: () => material.checkout,
    save,
    registerChild: (_root, child, call) => {
      assert.equal(child, f.source.childThreadId);
      assert.equal(call, f.source.spawnCallId);
    },
    readNativeHistory: async () => ({
      data: [{ id: f.source.childTurnId, status: "completed", itemsView: "full", items: [] }],
      nextCursor: null,
    }),
    runtime: {
      alive: () => native.status === "ready",
      inspectManagerRouting: () => structuredClone(routing),
      inspectCliInputs: () => structuredClone(cli),
      drainManagerRouting: async () => ({ pendingObservers: 0, activeHandlers: 0 }),
    },
    async continueDeliveryRoot(value) {
      assert.equal(entry.sourceApplication.phase, "released");
      assert.equal(closedInputs, false);
      assert.deepEqual(value.sourceContext, entry.acceptedSource);
      continuations.push(structuredClone(value));
      return {
        requestId: value.requestId,
        parentTurnId: value.parentTurnId,
        nextParentTurnId: randomUUID(),
        priorAttemptId: value.priorAttemptId,
        cursorVersion: value.cursorVersion,
        serverInstanceId: f.serverInstanceId,
        historyDigest: "b".repeat(64),
      };
    },
    revalidateDeliveryBoundary: async () => ({ observedAt: new Date().toISOString() }),
    revokeExecution: async (_project, reason) => {
      entry.executionRevoked = reason;
      save();
    },
    beginSourceApplication(value, app) {
      entry.sourceApplication = {
        ...structuredClone(app),
        phase: "closing",
        boundaryRequestDigest: sha(JSON.stringify(value)),
        serverInstanceId: f.serverInstanceId,
        managerThreadId: f.managerThreadId,
        cohort: structuredClone(value.cohort),
        leaseExpiresAt: inspect().lease.expiresAt,
        barrier: {
          ...app.barrier,
          projectId,
          closed: true,
          rootCompleted: true,
          observedAt: new Date().toISOString(),
          pendingCommands: 0,
          activeCli: 0,
          pendingInputs: 0,
          unknownInputs: 0,
        },
      };
      return this.sourceApplicationScope();
    },
    sourceApplicationScope() {
      const a = entry.sourceApplication;
      return {
        projectId,
        applicationId: a.applicationId,
        barrierId: a.barrier.id,
        generation: a.barrier.generation,
      };
    },
    assertSourceApplicationRead(scope) {
      assert.equal(scope.applicationId, entry.sourceApplication.applicationId);
      assert.notEqual(entry.sourceApplication.phase, "released");
      assert.equal(native.status, "ready");
    },
    async closeSourceApplicationInputs(_request, scope, close) {
      await close(projectId, scope);
      const a = entry.sourceApplication;
      a.inputInventory = {
        terminals: terminals(),
        cli: structuredClone(cli),
        routing: structuredClone(routing),
      };
      a.barrier.commandInventoryDigest = sha(JSON.stringify(routing));
      a.barrier.terminalInventoryDigest = sha(JSON.stringify({ terminals: terminals(), cli }));
      a.boundary = {
        receiveSequence: 17,
        observedAt: a.barrier.observedAt,
        historyDigest: "3".repeat(64),
        loadedInventoryDigest: "4".repeat(64),
        rootTurns: 1,
        historyBytes: 100,
      };
    },
  };
  const controller = {
    assertRuntimeExecution: () => assert.equal(native.status, "ready"),
    currentProjectContext: () => structuredClone(f.context),
    currentSource: () => ({
      checkoutBinding: structuredClone(f.context),
      headSha: entry.acceptedSource?.headSha ?? material.revision,
      ...(entry.acceptedSource ? { sourceContext: structuredClone(entry.acceptedSource) } : {}),
      phase:
        entry.sourceApplication && entry.sourceApplication.phase !== "released"
          ? "updating"
          : "ready",
    }),
    syncSourceApplication(app) {
      task.sourceApplication = structuredClone(app);
      if (entry.acceptedSource) task.acceptedSource = structuredClone(entry.acceptedSource);
      saveController();
    },
    sourceApplication: () => structuredClone(task.sourceApplication),
  };
  const gateway = {
    closeProjectInputs: async () => {
      closedInputs = true;
    },
    projectInputInventory: terminals,
    releaseProjectInputs: async (_id, _scope, verify) => {
      await verify();
      closedInputs = false;
    },
  };
  return {
    supervisor,
    controller,
    gateway,
    guardian,
    entry,
    continuations,
    closedInputs: () => closedInputs,
  };
}
