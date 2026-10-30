import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { startProjectGateway } from "../templates/ai-dev-k8s/scripts/codex-project-gateway.mjs";
import {
  createNativeManagerRouter,
  launchNative,
  openSupervisor,
  validateSupervisorConfig,
} from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

const config = () => ({
  schemaVersion: 1,
  profile: "software",
  ownerId: "owner",
  workspaceId: "workspace",
  buildId: "build",
  codexExecutable: "/fixture/codex",
  codexSha256: "a".repeat(64),
  projects: [
    {
      projectId: "project",
      repositoryId: "123",
      taskId: "task",
      leaseId: "lease",
      leaseGeneration: 1,
      model: "gpt-6.1-sol",
      effort: "low",
    },
  ],
});
const ensure = {
  operation: "ensureProject",
  projectId: "project",
  creationIntentId: "create-once",
};
const prompt = {
  operation: "firstPrompt",
  projectId: "project",
  requestId: "user-request",
  text: "Actual user-request fixture, no network model invocation.",
};
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "hive-supervisor-test-"));
  const checkout = join(home, "projects/.hive-managed/github/123/checkout");
  mkdirSync(checkout, { recursive: true });
  t.after(async () => {
    await runtime.close();
    rmSync(home, { recursive: true, force: true });
  });
  const calls = [];
  let live = true;
  let onClose = () => {};
  let persisted = false;
  const runtime = {
    version: "0.165.0",
    alive: () => live,
    onClose: (fn) => {
      onClose = fn;
    },
    close: async () => {
      live = false;
      onClose();
    },
    die: () => {
      live = false;
      onClose();
    },
    inspectLease: (project) => ({
      ok: true,
      data: {
        status: "ready",
        checkoutVerified: true,
        checkoutDirectory: checkout,
        lease: {
          id: project.leaseId,
          taskId: project.taskId,
          generation: project.leaseGeneration,
          expiresAt: Date.now() / 1000 + 900,
        },
      },
    }),
    async call(method, params) {
      calls.push({ method, params });
      if (method === "thread/start")
        return {
          thread: { id: "thread-one", cwd: checkout },
          model: "gpt-6.1-sol",
          reasoningEffort: "low",
        };
      if (method === "thread/resume") return { thread: { id: "thread-one", cwd: checkout } };
      if (method === "turn/start") {
        persisted = true;
        return { turn: { id: "turn-one" } };
      }
      if (method === "thread/turns/list") return { data: persisted ? [{ id: "turn-one" }] : [] };
      throw new Error("unexpected_rpc");
    },
    attach: async (...args) => {
      calls.push({ method: "attach", args });
    },
  };
  return { home, checkout, calls, runtime, options: { home, runtimeFactory: async () => runtime } };
}

test("one durable creation intent, actual first input once, persisted same-thread attach", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  assert.equal((await s.command(ensure)).phase, "awaitingFirstTurn");
  await s.command(ensure);
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  assert.throws(() => s.binding("project"), /session_not_available/);
  await assert.rejects(
    s.command({ operation: "attach", projectId: "project" }),
    /session_not_available/,
  );
  assert.equal((await s.command(prompt)).phase, "persisted");
  await s.command(prompt);
  const turnCalls = f.calls.filter((c) => c.method === "turn/start");
  assert.equal(turnCalls.length, 1);
  assert.equal(turnCalls[0].params.input[0].text, prompt.text);
  assert.deepEqual(s.binding("project"), {
    ownerId: "owner",
    workspaceId: "workspace",
    buildId: "build",
    serverInstanceId: s.state.serverInstanceId,
    threadId: "thread-one",
  });
  assert.equal(s.authorizeBinding(s.binding("project")), "project");
  for (const key of ["ownerId", "workspaceId", "buildId", "serverInstanceId", "threadId"])
    assert.throws(
      () => s.authorizeBinding({ ...s.binding("project"), [key]: "different" }),
      /denied/,
    );
  await s.command({ operation: "attach", projectId: "project" });
  assert.equal(f.calls.at(-1).args[0], "thread-one");
  assert.ok(!readFileSync(join(s.stateDirectory, "registry.json"), "utf8").includes(prompt.text));
});

test("ambiguous create survives restart and never creates a second thread", async (t) => {
  const f = fixture(t);
  const original = f.runtime.call;
  f.runtime.call = async (method, params) => {
    if (method === "thread/start") {
      f.calls.push({ method });
      throw new Error("response_lost");
    }
    return original(method, params);
  };
  const s = await openSupervisor(config(), f.options);
  await assert.rejects(s.command(ensure), /response_lost/);
  await s.close();
  f.runtime.alive = () => true;
  const second = await openSupervisor(config(), f.options);
  t.after(() => second.close());
  assert.equal((await second.command(ensure)).phase, "creation-uncertain");
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  await assert.rejects(
    second.command({ ...ensure, creationIntentId: "different" }),
    /binding_conflict/,
  );
});

test("one workspace lifetime authorizes only each independently registered project's exact thread", async (t) => {
  const f = fixture(t);
  const c = config();
  c.projects.push({
    ...c.projects[0],
    projectId: "second",
    repositoryId: "456",
    taskId: "second-task",
    leaseId: "second-lease",
  });
  const secondPath = join(f.home, "projects/.hive-managed/github/456/checkout");
  mkdirSync(secondPath, { recursive: true });
  const originalLease = f.runtime.inspectLease;
  f.runtime.inspectLease = (project) => {
    const value = originalLease(project);
    value.data.checkoutDirectory = project.projectId === "second" ? secondPath : f.checkout;
    return value;
  };
  const originalCall = f.runtime.call;
  f.runtime.call = async (method, params) => {
    const value = await originalCall(method, params);
    if (method === "thread/start" && params.cwd === secondPath)
      value.thread = { id: "thread-two", cwd: secondPath };
    return value;
  };
  const s = await openSupervisor(c, f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await s.command(prompt);
  await s.command({ ...ensure, projectId: "second", creationIntentId: "second-intent" });
  await s.command({ ...prompt, projectId: "second", requestId: "second-request" });
  assert.equal(s.authorizeBinding(s.binding("project")), "project");
  assert.equal(s.authorizeBinding(s.binding("second")), "second");
  assert.notEqual(s.binding("project").threadId, s.binding("second").threadId);
  assert.equal(s.binding("project").serverInstanceId, s.binding("second").serverInstanceId);
  await assert.rejects(s.command({ ...prompt, threadId: "thread-two" }), /invalid_command/);
});

test("lease expiry denies execution while durable read binding remains available", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await s.command(prompt);
  const original = f.runtime.inspectLease;
  f.runtime.inspectLease = (project) => {
    const value = original(project);
    value.data.lease.expiresAt = 1;
    return value;
  };
  assert.equal(s.authorizeBinding(s.binding("project")), "project");
  await assert.rejects(s.command({ operation: "attach", projectId: "project" }), /lease_changed/);
});

test("checkout absence retains durable reads while input and attach stay denied", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await s.command(prompt);
  rmSync(f.checkout, { recursive: true });
  assert.equal(s.authorizeBinding(s.binding("project")), "project");
  assert.equal(
    (await s.command({ operation: "refresh", projectId: "project" })).phase,
    "persisted",
  );
  await assert.rejects(s.command({ operation: "attach", projectId: "project" }));
  await assert.rejects(s.command(prompt));
  assert.equal(existsSync(f.checkout), false);
});

test("failed helper provenance cannot authorize execution even with an otherwise current lease", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  const original = f.runtime.inspectLease;
  f.runtime.inspectLease = (project) => {
    const value = original(project);
    value.data.checkoutVerified = false;
    return value;
  };
  await assert.rejects(s.command(prompt), /lease_changed/);
  assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 0);
});

test("ambiguous first prompt is durable, replay cannot repeat inference", async (t) => {
  const f = fixture(t);
  const original = f.runtime.call;
  f.runtime.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "turn/start") throw new Error("lost_reply");
    return result;
  };
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await assert.rejects(s.command(prompt), /lost_reply/);
  assert.equal((await s.command(prompt)).phase, "firstPromptUncertain");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  await assert.rejects(s.command({ ...prompt, text: "changed" }), /conflict/);
  assert.equal(
    (await s.command({ operation: "refresh", projectId: "project" })).phase,
    "persisted",
  );
});

test("native lifetime loss revokes all bindings and restart requires explicit same-thread rejoin", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  await s.command(ensure);
  await s.command(prompt);
  const old = s.binding("project");
  f.runtime.die();
  assert.throws(() => s.binding("project"), /session_not_available/);
  assert.equal((await s.command({ operation: "inspect", projectId: "project" })).phase, "revoked");
  await s.close();
  f.runtime.alive = () => true;
  const second = await openSupervisor(config(), f.options);
  t.after(() => second.close());
  await assert.rejects(
    second.command({ operation: "attach", projectId: "project" }),
    /explicit_rejoin_required/,
  );
  await second.command({ operation: "rejoin", projectId: "project" });
  assert.notEqual(second.binding("project").serverInstanceId, old.serverInstanceId);
  assert.equal(second.binding("project").threadId, old.threadId);
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
});

test("OS lock rejects another supervisor and private registry forgery cannot reopen", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  await assert.rejects(openSupervisor(config(), f.options), /already_running/);
  await s.close();
  const path = join(s.stateDirectory, "registry.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.state.ownerId = "forged";
  writeFileSync(path, JSON.stringify(saved));
  await assert.rejects(openSupervisor(config(), f.options), /signature/);
});

test("unpersisted rejoin failure is explicit and never substitutes a new thread", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  await s.command(ensure);
  await s.close();
  f.runtime.alive = () => true;
  const original = f.runtime.call;
  f.runtime.call = async (method, params) => {
    if (method === "thread/resume") throw new Error("no_rollout");
    return original(method, params);
  };
  const second = await openSupervisor(config(), f.options);
  t.after(() => second.close());
  await assert.rejects(
    second.command({ operation: "rejoin", projectId: "project" }),
    /history_rejoin_unsupported/,
  );
  assert.equal(second.snapshot("project").phase, "historyRejoinUnsupported");
  assert.throws(() => second.binding("project"), /session_not_available/);
  assert.equal(f.calls.filter((call) => call.method === "thread/start").length, 1);
});

test("unknown caller fields, project substitutions, lease changes and path escapes are denied", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  for (const extra of [
    { cwd: "/tmp" },
    { nativeUrl: "ws://127.0.0.1:1" },
    { ownerId: "forged" },
    { model: "other" },
  ])
    await assert.rejects(s.command({ ...ensure, ...extra }), /invalid_command/);
  await assert.rejects(s.command({ ...ensure, projectId: "unknown" }), /not_registered/);
  f.runtime.inspectLease = () => ({
    ok: true,
    data: { status: "ready", checkoutDirectory: f.checkout, lease: { id: "changed" } },
  });
  await assert.rejects(s.command(ensure), /lease_changed/);
  rmSync(f.checkout, { recursive: true });
  symlinkSync(tmpdir(), f.checkout);
  await assert.rejects(s.command(ensure));
  assert.equal(f.calls.length, 0);
});

test("unsupported profile/version and mismatched native thread metadata fail closed", async (t) => {
  const f = fixture(t);
  assert.throws(() => validateSupervisorConfig({ ...config(), profile: "browser" }), /unsupported/);
  f.runtime.version = "0.166.0";
  await assert.rejects(openSupervisor(config(), f.options), /unsupported_native/);
  f.runtime.version = "0.165.0";
  f.runtime.alive = () => true;
  f.runtime.call = async () => ({
    thread: { id: "wrong", cwd: "/other" },
    model: "gpt-6.1-sol",
    reasoningEffort: "low",
  });
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await assert.rejects(s.command(ensure), /binding_mismatch/);
  assert.equal((await s.command(ensure)).phase, "creation-uncertain");
});

test("SIGKILL releases process lock but preserves uncertain creation intent", {
  timeout: 10000,
}, async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL(
    "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
    import.meta.url,
  ).href;
  const source = `import {openSupervisor} from ${JSON.stringify(moduleUrl)};
const cfg=JSON.parse(process.argv[1]); const home=process.argv[2];
const runtime={version:'0.165.0',alive:()=>true,onClose:()=>{},close:async()=>{},inspectLease:(p)=>({ok:true,data:{status:'ready',checkoutVerified:true,checkoutDirectory:home+'/projects/.hive-managed/github/123/checkout',lease:{id:p.leaseId,taskId:p.taskId,generation:p.leaseGeneration,expiresAt:Date.now()/1000+900}}}),call:async()=>{process.stdout.write('pending\\n');await new Promise(()=>{})}};
const s=await openSupervisor(cfg,{home,runtimeFactory:async()=>runtime});
setInterval(()=>{},1000); await s.command(${JSON.stringify(ensure)});`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, JSON.stringify(config()), f.home],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  assert.match((await once(child.stdout, "data"))[0].toString(), /pending/);
  await assert.rejects(openSupervisor(config(), f.options), /already_running/);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const recovered = await openSupervisor(config(), f.options);
  t.after(() => recovered.close());
  assert.equal((await recovered.command(ensure)).phase, "creation-uncertain");
  assert.equal(f.calls.length, 0);
});

// Actual Codex, no account keys and no model request. The local provider port is
// deliberately closed. This proves the empty-thread limitation, not inference.
test("installed native 0.165 rejects remote CLI attachment of an empty loaded thread", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 20000,
}, async (t) => {
  const f = fixture(t);
  const executable =
    process.env.HIVE_TEST_CODEX_EXECUTABLE ||
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  const c = {
    ...config(),
    codexExecutable: realpathSync(executable),
    codexSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
  mkdirSync(join(f.home, ".codex"), { mode: 0o700 });
  writeFileSync(
    join(f.home, ".codex/config.toml"),
    'model = "gpt-6.1-sol"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "No inference"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nmemories = false\n',
  );
  let native;
  const s = await openSupervisor(c, {
    home: f.home,
    runtimeFactory: async (args) => {
      native = await launchNative(args);
      f.runtime.close = native.close;
      native.inspectLease = f.runtime.inspectLease;
      return native;
    },
  });
  t.after(() => s.close());
  const empty = await s.command(ensure);
  assert.equal(empty.phase, "awaitingFirstTurn");
  // Metadata-only turns=[] is not history proof; full hydration is unavailable.
  await assert.rejects(
    native.call("thread/read", { threadId: empty.threadId, includeTurns: true }),
    /native_request_rejected/,
  );
  await assert.rejects(
    s.provePreExecution("project", ensure.creationIntentId),
    /retry_history_unavailable/,
  );
  await assert.rejects(
    native.call("thread/resume", { threadId: empty.threadId, excludeTurns: true }),
    /native_request_rejected/,
  );
  await native.attach(empty.threadId, f.checkout, "project");
  await new Promise((r) => setTimeout(r, 1800));
  const socket = join(s.stateDirectory, "tmux.sock");
  let sessions = "";
  try {
    sessions = execFileSync("tmux", ["-S", socket, "list-sessions"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  assert.equal(sessions, "", "CLI should fail bootstrap and exit, never create another thread");
  const loaded = await native.call("thread/loaded/list", {});
  assert.deepEqual(loaded.data, [empty.threadId]);
  assert.equal(existsSync(join(f.home, ".codex/auth.json")), false);
});

test("actual native first text persists through local mock provider then same-thread CLI attaches", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 20000,
}, async (t) => {
  const f = fixture(t);
  const requests = [];
  let holdResponse = false;
  const server = createServer((req, res) => {
    let input = "";
    req.on("data", (chunk) => {
      input += chunk;
    });
    req.on("end", () => {
      requests.push(input);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (holdResponse) {
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_interrupt", status: "in_progress", output: [] } })}\n\n`,
        );
        return;
      }
      const message = {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "HIVE_LOCAL_PROVIDER_REPLY", annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: "resp_fixture", status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: "HIVE_LOCAL_PROVIDER_REPLY",
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            id: "resp_fixture",
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      for (const event of events)
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const executable =
    process.env.HIVE_TEST_CODEX_EXECUTABLE ||
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  const c = {
    ...config(),
    codexExecutable: realpathSync(executable),
    codexSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
  mkdirSync(join(f.home, ".codex"), { mode: 0o700 });
  writeFileSync(
    join(f.home, ".codex/config.toml"),
    `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Local fixture only"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nmemories = false\n`,
  );
  let native;
  const s = await openSupervisor(c, {
    home: f.home,
    runtimeFactory: async (args) => {
      native = await launchNative(args);
      f.runtime.close = native.close;
      native.inspectLease = f.runtime.inspectLease;
      return native;
    },
  });
  t.after(() => s.close());
  const created = await s.command(ensure);
  // Persistence may lag the accepted turn response. Never resend first input.
  await s.command(prompt).catch(() => {});
  let history;
  for (let n = 0; n < 60; n++) {
    try {
      await s.command({ operation: "refresh", projectId: "project" });
      history = await native.call("thread/turns/list", {
        threadId: created.threadId,
        limit: 10,
        sortDirection: "asc",
        itemsView: "full",
      });
      if (JSON.stringify(history).includes("HIVE_LOCAL_PROVIDER_REPLY")) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(JSON.stringify(history).includes("HIVE_LOCAL_PROVIDER_REPLY"));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes(prompt.text));
  // Explicit trusted fixture installs a pending record to exercise the actual
  // native read-only seam. This is not a server application or release proof.
  const sourceEntry = s.state.projects.project;
  sourceEntry.sourceApplication = {
    applicationId: randomUUID(),
    projectId: "project",
    phase: "closing",
    serverInstanceId: s.state.serverInstanceId,
    managerThreadId: created.threadId,
    cohort: [],
    barrier: { id: randomUUID(), generation: 1, closed: true },
  };
  s.save();
  const sourceScope = s.sourceApplicationScope("project");
  await assert.rejects(
    native.call("turn/start", {
      threadId: created.threadId,
      input: [{ type: "text", text: "must not reach provider", text_elements: [] }],
    }),
    /input_closed/,
  );
  const factual = await s.readSourceApplication(sourceScope, "thread/turns/list", {
    threadId: created.threadId,
    limit: 10,
    sortDirection: "asc",
    itemsView: "full",
  });
  assert.ok(JSON.stringify(factual).includes("HIVE_LOCAL_PROVIDER_REPLY"));
  await assert.rejects(
    native.readSourceApplication(sourceScope, "turn/start", { threadId: created.threadId }),
    /read_unavailable/,
  );
  assert.equal(requests.length, 1);
  delete sourceEntry.sourceApplication;
  s.save(); // End only this synthetic fence fixture.
  await s.command({ operation: "attach", projectId: "project" });
  await new Promise((r) => setTimeout(r, 1200));
  const pane = execFileSync(
    "tmux",
    ["-S", join(s.stateDirectory, "tmux.sock"), "capture-pane", "-p"],
    { encoding: "utf8" },
  );
  assert.match(pane, /HIVE_LOCAL_PROVIDER_REPLY/);
  assert.deepEqual((await native.call("thread/loaded/list", {})).data, [created.threadId]);
  await s.command(prompt);
  assert.equal(requests.length, 1);
  const gatewayKeys = generateKeyPairSync("ed25519");
  const gatewayState = join(f.home, "gateway");
  mkdirSync(gatewayState, { mode: 0o700 });
  const gatewayConfig = {
    schemaVersion: 1,
    protocolVersion: "0.165.0",
    hiveOrigin: "https://hive.example.com",
    appOrigin: "https://session.coder.example.com",
    publicKeyPem: gatewayKeys.publicKey.export({ type: "spki", format: "pem" }),
    keyId: "fixture-key",
    stateDirectory: gatewayState,
    port: 0,
  };
  async function readViaGateway(host, expectedLoaded = [created.threadId]) {
    const gateway = await startProjectGateway(gatewayConfig, host);
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/session`, {
      headers: { Origin: gatewayConfig.hiveOrigin, Host: new URL(gatewayConfig.appOrigin).host },
    });
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data)));
    ws.on("error", () => {});
    const until = async (fn) => {
      for (let n = 0; n < 100; n++) {
        const value = fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("native_gateway_timeout");
    };
    try {
      await until(() => ws.readyState === WebSocket.OPEN);
      const binding = host.binding("project");
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: gatewayConfig.keyId }),
      ).toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          iss: gatewayConfig.hiveOrigin,
          aud: gatewayConfig.appOrigin,
          origin: gatewayConfig.hiveOrigin,
          scope: "session:read",
          sub: binding.ownerId,
          workspaceId: binding.workspaceId,
          buildId: binding.buildId,
          serverInstanceId: binding.serverInstanceId,
          threadId: binding.threadId,
          iat: now,
          exp: now + 60,
          jti: randomUUID(),
        }),
      ).toString("base64url");
      ws.send(
        JSON.stringify({
          type: "authenticate",
          ticket: `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), gatewayKeys.privateKey).toString("base64url")}`,
        }),
      );
      const ack = await until(() => messages.find((m) => m.type === "authenticated"));
      assert.deepEqual(ack.binding, binding);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "native-fixture" } },
        }),
      );
      await until(() => messages.find((m) => m.id === 1));
      ws.send(JSON.stringify({ method: "initialized" }));
      ws.send(
        JSON.stringify({
          id: 2,
          method: "thread/resume",
          params: { threadId: binding.threadId, excludeTurns: true },
        }),
      );
      assert.equal(
        (await until(() => messages.find((m) => m.id === 2))).result.thread.id,
        created.threadId,
      );
      ws.send(
        JSON.stringify({
          id: 3,
          method: "thread/turns/list",
          params: {
            threadId: binding.threadId,
            limit: 10,
            sortDirection: "asc",
            itemsView: "full",
          },
        }),
      );
      assert.ok(
        JSON.stringify(await until(() => messages.find((m) => m.id === 3))).includes(
          "HIVE_LOCAL_PROVIDER_REPLY",
        ),
      );
      assert.deepEqual((await native.call("thread/loaded/list", {})).data, expectedLoaded);
    } finally {
      ws.terminate();
      await gateway.close();
    }
  }
  await readViaGateway(s);
  holdResponse = true;
  await native.call("turn/start", {
    threadId: created.threadId,
    clientUserMessageId: randomUUID(),
    input: [{ type: "text", text: "Local interruption fixture only.", text_elements: [] }],
  });
  for (let n = 0; n < 40 && requests.length < 2; n++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(requests.length >= 2);
  // CLI title generation is asynchronous relative to the actual user turn.
  // Wait for its separately held local response before checking quiescence.
  for (let n = 0; n < 100 && requests.length < 3; n++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 3, "two project turns plus native CLI title generation");
  const secondTurnLoaded = (await native.call("thread/loaded/list", {})).data;
  const unknownThreads = secondTurnLoaded.filter((threadId) => threadId !== created.threadId);
  assert.equal(
    unknownThreads.length,
    1,
    "native title generation has an unmapped ephemeral thread",
  );
  for (const threadId of unknownThreads) {
    const { thread } = await native.call("thread/read", { threadId, includeTurns: false });
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.parentThreadId, null);
    assert.equal(thread.status.type, "active");
  }
  sourceEntry.sourceApplication = {
    applicationId: sourceScope.applicationId,
    projectId: "project",
    phase: "held",
    serverInstanceId: s.state.serverInstanceId,
    managerThreadId: created.threadId,
    cohort: [],
    barrier: { id: sourceScope.barrierId, generation: sourceScope.generation, closed: true },
  };
  s.save();
  const revocation = await s.revokeExecution("project");
  assert.equal(
    revocation.reviewRequired,
    unknownThreads.length > 0,
    "unmapped active ephemeral threads must retain review hold despite acknowledged root interrupt",
  );
  const rootAfterInterrupt = await s.readSourceApplication(sourceScope, "thread/read", {
    threadId: created.threadId,
    includeTurns: true,
  });
  assert.equal(rootAfterInterrupt.thread.status.type, "idle");
  assert.equal(sourceEntry.sourceApplication.phase, "held");
  assert.throws(() => s.assertSourceInputOpen(), /input_closed/);
  delete sourceEntry.sourceApplication;
  s.save(); // End synthetic source fixture; durable execution revocation remains.
  await assert.rejects(
    s.command({ operation: "attach", projectId: "project" }),
    /project_execution_revoked/,
  );
  await readViaGateway(s, secondTurnLoaded);
  await s.close();
  const providerCallsBeforeHistoryRejoin = requests.length;
  rmSync(f.checkout, { recursive: true });
  const restarted = await openSupervisor(c, {
    home: f.home,
    runtimeFactory: async (args) => {
      native = await launchNative(args);
      f.runtime.close = native.close;
      native.inspectLease = f.runtime.inspectLease;
      return native;
    },
  });
  t.after(() => restarted.close());
  const rejoined = await restarted.command({ operation: "rejoin", projectId: "project" });
  assert.equal(rejoined.phase, "persisted");
  assert.equal(restarted.binding("project").threadId, created.threadId);
  await readViaGateway(restarted);
  assert.equal(existsSync(f.checkout), false, "read rejoin must not recreate checkout");
  await assert.rejects(restarted.command({ operation: "attach", projectId: "project" }));
  assert.equal(
    requests.length,
    providerCallsBeforeHistoryRejoin,
    "history rejoin must not invoke the provider again",
  );
  for (const body of requests.slice(2)) {
    const input = JSON.parse(body).input;
    const last = input
      .at(-1)
      ?.content?.map((part) => part.text ?? "")
      .join("");
    assert.match(
      last,
      /^Generate a concise, single-line task title/,
      "the extra native ephemeral request is title generation, never a second manager prompt",
    );
  }
});

test("SIGKILL supervisor terminates its actual native child and permits a fresh lifetime", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 15000,
}, async (t) => {
  const f = fixture(t);
  const executable =
    process.env.HIVE_TEST_CODEX_EXECUTABLE ||
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  const c = {
    ...config(),
    codexExecutable: realpathSync(executable),
    codexSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  };
  mkdirSync(join(f.home, ".codex"), { mode: 0o700 });
  writeFileSync(
    join(f.home, ".codex/config.toml"),
    "[features]\napps = false\nplugins = false\nmemories = false\n",
  );
  const moduleUrl = new URL(
    "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
    import.meta.url,
  ).href;
  const code = `import {openSupervisor} from ${JSON.stringify(moduleUrl)};const s=await openSupervisor(JSON.parse(process.argv[1]),{home:process.argv[2]});process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, JSON.stringify(c), f.home],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  assert.match((await once(child.stdout, "data"))[0].toString(), /ready/);
  const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
    .trim()
    .split(/\s+/);
  assert.equal(children.length, 1);
  const nativePid = children[0];
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  let recovered;
  for (let n = 0; n < 40; n++) {
    try {
      recovered = await openSupervisor(config(), f.options);
      break;
    } catch (error) {
      assert.match(error.message, /already_running/);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(recovered, "child-held lock must release after parent-death termination");
  t.after(() => recovered.close());
  const statusPath = `/proc/${nativePid}/status`;
  assert.ok(
    !existsSync(statusPath) || /^State:\s+Z/m.test(readFileSync(statusPath, "utf8")),
    "old native child must not remain running",
  );
});

test("registered empty thread supports first-turn manager enrollment but no premature history attach", async (t) => {
  const f = fixture(t);
  let installed;
  f.runtime.setManagerAdapter = (adapter) => {
    installed = adapter;
  };
  const adapter = {
    tools: () => [
      {
        type: "function",
        name: "hive_delivery",
        description: "Fixture installed tool",
        inputSchema: { type: "object" },
      },
    ],
    handleToolCall: async () => ({
      contentItems: [{ type: "inputText", text: "fixture" }],
      success: true,
    }),
  };
  const s = await openSupervisor(config(), { ...f.options, managerAdapter: adapter });
  t.after(() => s.close());
  await s.command(ensure);
  assert.equal(s.registrationBinding("project").threadId, "thread-one");
  assert.throws(() => s.registrationBinding("unknown"));
  assert.throws(() => s.binding("project"), /session_not_available/);
  assert.equal(f.calls.find((c) => c.method === "thread/start").params.experimentalRawEvents, true);
  assert.equal(
    f.calls.find((c) => c.method === "thread/start").params.dynamicTools[0].name,
    "hive_delivery",
  );
  assert.equal((await installed.handleToolCall({ threadId: "thread-one" })).success, true);
  await assert.rejects(installed.handleToolCall({ threadId: "other" }));
});
test("native tool router separates request IDs and never answers approvals or arbitrary tools", async () => {
  const replies = [],
    calls = [];
  const route = createNativeManagerRouter(
    () => ({
      handleToolCall: async (p) => {
        calls.push(p);
        return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
      },
    }),
    (id, result) => replies.push({ id, result }),
  );
  assert.equal(route({ id: 1, result: { thread: { id: "thread" } } }), false);
  assert.equal(route({ id: 1, method: "item/commandExecution/requestApproval", params: {} }), true);
  assert.equal(replies.length, 0);
  route({
    id: 2,
    method: "item/tool/call",
    params: { tool: "hive_delivery", namespace: null, threadId: "known" },
  });
  route({ id: 3, method: "item/tool/call", params: { tool: "arbitrary_shell", namespace: null } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.equal(replies.find((r) => r.id === 2).result.success, true);
  assert.equal(replies.find((r) => r.id === 3).result.success, false);
});

test("router drain tracks detached observers and excludes read responses from its notification fence", async () => {
  let release;
  const observer = new Promise((resolve) => {
    release = resolve;
  });
  const route = createNativeManagerRouter(
    () => ({ observe: () => observer }),
    () => {},
  );
  route({ method: "turn/completed", params: { threadId: "root" } });
  const sequence = route.inspect().receiveSequence;
  assert.equal(route({ id: 22, result: { data: [] } }), false);
  assert.equal(route.inspect().receiveSequence, sequence);
  assert.equal(route.inspect().pendingObservers, 1);
  await assert.rejects(route.drain({ timeoutMs: 10 }), /drain_timeout/);
  release();
  await route.drain({ timeoutMs: 100 });
  assert.equal(route.inspect().pendingObservers, 0);
});

test("a claim handler can drain others without awaiting itself or excluding a foreign same-named call", async () => {
  let route;
  const replies = [];
  route = createNativeManagerRouter(
    () => ({
      handleToolCall: async (params) => {
        const result = await route.drain({ excludeCall: params, timeoutMs: 100 });
        assert.equal(result.activeHandlers, 0);
        return { success: true, contentItems: [] };
      },
    }),
    (id, result) => replies.push({ id, result }),
  );
  route({
    id: 9,
    method: "item/tool/call",
    params: {
      tool: "hive_delivery",
      namespace: null,
      threadId: "root",
      turnId: "turn",
      callId: "claim",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies[0].result.success, true);
  let release;
  const work = new Promise((resolve) => {
    release = resolve;
  });
  const other = createNativeManagerRouter(
    () => ({ handleToolCall: () => work }),
    () => {},
  );
  other({
    id: 10,
    method: "item/tool/call",
    params: {
      tool: "hive_delivery",
      namespace: null,
      threadId: "foreign",
      turnId: "turn",
      callId: "claim",
    },
  });
  await assert.rejects(
    other.drain({
      excludeCall: { threadId: "root", turnId: "turn", callId: "claim" },
      timeoutMs: 10,
    }),
    /drain_timeout/,
  );
  release({ success: true, contentItems: [] });
  await other.drain({ timeoutMs: 100 });
});

async function progressionSupervisor(t) {
  const f = fixture(t);
  const lease = f.runtime.inspectLease;
  f.runtime.inspectLease = (project) => {
    const result = lease(project);
    result.data.revision = "a".repeat(40);
    return result;
  };
  f.runtime.setManagerAdapter = () => {};
  f.runtime.inspectManagerRouting = () => ({
    receiveSequence: 0,
    pendingObservers: 0,
    activeHandlers: 0,
    observerFailures: [],
  });
  f.runtime.drainManagerRouting = async () => f.runtime.inspectManagerRouting();
  const adapter = {
    progressionProtocol: 1,
    assertProgressionAuthority: () => {},
    tools: () => [],
    handleToolCall: async () => ({ success: true, contentItems: [] }),
  };
  const supervisor = await openSupervisor(config(), { ...f.options, managerAdapter: adapter });
  t.after(() => supervisor.close());
  await supervisor.command(ensure);
  await supervisor.command(prompt);
  const root = {
    id: "turn-one",
    status: "completed",
    itemsView: "full",
    items: [{ id: "first-input", type: "userMessage", clientId: prompt.requestId }],
  };
  const history = [root];
  const original = f.runtime.call;
  f.runtime.call = async (method, params) => {
    if (method === "thread/turns/list") return { data: structuredClone(history), nextCursor: null };
    if (method === "thread/items/list")
      return {
        data: history
          .find((turn) => turn.id === params.turnId)
          .items.map((item) => ({ turnId: params.turnId, item })),
        nextCursor: null,
      };
    if (method === "thread/loaded/list") return { data: ["thread-one"], nextCursor: null };
    if (method === "turn/start") {
      f.calls.push({ method, params });
      history.push({
        id: "turn-two",
        status: "inProgress",
        itemsView: "full",
        items: [
          { id: "next-input", type: "userMessage", clientId: params.clientUserMessageId },
          {
            id: "next-claim",
            type: "dynamicToolCall",
            tool: "hive_delivery",
            arguments: { operation: "claim_step" },
          },
        ],
      });
      return { turn: { id: "turn-two" } };
    }
    return original(method, params);
  };
  const request = {
    managerThreadId: "thread-one",
    parentTurnId: "turn-one",
    priorAttemptId: "attempt-one",
    cursorVersion: 1,
    requestId: "continuation-one",
    spawns: [],
    cohort: [],
    checkoutBinding: {
      projectId: "project",
      preparationIntentId: "task",
      repositoryId: "123",
      leaseId: "lease",
      leaseGeneration: 1,
      revision: "a".repeat(40),
    },
  };
  return { ...f, supervisor, history, request };
}

test("protocol one journals one private continuation and revalidates the exact claim without opening CLI admission", async (t) => {
  const f = await progressionSupervisor(t);
  const receipt = await f.supervisor.continueDeliveryRoot(f.request);
  assert.equal(receipt.nextParentTurnId, "turn-two");
  assert.deepEqual(await f.supervisor.continueDeliveryRoot(f.request), receipt);
  assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 2);
  const checkpoint = await f.supervisor.revalidateDeliveryBoundary(f.request, "turn-two", {
    threadId: "thread-one",
    turnId: "turn-two",
    callId: "next-claim",
  });
  assert.equal(checkpoint.receiveSequence, 0);
  await assert.rejects(
    f.supervisor.command({ operation: "attach", projectId: "project" }),
    /attachment_forbidden/,
  );
  await assert.rejects(
    f.supervisor.command({ operation: "rejoin", projectId: "project" }),
    /attachment_forbidden/,
  );
  const stored = JSON.parse(
    readFileSync(join(f.supervisor.stateDirectory, "registry.json"), "utf8"),
  ).state;
  assert.equal(stored.projects.project.deliveryContinuations["continuation-one"].phase, "started");
});

test("an ambiguous continuation start stays journaled and never sends a second native start", async (t) => {
  const f = await progressionSupervisor(t),
    original = f.runtime.call;
  f.runtime.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "turn/start") throw new Error("lost_ack");
    return result;
  };
  await assert.rejects(f.supervisor.continueDeliveryRoot(f.request), /lost_ack/);
  await assert.rejects(f.supervisor.continueDeliveryRoot(f.request), /continuation_uncertain/);
  assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 2);
});

test("parallel native input and work before claim receipt retain the continuation hold", async (t) => {
  const f = await progressionSupervisor(t);
  await f.supervisor.continueDeliveryRoot(f.request);
  f.history
    .at(-1)
    .items.push({ id: "foreign-input", type: "userMessage", clientId: "external-producer" });
  await assert.rejects(
    f.supervisor.revalidateDeliveryBoundary(f.request, "turn-two", { callId: "next-claim" }),
    /parallel_input/,
  );
  f.history.at(-1).items.pop();
  f.history.at(-1).items.push({ type: "commandExecution", id: "unadmitted-command" });
  await assert.rejects(
    f.supervisor.revalidateDeliveryBoundary(f.request, "turn-two", { callId: "next-claim" }),
    /work_before_claim/,
  );
});

test("protocol-one boundary refuses unknown inventory and inconsistent full-item history", async (t) => {
  const f = await progressionSupervisor(t),
    original = f.runtime.call;
  f.runtime.call = async (method, params) =>
    method === "thread/loaded/list"
      ? { data: ["thread-one", "unknown-thread"], nextCursor: null }
      : original(method, params);
  await assert.rejects(f.supervisor.continueDeliveryRoot(f.request), /unknown_native_inventory/);
  f.runtime.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/items/list")
      result.data[0].item = { ...result.data[0].item, clientId: "different-input" };
    return result;
  };
  await assert.rejects(f.supervisor.continueDeliveryRoot(f.request), /history_incomplete/);
  assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("router timeout keeps the actual handler tracked until its underlying work settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const work = new Promise((resolve) => {
      release = resolve;
    }),
    replies = [];
  const route = createNativeManagerRouter(
    () => ({ handleToolCall: () => work }),
    (id, result) => replies.push({ id, result }),
  );
  route({
    id: 1,
    method: "item/tool/call",
    params: { tool: "hive_delivery", threadId: "root", turnId: "turn", callId: "call" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15001);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.success, false);
  assert.equal(route.inspect().activeHandlers, 1);
  release({ success: true, contentItems: [] });
  await route.drain({ timeoutMs: 100 });
  assert.equal(route.inspect().activeHandlers, 0);
  assert.equal(replies.length, 1);
});

test("continuation rechecks registration after awaited history and again after durable start intent", async (t) => {
  for (const when of ["history", "journal"]) {
    const f = await progressionSupervisor(t);
    let expiresAt = Date.now() + 60000;
    f.supervisor.managerAdapter.assertProgressionAuthority = () => {
      if (expiresAt <= Date.now()) throw new Error("delivery_authority_changed");
    };
    if (when === "history") {
      const original = f.runtime.call;
      f.runtime.call = async (method, params) => {
        const value = await original(method, params);
        if (method === "thread/items/list") expiresAt = Date.now() - 1;
        return value;
      };
    } else {
      const save = f.supervisor.save;
      f.supervisor.save = () => {
        save();
        if (
          f.supervisor.state.projects.project.deliveryContinuations?.[f.request.requestId]
            ?.phase === "start-uncertain"
        )
          expiresAt = Date.now() - 1;
      };
    }
    await assert.rejects(f.supervisor.continueDeliveryRoot(f.request), /authority_changed/);
    assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 1);
  }
});

test("registration cannot adopt an empty thread after a failed new-lifetime rejoin", async (t) => {
  const f = fixture(t);
  let s = await openSupervisor(config(), f.options);
  await s.command(ensure);
  await s.close();
  const next = fixture(t);
  const options = { ...next.options, home: f.home };
  next.runtime.call = async () => {
    throw new Error("no rollout");
  };
  s = await openSupervisor(config(), options);
  try {
    assert.throws(() => s.registrationBinding("project"), /registration_binding_unavailable/);
    await assert.rejects(
      s.command({ operation: "rejoin", projectId: "project" }),
      /history_rejoin_unsupported/,
    );
    assert.throws(() => s.registrationBinding("project"), /registration_binding_unavailable/);
  } finally {
    await s.close();
  }
});

test("installed manager observer receives exact notification methods, never approval requests", () => {
  const observed = [];
  const route = createNativeManagerRouter(
    () => ({ observe: (value) => observed.push(value) }),
    () => {
      throw new Error("not a request");
    },
  );
  for (const method of ["item/started", "item/completed", "rawResponseItem/completed"])
    route({ method, params: { threadId: "manager", turnId: "turn", item: { type: "fixture" } } });
  route({ id: 1, method: "item/commandExecution/requestApproval", params: {} });
  assert.deepEqual(
    observed.map((v) => v.method),
    ["item/started", "item/completed", "rawResponseItem/completed"],
  );
});

test("renewal failure durably fences execution, interrupts exact turn and preserves reads and other project", async (t) => {
  const f = fixture(t),
    raw = config();
  raw.projects.push({
    ...raw.projects[0],
    projectId: "other",
    repositoryId: "456",
    taskId: "task-other",
    leaseId: "lease-other",
  });
  const second = join(f.home, "projects/.hive-managed/github/456/checkout");
  mkdirSync(second, { recursive: true });
  f.runtime.inspectLease = (p) => ({
    ok: true,
    data: {
      status: "ready",
      checkoutVerified: true,
      checkoutDirectory: p.projectId === "project" ? f.checkout : second,
      lease: {
        id: p.leaseId,
        taskId: p.taskId,
        generation: p.leaseGeneration,
        expiresAt: Date.now() / 1000 + 900,
      },
    },
  });
  f.runtime.call = async (method, params) => {
    f.calls.push({ method, params });
    if (method === "thread/start")
      return {
        thread: { id: params.cwd === f.checkout ? "thread-one" : "thread-other", cwd: params.cwd },
        model: "gpt-6.1-sol",
        reasoningEffort: "low",
      };
    if (method === "turn/start") return { turn: { id: "turn-one" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn-one", status: "inProgress" }] };
    if (method === "turn/interrupt") return {};
    if (method === "thread/loaded/list")
      return { data: ["thread-one", "child-one", "thread-other", "child-other"], nextCursor: null };
    if (method === "thread/read")
      return {
        thread: {
          id: params.threadId,
          status: {
            type: ["thread-one", "child-one"].includes(params.threadId) ? "idle" : "active",
          },
        },
      };
    throw new Error("unexpected_rpc");
  };
  f.runtime.detach = async (projectId) => f.calls.push({ method: "detach", projectId });
  const s = await openSupervisor(raw, f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await s.command(prompt);
  await s.command({ operation: "attach", projectId: "project" });
  await s.command({
    operation: "ensureProject",
    projectId: "other",
    creationIntentId: "other-intent",
  });
  await s.command({ ...prompt, projectId: "other" });
  s.registerChild("thread-one", "child-one", "spawn-one");
  s.registerChild("thread-other", "child-other", "spawn-other");
  await s.revokeExecution("project");
  assert.equal(s.state.projects.project.executionRevoked.reviewRequired, false);
  assert.deepEqual(
    f.calls.filter((c) => c.method === "turn/interrupt").map((c) => c.params),
    [
      { threadId: "thread-one", turnId: "turn-one" },
      { threadId: "child-one", turnId: "turn-one" },
    ],
  );
  assert.deepEqual(
    f.calls.filter((c) => c.method === "detach").map((c) => c.projectId),
    ["project"],
  );
  assert.equal(s.binding("project").threadId, "thread-one");
  assert.equal(s.binding("other").threadId, "thread-other");
  await assert.rejects(s.command({ ...prompt, requestId: "later" }), /project_execution_revoked/);
  await assert.rejects(
    s.command({ operation: "attach", projectId: "project" }),
    /project_execution_revoked/,
  );
  await s.command({ operation: "attach", projectId: "other" });
  assert.equal(s.snapshot("other").attached, true);
});
test("uncertain turn interruption stays durably revoked for review", async (t) => {
  const f = fixture(t),
    s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await s.command(prompt);
  f.runtime.call = async () => {
    throw new Error("unavailable");
  };
  await s.revokeExecution("project");
  assert.equal(s.state.projects.project.executionRevoked.reviewRequired, true);
  assert.equal(s.binding("project").threadId, "thread-one");
  await assert.rejects(
    s.command({ operation: "attach", projectId: "project" }),
    /project_execution_revoked/,
  );
});

for (const inventory of ["unknown-active", "truncated", "missing-root"]) {
  test(`revocation retains review hold for ${inventory} native inventory`, async (t) => {
    const f = fixture(t),
      s = await openSupervisor(config(), f.options);
    t.after(() => s.close());
    await s.command(ensure);
    await s.command(prompt);
    const interrupted = [];
    f.runtime.call = async (method, params) => {
      if (method === "thread/turns/list")
        return { data: [{ id: "turn-one", status: "inProgress" }] };
      if (method === "turn/interrupt") {
        interrupted.push(params.threadId);
        return {};
      }
      if (method === "thread/loaded/list")
        return {
          data: inventory === "missing-root" ? [] : ["thread-one", "unknown"],
          nextCursor: inventory === "truncated" ? "more" : null,
        };
      if (method === "thread/read")
        return {
          thread: {
            id: params.threadId,
            status: { type: params.threadId === "unknown" ? "active" : "idle" },
          },
        };
      throw new Error("unexpected_rpc");
    };
    const revoked = await s.revokeExecution("project");
    assert.equal(revoked.reviewRequired, true);
    assert.deepEqual(
      interrupted,
      ["thread-one"],
      "unknown thread must not be interrupted by guessed ownership",
    );
    assert.equal(s.binding("project").threadId, "thread-one");
    await assert.rejects(
      s.command({ operation: "attach", projectId: "project" }),
      /project_execution_revoked/,
    );
  });
}

test("pre-execution proof requires exact creation intent, loaded empty history and no first prompt", async (t) => {
  const f = fixture(t),
    s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  assert.deepEqual(await s.provePreExecution("project", ensure.creationIntentId), {
    threadId: null,
  });
  await s.command(ensure);
  let history = [];
  let loaded = true;
  const call = f.runtime.call;
  f.runtime.call = async (method, params) => {
    if (method === "thread/loaded/list")
      return { data: loaded ? ["thread-one"] : [], nextCursor: null };
    if (method === "thread/turns/list") return { data: history, nextCursor: null };
    return call(method, params);
  };
  await assert.rejects(s.provePreExecution("project", "other"), /retry_not_available/);
  assert.deepEqual(await s.provePreExecution("project", ensure.creationIntentId), {
    threadId: "thread-one",
  });
  history = [{ id: "turn-external", status: "completed" }];
  await assert.rejects(
    s.provePreExecution("project", ensure.creationIntentId),
    /retry_not_available/,
  );
  history = [];
  loaded = false;
  await assert.rejects(
    s.provePreExecution("project", ensure.creationIntentId),
    /retry_not_available/,
  );
  loaded = true;
  await s.command(prompt).catch(() => {});
  await assert.rejects(
    s.provePreExecution("project", ensure.creationIntentId),
    /retry_not_available/,
  );
});

test("pre-execution proof cannot reinterpret uncertain creation", async (t) => {
  const f = fixture(t),
    s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  f.runtime.call = async () => {
    throw new Error("lost_reply");
  };
  await assert.rejects(s.command(ensure));
  await assert.rejects(
    s.provePreExecution("project", ensure.creationIntentId),
    /retry_not_available/,
  );
});

test("installed child mapping gates notifications and history by exact parent/spawn/lifetime", async (t) => {
  const f = fixture(t),
    observed = [];
  let installed;
  f.runtime.setManagerAdapter = (value) => {
    installed = value;
  };
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  s.setManagerAdapter({
    tools: () => [],
    handleToolCall: async () => ({ success: true, contentItems: [] }),
    observe: (value) => observed.push(value),
  });
  const route = createNativeManagerRouter(
    () => installed,
    () => {},
  );
  for (const method of ["turn/started", "turn/completed", "item/completed"])
    route({ method, params: { threadId: "child-one" } });
  assert.equal(observed.length, 0);
  s.registerChild("thread-one", "child-one", "spawn-one");
  s.registerChild("thread-one", "child-one", "spawn-one");
  assert.throws(
    () => s.registerChild("thread-one", "child-one", "different"),
    /native_child_conflict/,
  );
  assert.throws(
    () => s.registerChild("thread-one", "another", "spawn-one"),
    /native_child_conflict/,
  );
  assert.throws(() => s.registerChild("unknown", "child-two", "spawn-two"));
  for (const method of [
    "turn/started",
    "turn/completed",
    "item/completed",
    "item/started",
    "rawResponseItem/completed",
  ])
    route({ method, params: { threadId: "child-one" } });
  assert.deepEqual(
    observed.map((x) => x.method),
    ["turn/started", "turn/completed", "item/completed"],
  );
  route({ method: "item/completed", params: { threadId: "unknown" } });
  assert.equal(observed.length, 3);
  f.runtime.inspectLease = () => {
    throw new Error("checkout_removed");
  };
  f.runtime.call = async (method, params) => {
    assert.equal(method, "thread/turns/list");
    assert.equal(params.threadId, "child-one");
    assert.equal(params.limit, 20);
    return { data: [{ id: "child-turn", status: "completed" }], nextCursor: "partial" };
  };
  const request = {
    managerThreadId: "thread-one",
    childThreadId: "child-one",
    spawnCallId: "spawn-one",
  };
  assert.equal(
    (await s.readNativeHistory(request)).nextCursor,
    "partial",
    "partial history stays explicitly partial without execution lease",
  );
  await assert.rejects(
    s.readNativeHistory({ ...request, spawnCallId: "other" }),
    /native_child_unregistered/,
  );
  await assert.rejects(
    s.readNativeHistory({ ...request, cursor: "unbounded" }),
    /invalid_native_child/,
  );
  s.state.projects.project.children["child-one"].serverInstanceId = "prior-lifetime";
  await assert.rejects(s.readNativeHistory(request), /native_child_unregistered/);
  route({ method: "item/completed", params: { threadId: "child-one" } });
  assert.equal(observed.length, 3);
});

test("late mapped child after revocation is interrupted and failures retain review hold", async (t) => {
  const f = fixture(t),
    s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  const interrupted = [];
  f.runtime.call = async (method, params) => {
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: "active-turn",
            status: params.threadId === "thread-one" ? "completed" : "inProgress",
          },
        ],
      };
    if (method === "turn/interrupt") {
      interrupted.push(params.threadId);
      throw new Error("interrupt_uncertain");
    }
    if (method === "thread/loaded/list")
      return { data: ["thread-one", "late-child"], nextCursor: null };
    if (method === "thread/read")
      return {
        thread: {
          id: params.threadId,
          status: { type: params.threadId === "thread-one" ? "idle" : "active" },
        },
      };
    throw new Error("unexpected_rpc");
  };
  assert.equal((await s.revokeExecution("project")).reviewRequired, true);
  s.registerChild("thread-one", "late-child", "late-spawn");
  await Promise.all([...s.executionRevocations.values()]);
  assert.deepEqual(interrupted, ["late-child"]);
  assert.equal(s.state.projects.project.executionRevoked.reviewRequired, true);
  assert.throws(() => s.lease(config().projects[0]), /project_execution_revoked/);
});

test("supervisor holds process lock and native lifetime until installed observer close drains", async (t) => {
  const f = fixture(t);
  f.runtime.setManagerAdapter = () => {};
  const s = await openSupervisor(config(), f.options);
  let release,
    closing = false;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  s.setManagerAdapter({
    tools: () => [],
    handleToolCall: async () => ({ success: false, contentItems: [] }),
    async close() {
      closing = true;
      await wait;
    },
  });
  const closed = s.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closing, true);
  assert.equal(f.runtime.alive(), true);
  await assert.rejects(openSupervisor(config(), f.options), /already_running/);
  release();
  await closed;
  assert.equal(f.runtime.alive(), false);
});

test("guardian closure while a native response is pending keeps the durable creation intent uncertain", async (t) => {
  const f = fixture(t);
  let open = true,
    release,
    entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const original = f.runtime.call;
  f.runtime.call = async (method, params) => {
    if (method === "thread/start") {
      entered();
      await gate;
    }
    return original(method, params);
  };
  const authority = {
    assert() {
      assert.equal(open, true, "guardian_closed");
    },
    async fence() {
      assert.equal(open, true, "guardian_closed");
    },
  };
  const s = await openSupervisor(config(), { ...f.options, executionAuthority: authority });
  t.after(() => s.close());
  const pending = s.command(ensure);
  await started;
  open = false;
  release();
  await assert.rejects(pending, /guardian_closed/);
  assert.equal(s.snapshot("project").phase, "creation-uncertain");
  assert.equal(s.snapshot("project").threadId, null);
  await assert.rejects(s.command(ensure), /guardian_closed/);
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
});

test("guardian close barrier revokes input before awaiting fixed owned CLI cleanup", async (t) => {
  const f = fixture(t);
  const s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  await s.command(prompt);
  await s.command({ operation: "attach", projectId: "project" });
  let revoked = false,
    release;
  s.onRevoked(() => {
    revoked = true;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  f.runtime.detach = async (projectId) => {
    assert.equal(projectId, "project");
    assert.equal(revoked, true);
    await gate;
  };
  const barrier = { barrierId: randomUUID() };
  const closing = s.closeAdmission(barrier);
  assert.equal(revoked, true);
  assert.equal(s.state.status, "revoked");
  assert.deepEqual(s.state.guardianBarrier, barrier);
  assert.throws(() => s.binding("project"), /session_not_available/);
  release();
  await closing;
  assert.equal(
    f.runtime.alive(),
    true,
    "native exit belongs to guardian receipt, not inner barrier",
  );
});

test("positive manager receipt arriving after guardian closure cannot be returned to the native model", async (t) => {
  const f = fixture(t);
  let installed,
    open = true,
    release,
    entered;
  const waiting = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  f.runtime.setManagerAdapter = (adapter) => {
    installed = adapter;
  };
  const executionAuthority = {
    assert() {
      assert.equal(open, true, "guardian_closed");
    },
    async fence() {
      assert.equal(open, true, "guardian_closed");
    },
  };
  const s = await openSupervisor(config(), { ...f.options, executionAuthority });
  t.after(() => s.close());
  s.setManagerAdapter({
    tools: () => [],
    handleToolCall: async () => {
      entered();
      await gate;
      return {
        success: true,
        contentItems: [{ type: "inputText", text: "fixture reservation receipt" }],
      };
    },
  });
  await s.command(ensure);
  const result = installed.handleToolCall({
    threadId: "thread-one",
    turnId: "turn-one",
    callId: "call-one",
  });
  await waiting;
  open = false;
  release();
  await assert.rejects(result, /guardian_closed/);
});

test("durable source barrier uses exact native history after execution closes and retains read binding", async (t) => {
  const f = await progressionSupervisor(t),
    s = f.supervisor;
  f.runtime.readSourceApplication = async (_scope, method, params) =>
    f.runtime.call(method, params);
  f.runtime.inspectCliInputs = () => ({ projectId: "project", activeCli: 0, unknownInputs: 0 });
  const application = {
    projectId: "project",
    applicationId: randomUUID(),
    publicationOperationId: randomUUID(),
    targetSourceContext: { revisionId: randomUUID(), version: 1, headSha: "b".repeat(40) },
    expectedAppliedSourceContext: null,
    barrier: { id: randomUUID(), generation: 1 },
  };
  const scope = s.beginSourceApplication(f.request, application);
  assert.throws(() => s.assertSourceInputOpen(), /input_closed/);
  await assert.rejects(s.continueDeliveryRoot(f.request), /input_closed/);
  const readBinding = s.binding("project");
  assert.equal(readBinding.threadId, "thread-one");
  const closed = await s.closeSourceApplicationInputs(f.request, scope, async () => ({
    projectId: "project",
    closed: true,
    activeTerminals: 0,
    helpersPendingClose: 0,
    pendingInputs: 0,
    unknownInputs: 0,
  }));
  assert.equal(closed.barrier.rootCompleted, true);
  assert.equal(closed.boundary.rootTurns, 1);
  assert.equal(closed.barrier.pendingCommands, 0);
  assert.equal(closed.phase, "closing");
  const originalBarrier = structuredClone(s.state.projects.project.sourceApplication.barrier);
  s.state.projects.project.sourceApplication.sourceObservation = {
    sourceJournalDigest: "c".repeat(64),
  };
  s.save();
  await s.closeSourceApplicationInputs(f.request, scope, async () => ({
    projectId: "project",
    closed: true,
    activeTerminals: 0,
    helpersPendingClose: 0,
    pendingInputs: 0,
    unknownInputs: 0,
  }));
  assert.deepEqual(s.state.projects.project.sourceApplication.barrier, originalBarrier);
  assert.equal(
    s.state.projects.project.sourceApplication.lastInputVerification.historyDigest,
    closed.boundary.historyDigest,
  );
  assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
  const record = JSON.parse(
    readFileSync(join(f.home, ".local/state/hive/codex-project-supervisor/registry.json"), "utf8"),
  );
  assert.equal(record.state.projects.project.sourceApplication.barrier.closed, true);
  f.history.push({ id: "unexpected", status: "inProgress", itemsView: "full", items: [] });
  await assert.rejects(
    s.readDeliveryBoundary(f.request, { sourceScope: scope }),
    /root_not_completed/,
  );
  assert.throws(() => s.assertSourceInputOpen(), /input_closed/);
  await s.close();
  let relaunched = 0;
  await assert.rejects(
    openSupervisor(config(), {
      home: f.home,
      runtimeFactory: async () => {
        relaunched++;
        throw new Error("must not launch");
      },
    }),
    /input_closed/,
  );
  assert.equal(relaunched, 0);
});

test("independent plan finishes before the first manager input without changing original digest", async (t) => {
  const f = fixture(t),
    s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  let release;
  const waiting = new Promise((r) => (release = r));
  s.config.acceptance = { fixture: true };
  s.setAcceptanceRuntime({
    closeAdmission() {},
    async beforeFirstPrompt(thread) {
      assert.equal(thread, "thread-one");
      await waiting;
      return {
        planDigest: "e".repeat(64),
        plan: { requirements: [{ id: "acceptance:behavior", meaning: "fixture scope" }] },
      };
    },
  });
  const pending = s.command(prompt);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.equal(s.state.projects.project.firstPrompt, undefined);
  release();
  await pending;
  const turn = f.calls.find((c) => c.method === "turn/start");
  assert.equal(turn.params.input[0].text, prompt.text);
  assert.match(turn.params.input[1].text, /acceptance:behavior/);
  assert.equal(
    s.state.projects.project.firstPrompt.digest,
    createHash("sha256").update(prompt.text).digest("hex"),
  );
});
test("native revocation during independent plan cannot start manager inference", async (t) => {
  const f = fixture(t),
    s = await openSupervisor(config(), f.options);
  t.after(() => s.close());
  await s.command(ensure);
  let release;
  const waiting = new Promise((r) => (release = r));
  s.config.acceptance = { fixture: true };
  s.setAcceptanceRuntime({
    closeAdmission() {},
    async beforeFirstPrompt() {
      await waiting;
      return { planDigest: "e".repeat(64), plan: {} };
    },
  });
  const pending = s.command(prompt);
  await new Promise((r) => setImmediate(r));
  f.runtime.die();
  release();
  await assert.rejects(pending);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.equal(s.state.projects.project.firstPrompt, undefined);
});
