import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
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
  const server = createServer((req, res) => {
    let input = "";
    req.on("data", (chunk) => {
      input += chunk;
    });
    req.on("end", () => {
      requests.push(input);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
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
  await s.close();
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
  assert.equal(existsSync(f.checkout), false, "read rejoin must not recreate checkout");
  await assert.rejects(restarted.command({ operation: "attach", projectId: "project" }));
  assert.equal(requests.length, 1, "history rejoin must not invoke the provider again");
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
