import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeliveryNativeSpool } from "../templates/ai-dev-k8s/scripts/delivery-native-spool.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hive-native-spool-")),
    key = generateKeyPairSync("ed25519"),
    managerThreadId = randomUUID(),
    parentTurnId = randomUUID(),
    childThreadId = randomUUID(),
    childTurnId = randomUUID(),
    spawnCallId = "spawn-call";
  let lifetime = randomUUID(),
    registration = {
      id: randomUUID(),
      serverInstanceId: lifetime,
      expiresAt: Date.now() + 60000,
      threads: [{ projectId: randomUUID(), threadId: managerThreadId }],
    };
  const context = {
    projectId: registration.threads[0].projectId,
    preparationIntentId: randomUUID(),
    repositoryId: "123",
    revision: "a".repeat(40),
    leaseId: randomUUID(),
    leaseGeneration: 1,
  };
  const sent = [],
    children = [],
    instances = [];
  const options = {
    stateDirectory: join(directory, "spool"),
    hostPrivateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    currentRegistration: () => registration,
    currentServerInstanceId: () => lifetime,
    registerChild: (...args) => children.push(args),
    deliver: async (value) => {
      sent.push(structuredClone(value));
      return { accepted: true, sequence: value.sequence, activeAttemptHeld: true };
    },
  };
  const make = (extra = {}) => {
    const spool = createDeliveryNativeSpool({ ...options, ...extra });
    instances.push(spool);
    return spool;
  };
  t.after(async () => {
    for (const instance of instances) await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const claim = {
    attemptId: randomUUID(),
    managerBindingId: randomUUID(),
    leaseGeneration: 1,
    nativeSequence: 0,
    replayed: false,
  };
  const request = { threadId: managerThreadId, turnId: parentTurnId, callId: "claim-call" },
    command = { operation: "claim_step", payload: { taskId: randomUUID(), stepId: randomUUID() } };
  const requested = {
    method: "rawResponseItem/completed",
    params: {
      threadId: managerThreadId,
      turnId: parentTurnId,
      item: {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: spawnCallId,
        arguments: JSON.stringify({
          message: "PRIVATE_NATIVE_PROMPT",
          model: "fixture-model",
          reasoning_effort: "low",
        }),
      },
    },
  };
  const resolved = {
    method: "item/completed",
    params: {
      threadId: managerThreadId,
      turnId: parentTurnId,
      item: {
        type: "subAgentActivity",
        kind: "started",
        id: spawnCallId,
        agentThreadId: childThreadId,
        model: "fixture-model",
        reasoningEffort: "low",
      },
    },
  };
  const item = {
    type: "commandExecution",
    id: "command-id",
    command: "printf PRIVATE_COMMAND",
    aggregatedOutput: "PRIVATE_COMMAND_OUTPUT",
    exitCode: 0,
    status: "completed",
  };
  const turn = { id: childTurnId, status: "completed", items: [item] };
  const events = (spool) => {
    spool.observe(requested);
    spool.observe(resolved);
    spool.observe({
      method: "turn/started",
      params: {
        threadId: childThreadId,
        turn: { id: childTurnId, status: "inProgress", items: [] },
      },
    });
    spool.observe({
      method: "item/completed",
      params: { threadId: childThreadId, turnId: childTurnId, item },
    });
    spool.observe({ method: "turn/completed", params: { threadId: childThreadId, turn } });
  };
  return {
    directory,
    context,
    claim,
    request,
    command,
    requested,
    resolved,
    item,
    turn,
    events,
    make,
    sent,
    children,
    managerThreadId,
    parentTurnId,
    childThreadId,
    childTurnId,
    options,
    offline: () => {
      registration = null;
    },
    online: () => {
      registration = {
        id: randomUUID(),
        serverInstanceId: lifetime,
        expiresAt: Date.now() + 60000,
        threads: [{ projectId: context.projectId, threadId: managerThreadId }],
      };
    },
    changeLifetime: () => {
      lifetime = randomUUID();
      registration = {
        id: randomUUID(),
        serverInstanceId: lifetime,
        expiresAt: Date.now() + 60000,
        threads: [{ projectId: context.projectId, threadId: managerThreadId }],
      };
    },
  };
}
test("claim receipt then exact native child facts create bounded ordered digest-only observations", async (t) => {
  const f = fixture(t),
    spool = f.make();
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  f.events(spool);
  await spool.flush();
  assert.deepEqual(
    f.sent.map((value) => value.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    f.sent.map((value) => value.source.kind),
    ["started", "command_completed", "turn_completed"],
  );
  assert.equal(f.children[0][0], f.managerThreadId);
  assert.equal(f.children[0][1], f.childThreadId);
  for (const value of f.sent) {
    assert.equal(value.taskId, f.command.payload.taskId);
    assert.notEqual(value.taskId, f.context.preparationIntentId);
    assert.deepEqual(value.checkoutBinding, f.context);
    assert.equal(value.source.childTurnId, f.childTurnId);
  }
  const stored = readFileSync(join(f.options.stateDirectory, "source.json"), "utf8");
  for (const value of ["PRIVATE_NATIVE_PROMPT", "printf PRIVATE_COMMAND", "PRIVATE_COMMAND_OUTPUT"])
    assert.equal(stored.includes(value), false);
  assert.deepEqual(spool.inspect(), { pending: 0, held: 1, blocked: 0 });
});
test("private spool survives lost acknowledgement and restart; history hydration repeats no source identities", async (t) => {
  const f = fixture(t);
  let failed = false;
  const first = f.make({
    deliver: async (value) => {
      f.sent.push(structuredClone(value));
      if (!failed) {
        failed = true;
        throw new Error("lost_ack");
      }
      return { accepted: true, sequence: value.sequence };
    },
  });
  first.recordClaim(f.request, f.command, f.claim, f.context);
  f.events(first);
  await assert.rejects(first.flush(), /lost_ack/);
  await first.close();
  const restarted = f.make({
    readNativeHistory: async () => ({ data: [f.turn], nextCursor: null }),
  });
  await restarted.resume();
  assert.equal(f.sent[0].eventId, f.sent[1].eventId);
  assert.equal(f.sent.filter((value) => value.sequence === 1).length, 2);
  assert.deepEqual(restarted.inspect(), { pending: 0, held: 1, blocked: 0 });
});
test("offline observations are retained and signed only after current registration returns", async (t) => {
  const f = fixture(t),
    spool = f.make();
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  f.offline();
  f.events(spool);
  await spool.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(spool.inspect().pending, 3);
  f.online();
  await spool.flush();
  assert.equal(f.sent.length, 3);
  assert.equal(spool.inspect().held, 1);
});
test("another native lifetime never replays old writer facts or admits a new claim", async (t) => {
  const f = fixture(t),
    spool = f.make();
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  f.events(spool);
  f.changeLifetime();
  await spool.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(spool.inspect().blocked, 1);
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation|lifetime/);
});
test("a spawn from another parent turn cannot inherit a reservation", async (t) => {
  const f = fixture(t),
    spool = f.make();
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  spool.observe({ ...f.requested, params: { ...f.requested.params, turnId: randomUUID() } });
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  await spool.flush();
  assert.equal(f.sent.length, 0);
});
test("same native item identity with changed exit/output becomes a controller conflict and keeps the writer held", async (t) => {
  const f = fixture(t),
    spool = f.make({
      deliver: async (value) => {
        f.sent.push(structuredClone(value));
        return { accepted: true, sequence: value.sequence, blocked: f.sent.length > 3 };
      },
    });
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  f.events(spool);
  await spool.flush();
  spool.observe({
    method: "item/completed",
    params: {
      threadId: f.childThreadId,
      turnId: f.childTurnId,
      item: { ...f.item, exitCode: 1, aggregatedOutput: "changed" },
    },
  });
  await spool.flush();
  assert.equal(f.sent[3].eventId, f.sent[1].eventId);
  assert.equal(f.sent[3].sequence, f.sent[1].sequence);
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  assert.equal(spool.inspect().held, 1);
});
test("partial native history and missing previous claim state fail closed", async (t) => {
  const f = fixture(t),
    spool = f.make({ readNativeHistory: async () => ({ data: [f.turn], nextCursor: "more" }) });
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  spool.observe(f.requested);
  spool.observe(f.resolved);
  await assert.rejects(spool.resume(), /history_incomplete/);
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  const another = fixture(t),
    empty = another.make();
  assert.throws(
    () =>
      empty.recordClaim(
        another.request,
        another.command,
        { ...another.claim, replayed: true },
        another.context,
      ),
    /missing_claim/,
  );
});
test("signed journal tampering is rejected rather than silently resetting source state", async (t) => {
  const f = fixture(t),
    spool = f.make();
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  await spool.close();
  const path = join(f.options.stateDirectory, "source.json"),
    saved = JSON.parse(readFileSync(path, "utf8"));
  saved.state.claims = {};
  writeFileSync(path, JSON.stringify(saved));
  assert.throws(() => f.make(), /spool_corrupt/);
});
test("failed history lookup persists a reconciliation hold across restart", async (t) => {
  const f = fixture(t),
    spool = f.make({
      readNativeHistory: async () => {
        throw new Error("native unavailable");
      },
    });
  spool.recordClaim(f.request, f.command, f.claim, f.context);
  spool.observe(f.requested);
  spool.observe(f.resolved);
  await assert.rejects(spool.resume(), /history_unavailable/);
  await spool.close();
  const restarted = f.make();
  assert.throws(() => restarted.assertAvailable(f.managerThreadId), /reconciliation/);
  assert.equal(restarted.inspect().held, 1);
});

function protocolOne(f) {
  const spool = f.make({
    progressionProtocol: 1,
    readNativeHistory: async () => ({ data: [{ ...f.turn, itemsView: "full" }], nextCursor: null }),
    deliver: async (value) => {
      f.sent.push(structuredClone(value));
      return {
        accepted: true,
        blocked: false,
        sequence: value.sequence,
        ...(value.source.kind === "root_boundary"
          ? { boundaryEventId: value.eventId, cursorVersion: value.source.cursorVersion }
          : {}),
      };
    },
  });
  const receipt = {
    ...f.claim,
    progressionProtocol: 1,
    cursorVersion: 1,
    checkoutBindingDigest: "a".repeat(64),
    outcome: "running",
    canRun: false,
    needsRuntimeBinding: true,
    needsReconciliation: false,
  };
  spool.beginClaim(f.request, f.command, randomUUID(), f.context);
  spool.recordClaim(f.request, f.command, receipt, f.context);
  return { spool, receipt };
}

test("protocol one preserves physical anchor and old attempt attribution across a monotonic logical cursor", async (t) => {
  const f = fixture(t),
    { spool, receipt } = protocolOne(f);
  f.events(spool);
  await spool.requireCompletedChild(f.managerThreadId, receipt.attemptId);
  spool.recordResult(
    f.request,
    { operation: "complete_step", payload: { ...f.command.payload, attemptId: receipt.attemptId } },
    { eventId: randomUUID(), reportId: randomUUID() },
  );
  spool.observe({
    method: "turn/completed",
    params: { threadId: f.managerThreadId, turn: { id: f.parentTurnId, status: "completed" } },
  });
  assert.equal(spool.continuationCandidate(f.managerThreadId).attemptId, receipt.attemptId);
  const nextTurn = randomUUID();
  spool.recordContinuationStart(f.managerThreadId, {
    parentTurnId: f.parentTurnId,
    priorAttemptId: receipt.attemptId,
    cursorVersion: 1,
    nextParentTurnId: nextTurn,
    serverInstanceId: f.options.currentServerInstanceId(),
  });
  const checkpoint = await spool.publishBoundary(
    f.managerThreadId,
    nextTurn,
    new Date().toISOString(),
  );
  assert.equal(checkpoint.sequence, 4);
  const nextRequest = { ...f.request, turnId: nextTurn, callId: "next-claim" };
  const nextCommand = { ...f.command, payload: { ...f.command.payload, stepId: randomUUID() } };
  const nextReceipt = { ...receipt, attemptId: randomUUID(), cursorVersion: 2, nativeSequence: 4 };
  spool.beginClaim(nextRequest, nextCommand, randomUUID(), f.context, checkpoint);
  spool.recordClaim(nextRequest, nextCommand, nextReceipt, f.context);
  assert.equal(spool.currentClaim(f.managerThreadId).attemptId, nextReceipt.attemptId);
  const saved = JSON.parse(
    readFileSync(join(f.options.stateDirectory, "source.json"), "utf8"),
  ).state;
  assert.equal(saved.claims[f.managerThreadId].attemptId, receipt.attemptId);
  assert.equal(saved.attempts[nextReceipt.attemptId].parentTurnId, nextTurn);
  // An exact late duplicate stays harmless and attributed to the old attempt.
  spool.observe({ method: "turn/completed", params: { threadId: f.childThreadId, turn: f.turn } });
  spool.assertAvailable(f.managerThreadId);
  assert.equal(spool.inspect().pending, 0);
  // A new old-turn fact cannot be promoted to the current cursor.
  spool.observe({
    method: "item/completed",
    params: {
      threadId: f.childThreadId,
      turnId: f.childTurnId,
      item: { ...f.item, id: "late-command" },
    },
  });
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  const after = JSON.parse(
    readFileSync(join(f.options.stateDirectory, "source.json"), "utf8"),
  ).state;
  assert.equal(after.events.at(-1).input.attemptId, receipt.attemptId);
  assert.equal(after.events.at(-1).input.sequence, 5);
  assert.equal(after.cursors[f.managerThreadId].attemptId, nextReceipt.attemptId);
});

test("protocol one never promotes a spawn observed before its claim receipt", async (t) => {
  const f = fixture(t),
    spool = f.make({ progressionProtocol: 1 });
  spool.observe(f.requested);
  spool.observe(f.resolved);
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  spool.beginClaim(f.request, f.command, randomUUID(), f.context);
  spool.recordClaim(
    f.request,
    f.command,
    {
      ...f.claim,
      progressionProtocol: 1,
      cursorVersion: 1,
      checkoutBindingDigest: "a".repeat(64),
      outcome: "running",
      canRun: false,
      needsRuntimeBinding: true,
      needsReconciliation: false,
    },
    f.context,
  );
  const saved = JSON.parse(
    readFileSync(join(f.options.stateDirectory, "source.json"), "utf8"),
  ).state;
  assert.equal(Object.keys(saved.fragments).length, 0);
  assert.equal(Object.values(saved.violations)[0].attemptId, null);
  assert.equal(Object.values(saved.violations)[0].childThreadId, f.childThreadId);
  assert.equal(f.children.length, 0);
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
});

test("a protocol-one historical claim replay remains held despite an exact pre-send journal", async (t) => {
  const f = fixture(t),
    { spool, receipt } = protocolOne(f);
  spool.recordClaim(
    f.request,
    f.command,
    { ...receipt, replayed: true, canRun: false, needsReconciliation: true },
    f.context,
  );
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  await spool.close();
  const restarted = f.make({ progressionProtocol: 1 });
  assert.throws(() => restarted.assertAvailable(f.managerThreadId), /reconciliation/);
  assert.equal(restarted.inspect().held, 1);
});

for (const patch of [
  { canRun: true },
  { needsRuntimeBinding: false },
  { needsReconciliation: undefined },
  { replayed: undefined },
  { outcome: "succeeded" },
])
  test(`unknown fresh reservation authority shape holds: ${JSON.stringify(patch)}`, async (t) => {
    const f = fixture(t),
      { spool, receipt } = protocolOne(f);
    assert.throws(
      () => spool.recordClaim(f.request, f.command, { ...receipt, ...patch }, f.context),
      /authority_unknown/,
    );
    assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  });

test("typed command work before a protocol-one claim cannot escape raw-event admission checks", async (t) => {
  const f = fixture(t),
    spool = f.make({ progressionProtocol: 1 });
  spool.observe({
    method: "item/started",
    params: {
      threadId: f.managerThreadId,
      turnId: f.parentTurnId,
      item: { id: "early-command", type: "commandExecution", status: "inProgress" },
    },
  });
  assert.throws(() => spool.assertAvailable(f.managerThreadId), /reconciliation/);
  assert.equal(spool.inspect().violations, 1);
  assert.equal(f.sent.length, 0);
});
