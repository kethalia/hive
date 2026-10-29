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
