import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstalledDeliveryRuntime } from "../templates/ai-dev-k8s/scripts/codex-delivery-runtime.mjs";
import { validateHostConfig } from "../templates/ai-dev-k8s/scripts/codex-workspace-host.mjs";
import { deliveryProofPayload } from "../templates/ai-dev-k8s/scripts/delivery-manager-adapter.mjs";
import { nativeSourceProofPayload } from "../templates/ai-dev-k8s/scripts/delivery-native-spool.mjs";
import { sourcePublisherProofPayload } from "../templates/ai-dev-k8s/scripts/delivery-source-publisher.mjs";

function config() {
  return {
    schemaVersion: 1,
    enabled: true,
    profile: "software",
    binding: { hiveUserId: randomUUID() },
    hiveOrigin: "https://hive.invalid",
    issuerPublicKeyPem: "fixture",
    issuerKeyId: "fixture",
    port: 13341,
    model: "gpt-6.1-sol",
    effort: "low",
    managerEnabled: true,
    nativeIsolationEnabled: true,
    guardianEnabled: true,
    deliveryExecutionEnabled: true,
  };
}
async function fixture(t, patch = {}) {
  const home = mkdtempSync(join(tmpdir(), "hive-delivery-factory-")),
    key = generateKeyPairSync("ed25519");
  const physical = {
    projectId: randomUUID(),
    preparationIntentId: randomUUID(),
    repositoryId: "123",
    revision: "a".repeat(40),
    leaseId: randomUUID(),
    leaseGeneration: 1,
  };
  const project = {
    projectId: physical.projectId,
    repositoryId: "123",
    taskId: physical.preparationIntentId,
    revision: physical.revision,
    leaseId: physical.leaseId,
    leaseGeneration: 1,
  };
  const thread = randomUUID(),
    serverInstanceId = randomUUID(),
    calls = [],
    revoked = [];
  const registration = {
    id: randomUUID(),
    serverInstanceId,
    expiresAt: Date.now() + 60000,
    threads: [{ projectId: project.projectId, threadId: thread }],
  };
  const checkout = join(home, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true, mode: 0o700 });
  const nativeListeners = new Set(),
    registrationListeners = new Set();
  const supervisor = {
    closed: false,
    onRevoked: (listener) => {
      nativeListeners.add(listener);
      return () => nativeListeners.delete(listener);
    },
    config: { executionMode: "isolated", metadataReadOnly: true, projects: [project] },
    state: {
      status: "ready",
      serverInstanceId,
      controllerPrivateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      projects: { [project.projectId]: { threadId: thread } },
    },
    checkout: (p) => {
      assert.equal(p, project);
      return checkout;
    },
    runtime: {
      alive: () => supervisor.state.status === "ready",
      drainManagerRouting: async () => ({ pendingObservers: 0, activeHandlers: 0 }),
    },
    registerChild: () => {},
    readNativeHistory: async () => ({ data: [], nextCursor: null }),
    continueDeliveryRoot: async () => {
      throw new Error("unexpected execution");
    },
    revalidateDeliveryBoundary: async () => {
      throw new Error("unexpected execution");
    },
    revokeExecution: async (id, reason) => {
      revoked.push({ id, reason });
      supervisor.state.projects[id].executionRevoked = true;
    },
  };
  const controller = {
    assertRuntimeExecution: () => {},
    currentProjectContext: (id) => {
      assert.equal(id, thread);
      return physical;
    },
    currentSource: (id) => {
      assert.equal(id, thread);
      return { checkoutBinding: physical, headSha: physical.revision, phase: "ready" };
    },
  };
  const guardian = {
    currentMetadata: async () => {
      throw new Error("not authorized by this fixture");
    },
    applyReserve: async () => {},
    applyVerify: async () => {},
    applyCommit: async () => {},
  };
  const gateway = {
    closeProjectInputs: async () => {},
    projectInputInventory: () => {},
    releaseProjectInputs: async () => {},
  };
  const options = {
    config: config(),
    home,
    supervisor,
    controller,
    registration: {
      currentRegistration: () => registration,
      onRevoked: (listener) => {
        registrationListeners.add(listener);
        return () => registrationListeners.delete(listener);
      },
    },
    guardian,
    gateway,
    inspectManaged: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (url === "https://hive.invalid/api/delivery/native") {
        assert(
          verify(
            null,
            Buffer.from(nativeSourceProofPayload(body)),
            key.publicKey,
            Buffer.from(body.proof, "base64url"),
          ),
        );
        return Response.json({ accepted: true, blocked: false, sequence: body.sequence });
      }
      if (url === "https://hive.invalid/api/delivery/source-publication/policy") {
        assert(
          verify(
            null,
            Buffer.from(sourcePublisherProofPayload("policy", body)),
            key.publicKey,
            Buffer.from(body.proof, "base64url"),
          ),
        );
        return Response.json({ error: "fixture_policy_disabled" }, { status: 403 });
      }
      assert.equal(url, "https://hive.invalid/api/delivery/host");
      assert(
        verify(
          null,
          Buffer.from(deliveryProofPayload(body)),
          key.publicKey,
          Buffer.from(body.proof, "base64url"),
        ),
      );
      if (body.command.operation === "create_task")
        return Response.json({ taskId: body.command.payload.id, replayed: false });
      return Response.json({
        attemptId: randomUUID(),
        leaseGeneration: 1,
        managerBindingId: randomUUID(),
        checkoutBindingDigest: "b".repeat(64),
        nativeSequence: 0,
        progressionProtocol: 1,
        cursorVersion: 1,
        replayed: false,
        outcome: "running",
        canRun: false,
        needsRuntimeBinding: true,
        needsReconciliation: false,
        inputSourceSha: physical.revision,
      });
    },
    ...patch,
  };
  let runtime;
  t.after(async () => {
    await runtime?.close();
    rmSync(home, { recursive: true, force: true });
  });
  runtime = await createInstalledDeliveryRuntime(options);
  const turnId = randomUUID();
  const call = (operation, payload, useThread = thread) =>
    runtime.adapter.handleToolCall({
      threadId: useThread,
      turnId,
      callId: randomUUID(),
      namespace: null,
      tool: "hive_delivery",
      arguments: { operation, payload },
    });
  return {
    runtime,
    options,
    physical,
    thread,
    turnId,
    calls,
    revoked,
    registration,
    supervisor,
    call,
    revokeNative: () => {
      supervisor.state.status = "revoked";
      for (const listener of nativeListeners) listener();
    },
    revokeRegistration: () => {
      registration.expiresAt = Date.now() - 1;
      for (const listener of registrationListeners) listener();
    },
  };
}

test("explicit delivery capability cannot be inferred from legacy manager-only config", () => {
  const enabled = config();
  assert.equal(validateHostConfig(enabled).deliveryExecutionEnabled, true);
  const { deliveryExecutionEnabled: _flag, ...legacy } = enabled;
  assert.equal(validateHostConfig(legacy).deliveryExecutionEnabled, undefined);
  for (const patch of [
    { deliveryExecutionEnabled: "true" },
    { managerEnabled: false },
    { guardianEnabled: false },
    { nativeIsolationEnabled: false },
  ])
    assert.throws(() => validateHostConfig({ ...enabled, ...patch }));
});
test("factory fails before constructing effects without all installed prerequisites", async () => {
  for (const patch of [
    { deliveryExecutionEnabled: undefined },
    { managerEnabled: false },
    { guardianEnabled: false },
    { nativeIsolationEnabled: false },
  ])
    await assert.rejects(
      createInstalledDeliveryRuntime({ config: { ...config(), ...patch } }),
      /delivery_runtime_unavailable/,
    );
});
test("actual installed adapter exposes source protocol and signs immutable physical task context", async (t) => {
  const f = await fixture(t),
    taskId = randomUUID(),
    stepId = randomUUID();
  assert.equal(f.runtime.adapter.progressionProtocol, 1);
  assert(
    f.runtime.adapter.tools()[0].inputSchema.properties.operation.enum.includes("publish_source"),
  );
  await f.call("create_task", { id: taskId, steps: [{ id: stepId }] });
  const claim = JSON.parse((await f.call("claim_step", { taskId, stepId })).contentItems[0].text);
  assert.equal(claim.canRun, false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].checkoutBinding, f.physical);
  assert.equal(f.calls[0].registrationId, f.registration.id);
  assert.deepEqual(f.runtime.evidenceStatus(), { phase: "idle", reason: null });
  await assert.rejects(
    f.call("publish_source", {
      operationId: randomUUID(),
      paths: ["src/a"],
      deletions: [],
      message: "feat: x",
      title: "feat: x",
      body: "fixture",
    }),
    /native_/,
  );
  assert.equal(f.calls.length, 2, "no source/provider request before known child completion");
});
test("foreign manager cannot select a checkout or mint a signed call", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call("create_task", { id: randomUUID() }, randomUUID()));
  assert.equal(f.calls.length, 0);
});
test("changed native lifetime stops signed effects and trusted status", async (t) => {
  const f = await fixture(t);
  f.supervisor.state.serverInstanceId = randomUUID();
  await assert.rejects(f.call("create_task", { id: randomUUID() }));
  assert.throws(() => f.runtime.evidenceStatus(), /delivery_runtime_unavailable/);
  assert.equal(f.calls.length, 0);
});

for (const mode of ["rejected_policy", "revoked_metadata"])
  test(`recorded child completion preserves ${mode} authority boundary`, async (t) => {
    const f = await fixture(t),
      taskId = randomUUID(),
      stepId = randomUUID(),
      childThreadId = randomUUID(),
      childTurnId = randomUUID(),
      spawnCallId = "known-child";
    const checkout = f.supervisor.checkout(f.supervisor.config.projects[0]);
    const meta = {
      runtimeId: randomUUID(),
      runtimeGeneration: 1,
      admissionId: randomUUID(),
      admissionGeneration: 3,
      producerDigest: "1".repeat(64),
      checkoutIncarnation: randomUUID(),
      barrierGeneration: 0,
      metadataPins: Object.fromEntries(
        [
          ["checkout", checkout],
          ["git", join(checkout, ".git")],
        ].map(([key, path]) => {
          const v = statSync(path, { bigint: true });
          return [key, { device: String(v.dev), inode: String(v.ino) }];
        }),
      ),
      metadataPinsDigest: "2".repeat(64),
      metadataPolicyDigest: "3".repeat(64),
      namespaceReceiptDigest: "4".repeat(64),
    };
    let entered, reply;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const late = new Promise((resolve) => {
      reply = resolve;
    });
    f.options.guardian.currentMetadata = async () => {
      if (mode === "revoked_metadata") {
        entered();
        await late;
      }
      return meta;
    };
    await f.call("create_task", { id: taskId, steps: [{ id: stepId }] });
    await f.call("claim_step", { taskId, stepId });
    f.supervisor.readNativeHistory = async () => ({
      data: [{ id: childTurnId, status: "completed", itemsView: "full", items: [] }],
      nextCursor: null,
    });
    f.runtime.adapter.observe({
      method: "rawResponseItem/completed",
      params: {
        threadId: f.thread,
        turnId: f.turnId,
        item: {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          call_id: spawnCallId,
          arguments: JSON.stringify({ model: "gpt-6.1-sol", reasoning_effort: "low" }),
        },
      },
    });
    f.runtime.adapter.observe({
      method: "item/completed",
      params: {
        threadId: f.thread,
        turnId: f.turnId,
        item: {
          type: "subAgentActivity",
          kind: "started",
          id: spawnCallId,
          agentThreadId: childThreadId,
          model: "gpt-6.1-sol",
          reasoningEffort: "low",
        },
      },
    });
    const pending = f.call("publish_source", {
      operationId: randomUUID(),
      paths: ["src/a"],
      deletions: [],
      message: "feat: x",
      title: "feat: x",
      body: "fixture",
    });
    void pending.catch(() => {});
    if (mode === "revoked_metadata") {
      await waiting;
      f.revokeRegistration();
      await assert.rejects(pending, /source_publisher_uncertain/);
      await f.runtime.close();
      reply();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        f.calls.some((call) => call.action === "publish_source_revision"),
        false,
      );
      return;
    }
    await assert.rejects(pending, /source_/);
    const policy = f.calls.find((call) => call.action === "publish_source_revision");
    assert(policy, "actual publisher must reach signed policy before any worker/provider effect");
    assert.deepEqual(policy.checkoutBinding, f.physical);
    assert.equal(policy.taskId, taskId);
    assert.equal(policy.stepId, stepId);
    assert.deepEqual(f.runtime.evidenceStatus(), { phase: "idle", reason: null });
  });

for (const mode of ["native", "registration", "close"])
  test(`in-flight ${mode} revocation aborts even an uncooperative transport and rejects late ACK`, async (t) => {
    let entered,
      respond,
      signal,
      cancelled = false;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const stalled = new Promise((resolve) => {
      respond = resolve;
    });
    const f = await fixture(t, {
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        entered();
        return stalled;
      },
    });
    const pending = f.call("create_task", { id: randomUUID(), steps: [{ id: randomUUID() }] });
    void pending.catch(() => {});
    await started;
    const at = performance.now();
    if (mode === "native") f.revokeNative();
    else if (mode === "registration") f.revokeRegistration();
    else void f.runtime.close();
    assert.equal(signal.aborted, true);
    await assert.rejects(pending);
    await f.runtime.close();
    assert(performance.now() - at < 1000, "close must not wait on an ignored transport abort");
    respond(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await new Promise((done) => setImmediate(done));
    assert.equal(cancelled, true);
    assert.throws(() => f.runtime.evidenceStatus(), /delivery_runtime_unavailable/);
    await assert.rejects(f.call("create_task", { id: randomUUID() }));
  });
