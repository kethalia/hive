import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import { NATIVE_PROFILE } from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";
import {
  processIdentity,
  processParentPid,
} from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import {
  launchNative,
  openSupervisor,
  validateSupervisorConfig,
} from "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs";

const nativeEnabled = process.env.HIVE_TEST_NATIVE_CODEX === "1";
const executable = nativeEnabled
  ? realpathSync(
      process.env.HIVE_TEST_CODEX_EXECUTABLE ??
        "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    )
  : "/fixture/codex";
const executableDigest = nativeEnabled
  ? createHash("sha256").update(readFileSync(executable)).digest("hex")
  : "0".repeat(64);
const projectId = randomUUID();
const config = () => ({
  schemaVersion: 1,
  profile: "software",
  ownerId: "owner",
  workspaceId: "workspace",
  buildId: "build",
  codexExecutable: executable,
  codexSha256: executableDigest,
  executionMode: "isolated",
  projects: [
    {
      projectId,
      repositoryId: "123",
      taskId: "task",
      leaseId: "lease",
      leaseGeneration: 1,
      model: "gpt-6.1-sol",
      effort: "low",
    },
  ],
});
test("isolated execution is an explicit configuration mode", () => {
  assert.equal(validateSupervisorConfig(config()).executionMode, "isolated");
  assert.throws(() => validateSupervisorConfig({ ...config(), executionMode: "auto" }));
  const direct = config();
  delete direct.executionMode;
  assert.equal(validateSupervisorConfig(direct).executionMode, undefined);
});
test("actual isolated native WS protects token and same-thread CLI/history with exact wrapper identity", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 30000,
}, async (t) => {
  assert.ok(
    !realpathSync(process.cwd()).startsWith("/tmp/"),
    "Run the actual real-home probe from a task checkout outside /tmp; native skips alias creation under /tmp.",
  );
  const home = mkdtempSync(join(process.cwd(), ".nh-"));
  const managed = join(home, "projects/.hive-managed");
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  const checkout = join(managed, "github/123/checkout");
  mkdirSync(checkout, { recursive: true, mode: 0o700 });
  const sibling = join(managed, "github/456/checkout");
  mkdirSync(sibling, { recursive: true, mode: 0o700 });
  writeFileSync(join(sibling, "other-project"), "SYNTHETIC_OTHER_PROJECT");
  const requests = [];
  const observations = [];
  const served = new Set();
  let rootThreadId;
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      requests.push(JSON.parse(raw));
      let item = {
        id: `message_${requests.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "NAMESPACE_LOCAL_REPLY", annotations: [] }],
      };
      const body = requests.at(-1),
        lastUser = [...(body.input ?? [])].reverse().find((value) => value.role === "user");
      const marker =
        req.headers["x-codex-parent-thread-id"] === rootThreadId && rootThreadId
          ? "NAMESPACE_CHILD_COMMAND"
          : JSON.stringify(lastUser).match(
              /NAMESPACE_(ROOT_COMMAND|WORKDIR|SPAWN|CHILD_COMMAND|RESUMED_COMMAND)/,
            )?.[0];
      if (
        marker &&
        !String(JSON.stringify(lastUser)).includes("Generate a concise, single-line task title") &&
        !served.has(marker)
      ) {
        served.add(marker);
        const secret = join(home, ".local/state/hive/codex-project-supervisor/native-token");
        const protectedPaths = [
          secret,
          join(sibling, "other-project"),
          join(checkout, "token-alias"),
          join(home, ".local/share/hive/codex-native/codex/config.toml"),
          join(home, ".local/share/hive/codex-native/codex/auth.json"),
          "/etc/codex/requirements.toml",
          `/proc/${native.processIdentity.pid}/root${secret}`,
          `/proc/${native.processIdentity.pid}/environ`,
          `/proc/${native.processIdentity.pid}/fd/3`,
          `/proc/${process.pid}/environ`,
          `/proc/${process.pid}/fd/${authorityFd}`,
        ];
        const code = `import sys,json,socket; from pathlib import Path; Path(${JSON.stringify(join(checkout, "positive-control"))}).write_text('ok')\nfor path in json.loads(sys.argv[1]):\n try: Path(path).read_bytes()\n except (PermissionError,FileNotFoundError): continue\n raise SystemExit('PROTECTED_READ_ALLOWED')\nfor path in json.loads(sys.argv[1])[:4]:\n try: Path(path).write_text('SYNTHETIC_WRITE')\n except (PermissionError,FileNotFoundError,OSError): continue\n raise SystemExit('PROTECTED_WRITE_ALLOWED')\ntry: socket.create_connection(('127.0.0.1',${server.address().port}),timeout=1); raise SystemExit('NETWORK_ALLOWED')\nexcept (PermissionError,OSError): pass\nprint('NAMESPACE_COMMAND_DENIED')`;
        item =
          marker === "NAMESPACE_SPAWN"
            ? {
                id: `fc_${requests.length}`,
                type: "function_call",
                namespace: "collaboration",
                name: "spawn_agent",
                call_id: `call_${requests.length}`,
                arguments: JSON.stringify({
                  task_name: "namespace_fixture",
                  message: "NAMESPACE_CHILD_COMMAND",
                  fork_turns: "none",
                  model: "gpt-6.1-sol",
                  reasoning_effort: "low",
                }),
                status: "completed",
              }
            : {
                id: `fc_${requests.length}`,
                type: "function_call",
                namespace: "functions",
                name: "exec_command",
                call_id: `call_${requests.length}`,
                arguments: JSON.stringify({
                  cmd: `/usr/bin/python3 -I -c '${code.replaceAll("'", "'\\''")}' '${JSON.stringify(protectedPaths)}'`,
                  ...(marker === "NAMESPACE_WORKDIR" ? { workdir: "/" } : {}),
                  login: false,
                  max_output_tokens: 1000,
                }),
                status: "completed",
              };
      }
      if (requests.length === 1) await new Promise((resolve) => setTimeout(resolve, 2000));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: `response_${requests.length}`, status: "in_progress", output: [] },
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
            id: `response_${requests.length}`,
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
  const nativeHome = join(home, ".local/share/hive/codex-native/codex");
  mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  const syntheticAuth = Buffer.from("{}\n");
  writeFileSync(join(nativeHome, "auth.json"), syntheticAuth, { mode: 0o600 });
  let native, supervisor, authorityFd;
  t.after(async () => {
    await supervisor?.close();
    if (authorityFd !== undefined) closeSync(authorityFd);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const options = {
    home,
    runtimeFactory: async (args) => {
      native = await launchNative({
        ...args,
        fixtureProvider: { baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
      });
      native.setManagerAdapter({ observe: (notification) => observations.push(notification) });
      native.inspectLease = (p) => ({
        ok: true,
        data: {
          status: "ready",
          checkoutVerified: true,
          checkoutDirectory: checkout,
          lease: {
            id: p.leaseId,
            taskId: p.taskId,
            generation: p.leaseGeneration,
            expiresAt: Date.now() / 1000 + 3600,
          },
        },
      });
      return native;
    },
  };
  supervisor = await openSupervisor(config(), options);
  const identity = supervisor.state.executionIdentity;
  assert.equal(identity.mode, "isolated");
  assert.equal(processParentPid(identity.wrapper.pid), process.pid);
  assert.equal(processParentPid(identity.native.pid), identity.monitor.pid);
  assert.deepEqual(processIdentity(identity.native.pid), supervisor.state.nativeProcess);
  const secret = join(supervisor.stateDirectory, "native-token");
  authorityFd = openSync(secret, "r");
  symlinkSync(secret, join(checkout, "token-alias"));
  const denied = await native.call("command/exec", {
    command: [
      "/usr/bin/python3",
      "-I",
      "-c",
      "import sys;\ntry: open(sys.argv[1]).read(); print('LEAK')\nexcept PermissionError: print('DENIED')",
      secret,
    ],
    cwd: checkout,
    permissionProfile: NATIVE_PROFILE,
  });
  assert.equal(denied.exitCode, 0);
  assert.equal(denied.stdout.trim(), "DENIED");
  await assert.rejects(
    native.call("command/exec", {
      command: ["/usr/bin/true"],
      cwd: checkout,
      sandboxPolicy: { type: "dangerFullAccess" },
    }),
  );
  const created = await supervisor.command({
    operation: "ensureProject",
    projectId,
    creationIntentId: "intent",
  });
  rootThreadId = created.threadId;
  let firstPromptError = null,
    lastRefreshError = null;
  await supervisor
    .command({
      operation: "firstPrompt",
      projectId,
      requestId: randomUUID(),
      text: "Actual local mock fixture only",
    })
    .catch((error) => {
      firstPromptError = error.message;
    });
  // A persisted user item does not mean the provider's answer has completed.
  // Wait on the actual turn event, then reconcile history within a bounded deadline.
  const firstTurnDeadline = Date.now() + 10000;
  let completedFirstTurn;
  while (Date.now() < firstTurnDeadline) {
    completedFirstTurn = observations.find(
      (value) => value.method === "turn/completed" && value.params.threadId === created.threadId,
    );
    if (completedFirstTurn) {
      assert.equal(
        completedFirstTurn.params.turn.status,
        "completed",
        JSON.stringify(completedFirstTurn),
      );
      await supervisor.command({ operation: "refresh", projectId }).catch((error) => {
        lastRefreshError = error.message;
      });
      if (supervisor.snapshot(projectId).phase === "persisted") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    completedFirstTurn,
    JSON.stringify({
      firstPromptError,
      lastRefreshError,
      status: supervisor.state.status,
      alive: native.alive(),
      requestCount: requests.length,
    }),
  );
  assert.equal(
    supervisor.snapshot(projectId).phase,
    "persisted",
    JSON.stringify({
      firstPromptError,
      lastRefreshError,
      status: supervisor.state.status,
      alive: native.alive(),
    }),
  );
  assert.equal(supervisor.binding(projectId).threadId, created.threadId);
  await supervisor.command({ operation: "attach", projectId });
  let pane = "";
  const paintDeadline = Date.now() + 5000;
  while (Date.now() < paintDeadline) {
    pane = execFileSync(
      "/usr/bin/tmux",
      ["-S", join(supervisor.stateDirectory, "tmux.sock"), "capture-pane", "-p"],
      { encoding: "utf8" },
    );
    if (pane.includes("NAMESPACE_LOCAL_REPLY")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(pane, /NAMESPACE_LOCAL_REPLY/);
  assert.deepEqual((await native.call("thread/loaded/list", {})).data, [created.threadId]);
  assert.equal(requests.length, 1, "remote CLI must attach without starting inference");
  // Verify the installed Python authority against the real pinned three-edge
  // process chain, then reject missing/extra monitor identities in private fixtures.
  const expected = {
    repositoryId: "123",
    taskId: "task",
    leaseId: "lease",
    leaseGeneration: 1,
    revision: "a".repeat(40),
    checkoutIncarnation: "fixture",
  };
  const controllerDir = join(home, ".local/state/hive/codex-project-controller");
  mkdirSync(controllerDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(join(controllerDir, "projects.key"), key, { mode: 0o600 });
  const controller = {
    hostProcess: processIdentity(process.pid),
    ownerId: "owner",
    workspaceId: "workspace",
    projects: {
      [projectId]: {
        repositoryId: "123",
        task: {
          taskId: "task",
          phase: "running",
          nativeThreadId: created.threadId,
          nativeServerInstanceId: supervisor.state.serverInstanceId,
          checkoutIncarnation: "fixture",
          request: { revision: expected.revision },
          prepared: { repositoryId: "123", taskId: "task", leaseId: "lease", leaseGeneration: 1 },
        },
      },
    },
  };
  const signed = (state, k) =>
    JSON.stringify({
      state,
      signature: createHmac("sha256", k).update(JSON.stringify(state)).digest("hex"),
    });
  writeFileSync(join(controllerDir, "projects.json"), signed(controller, key), { mode: 0o600 });
  const authority = () =>
    execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        "import importlib.util,json,os,sys; s=importlib.util.spec_from_file_location('fixture',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); v=json.load(sys.stdin); m.InstalledControllerAuthority(v['home'],os.getppid()).verify(v['projectId'],v['expected'])",
        join(process.cwd(), "templates/ai-dev-k8s/scripts/codex-project-lease.py"),
      ],
      { input: JSON.stringify({ home, projectId, expected }), stdio: ["pipe", "pipe", "pipe"] },
    );
  authority();
  const registryPath = join(supervisor.stateDirectory, "registry.json"),
    savedRegistry = readFileSync(registryPath),
    registryKey = readFileSync(join(supervisor.stateDirectory, "key"));
  for (const mutation of [
    (value) => {
      delete value.monitor;
    },
    (value) => {
      value.extraMonitor = value.monitor;
    },
    (value) => {
      value.monitor = value.wrapper;
    },
    (value) => {
      value.native = { ...value.native, startTime: "0" };
    },
  ]) {
    const state = JSON.parse(savedRegistry).state;
    mutation(state.executionIdentity);
    writeFileSync(registryPath, signed(state, registryKey));
    assert.throws(authority);
  }
  writeFileSync(registryPath, savedRegistry);
  authority();
  const runFixtureTurn = async (marker) => {
    const { turn } = await native.call("turn/start", {
      threadId: created.threadId,
      input: [{ type: "text", text: marker, text_elements: [] }],
      permissions: NATIVE_PROFILE,
    });
    for (let n = 0; n < 200; n++) {
      const done = observations.find(
        (value) =>
          value.method === "turn/completed" &&
          value.params.threadId === created.threadId &&
          value.params.turn.id === turn.id,
      );
      if (done) {
        assert.equal(done.params.turn.status, "completed", JSON.stringify(done));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("fixture turn timed out");
  };
  await runFixtureTurn("NAMESPACE_ROOT_COMMAND");
  await runFixtureTurn("NAMESPACE_WORKDIR");
  await runFixtureTurn("NAMESPACE_SPAWN");
  const deniedOutputs = () =>
    requests
      .flatMap((body) => body.input ?? [])
      .filter(
        (value) =>
          value.type === "function_call_output" &&
          String(value.output).includes("NAMESPACE_COMMAND_DENIED"),
      );
  for (let n = 0; n < 150 && new Set(deniedOutputs().map((value) => value.call_id)).size < 3; n++)
    await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(served.has("NAMESPACE_CHILD_COMMAND"), "actual native child request observed");
  assert.equal(
    new Set(deniedOutputs().map((value) => value.call_id)).size,
    3,
    "root, hostile cwd and child commands inherit token deny policy",
  );
  assert.equal(readFileSync(join(checkout, "positive-control"), "utf8"), "ok");
  const beforeRestart = requests.length;
  await supervisor.close();
  rmSync(checkout, { recursive: true });
  assert.throws(() => processIdentity(identity.native.pid));
  supervisor = await openSupervisor(config(), options);
  const rejoined = await supervisor.command({ operation: "rejoin", projectId });
  assert.equal(rejoined.threadId, created.threadId);
  assert.equal(rejoined.phase, "persisted");
  assert.equal(requests.length, beforeRestart);
  mkdirSync(checkout, { mode: 0o700 });
  symlinkSync(secret, join(checkout, "token-alias"));
  const override = await native.call("thread/resume", {
    threadId: created.threadId,
    excludeTurns: true,
    permissions: ":danger-full-access",
  });
  assert.equal(override.activePermissionProfile.id, NATIVE_PROFILE);
  await assert.rejects(
    native.call("turn/start", {
      threadId: created.threadId,
      input: [{ type: "text", text: "rejected without inference", text_elements: [] }],
      permissions: ":danger-full-access",
    }),
  );
  await runFixtureTurn("NAMESPACE_RESUMED_COMMAND");
  assert.equal(
    new Set(deniedOutputs().map((value) => value.call_id)).size,
    4,
    "resumed command retains all denial checks",
  );
  assert.deepEqual(readFileSync(join(nativeHome, "auth.json")), syntheticAuth);
  assert.ok(
    readFileSync(join(home, ".local/share/hive/codex-native/codex/config.toml"), "utf8").includes(
      "hive_local_fixture",
    ),
  );
});

const waitGone = async (identity) => {
  for (let n = 0; n < 100; n++) {
    try {
      processIdentity(identity.pid);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`fixture process ${identity.pid} remained alive`);
};
test("actual wrapper, monitor and host crashes terminate pinned native and release inherited lock", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 30000,
}, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "hive-native-crash-"));
  mkdirSync(join(home, "projects/.hive-managed"), { recursive: true, mode: 0o700 });
  let supervisor, host;
  t.after(async () => {
    host?.kill("SIGKILL");
    await supervisor?.close();
    rmSync(home, { recursive: true, force: true });
  });
  const runtimeFactory = (args) =>
    launchNative({ ...args, fixtureProvider: { baseUrl: "http://127.0.0.1:9/v1" } });
  for (const role of ["wrapper", "monitor"]) {
    supervisor = await openSupervisor(config(), { home, runtimeFactory });
    const identity = supervisor.state.executionIdentity;
    process.kill(identity[role].pid, "SIGKILL");
    await Promise.all([identity.wrapper, identity.monitor, identity.native].map(waitGone));
    await supervisor.close();
    supervisor = null;
  }
  const modulePath = new URL(
    "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
    import.meta.url,
  ).href;
  const code = `import {openSupervisor,launchNative} from ${JSON.stringify(modulePath)};const supervisor=await openSupervisor(${JSON.stringify(config())},{home:${JSON.stringify(home)},runtimeFactory:args=>launchNative({...args,fixtureProvider:{baseUrl:"http://127.0.0.1:9/v1"}})});process.stdout.write(JSON.stringify(supervisor.state.executionIdentity)+"\\n");setInterval(()=>{},1000);`;
  host = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identity = await new Promise((resolve, reject) => {
    let out = "",
      error = "";
    host.stderr.on("data", (chunk) => {
      error += chunk;
    });
    host.once("exit", () => reject(new Error(`fixture host exited: ${error}`)));
    host.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.trim()));
    });
  });
  host.kill("SIGKILL");
  await Promise.all([identity.wrapper, identity.monitor, identity.native].map(waitGone));
  supervisor = await openSupervisor(config(), { home, runtimeFactory });
  assert.equal(
    supervisor.state.executionIdentity.mode,
    "isolated",
    "kernel lock released after abrupt host death",
  );
});
