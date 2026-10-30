import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
  ACCEPTANCE_PERMISSIONS_DIGEST,
  ACCEPTANCE_PROFILE,
  createNativeAcceptanceEvaluator,
  validateAcceptanceProducer,
} from "../templates/ai-dev-k8s/scripts/codex-acceptance-native.mjs";
import { launchNative } from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const protocol = {
  prompts: {
    plan: "Return only the exact structured result. Do not call tools.",
    review: "Return a scoped review.",
  },
  schemas: {
    plan: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    review: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
};
const producer = {
  schemaVersion: 1,
  codeDigest: "a".repeat(64),
  promptDigest: hash(canonical(protocol.prompts)),
  schemaDigest: hash(canonical(protocol.schemas)),
  permissionsDigest: ACCEPTANCE_PERMISSIONS_DIGEST,
  runtimeVersion: "0.165.0",
  model: "gpt-6.1-sol",
  effort: "low",
  maxDurationMs: 10000,
  maxInputBytes: 32768,
  maxOutputBytes: 1024,
};
const job = () => ({
  jobId: randomUUID(),
  producer,
  inputDigest: hash(canonical({ input: "LOCAL_ACCEPTANCE_FIXTURE" })),
  expiresAt: Date.now() + 10000,
  kind: "plan",
  instructions: protocol.prompts.plan,
  outputSchema: protocol.schemas.plan,
  protocol,
  payload: { input: "LOCAL_ACCEPTANCE_FIXTURE" },
});
function fakeRuntime(options = {}) {
  let observe;
  const calls = [];
  let inputItem, persistedTurn;
  return {
    calls,
    alive: () => true,
    observeInstalled(fn) {
      observe = fn;
      return () => {
        observe = null;
      };
    },
    interruptAcceptance: async (scope) => calls.push(["interrupt", scope]),
    async call(method, params) {
      calls.push([method, params]);
      if (method === "model/list")
        return {
          data: [
            { model: producer.model, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
          ],
          nextCursor: null,
        };
      if (method === "thread/start")
        return {
          thread: { id: "independent-thread" },
          model: producer.model,
          reasoningEffort: "low",
          cwd: "/fixture",
          approvalPolicy: "never",
          activePermissionProfile: { id: ACCEPTANCE_PROFILE },
          instructionSources: [],
          ...options.start,
        };
      if (method === "turn/start") {
        inputItem = {
          type: "userMessage",
          id: "input",
          clientId: params.clientUserMessageId,
          content: params.input,
        };
        observe?.({
          method: "turn/started",
          params: { threadId: params.threadId, turn: { id: "turn" } },
        });
        observe?.({
          method: "item/completed",
          params: { threadId: params.threadId, turnId: "turn", item: inputItem },
        });
        if (options.extraInput)
          observe?.({
            method: "item/completed",
            params: {
              threadId: params.threadId,
              turnId: "turn",
              item: { ...inputItem, id: "foreign", clientId: null },
            },
          });
        if (options.tool)
          observe?.({
            method: "rawResponseItem/completed",
            params: { threadId: params.threadId, item: { type: "function_call" } },
          });
        else if (!options.stall) {
          observe?.({
            method: "item/completed",
            params: {
              threadId: params.threadId,
              turnId: "turn",
              item: {
                type: "agentMessage",
                phase: options.nullPhase ? null : "final_answer",
                text: '{"ok":true}',
              },
            },
          });
          observe?.({
            method: "turn/completed",
            params: { threadId: params.threadId, turn: { id: "turn", status: "completed" } },
          });
        }
        return { turn: { id: "turn" } };
      }
      if (method === "thread/read") {
        const result = {
          thread: {
            id: params.threadId,
            turns: [
              {
                id: "turn",
                status: "completed",
                itemsView: options.partialHistory ? "summary" : "full",
                truncated: options.truncatedHistory ?? false,
                items: [
                  inputItem,
                  { id: "output", type: "agentMessage", phase: null, text: '{"ok":true}' },
                  ...(options.extraHistory
                    ? [{ ...inputItem, id: "foreign", clientId: null }]
                    : []),
                ],
              },
            ],
          },
        };
        persistedTurn = result.thread.turns[0];
        return result;
      }
      if (method === "thread/turns/list")
        return { data: [persistedTurn], nextCursor: options.cursorHistory ? "extra" : null };
      if (method === "thread/items/list")
        return {
          data: persistedTurn.items.map((item) => ({ turnId: persistedTurn.id, item })),
          nextCursor: null,
          ...(options.nestedTruncated ? { extra: { truncated: true } } : {}),
        };
      if (method === "thread/archive") return {};
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      throw new Error("Unknown fixture RPC");
    },
  };
}
test("controller creates a separate configured evaluator and archives exact terminal thread", async () => {
  const runtime = fakeRuntime(),
    state = {},
    e = createNativeAcceptanceEvaluator({
      runtime,
      producer,
      workingDirectory: "/fixture",
      state,
      save() {},
      assertAuthority() {},
      serverInstanceId: "server",
    }),
    j = job();
  await e.create(j);
  const result = await e.run(j);
  assert.equal(result.output, '{"ok":true}');
  assert.equal(result.receipt.controllerCreated, true);
  assert.equal(
    runtime.calls.find(([m]) => m === "thread/start")[1].config["features.multi_agent"],
    false,
  );
  await e.archive(j.jobId);
  assert.equal(e.active(), false);
  e.close();
});
test("native configuration drift or unexpected tool output cannot become acceptance", async () => {
  for (const options of [{ start: { instructionSources: ["/repo/AGENTS.md"] } }, { tool: true }]) {
    const runtime = fakeRuntime(options),
      state = {},
      e = createNativeAcceptanceEvaluator({
        runtime,
        producer,
        workingDirectory: "/fixture",
        state,
        save() {},
        assertAuthority() {},
        serverInstanceId: "server",
      }),
      j = job();
    if (options.start) await assert.rejects(e.create(j), /acceptance_thread_config_mismatch/);
    else {
      await e.create(j);
      await assert.rejects(e.run(j), /acceptance_unexpected_tool/);
      assert.equal(runtime.calls.at(-1)[0], "interrupt");
    }
    assert.equal(state.entries[j.jobId].phase, "held");
    e.close();
  }
});
test("cancellation retains a held exact turn and never retries inference", async () => {
  const runtime = fakeRuntime({ stall: true }),
    state = {},
    abort = new AbortController(),
    e = createNativeAcceptanceEvaluator({
      runtime,
      producer,
      workingDirectory: "/fixture",
      state,
      save() {},
      assertAuthority() {},
      serverInstanceId: "server",
    }),
    j = job();
  await e.create(j);
  const work = e.run(j, abort.signal);
  abort.abort();
  await assert.rejects(work);
  assert.equal(state.entries[j.jobId].submissionAttempted, true);
  await assert.rejects(e.run(j), /acceptance_submission_held/);
  assert.equal(runtime.calls.filter(([m]) => m === "turn/start").length, 1);
  e.close();
});
test("unknown producer/config fields cannot enable evaluation", () => {
  assert.deepEqual(validateAcceptanceProducer(producer), producer);
  assert.throws(() => validateAcceptanceProducer({ ...producer, command: "arbitrary" }));
  assert.throws(() =>
    validateAcceptanceProducer({ ...producer, permissionsDigest: "f".repeat(64) }),
  );
});

test("pinned legacy null-phase final message still requires exact terminal turn", async () => {
  const runtime = fakeRuntime({ nullPhase: true }),
    state = {},
    evaluator = createNativeAcceptanceEvaluator({
      runtime,
      producer,
      workingDirectory: "/fixture",
      state,
      save() {},
      assertAuthority() {},
      serverInstanceId: "server",
    }),
    j = job();
  await evaluator.create(j);
  assert.equal((await evaluator.run(j)).output, '{"ok":true}');
  await evaluator.archive(j.jobId);
  evaluator.close();
});
for (const steering of [false, true])
  test(steering
    ? "actual manager cannot contaminate an evaluator result through incoming send_message"
    : "actual pinned native evaluator uses readonly permissions and no shell/collaboration tools", {
    skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
    timeout: 30000,
  }, async () => {
    assert.ok(!realpathSync(process.cwd()).startsWith("/tmp/"));
    const home = mkdtempSync(join(process.cwd(), ".ae-")),
      stateDirectory = join(home, ".local/state/hive/acceptance-native-fixture"),
      cwd = join(home, "projects/.hive-managed/evaluator");
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(cwd, "read-control"), "READ_CONTROL");
    const executable = realpathSync(
      process.env.HIVE_TEST_CODEX_EXECUTABLE ??
        "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    );
    const auth = join(home, ".local/share/hive/codex-native/codex");
    mkdirSync(auth, { recursive: true, mode: 0o700 });
    writeFileSync(join(auth, "auth.json"), "{}\n", { mode: 0o600 });
    const requests = [];
    let target,
      releaseEvaluator,
      evaluatorRequested,
      sentAttack = false;
    const evaluatorSeen = new Promise((resolve) => {
      evaluatorRequested = resolve;
    });
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", async () => {
        const request = JSON.parse(raw);
        requests.push(request);
        const lastUser = [...(request.input ?? [])].reverse().find((v) => v.role === "user");
        const attacker = JSON.stringify(lastUser).includes("ACCEPTANCE_INCOMING_ATTACK");
        if (
          steering &&
          !attacker &&
          JSON.stringify(request.input).includes("LOCAL_ACCEPTANCE_FIXTURE")
        ) {
          evaluatorRequested();
          await new Promise((resolve) => {
            releaseEvaluator = resolve;
          });
        }
        let item = {
          id: `m${requests.length}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
        };
        if (steering && attacker && !sentAttack) {
          sentAttack = true;
          item = {
            id: "incoming-call",
            type: "function_call",
            namespace: "collaboration",
            name: "send_message",
            call_id: "incoming-call",
            arguments: JSON.stringify({ target, message: "ATTACKER_CHANGED_ACCEPTANCE" }),
            status: "completed",
          };
        } else if (steering && attacker) releaseEvaluator?.();
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [
          {
            type: "response.created",
            response: { id: `r${requests.length}`, status: "in_progress", output: [] },
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
              id: `r${requests.length}`,
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
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const lock = openSync(join(stateDirectory, "fixture.lock"), "wx", 0o600);
    let native,
      evaluator,
      passed = false;
    try {
      native = await launchNative({
        config: {
          codexExecutable: executable,
          codexSha256: hash(readFileSync(executable)),
          executionMode: "isolated",
          acceptance: producer,
        },
        home,
        stateDirectory,
        lock,
        fixtureProvider: { baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
      });
      const state = {};
      evaluator = createNativeAcceptanceEvaluator({
        runtime: native,
        producer,
        workingDirectory: cwd,
        state,
        save() {},
        assertAuthority() {},
        serverInstanceId: "fixture-server",
      });
      native.setAcceptanceInterruptAuthority((scope) => evaluator.assertInterrupt(scope));
      const read = await native.call("command/exec", {
        command: [
          "/usr/bin/python3",
          "-I",
          "-c",
          "import pathlib;print(pathlib.Path('read-control').read_text())",
        ],
        cwd,
        permissionProfile: ACCEPTANCE_PROFILE,
        timeoutMs: 2000,
        outputBytesCap: 1024,
      });
      assert.equal(read.exitCode, 0);
      assert.equal(read.stdout.trim(), "READ_CONTROL");
      const write = await native.call("command/exec", {
        command: [
          "/usr/bin/python3",
          "-I",
          "-c",
          "from pathlib import Path\ntry: Path('denied-write').write_text('no');raise SystemExit(2)\nexcept OSError as e:\n if e.errno not in (13,30): raise\n print('DENIED:'+str(e.errno))",
        ],
        cwd,
        permissionProfile: ACCEPTANCE_PROFILE,
        timeoutMs: 2000,
        outputBytesCap: 1024,
      });
      assert.equal(write.exitCode, 0, write.stderr);
      assert.match(write.stdout.trim(), /^DENIED:(13|30)$/);
      const j = job();
      const created = await evaluator.create(j);
      target = created.threadId;
      const events = [];
      const stopObserve = native.observeInstalled((message) => {
        if (
          message.params?.threadId === target &&
          ["item/completed", "turn/started", "turn/completed"].includes(message.method)
        )
          events.push(message);
      });
      const running = evaluator.run(j);
      void running.catch(() => {});
      if (steering) {
        await evaluatorSeen;
        const manager = await native.call("thread/start", {
          model: producer.model,
          cwd,
          approvalPolicy: "never",
          config: { "features.multi_agent": true, model_reasoning_effort: "low" },
          experimentalRawEvents: true,
        });
        await native.call("turn/start", {
          threadId: manager.thread.id,
          input: [{ type: "text", text: "ACCEPTANCE_INCOMING_ATTACK", text_elements: [] }],
        });
        const result = await running;
        assert.equal(result.output, '{"ok":true}');
        assert.equal(sentAttack, true);
        const replies = requests.flatMap((r) =>
          (r.input ?? []).filter((v) => v.type === "function_call_output"),
        );
        assert.ok(
          replies.some(
            (r) =>
              r.call_id === "incoming-call" &&
              String(r.output).includes(`agent with id ${target} not found`),
          ),
          "actual advertised v2 manager tool must deny foreign evaluator root",
        );
        const history = await native.call("thread/read", { threadId: target, includeTurns: true });
        assert.equal(history.thread.turns.length, 1);
        assert.equal(
          history.thread.turns[0].items.filter((i) => i.type === "userMessage").length,
          1,
        );
        stopObserve();
        passed = true;
        return;
      }
      const result = await running;
      stopObserve();
      assert.equal(result.output, '{"ok":true}');
      const relevant = requests.find((r) =>
        JSON.stringify(r.input).includes("LOCAL_ACCEPTANCE_FIXTURE"),
      );
      assert.ok(relevant);
      assert.deepEqual(relevant.tools ?? [], []);
      await evaluator.archive(j.jobId);
      assert.equal(evaluator.active(), false);
      passed = true;
    } finally {
      evaluator?.close();
      await native?.close();
      closeSync(lock);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (passed) rmSync(home, { recursive: true, force: true });
      else process.stderr.write(`Acceptance fixture retained: ${home}\n`);
    }
  });

test("unexpected observed or persisted input never yields an acceptance receipt", async () => {
  for (const options of [
    { extraInput: true },
    { extraHistory: true },
    { partialHistory: true },
    { truncatedHistory: true },
    { cursorHistory: true },
    { nestedTruncated: true },
  ]) {
    const runtime = fakeRuntime(options),
      state = {},
      evaluator = createNativeAcceptanceEvaluator({
        runtime,
        producer,
        workingDirectory: "/fixture",
        state,
        save() {},
        assertAuthority() {},
        serverInstanceId: "server",
      }),
      j = job();
    await evaluator.create(j);
    await assert.rejects(
      evaluator.run(j),
      /acceptance_(unexpected_input|history_unproven|turn_incomplete)/,
    );
    assert.equal(state.entries[j.jobId].phase, "held");
    evaluator.close();
  }
});
