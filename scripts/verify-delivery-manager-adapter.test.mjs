import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  createDeliveryManagerAdapter,
  createNativeDelegationObserver,
  deliveryManagerToolSpec,
  deliveryProofPayload,
} from "../templates/ai-dev-k8s/scripts/delivery-manager-adapter.mjs";
import { nativeSourceProofPayload } from "../templates/ai-dev-k8s/scripts/delivery-native-spool.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hive-manager-adapter-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = generateKeyPairSync("ed25519");
  const registration = {
    id: randomUUID(),
    serverInstanceId: randomUUID(),
    expiresAt: Date.now() + 60000,
    threads: [{ projectId: randomUUID(), threadId: randomUUID() }],
  };
  const options = {
    enabled: true,
    hiveOrigin: "https://hive.example.invalid",
    stateDirectory: join(directory, "journal"),
    hostPrivateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    currentRegistration: () => registration,
    currentProjectContext: () => ({
      projectId: registration.threads[0].projectId,
      preparationIntentId: "11111111-1111-4111-8111-111111111111",
      repositoryId: "123",
      revision: "a".repeat(40),
      leaseId: "22222222-2222-4222-8222-222222222222",
      leaseGeneration: 1,
    }),
  };
  const request = {
    threadId: registration.threads[0].threadId,
    turnId: randomUUID(),
    callId: randomUUID(),
    namespace: null,
    tool: "hive_delivery",
    arguments: { operation: "create_task", payload: { id: randomUUID() } },
  };
  return { directory, key, registration, options, request };
}
test("native delegation reducer matches exact parent/turn/call and never persists prompt text", () => {
  const observe = createNativeDelegationObserver((thread) => thread === "manager");
  const request = {
    method: "rawResponseItem/completed",
    params: {
      threadId: "manager",
      turnId: "turn",
      item: {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: "spawn",
        arguments: JSON.stringify({
          message: "PRIVATE_PROMPT",
          model: "requested",
          reasoning_effort: "low",
        }),
      },
    },
  };
  const resolved = {
    method: "item/completed",
    params: {
      threadId: "manager",
      turnId: "turn",
      item: {
        type: "subAgentActivity",
        kind: "started",
        id: "spawn",
        agentThreadId: "child",
        model: "resolved",
        reasoningEffort: null,
      },
    },
  };
  assert.equal(observe({ ...request, params: { ...request.params, threadId: "other" } }), null);
  assert.equal(observe(resolved), null);
  const value = observe(request);
  assert.equal(value.requestedModel, "requested");
  assert.equal(value.effectiveModel, "resolved");
  assert.equal(value.effectiveEffort, null);
  assert.ok(!JSON.stringify(value).includes("PRIVATE_PROMPT"));
  assert.equal(observe(request), null);
  assert.equal(observe(resolved), null);
  assert.throws(
    () =>
      observe({
        ...resolved,
        params: {
          ...resolved.params,
          item: { ...resolved.params.item, agentThreadId: "different" },
        },
      }),
    /conflict/,
  );
});
test("default disabled, fixed configured HTTPS endpoint and exact registered native thread", async (t) => {
  const f = fixture(t);
  assert.deepEqual(createDeliveryManagerAdapter({ ...f.options, enabled: false }).tools(), []);
  assert.throws(
    () =>
      createDeliveryManagerAdapter({
        ...f.options,
        hiveOrigin: "https://hive.example.invalid/path",
      }),
    /origin/,
  );
  let calls = 0;
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    fetchImpl: async () => {
      calls++;
      return Response.json({ ok: true });
    },
  });
  await assert.rejects(adapter.handleToolCall({ ...f.request, threadId: "other" }), /registration/);
  await assert.rejects(
    adapter.handleToolCall({
      ...f.request,
      arguments: { operation: "record_evidence", payload: {} },
    }),
    /command/,
  );
  f.registration.expiresAt = Date.now() - 1;
  await assert.rejects(adapter.handleToolCall(f.request), /registration/);
  assert.equal(calls, 0);
});
test("informational report uses the signed manager path without creating execution or evidence authority", async (t) => {
  const f = fixture(t),
    payload = {
      taskId: randomUUID(),
      stepId: randomUUID(),
      attemptId: randomUUID(),
      expectedVersion: 1,
      leaseGeneration: 1,
      sourceSha: "a".repeat(40),
      report: {
        summary: "Understanding recorded",
        difficulty: "low",
        difficultyReason: "Bounded analysis",
        issues: [],
        remainingUncertainty: "Unverified model report",
        nextAction: "Implement",
      },
    };
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://hive.example.invalid/api/delivery/host");
      const body = JSON.parse(init.body);
      assert.equal(
        verify(
          null,
          Buffer.from(deliveryProofPayload(body)),
          f.key.publicKey,
          Buffer.from(body.proof, "base64url"),
        ),
        true,
      );
      assert.deepEqual(body.command, { operation: "report_step", payload });
      return Response.json({ informational: true, reportId: "fixture-report", replayed: false });
    },
  });
  assert.ok(adapter.tools()[0].inputSchema.properties.operation.enum.includes("report_step"));
  const result = await adapter.handleToolCall({
    ...f.request,
    arguments: { operation: "report_step", payload },
  });
  assert.equal(result.success, true);
  assert.equal(JSON.parse(result.contentItems[0].text).informational, true);
  assert.equal(JSON.parse(result.contentItems[0].text).canRun, undefined);
});
test("signed native-call journal survives adapter restart and changed-body replay conflicts", async (t) => {
  const f = fixture(t),
    sent = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://hive.example.invalid/api/delivery/host");
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    const body = JSON.parse(init.body);
    assert.equal(
      verify(
        null,
        Buffer.from(deliveryProofPayload(body)),
        f.key.publicKey,
        Buffer.from(body.proof, "base64url"),
      ),
      true,
    );
    sent.push(body);
    return Response.json({ taskId: "fixture", replayed: sent.length > 1 });
  };
  const first = createDeliveryManagerAdapter({ ...f.options, fetchImpl });
  assert.equal((await first.handleToolCall(f.request)).success, true);
  const restarted = createDeliveryManagerAdapter({ ...f.options, fetchImpl });
  await restarted.handleToolCall(f.request);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].eventId, sent[1].eventId);
  assert.equal(sent[0].managerThreadId, f.request.threadId);
  assert.equal(sent[0].nativeCallId, f.request.callId);
  await assert.rejects(
    restarted.handleToolCall({
      ...f.request,
      arguments: { ...f.request.arguments, payload: { id: "different" } },
    }),
    /replay_conflict/,
  );
  assert.equal(sent.length, 2);
});
test("ambiguous response may replay only the same event; redirects and excessive response fail closed", async (t) => {
  const f = fixture(t),
    events = [];
  let response = () => {
    throw new Error("lost_ack");
  };
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    fetchImpl: async (_url, init) => {
      events.push(JSON.parse(init.body).eventId);
      return response();
    },
  });
  await assert.rejects(adapter.handleToolCall(f.request), /lost_ack/);
  response = () =>
    new Response(null, { status: 302, headers: { Location: "https://other.invalid" } });
  await assert.rejects(adapter.handleToolCall(f.request), /rejected/);
  response = () => Response.json({ text: "x".repeat(65537) });
  await assert.rejects(adapter.handleToolCall(f.request), /response_limit/);
  assert.equal(new Set(events).size, 1);
});

function progressingAdapter(t, overrides = {}) {
  const f = fixture(t),
    posts = [],
    starts = [],
    bindingId = randomUUID();
  let sequence = 0,
    claims = 0;
  const native = {
    childThreadId: randomUUID(),
    childTurnId: randomUUID(),
    spawnCallId: "delegation-two",
  };
  const options = {
    ...f.options,
    nativeEnabled: true,
    progressionProtocol: 1,
    currentServerInstanceId: () => f.registration.serverInstanceId,
    registerChild: () => {},
    readNativeHistory: async () => ({
      data: [{ id: native.childTurnId, status: "completed", itemsView: "full", items: [] }],
      nextCursor: null,
    }),
    drainNativeRouting: async () => ({ pendingObservers: 0, activeHandlers: 0 }),
    continueRoot: async (request) => {
      starts.push(request);
      return {
        requestId: request.requestId,
        parentTurnId: request.parentTurnId,
        nextParentTurnId: `continuation-${request.cursorVersion}`,
        priorAttemptId: request.priorAttemptId,
        cursorVersion: request.cursorVersion,
        serverInstanceId: f.registration.serverInstanceId,
        historyDigest: "b".repeat(64),
      };
    },
    revalidateBoundary: async () => ({ observedAt: new Date().toISOString() }),
    fetchImpl: async (url, init) => {
      const value = JSON.parse(init.body);
      posts.push({ path: new URL(url).pathname, value });
      const payload = url.endsWith("/native")
        ? nativeSourceProofPayload(value)
        : deliveryProofPayload(value);
      assert.equal(
        verify(null, Buffer.from(payload), f.key.publicKey, Buffer.from(value.proof, "base64url")),
        true,
      );
      if (url.endsWith("/native")) {
        assert.equal(value.sequence, sequence + 1);
        sequence = value.sequence;
        return Response.json({
          accepted: true,
          blocked: false,
          sequence,
          ...(value.source.kind === "root_boundary"
            ? { boundaryEventId: value.eventId, cursorVersion: value.source.cursorVersion }
            : {}),
        });
      }
      if (value.command.operation === "claim_step")
        return Response.json({
          attemptId: randomUUID(),
          leaseGeneration: 1,
          managerBindingId: bindingId,
          checkoutBindingDigest: "a".repeat(64),
          nativeSequence: sequence,
          progressionProtocol: 1,
          cursorVersion: ++claims,
          replayed: false,
          outcome: "running",
          canRun: false,
          needsRuntimeBinding: true,
          needsReconciliation: false,
          inputSourceSha: value.sourceContext?.headSha ?? value.checkoutBinding.revision,
          ...(value.sourceContext ? { sourceContext: value.sourceContext } : {}),
        });
      if (value.command.operation === "create_task")
        return Response.json({ taskId: value.command.payload.id, replayed: false });
      return Response.json({
        eventId: value.eventId,
        reportId: randomUUID(),
        version: 1,
        replayed: false,
      });
    },
    ...overrides,
  };
  const adapter = createDeliveryManagerAdapter(options);
  t.after(() => adapter.close());
  const call = (turnId, callId, operation, payload) =>
    adapter.handleToolCall({ ...f.request, turnId, callId, arguments: { operation, payload } });
  const claim = async (turnId, callId, taskId, stepId) =>
    JSON.parse((await call(turnId, callId, "claim_step", { taskId, stepId })).contentItems[0].text);
  return { ...f, adapter, options, posts, starts, native, call, claim };
}

test("protocol one advances via signed host-only boundary without resetting its native sequence or physical anchor", async (t) => {
  const f = progressingAdapter(t),
    taskId = randomUUID(),
    stepId = randomUUID();
  const first = await f.claim(f.request.turnId, "first-claim", taskId, stepId);
  assert.equal(first.canRun, false);
  assert.equal(first.needsRuntimeBinding, true);
  await f.call(f.request.turnId, "first-report", "report_step", {
    taskId,
    stepId,
    attemptId: first.attemptId,
  });
  assert.equal(f.starts.length, 0);
  f.adapter.observe({
    method: "turn/completed",
    params: { threadId: f.request.threadId, turn: { id: f.request.turnId, status: "completed" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.starts.length, 1);
  const second = await f.claim("continuation-1", "second-claim", taskId, randomUUID());
  assert.equal(second.cursorVersion, 2);
  assert.equal(second.nativeSequence, 1);
  assert.notEqual(second.attemptId, first.attemptId);
  const boundary = f.posts.find((post) => post.value.source?.kind === "root_boundary").value;
  const nextClaim = f.posts.filter((post) => post.value.command?.operation === "claim_step")[1]
    .value;
  assert.equal(boundary.attemptId, first.attemptId);
  assert.equal(boundary.source.parentTurnId, f.request.turnId);
  assert.equal(boundary.source.nextParentTurnId, "continuation-1");
  assert.deepEqual(nextClaim.continuation, {
    boundaryEventId: boundary.eventId,
    priorAttemptId: first.attemptId,
    cursorVersion: 1,
    parentTurnId: f.request.turnId,
    nextParentTurnId: "continuation-1",
    sequence: 1,
  });
  assert.equal(Object.hasOwn(nextClaim.command, "continuation"), false);
  assert.equal(f.adapter.inspectNative().held, 1);
  assert.equal(f.adapter.inspectNative().attempts, 2);
});

test("completion drains child observations before HTTP and retries lost ACK with immutable call/event/content identity", async (t) => {
  const f = progressingAdapter(t),
    taskId = randomUUID(),
    stepId = randomUUID();
  const claim = await f.claim(f.request.turnId, "first-claim", taskId, stepId);
  const child = f.native;
  f.adapter.observe({
    method: "rawResponseItem/completed",
    params: {
      threadId: f.request.threadId,
      turnId: f.request.turnId,
      item: {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: child.spawnCallId,
        arguments: JSON.stringify({ model: "gpt-6.1-sol", reasoning_effort: "low" }),
      },
    },
  });
  f.adapter.observe({
    method: "item/completed",
    params: {
      threadId: f.request.threadId,
      turnId: f.request.turnId,
      item: {
        type: "subAgentActivity",
        kind: "started",
        id: child.spawnCallId,
        agentThreadId: child.childThreadId,
        model: "gpt-6.1-sol",
        reasoningEffort: "low",
      },
    },
  });
  // Rebuild around the same private journals with a transport that loses exactly
  // the completion ACK. Native source deliveries still acknowledge in order.
  await f.adapter.close();
  const attempts = [],
    transport = f.options.fetchImpl;
  let lost = false;
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    fetchImpl: async (url, init) => {
      const value = JSON.parse(init.body);
      if (value.command?.operation === "complete_step") {
        attempts.push(value);
        assert.equal(
          f.posts.filter((post) => post.value.source?.kind === "turn_completed").length,
          1,
        );
        if (!lost) {
          lost = true;
          throw new Error("lost_completion_ack");
        }
      }
      return transport(url, init);
    },
  });
  t.after(() => adapter.close());
  const result = await adapter.handleToolCall({
    ...f.request,
    callId: "complete-child",
    arguments: {
      operation: "complete_step",
      payload: { taskId, stepId, attemptId: claim.attemptId },
    },
  });
  assert.equal(result.success, true);
  assert.equal(attempts.length, 2);
  const immutable = ({ issuedAt, expiresAt, proof, ...value }) => value;
  assert.deepEqual(immutable(attempts[0]), immutable(attempts[1]));
  assert.equal(attempts[0].nativeCallId, "complete-child");
});

test("unknown continuation outcome retains a durable hold", async (t) => {
  const f = progressingAdapter(t, {
    continueRoot: async () => {
      throw new Error("ambiguous_native_start");
    },
  });
  const taskId = randomUUID(),
    stepId = randomUUID(),
    first = await f.claim(f.request.turnId, "first-claim", taskId, stepId);
  await f.call(f.request.turnId, "report", "report_step", {
    taskId,
    stepId,
    attemptId: first.attemptId,
  });
  f.adapter.observe({
    method: "turn/completed",
    params: { threadId: f.request.threadId, turn: { id: f.request.turnId, status: "completed" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.adapter.inspectNative().blocked, 1);
  await assert.rejects(
    f.call("unproven-next-turn", "claim", "claim_step", { taskId, stepId: randomUUID() }),
    /reconciliation/,
  );
});

function observeFixtureChild(f) {
  const child = f.native;
  f.adapter.observe({
    method: "rawResponseItem/completed",
    params: {
      threadId: f.request.threadId,
      turnId: f.request.turnId,
      item: {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: child.spawnCallId,
        arguments: JSON.stringify({ model: "gpt-6.1-sol", reasoning_effort: "low" }),
      },
    },
  });
  f.adapter.observe({
    method: "item/completed",
    params: {
      threadId: f.request.threadId,
      turnId: f.request.turnId,
      item: {
        type: "subAgentActivity",
        kind: "started",
        id: child.spawnCallId,
        agentThreadId: child.childThreadId,
        model: "gpt-6.1-sol",
        reasoningEffort: "low",
      },
    },
  });
}

test("controller policy rejection is never an automatic completion retry", async (t) => {
  const f = progressingAdapter(t),
    taskId = randomUUID(),
    stepId = randomUUID();
  const claim = await f.claim(f.request.turnId, "claim", taskId, stepId);
  observeFixtureChild(f);
  await f.adapter.close();
  let completionRequests = 0;
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    fetchImpl: async (url, init) => {
      if (JSON.parse(init.body).command?.operation === "complete_step") {
        completionRequests++;
        return Response.json({ error: "source_or_policy_rejected" }, { status: 409 });
      }
      return f.options.fetchImpl(url, init);
    },
  });
  t.after(() => adapter.close());
  await assert.rejects(
    adapter.handleToolCall({
      ...f.request,
      callId: "complete",
      arguments: {
        operation: "complete_step",
        payload: { taskId, stepId, attemptId: claim.attemptId },
      },
    }),
    /request_rejected/,
  );
  assert.equal(completionRequests, 1);
});

test("concurrent different manager calls hold the root even if the first reservation response arrives late", async (t) => {
  const f = progressingAdapter(t);
  await f.adapter.close();
  let release, requestStarted;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    fetchImpl: async (url, init) => {
      if (JSON.parse(init.body).command?.operation === "claim_step") {
        requestStarted();
        await gate;
      }
      return f.options.fetchImpl(url, init);
    },
  });
  t.after(() => adapter.close());
  const payload = { taskId: randomUUID(), stepId: randomUUID() };
  const first = adapter.handleToolCall({
    ...f.request,
    callId: "claim-a",
    arguments: { operation: "claim_step", payload },
  });
  await started;
  await assert.rejects(
    adapter.handleToolCall({
      ...f.request,
      callId: "claim-b",
      arguments: { operation: "claim_step", payload },
    }),
    /concurrent_delivery_calls/,
  );
  release();
  await assert.rejects(first, /reconciliation|authority_changed/);
  assert.equal(adapter.inspectNative().blocked, 1);
  assert.equal(f.posts.length, 1);
});

for (const change of ["expiry", "registration", "context"])
  test(`automatic continuation rejects stale ${change} before requesting another native turn`, async (t) => {
    const f = progressingAdapter(t),
      taskId = randomUUID(),
      stepId = randomUUID();
    const first = await f.claim(f.request.turnId, "claim", taskId, stepId);
    await f.call(f.request.turnId, "report", "report_step", {
      taskId,
      stepId,
      attemptId: first.attemptId,
    });
    if (change === "expiry") f.registration.expiresAt = Date.now() - 1;
    else if (change === "registration") f.registration.id = randomUUID();
    else f.registration.threads[0].projectId = randomUUID();
    f.adapter.observe({
      method: "turn/completed",
      params: { threadId: f.request.threadId, turn: { id: f.request.turnId, status: "completed" } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.starts.length, 0);
    assert.equal(f.adapter.inspectNative().blocked, 1);
  });

for (const change of ["expiry", "registration", "context", "lifetime"])
  test(`a delayed positive claim ACK across ${change} is journaled as uncertain, never returned as authority`, async (t) => {
    const f = progressingAdapter(t);
    await f.adapter.close();
    let release, entered;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      started = new Promise((resolve) => {
        entered = resolve;
      });
    const original = {
      registrationId: f.registration.id,
      serverInstanceId: f.registration.serverInstanceId,
    };
    const adapter = createDeliveryManagerAdapter({
      ...f.options,
      fetchImpl: async (url, init) => {
        entered();
        await gate;
        return f.options.fetchImpl(url, init);
      },
    });
    t.after(() => adapter.close());
    const request = adapter.handleToolCall({
      ...f.request,
      callId: "gated-claim",
      arguments: {
        operation: "claim_step",
        payload: { taskId: randomUUID(), stepId: randomUUID() },
      },
    });
    await started;
    if (change === "expiry") f.registration.expiresAt = Date.now() - 1;
    else if (change === "registration") f.registration.id = randomUUID();
    else if (change === "lifetime") f.registration.serverInstanceId = randomUUID();
    else f.registration.threads[0].projectId = randomUUID();
    release();
    await assert.rejects(request, /authority_changed/);
    assert.equal(adapter.inspectNative().blocked, 1);
    assert.equal(adapter.inspectNative().uncertainAcknowledgements, 1);
    assert.equal(adapter.inspectNative().held, 0); // Server reservation is not pretended undone; local authority was never accepted.
    const saved = JSON.parse(
      readFileSync(join(f.options.stateDirectory, "native/source.json"), "utf8"),
    ).state;
    const uncertain = Object.values(saved.uncertainAcknowledgements)[0];
    assert.equal(uncertain.registrationId, original.registrationId);
    assert.equal(uncertain.serverInstanceId, original.serverInstanceId);
    assert.equal(f.posts.length, 1);
  });

for (const operation of ["report_step", "complete_step"])
  test(`delayed positive ${operation} ACK after expiry stays historical and cannot schedule continuation`, async (t) => {
    const f = progressingAdapter(t),
      taskId = randomUUID(),
      stepId = randomUUID();
    const claim = await f.claim(f.request.turnId, "claim", taskId, stepId);
    if (operation === "complete_step") observeFixtureChild(f);
    await f.adapter.close();
    let release, entered;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      started = new Promise((resolve) => {
        entered = resolve;
      });
    const adapter = createDeliveryManagerAdapter({
      ...f.options,
      fetchImpl: async (url, init) => {
        const response = await f.options.fetchImpl(url, init);
        if (JSON.parse(init.body).command?.operation === operation) {
          entered();
          await gate;
        }
        return response;
      },
    });
    t.after(() => adapter.close());
    const result = adapter.handleToolCall({
      ...f.request,
      callId: "delayed-result",
      arguments: { operation, payload: { taskId, stepId, attemptId: claim.attemptId } },
    });
    await started;
    f.registration.expiresAt = Date.now() - 1;
    release();
    await assert.rejects(result, /authority_changed/);
    adapter.observe({
      method: "turn/completed",
      params: { threadId: f.request.threadId, turn: { id: f.request.turnId, status: "completed" } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.inspectNative().uncertainAcknowledgements, 1);
    assert.equal(adapter.inspectNative().blocked, 1);
    assert.equal(f.starts.length, 0);
  });

test("installed native 0.165 emits a real dynamic tool call and consumes its result using only a local Responses fixture", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 20000,
}, async (t) => {
  const f = fixture(t),
    requests = [],
    sent = [];
  const command = { operation: "create_task", payload: { id: randomUUID() } };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const call = {
        id: "fc_fixture",
        type: "function_call",
        name: "hive_delivery",
        call_id: "call_fixture",
        arguments: JSON.stringify(command),
        status: "completed",
      };
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "HIVE_DYNAMIC_TOOL_COMPLETE", annotations: [] }],
      };
      const delegate = {
        id: "fc_spawn_fixture",
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "spawn_fixture",
        arguments: JSON.stringify({
          task_name: "fixture_child",
          message: "Read-only fixture. Return HIVE_CHILD_DONE. Do not call tools.",
          model: "gpt-6.1-sol",
          reasoning_effort: "low",
          fork_turns: "none",
        }),
        status: "completed",
      };
      const item = requests.length === 1 ? call : requests.length === 2 ? delegate : message;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: `resp_${requests.length}`, status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_${requests.length}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  mkdirSync(join(f.directory, ".codex"), { mode: 0o700 });
  writeFileSync(
    join(f.directory, ".codex/config.toml"),
    `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Local fixture only"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nmemories = false\n`,
  );
  const executable =
    process.env.HIVE_TEST_CODEX_EXECUTABLE ||
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd: f.directory,
    env: {
      PATH: process.env.PATH,
      HOME: f.directory,
      CODEX_HOME: join(f.directory, ".codex"),
      USER: process.env.USER,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) return r();
      child.once("exit", r);
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    });
  });
  const observations = [];
  const adapter = createDeliveryManagerAdapter({
    ...f.options,
    onDelegation: (observation) => observations.push(observation),
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ taskId: command.payload.id, replayed: false });
    },
  });
  let next = 1;
  const pending = new Map(),
    notifications = [];
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "item/tool/call") {
      adapter.handleToolCall(m.params).then(
        (result) => send({ id: m.id, result }),
        () =>
          send({
            id: m.id,
            result: {
              contentItems: [{ type: "inputText", text: "fixture tool rejected" }],
              success: false,
            },
          }),
      );
      return;
    }
    if (m.method) {
      adapter.observe(m);
      notifications.push(m);
      return;
    }
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error("native_timeout")), 5000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  await call("initialize", {
    clientInfo: { name: "hive_manager_fixture", version: "1" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized" });
  const started = await call("thread/start", {
    cwd: f.directory,
    model: "gpt-6.1-sol",
    dynamicTools: [deliveryManagerToolSpec],
    experimentalRawEvents: true,
  });
  f.registration.threads[0].threadId = started.thread.id;
  const turn = await call("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "Call the fixture delivery tool once.", text_elements: [] }],
  });
  for (
    let i = 0;
    i < 100 &&
    !notifications.some((n) => n.method === "turn/completed" && n.params.turn.id === turn.turn.id);
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].managerThreadId, started.thread.id);
  assert.equal(sent[0].nativeTurnId, turn.turn.id);
  assert.equal(sent[0].nativeCallId, "call_fixture");
  assert.ok(requests.length >= 2);
  const advertised = JSON.stringify(requests[0]);

  assert.ok(
    advertised.includes("hive_delivery"),
    "dynamic tool must be advertised to native model context",
  );
  assert.ok(advertised.includes("spawn_agent"), "native collaboration tool must be advertised");
  const declared = [];
  const visit = (v) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      if (v.name === "spawn_agent") declared.push(v);
      Object.values(v).forEach(visit);
    }
  };
  visit(requests[0]);
  assert.ok(declared[0]?.parameters.properties.model);
  assert.ok(declared[0]?.parameters.properties.reasoning_effort);
  const requested = notifications.find(
    (n) =>
      n.method === "rawResponseItem/completed" &&
      n.params.threadId === started.thread.id &&
      n.params.item.type === "function_call" &&
      n.params.item.namespace === "collaboration" &&
      n.params.item.name === "spawn_agent",
  );
  assert.ok(requested, "raw native spawn request must be observed");
  assert.equal(requested.params.turnId, turn.turn.id);
  const settings = JSON.parse(requested.params.item.arguments);
  assert.equal(settings.model, "gpt-6.1-sol");
  assert.equal(settings.reasoning_effort, "low");
  const resolved = notifications.find(
    (n) =>
      n.params?.threadId === started.thread.id &&
      n.params.item?.type === "subAgentActivity" &&
      n.params.item.kind === "started" &&
      n.params.item.id === requested.params.item.call_id,
  );
  assert.ok(resolved, "resolved native creation telemetry must match exact call ID");
  assert.equal(resolved.params.item.model, "gpt-6.1-sol");
  assert.equal(resolved.params.item.reasoningEffort, "low");
  assert.notEqual(resolved.params.item.agentThreadId, started.thread.id);
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    managerThreadId: started.thread.id,
    parentTurnId: turn.turn.id,
    spawnCallId: requested.params.item.call_id,
    requestedModel: "gpt-6.1-sol",
    requestedEffort: "low",
    childThreadId: resolved.params.item.agentThreadId,
    effectiveModel: "gpt-6.1-sol",
    effectiveEffort: "low",
  });
  assert.ok(JSON.stringify(requests[1]).includes(command.payload.id));
  assert.equal(
    readFileSync(join(f.directory, ".codex/config.toml"), "utf8").includes(
      "requires_openai_auth = false",
    ),
    true,
  );
  assert.ok(
    notifications.some(
      (n) =>
        n.method === "item/completed" &&
        n.params.item.type === "dynamicToolCall" &&
        n.params.item.success === true,
    ),
  );
});

function sourceAdapter(t, overrides = {}) {
  let f,
    local = { phase: "ready", headSha: "a".repeat(40) },
    stored = null;
  const applies = [];
  const read = async (ctx, request) => {
    assert.equal(request.operationId, stored.operationId);
    return {
      schemaVersion: 1,
      requestId: randomUUID(),
      observedAt: Date.now() - 1,
      expiresAt: Date.now() + 29000,
      isCurrent: true,
      publicationAuthorized: false,
      executionAuthorized: false,
      scope: {
        managerBindingId: ctx.managerBindingId,
        taskId: ctx.taskId,
        managerThreadId: ctx.managerThreadId,
        registrationId: ctx.registration.id,
        serverInstanceId: ctx.registration.serverInstanceId,
        checkoutBinding: ctx.checkoutBinding,
      },
      accepted: {
        operationId: stored.operationId,
        producingAttemptId: ctx.attemptId,
        stepId: ctx.stepId,
        sourceContext: stored.sourceContext,
        parentSha: ctx.inputSourceSha,
        previousRevisionId: ctx.sourceContext?.revisionId ?? null,
        treeSha: "d".repeat(40),
        manifestDigest: "e".repeat(64),
        proofDigest: "f".repeat(64),
      },
      current: { sourceContext: stored.sourceContext, headSha: stored.sourceContext.headSha },
    };
  };
  f = progressingAdapter(t, {
    sourceProtocol: 1,
    currentSource: () => ({ ...local, checkoutBinding: f.options.currentProjectContext() }),
    publishSource: async (ctx, proposal) => {
      stored = {
        operationId: proposal.operationId,
        sourceContext: {
          revisionId: randomUUID(),
          version: (ctx.sourceContext?.version ?? 0) + 1,
          headSha: ctx.sourceContext ? "c".repeat(40) : "b".repeat(40),
        },
      };
      return {
        sourceContext: stored.sourceContext,
        inputSourceSha: ctx.inputSourceSha,
        current: true,
        replayed: false,
        executionAuthorized: false,
      };
    },
    readAcceptedSource: read,
    applyAcceptedSource: async (request, accepted) => {
      const snapshot = f.adapter.sourceApplicationSnapshot(request.managerThreadId, request);
      assert.equal(snapshot.scope, "native_observer_journal_only");
      assert.equal(snapshot.quiescenceAuthority, false);
      assert.equal(snapshot.metadataApplyAuthorized, false);
      assert.equal(snapshot.writerHeld, true);
      assert.equal(snapshot.pendingSourceEvents, 0);
      assert.match(snapshot.sourceJournalDigest, /^[a-f0-9]{64}$/);
      applies.push({ request, accepted, snapshot });
      assert.equal(request.priorAttemptId, accepted.accepted.producingAttemptId);
      local = {
        phase: "ready",
        headSha: accepted.accepted.sourceContext.headSha,
        sourceContext: accepted.accepted.sourceContext,
      };
    },
    ...overrides,
  });
  const taskId = randomUUID(),
    firstStep = randomUUID(),
    secondStep = randomUUID(),
    proposal = {
      operationId: randomUUID(),
      paths: ["src/a.ts"],
      deletions: [],
      message: "feat(source): bounded",
      title: "feat(source): bounded",
      body: "Local mock",
    };
  async function begin(final = false) {
    await f.call(f.request.turnId, "create-task", "create_task", {
      id: taskId,
      steps: [{ id: firstStep }, ...(!final ? [{ id: secondStep }] : [])],
    });
    const claim = await f.claim(f.request.turnId, "claim-one", taskId, firstStep);
    observeFixtureChild(f);
    return claim;
  }
  const publish = () => f.call(f.request.turnId, "publish-one", "publish_source", proposal);
  const complete = (claim) =>
    f.call(f.request.turnId, "complete-one", "complete_step", {
      taskId,
      stepId: firstStep,
      attemptId: claim.attemptId,
      sourceSha: stored.sourceContext.headSha,
    });
  const terminal = () =>
    f.adapter.observe({
      method: "turn/completed",
      params: { threadId: f.request.threadId, turn: { id: f.request.turnId, status: "completed" } },
    });
  return {
    ...f,
    taskId,
    firstStep,
    secondStep,
    proposal,
    applies,
    begin,
    publish,
    complete,
    terminal,
    get local() {
      return local;
    },
    get output() {
      return stored;
    },
  };
}
test("source protocol completes acceptedB while localA then applies only at terminal before continuation and next inputB", async (t) => {
  const f = sourceAdapter(t),
    first = await f.begin();
  await f.publish();
  assert.equal(f.local.headSha, "a".repeat(40));
  assert.equal(f.applies.length, 0);
  await f.complete(first);
  const complete = f.posts.find((v) => v.value.command?.operation === "complete_step").value;
  assert.deepEqual(complete.sourceContext, f.output.sourceContext);
  assert.equal(f.applies.length, 0);
  assert.equal(f.starts.length, 0);
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.applies.length, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.local.headSha, "b".repeat(40));
  const second = await f.claim("continuation-1", "claim-two", f.taskId, f.secondStep);
  assert.deepEqual(second.sourceContext, f.output.sourceContext);
  const boundary = f.posts.find((v) => v.value.source?.kind === "root_boundary").value;
  assert.deepEqual(boundary.sourceContext, f.output.sourceContext);
  assert.equal(boundary.checkoutBinding.revision, "a".repeat(40));
  assert.equal(f.adapter.inspectNative().held, 1);
  const originalChild = structuredClone(f.native);
  f.native.childThreadId = randomUUID();
  f.native.childTurnId = randomUUID();
  f.native.spawnCallId = "source-b-child";
  // A second child is bound to accepted/applied B while physical base stays A.
  f.adapter.observe({
    method: "rawResponseItem/completed",
    params: {
      threadId: f.request.threadId,
      turnId: "continuation-1",
      item: {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: f.native.spawnCallId,
        arguments: JSON.stringify({ model: "gpt-6.1-sol", reasoning_effort: "low" }),
      },
    },
  });
  f.adapter.observe({
    method: "item/completed",
    params: {
      threadId: f.request.threadId,
      turnId: "continuation-1",
      item: {
        type: "subAgentActivity",
        kind: "started",
        id: f.native.spawnCallId,
        agentThreadId: f.native.childThreadId,
        model: "gpt-6.1-sol",
        reasoningEffort: "low",
      },
    },
  });
  f.adapter.observe({
    method: "turn/completed",
    params: {
      threadId: f.native.childThreadId,
      turn: { id: f.native.childTurnId, status: "completed", items: [], itemsView: "full" },
    },
  });
  await f.adapter.flushNative();
  const childEvents = f.posts.filter(
    (v) => v.value.attemptId === second.attemptId && v.value.source,
  );
  assert.ok(childEvents.length >= 2);
  assert.ok(
    childEvents.every(
      (v) =>
        JSON.stringify(v.value.sourceContext) === JSON.stringify(f.output.sourceContext) &&
        v.value.checkoutBinding.revision === "a".repeat(40),
    ),
  );
  const before = f.posts.length;
  f.adapter.observe({
    method: "turn/completed",
    params: {
      threadId: originalChild.childThreadId,
      turn: { id: originalChild.childTurnId, status: "completed", items: [], itemsView: "full" },
    },
  });
  await f.adapter.flushNative();
  assert.equal(f.posts.length, before);
  assert.equal(f.adapter.inspectNative().blocked, 0);
});
for (const kind of ["command", "spawn"])
  test(`unexpected post-publication root ${kind} holds before apply/continuation`, async (t) => {
    const f = sourceAdapter(t),
      claim = await f.begin();
    await f.publish();
    await f.complete(claim);
    f.adapter.observe({
      method: "rawResponseItem/completed",
      params: {
        threadId: f.request.threadId,
        turnId: f.request.turnId,
        item: {
          type: "function_call",
          namespace: kind === "spawn" ? "collaboration" : "functions",
          name: kind === "spawn" ? "spawn_agent" : "exec_command",
          call_id: "late-root-work",
          arguments: JSON.stringify(
            kind === "spawn"
              ? { model: "gpt-6.1-sol", reasoning_effort: "low" }
              : { cmd: "echo late" },
          ),
        },
      },
    });
    f.terminal();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.adapter.inspectNative().blocked, 1);
    assert.equal(f.applies.length, 0);
    assert.equal(f.starts.length, 0);
  });
test("failed source apply retains the original writer and prevents new root admission", async (t) => {
  const f = sourceAdapter(t, {
      applyAcceptedSource: async () => {
        throw new Error("Input barrier unavailable");
      },
    }),
    claim = await f.begin();
  await f.publish();
  await f.complete(claim);
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.starts.length, 0);
  assert.equal(f.adapter.inspectNative().blocked, 1);
  assert.equal(f.adapter.inspectNative().held, 1);
});
test("final source output applies at terminal without inventing another root turn", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin(true);
  await f.publish();
  await f.complete(claim);
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.applies.length, 1);
  assert.equal(f.starts.length, 0);
  assert.equal(f.local.headSha, "b".repeat(40));
  assert.equal(f.adapter.inspectNative().held, 1);
});

test("novel child command after publication holds while original facts retain input source", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin();
  await f.publish();
  f.adapter.observe({
    method: "item/completed",
    params: {
      threadId: f.native.childThreadId,
      turnId: f.native.childTurnId,
      item: {
        id: "late-child-command",
        type: "commandExecution",
        status: "completed",
        command: "echo late",
        exitCode: 0,
        aggregatedOutput: "unexpected",
      },
    },
  });
  assert.equal(f.adapter.inspectNative().blocked, 1);
  await assert.rejects(f.complete(claim), /reconciliation/);
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.applies.length, 0);
  assert.equal(f.starts.length, 0);
  const raw = JSON.parse(
    readFileSync(join(f.options.stateDirectory, "native/source.json"), "utf8"),
  );
  assert.ok(
    raw.state.events
      .filter((v) => v.input.attemptId === claim.attemptId)
      .every((v) => v.input.sourceContext === undefined),
  );
});
test("persisted source protocol cannot be silently downgraded and accepted output stays informational", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin();
  await f.publish();
  const accepted = await f.adapter.currentAcceptedSource({
    managerThreadId: f.request.threadId,
    taskId: f.taskId,
    stepId: f.firstStep,
    checkoutBinding: f.options.currentProjectContext(),
  });
  assert.deepEqual(accepted, f.output.sourceContext);
  assert.equal(f.local.headSha, "a".repeat(40));
  await f.adapter.close();
  assert.throws(
    () => createDeliveryManagerAdapter({ ...f.options, sourceProtocol: 0 }),
    /source_protocol_required/,
  );
  const saved = JSON.parse(
    readFileSync(join(f.options.stateDirectory, "native/source.json"), "utf8"),
  );
  assert.equal(saved.state.attempts[claim.attemptId].inputSourceSha, "a".repeat(40));
  assert.equal(saved.state.attempts[claim.attemptId].sourceContext, undefined);
  assert.deepEqual(
    saved.state.sourcePublications[claim.attemptId].sourceContext,
    f.output.sourceContext,
  );
});

test("a successful boolean from apply callback cannot replace verified local source agreement", async (t) => {
  const f = sourceAdapter(t, { applyAcceptedSource: async () => true }),
    claim = await f.begin();
  await f.publish();
  await f.complete(claim);
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.local.headSha, "a".repeat(40));
  assert.equal(f.starts.length, 0);
  assert.equal(f.adapter.inspectNative().blocked, 1);
});
test("accepted output cannot be completed against old input source or model-provided source context", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin();
  await assert.rejects(
    f.call(f.request.turnId, "bad-source-proposal", "publish_source", {
      ...f.proposal,
      sourceContext: { headSha: "b".repeat(40) },
    }),
    /proposal_invalid/,
  );
  assert.equal(f.output, null);
  await f.publish();
  await assert.rejects(
    f.call(f.request.turnId, "old-source-completion", "complete_step", {
      taskId: f.taskId,
      stepId: f.firstStep,
      attemptId: claim.attemptId,
      sourceSha: "a".repeat(40),
    }),
    /report_source_mismatch/,
  );
  assert.ok(!f.posts.some((v) => v.value.command?.operation === "complete_step"));
  assert.equal(f.applies.length, 0);
});
test("stale source facts at terminal hold rather than invoke apply or root continuation", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin();
  await f.publish();
  await f.complete(claim);
  const original = f.options.readAcceptedSource;
  f.options.readAcceptedSource = async (...args) => ({
    ...(await original(...args)),
    expiresAt: Date.now() - 1,
  });
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.applies.length, 0);
  assert.equal(f.starts.length, 0);
  assert.equal(f.adapter.inspectNative().blocked, 1);
});

test("bounded supervisor-busy retry starts after source apply rather than consuming its budget", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin();
  await f.publish();
  await f.complete(claim);
  const now = Date.now;
  let offset = 0,
    starts = 0;
  Date.now = () => now() + offset;
  const apply = f.options.applyAcceptedSource,
    continueRoot = f.options.continueRoot;
  f.options.applyAcceptedSource = async (...args) => {
    await apply(...args);
    offset = 10000;
  };
  f.options.continueRoot = async (request) => {
    if (starts++ === 0) throw new Error("supervisor_busy_or_closed");
    return continueRoot(request);
  };
  try {
    f.terminal();
    for (let i = 0; i < 20 && !f.starts.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(starts, 2);
    assert.equal(f.starts.length, 1);
    assert.equal(f.adapter.inspectNative().blocked, 0);
  } finally {
    Date.now = now;
  }
});

test("source application snapshot rejects pre-terminal and substituted claim scope without authority", async (t) => {
  const f = sourceAdapter(t),
    claim = await f.begin();
  await f.publish();
  await f.complete(claim);
  assert.throws(
    () =>
      f.adapter.sourceApplicationSnapshot(f.request.threadId, {
        managerThreadId: f.request.threadId,
        registrationId: f.registration.id,
        serverInstanceId: f.registration.serverInstanceId,
        checkoutBinding: f.options.currentProjectContext(),
      }),
    /snapshot_scope_changed/,
  );
  f.terminal();
  await new Promise((resolve) => setImmediate(resolve));
  const { request, snapshot } = f.applies[0];
  assert.equal(snapshot.nativeSequence, 2);
  assert.equal(snapshot.inputSourceSha, "a".repeat(40));
  assert.deepEqual(snapshot.acceptedSourceContext, f.output.sourceContext);
  assert.throws(
    () =>
      f.adapter.sourceApplicationSnapshot(f.request.threadId, {
        ...request,
        priorAttemptId: randomUUID(),
      }),
    /snapshot_scope_changed/,
  );
  assert.equal(f.adapter.inspectNative().held, 1);
});
