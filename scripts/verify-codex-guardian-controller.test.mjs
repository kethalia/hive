import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  guardianCanonical as canonical,
  GUARDIAN_CONTROLLER_POLICY_DIGEST,
  openGuardianController,
} from "../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";
import { createDeliveryNativeSpool } from "../templates/ai-dev-k8s/scripts/delivery-native-spool.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex"),
  digest = (v) => sha(canonical(v));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hive-guardian-controller-")),
    issuer = generateKeyPairSync("ed25519");
  const binding = {
    coderOrigin: "https://coder.invalid",
    hiveUserId: randomUUID(),
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    buildId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://app.invalid",
    appId: randomUUID(),
  };
  const config = {
    guardianEnabled: true,
    nativeIsolationEnabled: true,
    hiveOrigin: "https://hive.invalid",
    binding,
    port: 13341,
    issuerKeyId: "issuer",
    issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const kernel = {
    pid: process.pid,
    startTime: "100",
    bootId: randomUUID(),
    executable: "/usr/bin/node",
    device: "1",
    inode: "2",
  };
  const startup = {
    schemaVersion: 1,
    type: "ready",
    phase: "open",
    nonce: Buffer.alloc(32).toString("base64url"),
    configSha256: "1".repeat(64),
    packageManifestSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    guardianSha256: "4".repeat(64),
    workerSha256: "5".repeat(64),
    port: config.port,
    lifetimeId: randomUUID(),
    bindingDigest: "6".repeat(64),
    generation: 1,
    ownershipDigest: "7".repeat(64),
    projects: [],
    workerIdentity: { ...kernel, parentPid: 10 },
    guardianIdentity: { ...kernel, pid: 10, parentPid: 9 },
    outerIdentity: { ...kernel, pid: 9, parentPid: 8 },
  };
  const calls = [],
    runtimeId = randomUUID(),
    admissionId = randomUUID();
  let packet,
    mode = "normal",
    generation = 1,
    admission,
    metadata,
    applicationRequest,
    applicationPhase = "pending";
  const options = {
    config,
    configSha256: startup.configSha256,
    home,
    stateDirectory: join(home, "outer"),
    packageManifestSha256: startup.packageManifestSha256,
    guardianElfSha256: startup.guardianSha256,
    nodeSha256: startup.nodeSha256,
    startupAttestation: () => structuredClone(startup),
    async fetchImpl(url, request) {
      assert.equal(url, "https://hive.invalid/api/codex-host/guardians");
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      assert.deepEqual(request.headers, { "Content-Type": "application/json" });
      const { proof, ...body } = JSON.parse(request.body);
      assert(
        verify(
          null,
          Buffer.from(
            `hive-guardian-controller-v1\nPOST\n/api/codex-host/guardians\n${canonical(body)}`,
          ),
          packet.identity.outerPublicKeyPem,
          Buffer.from(proof, "base64url"),
        ),
      );
      calls.push(body);
      if (mode === "unknown") throw new Error("fixture_unknown_commit");
      if (mode === "redirect")
        return new Response(null, {
          status: 307,
          headers: { Location: "https://foreign.invalid" },
        });
      if (body.action === "enroll")
        return Response.json({ accepted: true, runtimeId, runtimeGeneration: 1 });
      if (body.action === "prepare") {
        generation = 2;
        admission = {
          id: admissionId,
          projectId: body.preparation.projectId,
          runtimeId,
          generation: 1,
          phase: "preparation",
          preparationDigest: body.preparationDigest,
          checkoutBinding: null,
          metadataPinsDigest: null,
        };
      }
      if (body.action === "checkout")
        admission = {
          ...admission,
          phase: "checkout",
          generation: 2,
          checkoutBinding: body.checkout,
        };
      if (body.action === "native") {
        metadata = body.metadata;
        admission = {
          ...admission,
          phase: "native",
          generation: 3,
          registrationId: body.registrationId,
          nativeThreadId: body.managerThreadId,
          metadataPinsDigest: digest(metadata),
        };
      }
      if (body.action.startsWith("apply_")) {
        if (body.action === "apply_reserve") applicationRequest = structuredClone(body);
        assert(applicationRequest);
        if (body.action === "apply_commit") applicationPhase = "applied";
        const r = applicationRequest;
        const result = {
          schemaVersion: 1,
          applicationId: r.applicationId,
          phase: applicationPhase,
          operationId: r.publicationOperationId,
          sourceContext: r.targetSourceContext,
          previousSourceContext: r.expectedAppliedSourceContext,
          parentSha: admission.checkoutBinding.revision,
          treeSha: "d".repeat(40),
          manifestDigest: "e".repeat(64),
          metadataIdentity: metadata.pins,
          producer: {
            runtimeId,
            runtimeGeneration: generation,
            admissionId,
            admissionGeneration: admission.generation,
            producerDigest: "f".repeat(64),
            checkoutIncarnation: admission.checkoutBinding.checkoutIncarnation,
            barrierGeneration: 0,
            metadataPinsDigest: digest(metadata),
            metadataPolicyDigest: metadata.metadataPolicyDigest,
            namespaceReceiptDigest: metadata.namespaceReceiptDigest,
          },
          inputBarrier: {
            id: r.inputBarrier.id,
            generation: r.inputBarrier.generation,
            digest: digest(r.inputBarrier),
          },
          expiresAt: Math.floor(Date.now() / 1000) + 29,
          applicationAuthorized: true,
          executionAuthorized: false,
          cleanupAuthorized: false,
        };
        if (mode === "applyLost") throw new Error("fixture_unknown_application_ack");
        return Response.json(result);
      }
      if (body.action === "metadata")
        return Response.json({
          runtimeId,
          runtimeGeneration: generation,
          admissionId,
          admissionGeneration: admission.generation,
          producerDigest: "f".repeat(64),
          checkoutIncarnation: admission.checkoutBinding.checkoutIncarnation,
          barrierGeneration: 0,
          metadataPins: metadata.pins,
          metadataPinsDigest: digest(metadata),
          metadataPolicyDigest: metadata.metadataPolicyDigest,
          namespaceReceiptDigest: metadata.namespaceReceiptDigest,
        });
      if (body.action === "launch")
        return Response.json({
          runtimeId,
          runtimeGeneration: generation,
          policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
          metadataPolicyDigest: packet.identity.metadataPolicyDigest,
          nativeLaunchId: body.nativeLaunchId,
          launchIntentDigest: body.launchIntentDigest,
          approvals: [
            {
              projectId: admission.projectId,
              repositoryId: admission.checkoutBinding.repositoryId,
              taskId: admission.checkoutBinding.preparationIntentId,
              revision: admission.checkoutBinding.revision,
              leaseId: admission.checkoutBinding.leaseId,
              leaseGeneration: admission.checkoutBinding.leaseGeneration,
              checkoutIdentity: admission.checkoutBinding.checkoutIdentity,
              checkoutIncarnation: admission.checkoutBinding.checkoutIncarnation,
              admissionId,
              admissionGeneration: admission.generation,
              firstNative: true,
            },
          ],
        });
      return Response.json({
        runtime: { id: runtimeId, lifetimeId: startup.lifetimeId, phase: "open", generation },
        admission,
      });
    },
  };
  const client = openGuardianController(options);
  function identity() {
    packet = client.identity("a".repeat(64));
    return packet;
  }
  function grant(patch = {}) {
    const p = packet ?? identity(),
      now = Math.floor(Date.now() / 1000),
      head = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.issuerKeyId }),
      ).toString("base64url"),
      claims = {
        iss: config.hiveOrigin,
        aud: "hive:workspace-guardian",
        scope: "workspace:guardian:enroll",
        jti: randomUUID(),
        iat: now,
        exp: now + 60,
        runtimeId,
        hiveUserId: binding.hiveUserId,
        coderOwnerId: binding.ownerId,
        workspaceId: binding.workspaceId,
        agentId: binding.agentId,
        buildId: binding.buildId,
        appId: binding.appId,
        lifetimeId: startup.lifetimeId,
        outerKeyFingerprint: sha(
          createPublicKey(p.identity.outerPublicKeyPem).export({ type: "spki", format: "der" }),
        ),
        bindingDigest: startup.bindingDigest,
        identityDigest: digest({ identity: p.identity, binding: { ...binding, projects: [] } }),
        startupDigest: digest(p.startup),
        ...patch,
      },
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), issuer.privateKey).toString("base64url")}`;
  }
  function project(prepared = false) {
    const directory = join(home, ".local/state/hive/codex-project-controller");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const projectId = randomUUID(),
      request = {
        schemaVersion: 1,
        requestId: randomUUID(),
        repositoryId: "11",
        revision: "b".repeat(40),
        text: "PRIVATE_FIXTURE_PROMPT",
      },
      preparation = {
        schemaVersion: 1,
        stage: "preparation",
        ownerId: binding.ownerId,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        projectId,
        repositoryId: "11",
        providerAccountId: "12",
        taskId: randomUUID(),
        requestId: request.requestId,
        baseSha: request.revision,
        requestDigest: sha(JSON.stringify(request)),
      },
      task = {
        taskId: preparation.taskId,
        request,
        phase: "preparing",
        guardianPreparation: preparation,
      };
    const record = {
      schemaVersion: 1,
      preparationDigest: sha(JSON.stringify(preparation)),
      projectId,
      repositoryId: "11",
      taskId: task.taskId,
      revision: request.revision,
      leaseId: randomUUID(),
      leaseGeneration: 1,
      checkoutIncarnation: randomUUID(),
      checkoutIdentity: { device: "1", inode: "2" },
    };
    if (prepared) task.guardianPrepared = record;
    const state = {
      schemaVersion: 1,
      ownerId: binding.ownerId,
      workspaceId: binding.workspaceId,
      guardianLifetimeId: startup.lifetimeId,
      hostProcess: kernel,
      projects: { [projectId]: { projectId, repositoryId: "11", task } },
    };
    const key = Buffer.alloc(32, 13);
    writeFileSync(join(directory, "projects.key"), key, { mode: 0o600 });
    const save = () =>
      writeFileSync(
        join(directory, "projects.json"),
        JSON.stringify({
          state,
          signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
        }),
        { mode: 0o600 },
      );
    save();
    return { projectId, bindingDigest: sha(JSON.stringify(preparation)), state, save, record };
  }
  return {
    home,
    client,
    options,
    identity,
    grant,
    project,
    calls,
    startup,
    get applicationRequest() {
      return applicationRequest;
    },
    native(approval, projectId) {
      const directory = join(home, ".local/state/hive/codex-project-supervisor");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const a = approval.approvals[0],
        serverInstanceId = randomUUID(),
        key = Buffer.alloc(32, 14);
      const state = {
        status: "ready",
        buildId: binding.buildId,
        workspaceId: binding.workspaceId,
        hostProcess: kernel,
        serverInstanceId,
        controllerRegistration: { status: "registered", grantId: randomUUID() },
        projects: { [projectId]: { threadId: "fixture-native-root", serverInstanceId } },
        metadataLaunch: {
          phase: "started",
          approval,
          pins: {
            metadataPolicyDigest: packet.identity.metadataPolicyDigest,
            pins: [
              { projectId, checkout: a.checkoutIdentity, metadata: { device: "1", inode: "3" } },
            ],
          },
        },
        executionIdentity: { mode: "isolated" },
      };
      writeFileSync(join(directory, "key"), key, { mode: 0o600 });
      const save = () =>
        writeFileSync(
          join(directory, "registry.json"),
          JSON.stringify({
            state,
            signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
          }),
          { mode: 0o600 },
        );
      save();
      return { state, save };
    },
    mode: (v) => {
      mode = v;
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("fresh nonce identity and one-use issuer grant use real Ed25519 domains and no bearer", async () => {
  const f = fixture();
  try {
    const p = f.identity(),
      { proof, ...body } = p;
    assert(
      verify(
        null,
        Buffer.from(`hive-guardian-identity-v1\n${canonical(body)}`),
        p.identity.outerPublicKeyPem,
        Buffer.from(proof, "base64url"),
      ),
    );
    assert.deepEqual(await f.client.bootstrap(f.grant()), {
      enrolled: true,
      runtimeId: f.calls[0].runtimeId,
    });
    await assert.rejects(f.client.bootstrap(f.grant()));
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});
test("foreign scope, unknown claims, expiry and startup changes cannot bootstrap", async () => {
  for (const patch of [{ workspaceId: randomUUID() }, { extra: true }, { exp: 1 }]) {
    const f = fixture();
    try {
      f.identity();
      await assert.rejects(f.client.bootstrap(f.grant(patch)));
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    f.identity();
    const grant = f.grant();
    f.startup.workerIdentity.inode = "999";
    await assert.rejects(f.client.bootstrap(grant));
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});
test("preparation and exact checkout precede fixed one-use native launch, no prompt forwarded", async () => {
  const f = fixture();
  try {
    f.identity();
    await f.client.bootstrap(f.grant());
    const p = f.project(true);
    const target = { projectId: p.projectId, bindingDigest: p.bindingDigest };
    assert.deepEqual(await f.client.authorizeAdmission(target), target);
    const approval = await f.client.metadataAuthority([{ projectId: p.projectId }]);
    assert.equal(approval.approvals[0].firstNative, true);
    assert.deepEqual(
      f.calls.map((c) => c.action),
      ["enroll", "prepare", "checkout", "fence", "fence", "launch"],
    );
    assert(!JSON.stringify(f.calls).includes("PRIVATE_FIXTURE_PROMPT"));
    await assert.rejects(f.client.metadataAuthority([{ projectId: p.projectId }]));
  } finally {
    f.close();
  }
});
test("HMAC-tampered and closed preparation journals never authorize a helper", async () => {
  const f = fixture();
  try {
    f.identity();
    await f.client.bootstrap(f.grant());
    const p = f.project();
    p.state.guardianBarrier = { closed: true };
    p.save();
    await assert.rejects(
      f.client.authorizeAdmission({ projectId: p.projectId, bindingDigest: p.bindingDigest }),
    );
    delete p.state.guardianBarrier;
    p.save();
    const path = join(f.home, ".local/state/hive/codex-project-controller/projects.json");
    const saved = JSON.parse(readFileSync(path));
    saved.state.projects[p.projectId].task.guardianPreparation.baseSha = "c".repeat(40);
    writeFileSync(path, JSON.stringify(saved));
    await assert.rejects(
      f.client.authorizeAdmission({ projectId: p.projectId, bindingDigest: p.bindingDigest }),
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});
test("unknown commit or redirect durably holds, including reopen; never retries the operation", async () => {
  for (const mode of ["unknown", "redirect"]) {
    const f = fixture();
    try {
      f.identity();
      f.mode(mode);
      await assert.rejects(f.client.bootstrap(f.grant()));
      assert.equal(f.client.status.held, true);
      assert.throws(() => f.client.identity("a".repeat(64)));
      const reopened = openGuardianController(f.options);
      assert.throws(() => reopened.identity("b".repeat(64)));
      assert.equal(f.calls.length, 1);
    } finally {
      f.close();
    }
  }
});
test("private signer permission changes and absent idle authority fail closed", () => {
  const f = fixture();
  try {
    assert.throws(() => f.client.authorizeDrain());
    chmodSync(join(f.home, "outer/controller-key.pem"), 0o644);
    assert.throws(() => openGuardianController(f.options));
  } finally {
    f.close();
  }
});

test("registered native journal is freshly finalized and metadata revocation cannot use a cached receipt", async () => {
  const f = fixture();
  try {
    f.identity();
    await f.client.bootstrap(f.grant());
    const p = f.project(true),
      target = { projectId: p.projectId, bindingDigest: p.bindingDigest };
    await f.client.authorizeAdmission(target);
    const approval = await f.client.metadataAuthority([{ projectId: p.projectId }]),
      native = f.native(approval, p.projectId);
    const result = await f.client.currentMetadata(p.projectId);
    assert.deepEqual(result.metadataPins.git, { device: "1", inode: "3" });
    assert.deepEqual(
      f.calls.slice(-3).map((c) => c.action),
      ["native", "fence", "metadata"],
    );
    native.state.metadataLaunch.pins.pins[0].metadata.inode = "99";
    native.save();
    await assert.rejects(f.client.currentMetadata(p.projectId));
    assert.equal(f.client.status.held, true);
  } finally {
    f.close();
  }
});

// Explicit terminal observer fixtures; these do not claim native inference or
// a kernel writer census. Production reads the same independently signed files.
async function applicationFixture({ physical = false } = {}) {
  const f = fixture();
  f.identity();
  await f.client.bootstrap(f.grant());
  const p = f.project(true),
    target = { projectId: p.projectId, bindingDigest: p.bindingDigest };
  let physicalPath;
  const inode = (path) => {
    const s = statSync(path, { bigint: true });
    return { device: String(s.dev), inode: String(s.ino) };
  };
  if (physical) {
    physicalPath = join(f.home, "projects/.hive-managed/github/11/checkout");
    mkdirSync(join(physicalPath, ".git"), { recursive: true, mode: 0o700 });
    writeFileSync(join(physicalPath, ".git/HEAD"), `${"c".repeat(40)}\n`, { mode: 0o600 });
    writeFileSync(join(physicalPath, ".git/index"), "FIXTURE INDEX BYTES", { mode: 0o600 });
    p.record.checkoutIdentity = inode(physicalPath);
    p.save();
  }
  await f.client.authorizeAdmission(target);
  const approval = await f.client.metadataAuthority([{ projectId: p.projectId }]),
    n = f.native(approval, p.projectId);
  if (physical) n.state.metadataLaunch.pins.pins[0].metadata = inode(join(physicalPath, ".git"));
  n.state.controllerPrivateKeyPem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  n.save();
  const metadata = await f.client.currentMetadata(p.projectId),
    checkout = Object.fromEntries(
      [
        "projectId",
        "preparationIntentId",
        "repositoryId",
        "revision",
        "leaseId",
        "leaseGeneration",
      ].map((k) => [k, f.calls.find((c) => c.action === "checkout").checkout[k]]),
    ),
    managerThreadId = n.state.projects[p.projectId].threadId,
    parentTurnId = "fixture-completed-root",
    attemptId = randomUUID(),
    taskId = randomUUID(),
    stepId = randomUUID(),
    managerBindingId = randomUUID(),
    operationId = randomUUID(),
    registrationId = n.state.controllerRegistration.grantId,
    context = { revisionId: randomUUID(), version: 1, headSha: "c".repeat(40) },
    claim = {
      managerThreadId,
      parentTurnId,
      attemptId,
      taskId,
      stepId,
      managerBindingId,
      registrationId,
      serverInstanceId: n.state.serverInstanceId,
      checkoutBinding: checkout,
      checkoutBindingDigest: digest(checkout),
      inputSourceSha: checkout.revision,
      progressionProtocol: 1,
    },
    publication = {
      operationId,
      sourceContext: context,
      parentSha: checkout.revision,
      previousRevisionId: null,
      treeSha: "d".repeat(40),
      manifestDigest: "e".repeat(64),
      proofDigest: "9".repeat(64),
    },
    spool = {
      schemaVersion: 1,
      sourceProtocol: 1,
      claims: { [managerThreadId]: claim },
      attempts: { [attemptId]: claim },
      cursors: {
        [managerThreadId]: { attemptId, cursorVersion: 1, sequence: 2, acknowledgedSequence: 2 },
      },
      sourcePublications: { [attemptId]: publication },
      results: { [attemptId]: { outcome: "succeeded" } },
      rootTurns: { [digest([managerThreadId, parentTurnId])]: { status: "completed" } },
      fragments: {},
      events: [],
      violations: {},
      blocked: {},
    },
    directory = join(f.home, ".local/state/hive/delivery-manager/native");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const saveSpool = () => {
      const signature = createHmac(
        "sha256",
        sha(`hive-native-spool-v1\n${n.state.controllerPrivateKeyPem}`),
      )
        .update(JSON.stringify(spool))
        .digest("hex");
      const raw = JSON.stringify({ state: spool, signature });
      writeFileSync(join(directory, "source.json"), raw, { mode: 0o600 });
      return sha(raw);
    },
    sourceJournalDigest = saveSpool(),
    observedAt = new Date().toISOString(),
    routing = { receiveSequence: 17, pendingObservers: 0, activeHandlers: 0, observerFailures: [] },
    terminals = {
      projectId: p.projectId,
      closed: true,
      activeTerminals: 0,
      helpersPendingClose: 0,
      pendingInputs: 0,
      unknownInputs: 0,
    },
    cli = { projectId: p.projectId, activeCli: 0, unknownInputs: 0 },
    app = {
      projectId: p.projectId,
      applicationId: randomUUID(),
      publicationOperationId: operationId,
      targetSourceContext: context,
      expectedAppliedSourceContext: null,
      phase: "closing",
      serverInstanceId: n.state.serverInstanceId,
      managerThreadId,
      cohort: [],
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
      barrier: {
        id: randomUUID(),
        generation: 1,
        closed: true,
        projectId: p.projectId,
        observedAt,
        rootCompleted: true,
        commandInventoryDigest: sha(JSON.stringify(routing)),
        terminalInventoryDigest: sha(JSON.stringify({ terminals, cli })),
        sourceSpoolDigest: sourceJournalDigest,
        pendingCommands: 0,
        activeCli: 0,
        pendingInputs: 0,
        unknownInputs: 0,
      },
      inputInventory: { terminals, cli, routing },
      boundary: {
        observedAt,
        historyDigest: "a".repeat(64),
        loadedInventoryDigest: "b".repeat(64),
        historyBytes: 800,
        rootTurns: 1,
        receiveSequence: 17,
      },
      sourceObservation: {
        schemaVersion: 1,
        scope: "native_observer_journal_only",
        ...claim,
        cursorVersion: 1,
        nativeSequence: 2,
        operationId,
        acceptedSourceContext: context,
        sourceJournalDigest,
        pendingSourceEvents: 0,
        unknownInputs: 0,
        writerHeld: true,
        quiescenceAuthority: false,
        metadataApplyAuthorized: false,
      },
      idleSnapshot: {
        projectId: p.projectId,
        admissionId: metadata.admissionId,
        admissionGeneration: metadata.admissionGeneration,
        managerBindingId,
        currentAttemptId: attemptId,
        managerThreadId,
        parentTurnId,
        cursorVersion: 1,
        nativeSequence: 2,
        observedAt,
        historyDigest: "a".repeat(64),
        loadedInventoryDigest: "b".repeat(64),
        fullHistory: true,
        rootTurns: 1,
        historyBytes: 800,
        pendingHandlers: 0,
        pendingObservers: 0,
        unknownFacts: 0,
        activeRoots: 0,
      },
      reserveAttempted: true,
    };
  const sync = () => {
    p.state.projects[p.projectId].task.sourceApplication = structuredClone(app);
    n.state.projects[p.projectId].sourceApplication = structuredClone(app);
    p.save();
    n.save();
  };
  sync();
  const request = {
    projectId: p.projectId,
    applicationId: app.applicationId,
    publicationOperationId: operationId,
    targetSourceContext: context,
    expectedAppliedSourceContext: null,
  };
  return { ...f, p, n, app, spool, saveSpool, sync, request, physicalPath, inode };
}

test("application reserve derives closed barrier and spool facts from both HMAC journals; verify needs no managed checkout lock", async () => {
  const f = await applicationFixture();
  try {
    const reserved = await f.client.applyReserve(f.request);
    assert.equal(reserved.phase, "pending");
    assert.equal(reserved.executionAuthorized, false);
    assert.equal(reserved.cleanupAuthorized, false);
    const input = f.calls.find((c) => c.action === "apply_reserve").inputBarrier;
    assert.equal(input.sourceSpoolDigest, f.app.sourceObservation.sourceJournalDigest);
    assert.match(input.controllerJournalDigest, /^[a-f0-9]{64}$/);
    assert.match(input.supervisorJournalDigest, /^[a-f0-9]{64}$/);
    f.app.phase = "held";
    f.sync();
    const verified = await f.client.applyVerify({
      projectId: f.request.projectId,
      applicationId: f.request.applicationId,
    });
    assert.deepEqual(verified.inputBarrier, reserved.inputBarrier);
    assert.equal(f.calls.filter((c) => c.action === "apply_reserve").length, 1);
    await assert.rejects(
      f.client.applyReserve({ ...f.request, controllerJournalDigest: "a".repeat(64) }),
    );
  } finally {
    f.close();
  }
});

test("unknown reservation ACK is retained and only exact same-application fresh readback can recover across reopen", async () => {
  const f = await applicationFixture();
  try {
    f.mode("applyLost");
    await assert.rejects(f.client.applyReserve(f.request));
    assert.equal(f.client.status.held, true);
    const original = JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state.pending;
    f.mode("normal");
    const reopened = openGuardianController(f.options);
    await reopened.currentMetadata(f.request.projectId);
    assert.equal(reopened.status.held, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state.pending,
      original,
    );
    f.app.phase = "held";
    f.sync();
    const verified = await reopened.applyReserve(f.request);
    assert.equal(verified.phase, "pending");
    assert.equal(reopened.status.held, false);
    assert.equal(f.calls.filter((c) => c.action === "apply_reserve").length, 1);
    assert.equal(f.calls.filter((c) => c.action === "apply_verify").length, 1);
    const saved = JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state;
    assert.deepEqual(saved.applications[f.request.applicationId].uncertainRequest, original);
  } finally {
    f.close();
  }
});

test("changed mirror, late signed spool fact, forged spool MAC and live input inventory never reach application authority", async () => {
  for (const mutation of ["mirror", "late", "mac", "input"]) {
    const f = await applicationFixture();
    try {
      if (mutation === "mirror") {
        f.n.state.projects[f.request.projectId].sourceApplication.barrier.id = randomUUID();
        f.n.save();
      } else if (mutation === "late") {
        f.spool.events.push({ managerThreadId: f.app.managerThreadId, acknowledged: false });
        f.saveSpool();
      } else if (mutation === "input") {
        f.app.inputInventory.cli.activeCli = 1;
        f.sync();
      } else {
        const path = join(f.home, ".local/state/hive/delivery-manager/native/source.json"),
          saved = JSON.parse(readFileSync(path));
        saved.signature = "0".repeat(64);
        writeFileSync(path, JSON.stringify(saved));
      }
      await assert.rejects(f.client.applyReserve(f.request));
      assert.equal(f.calls.filter((c) => c.action.startsWith("apply_")).length, 0);
    } finally {
      f.close();
    }
  }
});

async function appliedFixture() {
  const f = await applicationFixture({ physical: true }),
    authority = await f.client.applyReserve(f.request),
    r = f.p.record,
    root = join(f.home, ".local/state/hive/managed-projects");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = Buffer.alloc(32, 29);
  writeFileSync(join(root, "key"), key, { mode: 0o600 });
  const record = {
    schemaVersion: 1,
    provider: "github",
    repositoryId: r.repositoryId,
    revision: r.revision,
    checkoutIncarnation: r.checkoutIncarnation,
    checkoutIdentity: r.checkoutIdentity,
    lease: {
      id: r.leaseId,
      generation: r.leaseGeneration,
      taskId: r.taskId,
      expiresAt: f.app.leaseExpiresAt,
    },
    acceptedSource: f.app.targetSourceContext,
    sourceUpdating: null,
    sourceAppliedOperation: f.app.publicationOperationId,
    sourceLastApplied: {
      phase: "applied",
      operationId: f.app.publicationOperationId,
      expected: { currentSource: null },
      approval: {
        sourceContext: f.app.targetSourceContext,
        metadataIdentity: authority.metadataIdentity,
        producer: authority.producer,
      },
      candidateIndexDigest: sha(readFileSync(join(f.physicalPath, ".git/index"))),
      "candidate-headIdentity": f.inode(join(f.physicalPath, ".git/HEAD")),
      "candidate-indexIdentity": f.inode(join(f.physicalPath, ".git/index")),
    },
  };
  // Python floats/Unicode escapes are part of its HMAC bytes. JS reserialization
  // would change 1.0 to 1; this crosses the real managed receipt representation.
  execFileSync(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `
import json,hmac,hashlib,sys,os
v=json.load(sys.stdin);r=v['record'];r['fixtureFloat']=1.0;r['fixtureUnicode']='☃'
raw=json.dumps(r,sort_keys=True,separators=(',',':')).encode()
s=hmac.new(bytes.fromhex(v['key']),raw,hashlib.sha256).hexdigest()
with open(v['path'],'w',opener=lambda path,flags:os.open(path,flags,0o600)) as f:json.dump({'record':r,'signature':s},f,sort_keys=True,indent=2)
`,
    ],
    {
      input: JSON.stringify({
        record,
        key: key.toString("hex"),
        path: join(root, "github-11.json"),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  f.app.phase = "applied";
  f.p.state.projects[f.request.projectId].task.acceptedSource = structuredClone(
    f.app.targetSourceContext,
  );
  f.n.state.projects[f.request.projectId].acceptedSource = structuredClone(
    f.app.targetSourceContext,
  );
  f.sync();
  return f;
}

test("outer verifies Python-canonical managed receipt and pinned HEAD/index before signing applied receipt", async () => {
  const f = await appliedFixture();
  try {
    const applied = await f.client.applyCommit({
      projectId: f.request.projectId,
      applicationId: f.request.applicationId,
    });
    assert.equal(applied.phase, "applied");
    const frame = f.calls.find((c) => c.action === "apply_commit"),
      receipt = frame.appliedReceipt;
    assert.equal(receipt.appliedHeadSha, f.app.targetSourceContext.headSha);
    assert.equal(receipt.appliedIndexDigest, sha(readFileSync(join(f.physicalPath, ".git/index"))));
    assert.equal(receipt.sourceUpdating, false);
    assert.equal(receipt.inputBarrierId, f.app.barrier.id);
    assert.match(receipt.managedReceiptDigest, /^[a-f0-9]{64}$/);
  } finally {
    f.close();
  }
});

test("lost applied commit ACK recovers only through fresh applied verify without rewriting the receipt", async () => {
  const f = await appliedFixture();
  try {
    f.mode("applyLost");
    await assert.rejects(
      f.client.applyCommit({
        projectId: f.request.projectId,
        applicationId: f.request.applicationId,
      }),
    );
    const original = f.calls.find((c) => c.action === "apply_commit").appliedReceipt;
    f.mode("normal");
    f.app.phase = "held";
    f.sync();
    const reopened = openGuardianController(f.options),
      verified = await reopened.applyVerify({
        projectId: f.request.projectId,
        applicationId: f.request.applicationId,
      });
    assert.equal(verified.phase, "applied");
    assert.equal(f.calls.filter((c) => c.action === "apply_commit").length, 1);
    const saved = JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state;
    assert.deepEqual(saved.applications[f.request.applicationId].receipt, original);
    const savedRequest = saved.applications[f.request.applicationId].requests.apply_commit;
    assert.deepEqual(savedRequest.appliedReceipt, original);
    assert.equal(savedRequest.eventId, f.calls.find((c) => c.action === "apply_commit").eventId);
    assert.equal(
      saved.applications[f.request.applicationId].requests.apply_reserve.action,
      "apply_reserve",
    );
    assert.equal(reopened.status.held, false);
  } finally {
    f.close();
  }
});

test("forged managed receipt, replaced index inode or changed applied head cannot mint a commit", async () => {
  for (const mutation of ["receipt", "inode", "head"]) {
    const f = await appliedFixture();
    try {
      if (mutation === "receipt") {
        const path = join(f.home, ".local/state/hive/managed-projects/github-11.json"),
          s = JSON.parse(readFileSync(path));
        s.record.lease.id = randomUUID();
        writeFileSync(path, JSON.stringify(s));
      } else if (mutation === "head")
        writeFileSync(join(f.physicalPath, ".git/HEAD"), `${"e".repeat(40)}\n`);
      else {
        const path = join(f.physicalPath, ".git/index"),
          raw = readFileSync(path);
        writeFileSync(`${path}.replacement`, raw, { mode: 0o600 });
        renameSync(`${path}.replacement`, path);
      }
      await assert.rejects(
        f.client.applyCommit({
          projectId: f.request.projectId,
          applicationId: f.request.applicationId,
        }),
      );
      assert.equal(f.calls.filter((c) => c.action === "apply_commit").length, 0);
    } finally {
      f.close();
    }
  }
});

test("a successful reservation response cannot cross changed barrier, native lifetime or extended local lease", async () => {
  for (const mutation of ["barrier", "runtime", "lease"]) {
    const f = await applicationFixture();
    try {
      const original = f.options.fetchImpl;
      const reopened = openGuardianController({
        ...f.options,
        async fetchImpl(url, init) {
          const result = await original(url, init);
          if (JSON.parse(init.body).action === "apply_reserve") {
            if (mutation === "barrier") f.app.barrier.id = randomUUID();
            else if (mutation === "lease") f.app.leaseExpiresAt += 60;
            else {
              f.n.state.serverInstanceId = randomUUID();
              f.n.state.projects[f.request.projectId].serverInstanceId = f.n.state.serverInstanceId;
            }
            f.sync();
          }
          return result;
        },
      });
      await assert.rejects(reopened.applyReserve(f.request));
      assert.equal(reopened.status.held, true);
      const saved = JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state;
      assert.equal(saved.pending.action, "apply_reserve");
      assert.equal(saved.applications[f.request.applicationId].authority, undefined);
    } finally {
      f.close();
    }
  }
});

function driftApplied(f, mutation) {
  if (mutation === "head") writeFileSync(join(f.physicalPath, ".git/HEAD"), `${"e".repeat(40)}\n`);
  else if (mutation === "index") {
    const path = join(f.physicalPath, ".git/index");
    writeFileSync(`${path}.replacement`, readFileSync(path), { mode: 0o600 });
    renameSync(`${path}.replacement`, path);
  } else {
    // A validly re-signed changed receipt also fails the original applied
    // evidence comparison; this is stronger than only corrupting its MAC.
    execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        `
import json,hmac,hashlib,sys
v=json.load(sys.stdin)
with open(v['path']) as f:r=json.load(f)['record']
r['fixtureFloat']=2.0
with open(v['key'],'rb') as f:key=f.read()
s=hmac.new(key,json.dumps(r,sort_keys=True,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
with open(v['path'],'w') as f:json.dump({'record':r,'signature':s},f,sort_keys=True,indent=2)
`,
      ],
      {
        input: JSON.stringify({
          path: join(f.home, ".local/state/hive/managed-projects/github-11.json"),
          key: join(f.home, ".local/state/hive/managed-projects/key"),
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }
}
test("known physical HEAD/index or valid signed-receipt drift across applied commit ACK retains hold", async () => {
  for (const mutation of ["head", "index", "receipt"]) {
    const f = await appliedFixture();
    try {
      const original = f.options.fetchImpl;
      const reopened = openGuardianController({
        ...f.options,
        async fetchImpl(url, init) {
          const response = await original(url, init);
          if (JSON.parse(init.body).action === "apply_commit") driftApplied(f, mutation);
          return response;
        },
      });
      await assert.rejects(
        reopened.applyCommit({
          projectId: f.request.projectId,
          applicationId: f.request.applicationId,
        }),
      );
      assert.equal(reopened.status.held, true);
      assert.equal(f.calls.filter((c) => c.action === "apply_commit").length, 1);
      const saved = JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state;
      assert.equal(saved.pending.action, "apply_commit");
      assert.equal(saved.applications[f.request.applicationId].authority.phase, "pending");
    } finally {
      f.close();
    }
  }
});
test("lost applied ACK readback cannot release input after HEAD/index or valid signed-receipt drift", async () => {
  for (const mutation of ["head", "index", "receipt"]) {
    const f = await appliedFixture();
    try {
      f.mode("applyLost");
      await assert.rejects(
        f.client.applyCommit({
          projectId: f.request.projectId,
          applicationId: f.request.applicationId,
        }),
      );
      const receipt = f.calls.find((c) => c.action === "apply_commit").appliedReceipt;
      driftApplied(f, mutation);
      f.mode("normal");
      f.app.phase = "held";
      f.sync();
      const reopened = openGuardianController(f.options);
      await assert.rejects(
        reopened.applyVerify({
          projectId: f.request.projectId,
          applicationId: f.request.applicationId,
        }),
      );
      assert.equal(reopened.status.held, true);
      assert.equal(f.calls.filter((c) => c.action === "apply_commit").length, 1);
      const saved = JSON.parse(readFileSync(join(f.home, "outer/controller.json"))).state;
      assert.equal(saved.pending.action, "apply_commit");
      assert.deepEqual(saved.applications[f.request.applicationId].receipt, receipt);
      assert.equal(saved.applications[f.request.applicationId].authority.phase, "pending");
    } finally {
      f.close();
    }
  }
});

test("actual native spool persists progression on claims, and unsupported claims cannot authorize application", async () => {
  for (const valid of [true, false]) {
    const f = await applicationFixture();
    let writer;
    try {
      const o = f.app.sourceObservation,
        registration = {
          id: o.registrationId,
          serverInstanceId: o.serverInstanceId,
          expiresAt: Date.now() + 60000,
          threads: [{ projectId: f.request.projectId, threadId: o.managerThreadId }],
        },
        directory = join(f.home, "actual-spool"),
        params = { threadId: o.managerThreadId, turnId: o.parentTurnId, callId: "actual-claim" },
        command = { operation: "claim_step", payload: { taskId: o.taskId, stepId: o.stepId } };
      writer = createDeliveryNativeSpool({
        stateDirectory: directory,
        hostPrivateKeyPem: f.n.state.controllerPrivateKeyPem,
        progressionProtocol: 1,
        sourceProtocol: 1,
        currentRegistration: () => registration,
        currentServerInstanceId: () => o.serverInstanceId,
        registerChild: () => {},
        deliver: async () => {
          throw new Error("unexpected native delivery");
        },
      });
      writer.beginClaim(params, command, randomUUID(), o.checkoutBinding, undefined, {
        registrationId: o.registrationId,
        serverInstanceId: o.serverInstanceId,
        inputSourceSha: o.inputSourceSha,
      });
      writer.recordClaim(
        params,
        command,
        {
          attemptId: o.attemptId,
          managerBindingId: o.managerBindingId,
          leaseGeneration: 1,
          nativeSequence: 0,
          cursorVersion: 1,
          progressionProtocol: 1,
          checkoutBindingDigest: o.checkoutBindingDigest,
          inputSourceSha: o.inputSourceSha,
          replayed: false,
          outcome: "running",
          canRun: false,
          needsRuntimeBinding: true,
          needsReconciliation: false,
        },
        o.checkoutBinding,
      );
      const actual = JSON.parse(readFileSync(join(directory, "source.json"))).state,
        claim = actual.attempts[o.attemptId];
      assert.equal(Object.hasOwn(actual, "progressionProtocol"), false);
      assert.equal(actual.sourceProtocol, 1);
      assert.equal(claim.progressionProtocol, 1);
      // Other terminal facts remain the explicitly synthetic observer fixture.
      f.spool.attempts[o.attemptId] = structuredClone(claim);
      f.spool.claims[o.managerThreadId] = structuredClone(claim);
      if (!valid) delete f.spool.attempts[o.attemptId].progressionProtocol;
      f.app.sourceObservation.sourceJournalDigest = f.saveSpool();
      f.app.barrier.sourceSpoolDigest = f.app.sourceObservation.sourceJournalDigest;
      f.sync();
      if (valid) assert.equal((await f.client.applyReserve(f.request)).phase, "pending");
      else {
        await assert.rejects(f.client.applyReserve(f.request));
        assert.equal(f.calls.filter((c) => c.action === "apply_reserve").length, 0);
      }
    } finally {
      await writer?.close();
      f.close();
    }
  }
});
