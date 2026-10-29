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
