import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectSupervisor } from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

function fixture() {
  const projectId = randomUUID(),
    root = randomUUID(),
    child = randomUUID(),
    maintenanceId = randomUUID();
  const promptId = randomUUID(),
    promptTurnId = randomUUID(),
    promptText = "original accepted prompt";
  const state = {
    status: "ready",
    serverInstanceId: "server",
    projects: {
      [projectId]: {
        threadId: root,
        serverInstanceId: "server",
        attached: true,
        firstPrompt: {
          requestId: promptId,
          turnId: promptTurnId,
          digest: createHash("sha256").update(promptText).digest("hex"),
          phase: "accepted",
        },
        children: { [child]: { serverInstanceId: "server" } },
      },
    },
  };
  const supervisor = new ProjectSupervisor(
    { projects: [{ projectId }] },
    "/unused",
    "/unused",
    state,
    () => {},
    null,
  );
  const calls = [];
  let rootActive = true,
    childActive = true,
    extra = false,
    evaluator = true,
    input = true;
  supervisor.acceptanceRuntime = {
    closeAdmission() {
      calls.push("close-evaluator-admission");
    },
    active: () => evaluator,
  };
  supervisor.runtime = {
    async detach(p) {
      assert.equal(p, projectId);
      calls.push("detach-input-cli");
      input = false;
    },
    inspectCliInputs: () => ({ activeCli: input ? 1 : 0, unknownInputs: 0 }),
    inspectManagerRouting: () => ({
      receiveSequence: 0,
      activeHandlers: 0,
      pendingObservers: 0,
      observerFailures: [],
    }),
    async call(method, params) {
      calls.push(method);
      if (method === "thread/loaded/list")
        return { data: [root, child, ...(extra ? [randomUUID()] : [])] };
      if (method === "thread/read")
        return {
          thread: {
            id: params.threadId,
            status: {
              type: (params.threadId === root ? rootActive : childActive) ? "active" : "idle",
            },
          },
        };
      if (method === "thread/turns/list")
        return {
          data: [
            {
              id: params.threadId === root ? promptTurnId : randomUUID(),
              status: "failed",
              itemsView: "full",
              items:
                params.threadId === root
                  ? [
                      {
                        type: "userMessage",
                        clientId: promptId,
                        content: [{ type: "text", text: promptText }],
                      },
                    ]
                  : [],
            },
          ],
        }; // Failed auth is idle, never task success.
      throw Error("unexpected native command");
    },
  };
  return {
    supervisor,
    projectId,
    maintenanceId,
    calls,
    finishRoot() {
      rootActive = false;
    },
    finishChild() {
      childActive = false;
    },
    finishEvaluator() {
      evaluator = false;
    },
    addUnknown() {
      extra = true;
    },
  };
}
test("graceful account maintenance closes inputs, waits active root/child/evaluator and never interrupts them", async () => {
  const f = fixture();
  await f.supervisor.beginAccountMaintenance(f.maintenanceId);
  assert.throws(() => f.supervisor.assertAccountMaintenanceStart(), /account_maintenance_pending/);
  await assert.rejects(
    f.supervisor.accountMaintenanceBoundary(f.maintenanceId),
    /account_maintenance_waiting/,
  );
  f.finishEvaluator();
  await assert.rejects(
    f.supervisor.accountMaintenanceBoundary(f.maintenanceId),
    /account_maintenance_waiting/,
  );
  f.finishRoot();
  await assert.rejects(
    f.supervisor.accountMaintenanceBoundary(f.maintenanceId),
    /account_maintenance_waiting/,
  );
  f.finishChild();
  const result = await f.supervisor.accountMaintenanceBoundary(f.maintenanceId);
  assert.equal(result.length, 1);
  assert.equal(result[0].projectId, f.projectId);
  assert.equal(result[0].threadIds.length, 2);
  assert.equal(result[0].activeRoots, 0);
  assert.equal(
    f.calls.some((s) => /interrupt|turn\/start|thread\/start/.test(s)),
    false,
  );
});
test("unknown loaded actors and a different maintenance intent never authorize closure", async () => {
  const f = fixture();
  await f.supervisor.beginAccountMaintenance(f.maintenanceId);
  await assert.rejects(
    f.supervisor.beginAccountMaintenance(randomUUID()),
    /account_maintenance_changed/,
  );
  await assert.rejects(
    f.supervisor.accountMaintenanceBoundary(randomUUID()),
    /account_maintenance_changed/,
  );
  f.finishRoot();
  f.finishChild();
  f.finishEvaluator();
  f.addUnknown();
  await assert.rejects(
    f.supervisor.accountMaintenanceBoundary(f.maintenanceId),
    /account_maintenance_inventory_unknown/,
  );
});

test("maintenance parking retains exact unfinished task, native metadata reservation, dirty checkout and lease on replay", async () => {
  const { createHmac } = await import("node:crypto");
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parkAccountMaintenanceProjectState } = await import(
    "../templates/ai-dev-k8s/scripts/codex-project-controller.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "hive-maintenance-park-"));
  try {
    const directory = join(root, "codex-project-controller"),
      nativeDirectory = join(root, "codex-project-supervisor"),
      checkout = join(root, "dirty-checkout");
    for (const dir of [directory, nativeDirectory, checkout]) await mkdir(dir, { mode: 0o700 });
    const key = Buffer.alloc(32, 1),
      nativeKey = Buffer.alloc(32, 2);
    const ownerId = randomUUID(),
      workspaceId = randomUUID(),
      projectId = randomUUID(),
      threadId = randomUUID(),
      lifetimeId = randomUUID(),
      barrierId = randomUUID(),
      maintenanceId = randomUUID();
    const state = {
      schemaVersion: 1,
      ownerId,
      workspaceId,
      guardianLifetimeId: lifetimeId,
      guardianBarrier: {
        barrierId,
        generation: 2,
        projects: [{ projectId, bindingDigest: "a".repeat(64) }],
      },
      hostProcess: { pid: 100 },
      projects: {
        [projectId]: {
          task: {
            taskId: randomUUID(),
            phase: "running",
            nativeThreadId: threadId,
            firstPromptSubmissionAttempted: true,
            request: { text: "PRIVATE_ORIGINAL_INTENT" },
            prepared: { leaseId: randomUUID(), leaseGeneration: 4 },
          },
        },
      },
    };
    const native = {
      schemaVersion: 1,
      ownerId,
      workspaceId,
      serverInstanceId: "old",
      projects: { [projectId]: { threadId, serverInstanceId: "old" } },
      metadataLaunch: { phase: "reserved", approval: { nativeLaunchId: randomUUID() } },
    };
    const signed = (value, secret) =>
      JSON.stringify({
        state: value,
        signature: createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex"),
      });
    const registry = signed(native, nativeKey);
    for (const [file, bytes] of [
      [join(directory, "controller.lock"), ""],
      [join(directory, "projects.key"), key],
      [join(directory, "projects.json"), signed(state, key)],
      [join(nativeDirectory, "supervisor.lock"), ""],
      [join(nativeDirectory, "key"), nativeKey],
      [join(nativeDirectory, "registry.json"), registry],
      [join(checkout, "uncommitted.txt"), "retain local edits"],
      [join(checkout, "lease.json"), "retained-writer-even-if-expired"],
    ])
      await writeFile(file, bytes, { mode: 0o600 });
    const receipt = {
      scope: "managed_native_tree_only",
      guardianExited: true,
      finalWaitResult: "ECHILD",
      cleanupAuthorized: false,
      lifetimeId,
      workerBarrier: { barrierId, generation: 2, closed: true },
      generation: 3,
      workerPid: 100,
      projects: [{ projectId, bindingDigest: "a".repeat(64) }],
    };
    const config = { stateDirectory: directory, ownerId, workspaceId };
    assert.throws(
      () =>
        parkAccountMaintenanceProjectState(
          config,
          { ...receipt, guardianExited: false },
          maintenanceId,
        ),
      /maintenance_tree_exit_unverified/,
    );
    const parked = parkAccountMaintenanceProjectState(config, receipt, maintenanceId);
    assert.equal(parked.parked, true);
    assert.equal(JSON.stringify(parked).includes("PRIVATE_ORIGINAL_INTENT"), false);
    assert.deepEqual(parkAccountMaintenanceProjectState(config, receipt, maintenanceId), parked);
    const archive = JSON.parse(
      await readFile(join(directory, `projects-maintenance-${maintenanceId}.json`), "utf8"),
    );
    assert.deepEqual(archive.state.projectState, state);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "projects.json"), "utf8")).state.projects,
      {},
    );
    assert.equal(await readFile(join(nativeDirectory, "registry.json"), "utf8"), registry);
    assert.equal(await readFile(join(checkout, "uncommitted.txt"), "utf8"), "retain local edits");
    assert.equal(
      await readFile(join(checkout, "lease.json"), "utf8"),
      "retained-writer-even-if-expired",
    );
    assert.throws(
      () =>
        parkAccountMaintenanceProjectState(
          config,
          { ...receipt, lifetimeId: randomUUID() },
          maintenanceId,
        ),
      /maintenance_park_identity_changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function resumeFixture({
  lostAck = false,
  runnable = true,
  completed = false,
  resumeClass = "auth-failed",
} = {}) {
  const f = fixture(),
    requestId = randomUUID(),
    ownerIntentRuntimeId = randomUUID(),
    ownerIntentEventId = randomUUID();
  const scope = { id: f.maintenanceId, requestId, ownerIntentRuntimeId, ownerIntentEventId };
  const root = f.supervisor.state.projects[f.projectId].threadId,
    nativeReceiptEventId = randomUUID();
  f.supervisor.state.accountMaintenance = { id: scope.id };
  f.supervisor.state.maintenanceResume = {
    ...scope,
    historyProof: {
      [f.projectId]: { historyDigest: "a".repeat(64), lastTurnId: randomUUID(), resumeClass },
    },
  };
  f.supervisor.executionAuthority = { fence: async () => {}, assert() {} };
  f.supervisor.lease = () => {};
  let starts = 0,
    submitted,
    turnId = randomUUID(),
    visible = true;
  f.supervisor.runtime = {
    async call(method, params) {
      f.calls.push(method);
      if (method === "turn/start") {
        starts++;
        submitted = structuredClone(params);
        if (lostAck) throw Error("ACK lost after accepted input");
        return { turn: { id: turnId } };
      }
      if (method === "thread/turns/list")
        return {
          data: visible
            ? [
                {
                  id: turnId,
                  items: [
                    {
                      type: "userMessage",
                      clientId: requestId,
                      content: [{ type: "text", text: submitted.input[0].text }],
                    },
                  ],
                },
              ]
            : [],
          nextCursor: null,
        };
      throw Error("unexpected maintenance RPC");
    },
  };
  const authorized = {
    ready: true,
    runtimeId: randomUUID(),
    maintenanceId: scope.id,
    ownerIntentRuntimeId,
    ownerIntentEventId,
    authorizations: [
      {
        projectId: f.projectId,
        nativeReceiptEventId,
        managerBindingId: null,
        executionEpochVersion: 0,
        claimContinuation: null,
        runnable,
        completed,
      },
    ],
  };
  return {
    ...f,
    scope,
    authorized,
    root,
    starts: () => starts,
    submitted: () => submitted,
    hide: () => {
      visible = false;
    },
  };
}

test("one owner maintenance continuation follows committed fresh authority and never replays the first prompt", async () => {
  const f = resumeFixture(),
    original = structuredClone(f.supervisor.state.projects[f.projectId].firstPrompt);
  await assert.rejects(
    f.supervisor.finishAccountMaintenanceResume(f.scope, { ...f.authorized, ready: false }),
    /resume_unverified/,
  );
  await assert.rejects(
    f.supervisor.finishAccountMaintenanceResume(f.scope, {
      ...f.authorized,
      ownerIntentEventId: randomUUID(),
    }),
    /resume_unverified/,
  );
  assert.equal(f.starts(), 0);
  await f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized);
  await f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized);
  assert.equal(f.starts(), 1);
  assert.equal(f.submitted().threadId, f.root);
  assert.equal(f.submitted().clientUserMessageId, f.scope.requestId);
  assert.match(f.submitted().input[0].text, /fresh Hive delivery authorization/);
  assert(!f.submitted().input[0].text.includes("original accepted prompt"));
  assert.deepEqual(f.supervisor.state.projects[f.projectId].firstPrompt, original);
});
test("lost owner input ACK reconciles history only; missing history holds without another native start", async () => {
  for (const visible of [true, false]) {
    const f = resumeFixture({ lostAck: true });
    await assert.rejects(
      f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized),
      /ACK lost/,
    );
    assert.equal(f.starts(), 1);
    if (!visible) f.hide();
    const replay = f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized);
    if (visible) await replay;
    else await assert.rejects(replay, /input_uncertain/);
    assert.equal(f.starts(), 1);
  }
});
test("old physical claims, completed tasks and revoked fresh authority cannot gain maintenance model input", async () => {
  for (const options of [
    { runnable: false },
    { resumeClass: "completed", completed: true },
    { resumeClass: "unavailable" },
  ]) {
    const f = resumeFixture(options);
    await f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized);
    assert.equal(f.starts(), 0);
  }
  const f = resumeFixture();
  f.supervisor.executionAuthority.fence = async () => {
    throw Error("revoked");
  };
  await assert.rejects(
    f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized),
    /revoked/,
  );
  assert.equal(f.starts(), 0);
});

test("signed parked controller restores the same protocol-one thread and prompt with private rejoin only", async () => {
  const { createHmac } = await import("node:crypto"),
    { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const {
    createProjectController,
    parkAccountMaintenanceProjectState,
    readAccountMaintenanceArchive,
  } = await import("../templates/ai-dev-k8s/scripts/codex-project-controller.mjs");
  const home = await mkdtemp(join(tmpdir(), "hive-maintenance-rejoin-"));
  let controller;
  try {
    const dir = join(home, "controller"),
      nativeDir = join(home, "codex-project-supervisor");
    for (const p of [dir, nativeDir]) await mkdir(p, { mode: 0o700 });
    const ownerId = randomUUID(),
      workspaceId = randomUUID(),
      projectId = randomUUID(),
      buildId = randomUUID(),
      taskId = randomUUID(),
      requestId = randomUUID(),
      threadId = randomUUID(),
      turnId = randomUUID(),
      maintenanceId = randomUUID(),
      oldLifetimeId = randomUUID(),
      barrierId = randomUUID(),
      leaseId = randomUUID();
    const hash = (x) =>
      createHash("sha256")
        .update(typeof x === "string" ? x : JSON.stringify(x))
        .digest("hex");
    const text = "preserve this original task",
      request = {
        schemaVersion: 1,
        projectId,
        repositoryId: "123",
        expectedAccountId: "456",
        taskId,
        requestId,
        revision: "a".repeat(40),
        model: "gpt-6.1-sol",
        effort: "low",
        text,
      };
    const preparation = {
      schemaVersion: 1,
      stage: "preparation",
      ownerId,
      workspaceId,
      buildId,
      projectId,
      repositoryId: "123",
      providerAccountId: "456",
      taskId,
      requestId,
      baseSha: request.revision,
      requestDigest: hash(request),
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
    const checkoutIncarnation = randomUUID(),
      checkoutIdentity = { device: "1", inode: "2" };
    const old = {
      schemaVersion: 1,
      ownerId,
      workspaceId,
      guardianLifetimeId: oldLifetimeId,
      hostProcess: { pid: 100 },
      guardianBarrier: {
        barrierId,
        generation: 1,
        projects: [{ projectId, bindingDigest: hash(preparation) }],
      },
      projects: {
        [projectId]: {
          projectId,
          repositoryId: "123",
          expectedAccountId: "456",
          task: {
            taskId,
            request,
            digest: hash(request),
            guardianPreparation: preparation,
            prepared,
            checkoutIncarnation,
            checkoutIdentity,
            phase: "running",
            nativeThreadId: threadId,
            nativeCreationAttempted: true,
            firstPromptSubmissionAttempted: true,
          },
        },
      },
    };
    const firstPrompt = { requestId, turnId, digest: hash(text), phase: "accepted" };
    const native = {
      schemaVersion: 1,
      ownerId,
      workspaceId,
      buildId,
      status: "revoked",
      serverInstanceId: "old-server",
      accountMaintenance: { id: maintenanceId },
      metadataLaunch: { phase: "started", approval: { nativeLaunchId: randomUUID() } },
      projects: {
        [projectId]: {
          repositoryId: "123",
          threadId,
          serverInstanceId: "old-server",
          phase: "persisted",
          firstPrompt,
          children: {},
        },
      },
    };
    const key = Buffer.alloc(32, 3),
      nativeKey = Buffer.alloc(32, 4),
      signed = (state, k) =>
        JSON.stringify({
          state,
          signature: createHmac("sha256", k).update(JSON.stringify(state)).digest("hex"),
        });
    for (const [path, bytes] of [
      [join(dir, "projects.key"), key],
      [join(dir, "projects.json"), signed(old, key)],
      [join(dir, "controller.lock"), ""],
      [join(nativeDir, "key"), nativeKey],
      [join(nativeDir, "registry.json"), signed(native, nativeKey)],
      [join(nativeDir, "supervisor.lock"), ""],
      [join(home, "dirty.txt"), "unfinished source must survive"],
    ])
      await writeFile(path, bytes, { mode: 0o600 });
    const receipt = {
      scope: "managed_native_tree_only",
      guardianExited: true,
      finalWaitResult: "ECHILD",
      cleanupAuthorized: false,
      lifetimeId: oldLifetimeId,
      workerBarrier: { barrierId, generation: 1, closed: true },
      generation: 2,
      workerPid: 100,
      projects: old.guardianBarrier.projects,
    };
    const config = {
      stateDirectory: dir,
      ownerId,
      workspaceId,
      model: request.model,
      effort: request.effort,
    };
    const parked = parkAccountMaintenanceProjectState(config, receipt, maintenanceId);
    assert.equal(
      readAccountMaintenanceArchive(config, maintenanceId).parkedJournalDigest,
      parked.parkedJournalDigest,
    );
    const history = {
      data: [
        {
          id: turnId,
          status: "failed",
          error: { codexErrorInfo: "unauthorized" },
          itemsView: "full",
          items: [{ type: "userMessage", clientId: requestId, content: [{ type: "text", text }] }],
        },
      ],
      nextCursor: null,
    };
    const scope = {
      id: maintenanceId,
      requestId: randomUUID(),
      ownerIntentRuntimeId: randomUUID(),
      ownerIntentEventId: randomUUID(),
      parkedJournalDigest: parked.parkedJournalDigest,
      historyThreads: [{ projectId, threadIds: [threadId] }],
      projects: [
        {
          preparationIntentId: taskId,
          nativeThreadId: threadId,
          firstPromptRequestId: requestId,
          firstPromptDigest: hash(text),
          historyDigest: hash([{ threadId, history }]),
        },
      ],
    };
    const calls = [],
      guardian = {
        state: { phase: "open", lifetimeId: randomUUID(), generation: 1 },
        admit: async (value) => ({ ...value, generation: 1 }),
        executionFence: async (value) => value,
        assertAdmission() {},
      };
    let supervisor;
    controller = createProjectController(config, {
      guardian,
      guardianBuildId: buildId,
      inspectCheckout: async () => ({
        status: "ready",
        checkoutVerified: true,
        revision: request.revision,
        checkoutIncarnation,
        checkoutIdentity,
        lease: { id: leaseId, taskId, generation: 1, expiresAt: Date.now() / 1000 + 300 },
      }),
      prepareCheckout: async () => {
        throw Error("must not prepare or clean retained source");
      },
      async openRuntime(projects, resume) {
        assert.deepEqual(projects, [prepared]);
        assert.equal(resume.nativeRegistryDigest, hash(JSON.parse(signed(native, nativeKey))));
        const state = structuredClone(native);
        state.status = "ready";
        state.serverInstanceId = "new-server";
        state.maintenanceResume = resume;
        supervisor = new ProjectSupervisor(
          { projects, executionMode: "direct" },
          home,
          nativeDir,
          state,
          () => {},
          null,
        );
        supervisor.managerAdapter = { progressionProtocol: 1 };
        supervisor.executionAuthority = { fence: async () => {}, assert() {} };
        supervisor.runtime = {
          alive: () => true,
          inspectManagerRouting: () => ({
            receiveSequence: 0,
            activeHandlers: 0,
            pendingObservers: 0,
            observerFailures: [],
          }),
          async call(method, _params) {
            calls.push(method);
            if (method === "thread/resume")
              return {
                thread: {
                  id: threadId,
                  cwd: join(home, "projects/.hive-managed/github/123/checkout"),
                },
              };
            if (method === "thread/read")
              return { thread: { id: threadId, status: { type: "idle" } } };
            if (method === "thread/loaded/list") return { data: [threadId], nextCursor: null };
            if (method === "thread/turns/list") return structuredClone(history);
            throw Error(`unexpected effect ${method}`);
          },
        };
        return { supervisor, registration: { currentRegistration: () => null } };
      },
    });
    await assert.rejects(
      controller.resumeAccountMaintenance({ ...scope, parkedJournalDigest: "f".repeat(64) }),
      /archive_changed/,
    );
    assert.deepEqual(await controller.resumeAccountMaintenance(scope), { accepted: true });
    assert.equal(calls.filter((c) => c === "thread/resume").length, 1);
    assert(
      !calls.includes("thread/start") &&
        !calls.includes("turn/start") &&
        !calls.includes("turn/interrupt"),
    );
    assert.deepEqual(supervisor.state.projects[projectId].firstPrompt, firstPrompt);
    await assert.rejects(
      supervisor.command({ operation: "rejoin", projectId }),
      /manager_cli_attachment_forbidden/,
    );
    const status = await controller.handle("/projects/tasks/status", {
      schemaVersion: 1,
      projectId,
      taskId,
      requestId,
    });
    assert.equal(status.phase, "awaitingRegistration");
    assert.equal(status.nativeThreadId, threadId);
    assert.equal(await readFile(join(home, "dirty.txt"), "utf8"), "unfinished source must survive");
    const archive = JSON.parse(
      await readFile(join(dir, `projects-maintenance-${maintenanceId}.json`), "utf8"),
    );
    assert.deepEqual(
      archive.state.projectState.projects[projectId].task,
      old.projects[projectId].task,
    );
    await assert.rejects(controller.resumeAccountMaintenance(scope), /resume_unavailable/);
  } finally {
    await controller?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a successful step in an unfinished task receives one fixed owner input, whose private scope is turn-bound", async () => {
  const f = resumeFixture({ resumeClass: "completed" });
  const c = {
    ownerIntentRuntimeId: f.scope.ownerIntentRuntimeId,
    ownerIntentEventId: f.scope.ownerIntentEventId,
    epochRuntimeId: f.authorized.runtimeId,
    nativeReceiptEventId: f.authorized.authorizations[0].nativeReceiptEventId,
    epochResumeEventId: randomUUID(),
    epochVersion: 1,
    inputRequestId: f.scope.requestId,
  };
  Object.assign(f.authorized.authorizations[0], {
    executionEpochVersion: 1,
    claimContinuation: c,
  });
  assert.equal(f.supervisor.accountMaintenanceDeliveryContext(f.root, randomUUID()), null);
  await f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized);
  const input =
    f.supervisor.state.projects[f.projectId].accountMaintenanceInputs[f.scope.requestId];
  assert.deepEqual(
    f.supervisor.accountMaintenanceDeliveryContext(f.root, input.turnId).claimContinuation,
    c,
  );
  assert.equal(f.supervisor.accountMaintenanceDeliveryContext(f.root, randomUUID()), null);
  assert.equal(f.supervisor.accountMaintenanceDeliveryContext(randomUUID(), input.turnId), null);
  await f.supervisor.finishAccountMaintenanceResume(f.scope, f.authorized);
  assert.equal(f.starts(), 1);
});
