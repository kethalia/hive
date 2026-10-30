import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSourceApplication } from "../templates/ai-dev-k8s/scripts/codex-source-application.mjs";
import {
  runApplyWorkerChannel,
  runFixedSourceApplyWorker,
} from "../templates/ai-dev-k8s/scripts/delivery-source-apply-client.mjs";

const clone = structuredClone,
  uuid = randomUUID;
function fixture(input = null) {
  const projectId = input?.checkoutBinding.projectId ?? uuid(),
    operationId = input?.facts.accepted.operationId ?? uuid(),
    thread = input?.request.managerThreadId ?? "root",
    leaseId = input?.checkoutBinding.leaseId ?? uuid(),
    preparationIntentId = input?.checkoutBinding.preparationIntentId ?? uuid();
  const checkoutBinding = input?.checkoutBinding ?? {
    projectId,
    repositoryId: "123",
    preparationIntentId,
    revision: "a".repeat(40),
    leaseId,
    leaseGeneration: 1,
  };
  const target = input?.facts.accepted.sourceContext ?? {
    revisionId: uuid(),
    version: 1,
    headSha: "b".repeat(40),
  };
  const metadata = input?.metadata ?? {
    runtimeId: uuid(),
    runtimeGeneration: 1,
    admissionId: uuid(),
    admissionGeneration: 3,
    producerDigest: "c".repeat(64),
    checkoutIncarnation: uuid(),
    barrierGeneration: 0,
    metadataPins: { checkout: { device: "1", inode: "2" }, git: { device: "1", inode: "3" } },
    metadataPinsDigest: "d".repeat(64),
    metadataPolicyDigest: "e".repeat(64),
    namespaceReceiptDigest: "f".repeat(64),
  };
  const admission = Object.fromEntries(
    [
      "runtimeId",
      "runtimeGeneration",
      "admissionId",
      "admissionGeneration",
      "producerDigest",
      "checkoutIncarnation",
      "barrierGeneration",
    ].map((k) => [k, metadata[k]]),
  );
  const facts = input?.facts ?? {
    isCurrent: true,
    scope: { checkoutBinding },
    admission,
    metadata: {
      pins: metadata.metadataPins,
      pinsDigest: metadata.metadataPinsDigest,
      policyDigest: metadata.metadataPolicyDigest,
      namespaceReceiptDigest: metadata.namespaceReceiptDigest,
    },
    accepted: {
      operationId,
      sourceContext: target,
      parentSha: checkoutBinding.revision,
      treeSha: "1".repeat(40),
      manifestDigest: "2".repeat(64),
    },
  };
  const request = input?.request ?? {
    managerThreadId: thread,
    checkoutBinding,
    registrationId: uuid(),
    serverInstanceId: "lifetime",
    parentTurnId: "turn",
    cursorVersion: 1,
  };
  const routing = {
    receiveSequence: 3,
    pendingObservers: 0,
    activeHandlers: 0,
    observerFailures: [],
  };
  const entry = {};
  let mirrored = null,
    terminalClosed = false,
    phase = "pending",
    releaseCount = 0,
    workerCalls = 0;
  const saved = [];
  const supervisor = {
    state: { serverInstanceId: request.serverInstanceId, projects: { [projectId]: entry } },
    runtime: {
      inspectManagerRouting: () => routing,
      inspectCliInputs: () => ({ activeCli: 0, unknownInputs: 0 }),
    },
    save() {
      saved.push(clone(entry));
    },
    beginSourceApplication(_request, app) {
      entry.sourceApplication = {
        ...clone(app),
        phase: "closing",
        boundaryRequestDigest: createHash("sha256").update(JSON.stringify(_request)).digest("hex"),
        serverInstanceId: request.serverInstanceId,
        managerThreadId: thread,
        leaseExpiresAt: Date.now() / 1000 + 300,
        barrier: { ...app.barrier, closed: true },
      };
      return this.sourceApplicationScope(projectId);
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
    },
    async closeSourceApplicationInputs(_request, scope, close) {
      await close(projectId, scope);
      if (entry.sourceApplication.sourceObservation) return;
      entry.sourceApplication.boundary = {
        receiveSequence: 3,
        observedAt: new Date().toISOString(),
        historyDigest: "3".repeat(64),
        loadedInventoryDigest: "4".repeat(64),
        rootTurns: 1,
        historyBytes: 100,
      };
    },
  };
  const controller = {
    syncSourceApplication(record) {
      mirrored = clone(record);
    },
    sourceApplication() {
      return clone(mirrored);
    },
  };
  const gateway = {
    async closeProjectInputs() {
      terminalClosed = true;
    },
    projectInputInventory() {
      return {
        closed: terminalClosed,
        activeTerminals: 0,
        helpersPendingClose: 0,
        pendingInputs: 0,
        unknownInputs: 0,
      };
    },
    async releaseProjectInputs(_project, _scope, verify) {
      await verify();
      terminalClosed = false;
      releaseCount++;
    },
  };
  const authority = () => ({
    schemaVersion: 1,
    applicationId: entry.sourceApplication.applicationId,
    phase,
    operationId,
    sourceContext: target,
    previousSourceContext: null,
    parentSha: facts.accepted.parentSha,
    treeSha: facts.accepted.treeSha,
    manifestDigest: facts.accepted.manifestDigest,
    metadataIdentity: metadata.metadataPins,
    producer: {
      ...admission,
      metadataPinsDigest: metadata.metadataPinsDigest,
      metadataPolicyDigest: metadata.metadataPolicyDigest,
      namespaceReceiptDigest: metadata.namespaceReceiptDigest,
    },
    inputBarrier: {
      id: entry.sourceApplication.barrier.id,
      generation: entry.sourceApplication.barrier.generation,
      digest: "5".repeat(64),
    },
    expiresAt: Math.floor(Date.now() / 1000) + 29,
    applicationAuthorized: true,
    executionAuthorized: false,
    cleanupAuthorized: false,
  });
  const guardian = {
    currentMetadata: async () => clone(metadata),
    applyReserve: async () => {},
    applyVerify: async () => clone(authority()),
    applyCommit: async () => {
      phase = "applied";
    },
  };
  const snapshot = {
    scope: "native_observer_journal_only",
    writerHeld: true,
    quiescenceAuthority: false,
    metadataApplyAuthorized: false,
    pendingSourceEvents: 0,
    unknownInputs: 0,
    operationId,
    acceptedSourceContext: target,
    checkoutBinding,
    registrationId: request.registrationId,
    serverInstanceId: request.serverInstanceId,
    parentTurnId: request.parentTurnId,
    cursorVersion: 1,
    sourceJournalDigest: "6".repeat(64),
    managerBindingId: uuid(),
    attemptId: uuid(),
    nativeSequence: 7,
  };
  const expected = {
    projectId,
    repositoryId: "123",
    taskId: preparationIntentId,
    leaseId,
    leaseGeneration: 1,
    revision: checkoutBinding.revision,
    checkoutIncarnation: metadata.checkoutIncarnation,
    checkoutIdentity: metadata.metadataPins.checkout,
    currentSource: null,
  };
  const options = {
    enabled: true,
    supervisor,
    controller,
    gateway,
    guardian,
    sourceState: { readForApply: async () => clone(facts) },
    managerAdapter: { sourceApplicationSnapshot: async () => clone(snapshot) },
    inspectManaged: async () => ({
      status: "ready",
      checkoutVerified: true,
      acceptedSource: target,
      revision: checkoutBinding.revision,
      checkoutIncarnation: metadata.checkoutIncarnation,
      checkoutIdentity: metadata.metadataPins.checkout,
      lease: {
        id: leaseId,
        taskId: preparationIntentId,
        generation: 1,
        expiresAt: Date.now() / 1000 + 300,
      },
    }),
    runWorker: async (start, exchange) => {
      workerCalls++;
      await exchange("authority", { request: start, expected, operationId });
      await exchange("input_barrier", { request: start, expected, operationId, producer: null });
      await exchange("applied", { request: start, expected, sourceContext: target });
      return {
        applicationId: start.applicationId,
        publicationOperationId: operationId,
        acceptedSource: target,
      };
    },
  };
  return {
    options,
    entry,
    request,
    facts,
    target,
    routing,
    saved,
    get releaseCount() {
      return releaseCount;
    },
    get terminalClosed() {
      return terminalClosed;
    },
    get workerCalls() {
      return workerCalls;
    },
  };
}
test("application remains disabled without installed independent authority callbacks", async () => {
  await assert.rejects(createSourceApplication().applyAcceptedSource(), /disabled/);
  assert.throws(() => createSourceApplication({ enabled: true }), /dependencies_unavailable/);
});
test("accepted source is synchronized in both journals before commit; only fresh applied readback releases input", async () => {
  const f = fixture();
  let observed = false;
  f.options.guardian.applyCommit = async () => {
    assert.equal(f.entry.sourceApplication.phase, "applied");
    assert.deepEqual(f.entry.acceptedSource, f.target);
    assert.deepEqual(f.options.controller.sourceApplication(), f.entry.sourceApplication);
    assert.equal(f.terminalClosed, true);
    observed = true;
    const original = f.options.guardian.applyVerify;
    f.options.guardian.applyVerify = async () => ({ ...(await original()), phase: "applied" });
  };
  const result = await createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts);
  assert.deepEqual(result.acceptedSource, f.target);
  assert.equal(observed, true);
  assert.equal(f.releaseCount, 1);
  assert.equal(f.entry.sourceApplication.phase, "released");
  assert.ok(f.saved.some((v) => v.sourceApplication.phase === "closing"));
});
for (const mode of ["commit_lost_ack", "verify_revoked", "late_native_input", "wrong_source"])
  test(`${mode} retains input and physical writer hold after metadata receipt`, async () => {
    const f = fixture();
    if (mode === "commit_lost_ack")
      f.options.guardian.applyCommit = async () => {
        throw new Error("lost_ack");
      };
    if (mode === "verify_revoked")
      f.options.guardian.applyCommit = async () => {
        f.options.guardian.applyVerify = async () => {
          throw new Error("revoked");
        };
      };
    if (mode === "late_native_input") {
      const inspect = f.options.inspectManaged;
      f.options.inspectManaged = async () => {
        f.routing.receiveSequence++;
        return inspect();
      };
    }
    if (mode === "wrong_source")
      f.options.inspectManaged = async () => ({
        status: "ready",
        checkoutVerified: true,
        acceptedSource: { ...f.target, version: 2 },
      });
    await assert.rejects(
      createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
    );
    assert.equal(f.releaseCount, 0);
    assert.equal(f.terminalClosed, true);
    assert.equal(f.entry.sourceApplication.phase, "held");
  });
function protocolChild(body) {
  return spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `import socket,json,os,time\ns=socket.socket(fileno=3)\nf=s.makefile('rwb',buffering=0)\nstart=json.loads(f.readline())\n${body}`,
    ],
    {
      detached: true,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    },
  );
}
const start = {
  projectId: uuid(),
  repositoryId: "1",
  applicationId: uuid(),
  publicationOperationId: uuid(),
};
test("fixed apply worker rejects arbitrary paths before spawning", async () => {
  assert.throws(
    () => runFixedSourceApplyWorker({ ...start, path: "/arbitrary" }, () => {}),
    /configuration_invalid/,
  );
});
test("worker deadline aborts stalled trusted callback and reaps exact child", async () => {
  const child = protocolChild(
    `f.write(json.dumps({'schemaVersion':1,'type':'authority','id':1,'value':{}}).encode()+b'\\n')\ntime.sleep(10)`,
  );
  const before = Date.now();
  let aborted = false;
  await assert.rejects(
    runApplyWorkerChannel(
      child,
      start,
      (_type, _value, { signal }) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      { timeoutMs: 70 },
    ),
    /uncertain/,
  );
  assert.equal(aborted, true);
  assert.ok(Date.now() - before < 1500);
  assert.notEqual(child.signalCode, null);
});
test("EOF and nonmonotonic worker frames cannot be treated as success", async () => {
  for (const body of [
    `s.close()`,
    `f.write(json.dumps({'schemaVersion':1,'type':'authority','id':2,'value':{}}).encode()+b'\\n')\ntime.sleep(10)`,
  ]) {
    const child = protocolChild(body);
    let callbacks = 0;
    await assert.rejects(
      runApplyWorkerChannel(
        child,
        start,
        () => {
          callbacks++;
        },
        { timeoutMs: 1000 },
      ),
      /uncertain/,
    );
    assert.equal(callbacks, 0);
  }
});

test("lost reserve ACK recovers after coordinator reconstruction without replacing immutable barrier or re-reserving", async () => {
  const f = fixture();
  let reserves = 0,
    verifies = 0;
  f.options.guardian.applyReserve = async () => {
    reserves++;
    throw new Error("lost_reserve_ack");
  };
  await assert.rejects(
    createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
    /lost_reserve_ack/,
  );
  const persisted = JSON.parse(JSON.stringify(f.entry.sourceApplication));
  assert.equal(persisted.reserveAttempted, true);
  assert.equal(f.workerCalls, 0);
  const immutable = ({
    barrier,
    idleSnapshot,
    boundaryRequestDigest,
    applicationId,
    publicationOperationId,
  }) => ({ barrier, idleSnapshot, boundaryRequestDigest, applicationId, publicationOperationId });
  // Reconstruct the coordinator from the durable record in the SAME native
  // lifetime. A new native lifetime has a separate refusal test.
  f.entry.sourceApplication = JSON.parse(JSON.stringify(persisted));
  f.options.controller.syncSourceApplication(f.entry.sourceApplication);
  const verify = f.options.guardian.applyVerify;
  f.options.guardian.applyVerify = async () => {
    verifies++;
    return verify();
  };
  const close = f.options.gateway.closeProjectInputs;
  f.options.gateway.closeProjectInputs = async () => {
    assert.ok(verifies >= 1, "existing application is verified before rechecking inputs");
    return close();
  };
  await createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts);
  assert.equal(reserves, 1);
  assert.equal(f.workerCalls, 1);
  assert.equal(f.releaseCount, 1);
  assert.deepEqual(immutable(f.entry.sourceApplication), immutable(persisted));
});
for (const reason of ["not_found", "revoked", "unknown_transport"])
  test(`ambiguous reserve then ${reason} never infers permission to reserve again`, async () => {
    const f = fixture();
    let reserves = 0;
    f.options.guardian.applyReserve = async () => {
      reserves++;
      throw new Error("lost_reserve_ack");
    };
    await assert.rejects(
      createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
    );
    const barrier = clone(f.entry.sourceApplication.barrier);
    f.options.guardian.applyVerify = async () => {
      throw new Error(reason);
    };
    await assert.rejects(
      createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
      new RegExp(reason),
    );
    assert.equal(reserves, 1);
    assert.equal(f.workerCalls, 0);
    assert.equal(f.releaseCount, 0);
    assert.deepEqual(f.entry.sourceApplication.barrier, barrier);
    assert.equal(f.entry.sourceApplication.phase, "held");
  });
test("lost commit ACK reads original applied authority and skips a second commit after reconstruction", async () => {
  const f = fixture();
  let commits = 0,
    reserves = 0,
    applied = false;
  const verify = f.options.guardian.applyVerify;
  f.options.guardian.applyVerify = async () => ({
    ...(await verify()),
    phase: applied ? "applied" : "pending",
  });
  f.options.guardian.applyReserve = async () => {
    reserves++;
  };
  f.options.guardian.applyCommit = async () => {
    commits++;
    applied = true;
    throw new Error("lost_commit_ack");
  };
  await assert.rejects(
    createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
    /lost_commit_ack/,
  );
  const original = clone(f.entry.sourceApplication);
  await createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts);
  assert.equal(commits, 1);
  assert.equal(reserves, 1);
  assert.equal(f.releaseCount, 1);
  assert.deepEqual(f.entry.sourceApplication.barrier, original.barrier);
  assert.deepEqual(f.entry.sourceApplication.idleSnapshot, original.idleSnapshot);
});
test("changed observer journal after lost reserve ACK retains original barrier and refuses helper", async () => {
  const f = fixture();
  f.options.guardian.applyReserve = async () => {
    throw new Error("lost_reserve_ack");
  };
  await assert.rejects(createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts));
  const original = clone(f.entry.sourceApplication.barrier),
    read = f.options.managerAdapter.sourceApplicationSnapshot;
  f.options.managerAdapter.sourceApplicationSnapshot = async () => ({
    ...(await read()),
    sourceJournalDigest: "9".repeat(64),
  });
  await assert.rejects(
    createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
    /observer_changed/,
  );
  assert.deepEqual(f.entry.sourceApplication.barrier, original);
  assert.equal(f.workerCalls, 0);
  assert.equal(f.releaseCount, 0);
});

test("actual private FD3 coordinator retry restores historical expected source after lost commit ACK", {
  skip: !process.env.HIVE_SOURCE_APPLY_REPLAY_FIXTURE,
}, async () => {
  const input = JSON.parse(readFileSync(process.env.HIVE_SOURCE_APPLY_REPLAY_FIXTURE, "utf8")),
    f = fixture(input);
  const worker = fileURLToPath(
    new URL("../templates/ai-dev-k8s/scripts/delivery-source-apply-worker.py", import.meta.url),
  );
  const managed = fileURLToPath(
    new URL("../templates/ai-dev-k8s/scripts/managed-projects.py", import.meta.url),
  );
  const pythonModule = (path) =>
    `import importlib.util,json\ns=importlib.util.spec_from_file_location('fixture',${JSON.stringify(path)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n`;
  f.options.inspectManaged = async () =>
    JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          pythonModule(managed) +
            `print(json.dumps(m.ManagedProjects(${JSON.stringify(input.home)}).inspect('123')))\n`,
        ],
        {
          env: { PATH: "/usr/bin:/bin" },
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
  const attempts = [];
  let attempt = 0,
    commits = 0,
    reserves = 0,
    applied = false;
  f.options.runWorker = async (start, exchange, options) => {
    const current = attempt++;
    attempts.push([]);
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        `${pythonModule(worker)}m.run(m.protocol.Channel(),home=${JSON.stringify(input.home)})\n`,
      ],
      {
        env: { PATH: "/usr/bin:/bin" },
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "pipe"],
      },
    );
    return runApplyWorkerChannel(
      child,
      start,
      async (type, value, control) => {
        attempts[current].push({ type, currentSource: clone(value.expected.currentSource) });
        if (current === 1) {
          assert.equal(
            value.expected.currentSource,
            null,
            "helper restores original source context, not applied B",
          );
          // Metadata is already B even while callback carries historical A/null.
          const receipt = JSON.parse(readFileSync(input.managedReceipt, "utf8"));
          assert.deepEqual(receipt.record.acceptedSource, f.target);
          assert.equal(
            readFileSync(`${input.checkout}/.git/HEAD`, "utf8").trim(),
            f.target.headSha,
          );
        }
        try {
          return await exchange(type, value, control);
        } catch (error) {
          attempts[current].push({ callbackError: error.message, expected: value.expected });
          throw error;
        }
      },
      options,
    );
  };
  const verify = f.options.guardian.applyVerify;
  f.options.guardian.applyVerify = async () => ({
    ...(await verify()),
    phase: applied ? "applied" : "pending",
  });
  f.options.guardian.applyReserve = async () => {
    reserves++;
  };
  f.options.guardian.applyCommit = async () => {
    commits++;
    applied = true;
    throw new Error("synthetic_lost_commit_ack");
  };
  await assert.rejects(
    createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts),
    /source_worker_uncertain/,
  );
  assert.equal(f.releaseCount, 0);
  assert.equal(commits, 1, JSON.stringify(attempts));
  assert.equal(f.entry.sourceApplication.phase, "held");
  const identity = (path) => {
    const st = statSync(path, { bigint: true });
    return {
      bytes: readFileSync(path).toString("base64"),
      inode: st.ino.toString(),
      mtime: st.mtimeNs.toString(),
    };
  };
  const paths = [
      `${input.checkout}/.git/HEAD`,
      `${input.checkout}/.git/index`,
      input.managedReceipt,
    ],
    before = paths.map(identity),
    barrier = clone(f.entry.sourceApplication.barrier);
  await createSourceApplication(f.options).applyAcceptedSource(f.request, f.facts);
  assert.equal(attempt, 2);
  assert.equal(commits, 1);
  assert.equal(reserves, 1);
  assert.equal(f.releaseCount, 1);
  assert.deepEqual(
    paths.map(identity),
    before,
    "replay must not rewrite HEAD/index/managed receipt",
  );
  assert.deepEqual(f.entry.sourceApplication.barrier, barrier);
  assert.ok(attempts[1].some((v) => v.type === "authority"));
  assert.ok(attempts[1].some((v) => v.type === "applied"));
});
