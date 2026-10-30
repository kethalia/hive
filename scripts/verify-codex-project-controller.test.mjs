import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProjectController,
  validateProjectOperation,
} from "../templates/ai-dev-k8s/scripts/codex-project-controller.mjs";

function fixture(t, configure) {
  const dir = mkdtempSync(join(tmpdir(), "hive-controller-"));
  const projectId = randomUUID(),
    taskId = randomUUID(),
    requestId = randomUUID();
  const config = {
    stateDirectory: dir,
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    model: "gpt-6.1-sol",
    effort: "low",
  };
  const open = {
    schemaVersion: 1,
    projectId,
    repositoryId: "123",
    expectedAccountId: "456",
    requestId,
  };
  const start = {
    ...open,
    taskId,
    revision: "a".repeat(40),
    model: config.model,
    effort: config.effort,
    text: "Actual user task fixture",
  };
  const status = { schemaVersion: 1, projectId, taskId, requestId: randomUUID() };
  let prepared = null,
    registered = false,
    registrationError = false,
    phase = "not-created",
    threadId = null,
    attached = false;
  const calls = [];
  const supervisor = {
    async provePreExecution() {
      calls.push("provePreExecution");
      assert.equal(phase, "awaitingFirstTurn");
      return { threadId };
    },
    registrationBinding() {
      return { threadId, serverInstanceId: "server" };
    },
    lease() {
      assert.ok(prepared?.lease.expiresAt > Date.now() / 1000);
      return prepared;
    },
    async revokeExecution() {
      calls.push("revokeExecution");
    },
    snapshot() {
      return { phase, threadId, serverInstanceId: "server", attached };
    },
    enrollPreparedProject(p) {
      calls.push("enroll");
      assert.equal(p.taskId, taskId);
    },
    async command(r) {
      calls.push(r.operation);
      if (r.operation === "ensureProject" && !threadId) {
        threadId = randomUUID();
        phase = "awaitingFirstTurn";
      }
      if (r.operation === "firstPrompt") {
        assert.equal(r.text, start.text);
        assert.equal(r.requestId, start.requestId);
        phase = "persisted";
      }
      if (r.operation === "attach") attached = true;
      return { phase, threadId, serverInstanceId: "server", attached };
    },
  };
  const deps = {
    async resolveRepository(r) {
      assert.equal(r.expectedAccountId, "456");
      return {
        schemaVersion: 1,
        providerAccountId: "456",
        repository: { providerRepositoryId: "123", permissions: { push: true }, archived: false },
        defaultRevision: "a".repeat(40),
      };
    },
    async inspectCheckout() {
      calls.push("inspect");
      return prepared ?? { status: "not_created", lease: null };
    },
    async prepareCheckout() {
      calls.push("prepare");
      prepared = {
        status: "ready",
        checkoutVerified: true,
        revision: start.revision,
        checkoutIncarnation: "fixture-incarnation",
        checkoutIdentity: { device: "1", inode: "2" },
        renewalSequence: 0,
        lease: { taskId, id: randomUUID(), generation: 1, expiresAt: Date.now() / 1000 + 900 },
      };
      return prepared;
    },
    async openRuntime() {
      calls.push("runtime");
      return {
        supervisor,
        registration: {
          currentRegistration: () => {
            if (registrationError) throw new Error("registration_unavailable");
            return registered
              ? { serverInstanceId: "server", threads: [{ projectId, threadId }] }
              : null;
          },
        },
      };
    },
  };
  configure?.({ deps, config, calls, projectId, taskId, dir });
  let controller = createProjectController(config, deps);
  t.after(async () => {
    await controller.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    deps,
    open,
    start,
    status,
    calls,
    get controller() {
      return controller;
    },
    register() {
      registered = true;
    },
    unregister() {
      registered = false;
    },
    failRegistration(value) {
      registrationError = value;
    },
    setPrepared(v) {
      prepared = v;
    },
    setPhase(v) {
      phase = v;
    },
    async restart() {
      await controller.close();
      controller = createProjectController(config, deps);
    },
  };
}
test("enrollment is durable without clone/native; queued start waits registration then submits actual prompt once", async (t) => {
  const f = fixture(t);
  const enrolled = await f.controller.handle("/projects/open", f.open);
  assert.equal(enrolled.currentTaskId, null);
  assert.equal(enrolled.phase, "awaitingTask");
  assert.deepEqual(f.calls, []);
  const started = await f.controller.handle("/projects/tasks/start", f.start);
  assert.equal(started.phase, "preparing");
  await f.controller.drain();
  let state = await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.equal(state.phase, "awaitingRegistration");
  assert.equal(f.calls.filter((x) => x === "runtime").length, 1);
  assert.equal(f.calls.includes("firstPrompt"), false);
  f.register();
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  state = await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.equal(state.phase, "running");
  assert.match(state.terminalSessionName, /^project-[a-f0-9]{24}$/);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
  assert.equal(f.calls.filter((x) => x === "prepare").length, 1);
  const reopened = await f.controller.handle("/projects/open", f.open);
  assert.equal(reopened.currentTaskId, f.start.taskId);
  await assert.rejects(
    f.controller.handle("/projects/tasks/start", { ...f.start, text: "Different prompt" }),
    /task_identity_conflict/,
  );
});
test("restart recovers exact durable intent and never repeats checkout preparation or first prompt", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  await f.restart();
  f.register();
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "prepare").length, 1);
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
  await f.restart();
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
});
test("ambiguous first prompt blocks replay without another inference", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  f.register();
  f.setPhase("firstPromptUncertain");
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  const state = await f.controller.handle("/projects/tasks/status", f.status);
  assert.equal(state.phase, "blocked");
  assert.equal(state.reason, "prompt_submission_uncertain");
  assert.equal(f.calls.includes("firstPrompt"), false);
});
test("owned interrupted checkout preparation reuses verified lease without cleaning dirty edits", async (t) => {
  const f = fixture(t);
  f.setPrepared({
    status: "ready",
    checkoutVerified: true,
    revision: f.start.revision,
    lease: {
      taskId: f.start.taskId,
      id: randomUUID(),
      generation: 2,
      expiresAt: Date.now() / 1000 + 900,
    },
  });
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  assert.equal(f.calls.includes("prepare"), false);
});
test("private journal rejects competing writer, forgery, identity changes and unknown authority", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  assert.throws(() => createProjectController(f.config, f.deps));
  await assert.rejects(
    f.controller.handle("/projects/tasks/start", { ...f.start, model: "unconfigured" }),
    /model_unavailable/,
  );
  await assert.rejects(f.controller.handle("/projects/open", { ...f.open, repositoryId: "999" }));
  await f.controller.close();
  const p = join(f.config.stateDirectory, "projects.json"),
    saved = JSON.parse(readFileSync(p));
  saved.state.ownerId = randomUUID();
  writeFileSync(p, JSON.stringify(saved));
  assert.throws(() => createProjectController(f.config, f.deps), /journal_signature_invalid/);
});
test("request surface rejects paths, arbitrary fields, controls, and oversized UTF8 prompts", (t) => {
  const f = fixture(t);
  for (const patch of [
    { path: "/tmp" },
    { text: "\u0000" },
    { text: "界".repeat(10923) },
    { taskId: "../escape" },
  ])
    assert.throws(() =>
      validateProjectOperation("/projects/tasks/start", { ...f.start, ...patch }),
    );
  assert.throws(() => validateProjectOperation("/shell", f.start));
});

test("manager checkout context is derived from registered thread and verified lease, independent of delivery task IDs", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  const state = await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.throws(
    () => f.controller.currentProjectContext(state.nativeThreadId),
    /registration_unavailable/,
  );
  f.register();
  const context = f.controller.currentProjectContext(state.nativeThreadId);
  assert.equal(context.preparationIntentId, f.start.taskId);
  assert.equal(context.revision, f.start.revision);
  assert.equal(context.projectId, f.open.projectId);
  assert.throws(() => f.controller.currentProjectContext("other"), /task_identity_conflict/);
  f.setPrepared({ ...context, lease: { expiresAt: 0 } });
  assert.throws(() => f.controller.currentProjectContext(state.nativeThreadId));
});

test("safe lease renewal keeps immutable intent and failed renewal revokes only execution", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  f.register();
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  const context = f.controller.currentProjectContext(
    (await f.controller.handle("/projects/tasks/status", f.status)).nativeThreadId,
  );
  await f.controller.drain();
  let calls = 0;
  f.deps.renewLease = async (projectId) => {
    calls++;
    assert.equal(projectId, f.open.projectId);
    return {
      checkoutIncarnation: "fixture-incarnation",
      revision: f.start.revision,
      renewalSequence: calls,
      lease: {
        id: context.leaseId,
        generation: context.leaseGeneration,
        taskId: context.preparationIntentId,
        expiresAt: Date.now() / 1000 + 3600,
      },
    };
  };
  f.controller.renewLeases();
  await f.controller.drain();
  assert.equal(calls, 1);
  assert.deepEqual(
    f.controller.currentProjectContext(
      (await f.controller.handle("/projects/tasks/status", f.status)).nativeThreadId,
    ),
    context,
  );
  await f.controller.drain();
  f.deps.renewLease = async () => {
    throw new Error("denied");
  };
  f.controller.renewLeases();
  await f.controller.drain();
  const result = await f.controller.handle("/projects/tasks/status", f.status);
  assert.equal(result.phase, "blocked");
  assert.equal(result.reason, "checkout_unavailable");
  assert.ok(result.nativeThreadId);
  assert.equal(f.calls.filter((x) => x === "revokeExecution").length, 1);
  f.controller.renewLeases();
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
});

test("revoked execution can re-register existing history after restart without new prompt or attach", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  f.register();
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  f.deps.renewLease = async () => {
    throw new Error("denied");
  };
  f.controller.renewLeases();
  await f.controller.drain();
  const beforePrompt = f.calls.filter((x) => x === "firstPrompt").length,
    beforeAttach = f.calls.filter((x) => x === "attach").length;
  await f.restart();
  f.controller.resumePending();
  await f.controller.drain();
  const status = await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.equal(status.phase, "blocked");
  assert.ok(status.nativeThreadId);
  assert.equal(status.terminalSessionName, null);
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, beforePrompt);
  assert.equal(f.calls.filter((x) => x === "attach").length, beforeAttach);
});

for (const phase of ["awaitingRegistration", "blocked"]) {
  test(`lease expiry revokes ${phase} native execution without renewing or discarding history`, async (t) => {
    const f = fixture(t);
    await f.controller.handle("/projects/open", f.open);
    await f.controller.handle("/projects/tasks/start", f.start);
    await f.controller.drain();
    f.register();
    await f.controller.handle("/projects/tasks/status", f.status);
    await f.controller.drain();
    if (phase === "awaitingRegistration") f.unregister();
    else f.setPhase("firstPromptUncertain");
    await f.controller.handle("/projects/tasks/status", f.status);
    await f.controller.drain();
    const before = await f.controller.handle("/projects/tasks/status", f.status);
    await f.controller.drain();
    assert.equal(before.phase, phase);
    let renewals = 0;
    f.deps.renewLease = async () => {
      renewals++;
      throw new Error("must_not_renew");
    };
    f.controller.renewLeases();
    await f.controller.drain();
    assert.equal(renewals, 0, "blocked and registration-pending work cannot extend authority");
    assert.equal(
      f.calls.includes("revokeExecution"),
      false,
      "valid lease survives phase transition",
    );
    // Expiry enforcement must still run without an available renewal helper.
    delete f.deps.renewLease;
    f.setPrepared({ status: "ready", lease: { expiresAt: Date.now() / 1000 - 1 } });
    f.controller.renewLeases();
    await f.controller.drain();
    const result = await f.controller.handle("/projects/tasks/status", f.status);
    assert.equal(result.phase, "blocked");
    assert.equal(result.reason, "checkout_unavailable");
    assert.equal(result.nativeThreadId, before.nativeThreadId);
    assert.equal(result.terminalSessionName, null);
    assert.equal(f.calls.filter((x) => x === "revokeExecution").length, 1);
    assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
    f.controller.renewLeases();
    await f.controller.drain();
    assert.equal(f.calls.filter((x) => x === "revokeExecution").length, 1);
  });
}

test("pre-execution retry is durable, concurrent-idempotent and preserves the original first prompt", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  const resolve = f.deps.resolveRepository;
  f.deps.resolveRepository = async () => {
    throw new Error("github_auth_required");
  };
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  assert.equal(
    (await f.controller.handle("/projects/tasks/status", f.status)).reason,
    "github_auth_required",
  );
  await f.restart();
  f.deps.resolveRepository = resolve;
  const retry = { ...f.status, requestId: randomUUID() };
  await Promise.all([
    f.controller.handle("/projects/tasks/retry", retry),
    f.controller.handle("/projects/tasks/retry", retry),
  ]);
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "prepare").length, 1);
  assert.equal(f.calls.filter((x) => x === "ensureProject").length, 1);
  f.register();
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
  const before = [...f.calls];
  assert.equal(
    (await f.controller.handle("/projects/tasks/retry", { ...retry, requestId: randomUUID() }))
      .phase,
    "running",
  );
  assert.deepEqual(f.calls, before, "running recovery is a read-only acknowledgement");
  await f.restart();
  assert.equal((await f.controller.handle("/projects/tasks/retry", retry)).phase, "running");
  assert.deepEqual(f.calls, before, "lost ACK replay after restart cannot launch a runtime");
  const saved = JSON.parse(readFileSync(join(f.config.stateDirectory, "projects.json"))).state
    .projects[f.open.projectId].task;
  assert.deepEqual(saved.request, f.start);
  assert.equal(saved.retries.length, 1);
  assert.equal(saved.retries[0].requestId, retry.requestId);
});

test("retry receipt cannot automatically retry a second failure", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  f.deps.resolveRepository = async () => {
    throw new Error("github_auth_required");
  };
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  const retry = { ...f.status, requestId: randomUUID() };
  await f.controller.handle("/projects/tasks/retry", retry);
  await f.controller.drain();
  const before = [...f.calls];
  await f.restart();
  assert.equal((await f.controller.handle("/projects/tasks/retry", retry)).phase, "blocked");
  await f.controller.drain();
  assert.deepEqual(f.calls, before);
});

test("ready live empty native thread retries registration failure without recreating checkout or thread", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  f.failRegistration(true);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  assert.equal(
    (await f.controller.handle("/projects/tasks/status", f.status)).reason,
    "registration_unavailable",
  );
  f.failRegistration(false);
  f.register();
  await f.controller.handle("/projects/tasks/retry", { ...f.status, requestId: randomUUID() });
  await f.controller.drain();
  assert.equal(f.calls.filter((x) => x === "provePreExecution").length, 1);
  assert.equal(f.calls.filter((x) => x === "prepare").length, 1);
  assert.equal(f.calls.filter((x) => x === "ensureProject").length, 1);
  assert.equal(f.calls.filter((x) => x === "firstPrompt").length, 1);
});

for (const changed of ["interrupted", "incarnation", "expired", "history"]) {
  test(`retry refuses ${changed} checkout/native proof`, async (t) => {
    const f = fixture(t);
    await f.controller.handle("/projects/open", f.open);
    f.failRegistration(true);
    await f.controller.handle("/projects/tasks/start", f.start);
    await f.controller.drain();
    const inspected = await f.deps.inspectCheckout();
    if (changed === "interrupted") f.setPrepared({ ...inspected, status: "interrupted" });
    if (changed === "incarnation")
      f.setPrepared({ ...inspected, checkoutIncarnation: "replacement" });
    if (changed === "expired")
      f.setPrepared({ ...inspected, lease: { ...inspected.lease, expiresAt: 0 } });
    if (changed === "history") f.setPhase("persisted");
    f.failRegistration(false);
    await assert.rejects(
      f.controller.handle("/projects/tasks/retry", { ...f.status, requestId: randomUUID() }),
    );
    assert.equal(f.calls.includes("firstPrompt"), false);
  });
}

test("retry cannot reopen uncertain first prompt or accept caller execution fields", async (t) => {
  const f = fixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  f.register();
  f.setPhase("firstPromptUncertain");
  await f.controller.handle("/projects/tasks/status", f.status);
  await f.controller.drain();
  await assert.rejects(
    f.controller.handle("/projects/tasks/retry", f.status),
    /retry_not_available/,
  );
  for (const patch of [
    { text: "replacement" },
    { revision: "b".repeat(40) },
    { leaseId: randomUUID() },
    { model: "other" },
  ])
    assert.throws(() =>
      validateProjectOperation("/projects/tasks/retry", { ...f.status, ...patch }),
    );
});

for (const mutation of ["legacy", "creationAttempted", "promptAttempted", "revoked"]) {
  test(`retry rejects ${mutation} durable intent authority`, async (t) => {
    const f = fixture(t);
    await f.controller.handle("/projects/open", f.open);
    f.deps.resolveRepository = async () => {
      throw new Error("github_auth_required");
    };
    await f.controller.handle("/projects/tasks/start", f.start);
    await f.controller.drain();
    await f.controller.close();
    const path = join(f.config.stateDirectory, "projects.json");
    const saved = JSON.parse(readFileSync(path));
    const task = saved.state.projects[f.open.projectId].task;
    if (mutation === "legacy") delete task.nativeCreationAttempted;
    if (mutation === "creationAttempted") task.nativeCreationAttempted = true;
    if (mutation === "promptAttempted") task.firstPromptSubmissionAttempted = true;
    if (mutation === "revoked") task.executionRevoked = { reason: "lease_renewal_failed" };
    // Explicit trusted fixture journal, never a production bypass.
    saved.signature = createHmac(
      "sha256",
      readFileSync(join(f.config.stateDirectory, "projects.key")),
    )
      .update(JSON.stringify(saved.state))
      .digest("hex");
    writeFileSync(path, JSON.stringify(saved));
    await f.restart();
    await assert.rejects(
      f.controller.handle("/projects/tasks/retry", { ...f.status, requestId: randomUUID() }),
      /retry_not_available/,
    );
    assert.equal(f.calls.includes("ensureProject"), false);
  });
}

test("unavailable empty native history returns the existing blocked status without scheduling", async (t) => {
  const f = fixture(t);
  const openRuntime = f.deps.openRuntime;
  f.deps.openRuntime = async (...args) => {
    const runtime = await openRuntime(...args);
    runtime.supervisor.provePreExecution = async () => {
      throw new Error("retry_history_unavailable");
    };
    return runtime;
  };
  await f.controller.handle("/projects/open", f.open);
  f.failRegistration(true);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  f.failRegistration(false);
  const before = [...f.calls];
  const result = await f.controller.handle("/projects/tasks/retry", {
    ...f.status,
    requestId: randomUUID(),
  });
  await f.controller.drain();
  assert.equal(result.phase, "blocked");
  assert.equal(result.reason, "registration_unavailable");
  assert.deepEqual(f.calls, before.concat("inspect"));
});

function guardianFixture(t, configure) {
  let phase = "open",
    generation = 1;
  const lifetimeId = randomUUID(),
    bindingDigest = "b".repeat(64),
    projects = new Map();
  const ownershipDigest = () => String(generation).padStart(64, "0");
  let context;
  const guard = {
    get state() {
      return { phase, lifetimeId, bindingDigest, generation, ownershipDigest: ownershipDigest() };
    },
    async admit(project) {
      const saved = JSON.parse(readFileSync(join(context.dir, "projects.json"))).state;
      assert.ok(saved.projects[project.projectId].task.guardianPreparation);
      assert.equal(saved.projects[project.projectId].task.guardianPrepared, undefined);
      if (projects.size === 0) {
        assert.equal(context.calls.includes("prepare"), false);
        assert.equal(context.calls.includes("inspect"), false);
      }
      assert.ok(
        !projects.has(project.projectId) ||
          projects.get(project.projectId) === project.bindingDigest,
      );
      projects.set(project.projectId, project.bindingDigest);
      generation++;
      return {
        projectId: project.projectId,
        projectBindingDigest: project.bindingDigest,
        ...guard.state,
      };
    },
    async executionFence(token) {
      assert.equal(phase, "open");
      assert.equal(token.projectBindingDigest, projects.get(token.projectId));
      return { ...token, ...guard.state };
    },
    assertAdmission(token) {
      assert.equal(phase, "open");
      assert.equal(token.generation, generation);
      assert.equal(token.lifetimeId, lifetimeId);
      assert.equal(token.projectBindingDigest, projects.get(token.projectId));
    },
  };
  const f = fixture(t, (c) => {
    context = c;
    c.deps.guardian = guard;
    c.deps.guardianBuildId = randomUUID();
    configure?.(c, guard);
  });
  return {
    ...f,
    guard,
    barrier() {
      phase = "closed";
      return {
        ...guard.state,
        barrierId: randomUUID(),
        projects: [...projects].map(([projectId, bindingDigest]) => ({ projectId, bindingDigest })),
      };
    },
    lose() {
      phase = "indeterminate";
      f.controller.loseAdmission();
    },
    saved: () => JSON.parse(readFileSync(join(context.dir, "projects.json"))).state,
  };
}

test("guardian admission is durable before preparation and final binding is a separate immutable record", async (t) => {
  const f = guardianFixture(t);
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  const task = f.saved().projects[f.open.projectId].task;
  assert.equal(task.guardianPreparation.stage, "preparation");
  assert.equal(task.guardianPreparation.baseSha, f.start.revision);
  assert.equal(task.guardianPreparation.leaseId, undefined);
  assert.equal(task.guardianPrepared.leaseId, task.prepared.leaseId);
  assert.equal(task.guardianPrepared.checkoutIncarnation, task.checkoutIncarnation);
  assert.deepEqual(task.guardianPrepared.checkoutIdentity, { device: "1", inode: "2" });
  assert.ok(f.calls.indexOf("prepare") < f.calls.indexOf("runtime"));
  const earlier = JSON.stringify(task.guardianPreparation);
  await f.controller.executionFence(f.open.projectId);
  f.controller.assertExecution(f.open.projectId);
  assert.equal(
    JSON.stringify(f.saved().projects[f.open.projectId].task.guardianPreparation),
    earlier,
  );
  const barrier = f.barrier();
  assert.equal(f.controller.closeAdmission(barrier).closed, true);
  assert.deepEqual(f.saved().guardianBarrier, barrier);
  assert.throws(
    () => f.controller.assertExecution(f.open.projectId),
    /controller_admission_closed/,
  );
  await assert.rejects(
    f.controller.handle("/projects/tasks/status", f.status),
    /controller_admission_closed/,
  );
});

test("closing while preparation is in flight retains uncertainty and cannot enroll or start native execution", async (t) => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const pause = new Promise((done) => {
    release = done;
  });
  const f = guardianFixture(t, ({ deps }) => {
    const prepare = deps.prepareCheckout;
    deps.prepareCheckout = async () => {
      entered();
      await pause;
      return prepare();
    };
  });
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await started;
  const barrier = f.barrier();
  assert.throws(
    () => f.controller.closeAdmission(barrier),
    /guardian_barrier_preparation_uncertain/,
  );
  release();
  await f.controller.drain();
  assert.equal(f.calls.includes("runtime"), false);
  assert.equal(f.calls.includes("ensureProject"), false);
  assert.deepEqual(f.saved().guardianBarrier, barrier);
  assert.equal(f.saved().projects[f.open.projectId].task.guardianPrepared, undefined);
});

test("lost guardian channel persists a closed admission fence and prevents helper dispatch", async (t) => {
  const f = guardianFixture(t);
  await f.controller.handle("/projects/open", f.open);
  f.lose();
  await assert.rejects(
    f.controller.handle("/projects/tasks/start", f.start),
    /controller_admission_closed/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved().guardianBarrier.reason, "guardian_channel_lost");
});

test("a new admitted project refreshes existing generation tokens before shared helper work", async (t) => {
  let f,
    preparations = 0;
  f = guardianFixture(t, ({ deps }) => {
    deps.resolveRepository = async (r) => ({
      schemaVersion: 1,
      providerAccountId: r.expectedAccountId,
      repository: {
        providerRepositoryId: r.repositoryId,
        permissions: { push: true },
        archived: false,
      },
      defaultRevision: "a".repeat(40),
    });
    deps.inspectCheckout = async () => ({ status: "not_created", lease: null });
    deps.prepareCheckout = async (r) => {
      f.controller.assertRuntimeExecution();
      preparations++;
      return {
        status: "ready",
        checkoutIncarnation: randomUUID(),
        checkoutIdentity: { device: "1", inode: "2" },
        lease: {
          taskId: r.taskId,
          id: randomUUID(),
          generation: 1,
          expiresAt: Date.now() / 1000 + 900,
        },
      };
    };
    deps.openRuntime = async () => {
      throw new Error("fixture_no_native");
    };
  });
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  const other = {
    ...f.open,
    projectId: randomUUID(),
    repositoryId: "789",
    requestId: randomUUID(),
  };
  await f.controller.handle("/projects/open", other);
  await f.controller.handle("/projects/tasks/start", {
    ...f.start,
    ...other,
    taskId: randomUUID(),
  });
  await f.controller.drain();
  assert.equal(preparations, 2);
  f.controller.assertRuntimeExecution();
});

test("closure during repository resolution cannot dispatch checkout inspection or preparation", async (t) => {
  let entered,
    release,
    resolves = 0;
  const waiting = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const f = guardianFixture(t, ({ deps }) => {
    const original = deps.resolveRepository;
    deps.resolveRepository = async (r) => {
      if (++resolves === 2) {
        entered();
        await gate;
      }
      return original(r);
    };
  });
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await waiting;
  f.lose();
  release();
  await f.controller.drain();
  assert.equal(f.calls.includes("inspect"), false);
  assert.equal(f.calls.includes("prepare"), false);
  assert.equal(f.calls.includes("runtime"), false);
});

test("late lease renewal after the close barrier cannot rewrite the closed controller snapshot", async (t) => {
  let entered, release;
  const waiting = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const f = guardianFixture(t, ({ deps }) => {
    deps.renewLease = async () => {
      entered();
      await gate;
      return null;
    };
  });
  f.register();
  await f.controller.handle("/projects/open", f.open);
  await f.controller.handle("/projects/tasks/start", f.start);
  await f.controller.drain();
  f.controller.renewLeases();
  await waiting;
  f.controller.closeAdmission(f.barrier());
  const closed = JSON.stringify(f.saved());
  release();
  await f.controller.drain();
  assert.equal(JSON.stringify(f.saved()), closed);
  assert.equal(f.calls.includes("revokeExecution"), false);
});
