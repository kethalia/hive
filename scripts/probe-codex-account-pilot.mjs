#!/usr/bin/env node
// Explicit dedicated test-workspace pilot. No automatic startup or imports by host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const archive = "94a6c97e26238cfb6904cdfca699863e22e472014dd296d6cef6fc3eeae0f2d8";
const nativePin = "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5";
const workspaceId = "22c4f094-46f0-4a76-86ca-37ad74254872",
  buildId = "ebafefde-23d7-46cb-948f-865a7c0fb464";
const repoId = "99000016520261029";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash("sha256").update(value).digest("hex");
export async function pilot() {
  assert.equal(process.env.HIVE_WORKSPACE_PROFILE, "software");
  const home = userInfo().homedir;
  assert.equal(home, "/home/coder");
  const hostConfigPath = join(home, ".config/hive/codex-host.json"),
    hostConfigBytes = readFileSync(hostConfigPath),
    hostConfig = JSON.parse(hostConfigBytes);
  assert.equal(hostConfig.binding.workspaceId, workspaceId);
  assert.equal(hostConfig.binding.buildId, buildId);
  assert.equal(hostConfig.nativeIsolationEnabled, true);
  assert.equal(hostConfig.managerEnabled, false);
  const packageDir = join(home, ".local/share/hive/codex-host", archive),
    manifest = JSON.parse(readFileSync(join(packageDir, "package-manifest.json")));
  for (const [name, sha] of Object.entries(manifest.files))
    assert.equal(digest(readFileSync(join(packageDir, name))), sha);
  const executable = join(
    home,
    ".local/share/hive/codex-runtime/0.165.0-linux-x64-c06a67fd8ac76508/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  assert.equal(realpathSync(executable), executable);
  assert.equal(digest(readFileSync(executable)), nativePin);
  // Only process metadata for this exact pinned ELF is inspected; no auth contents.
  for (const pid of readdirSync("/proc").filter((v) => /^\d+$/.test(v))) {
    try {
      if (realpathSync(`/proc/${pid}/exe`) === executable)
        assert.ok(
          !readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("app-server"),
          "existing pinned native app-server",
        );
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    }
  }
  const official = join(home, ".local/state/hive/codex-project-supervisor/registry.json");
  assert.ok(!existsSync(official), "official supervisor already initialized");
  const fixtureRoot = join(home, "projects/.hive-managed/github", repoId),
    stateDirectory = join(home, ".local/state/hive", `native-account-pilot-${randomUUID()}`);
  assert.ok(!existsSync(fixtureRoot), "fixture must be newly created");
  const parent = join(home, "projects/.hive-managed/github");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(parent), parent);
  mkdirSync(fixtureRoot, { mode: 0o700 });
  const checkout = join(fixtureRoot, "checkout");
  mkdirSync(checkout, { mode: 0o700 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  const receipt = {
    schemaVersion: 1,
    task: "bounded-native-account-pilot",
    workspaceId,
    buildId,
    archive,
    fixtureRoot,
    checkout,
    stateDirectory,
    createdAt: new Date().toISOString(),
    fixtureInode: String(lstatSync(fixtureRoot).ino),
    fixtureDevice: String(lstatSync(fixtureRoot).dev),
  };
  writeFileSync(join(stateDirectory, "receipt.json"), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  const lock = openSync(
    join(stateDirectory, "pilot.lock"),
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600,
  );
  execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "ignore", lock],
    timeout: 2000,
  });
  const { launchNative } = await import(
    pathToFileURL(join(packageDir, "codex-project-supervisor.mjs"))
  );
  const report = {
    ...receipt,
    accountInferenceAuthorized: true,
    accountInferenceStarted: false,
    productionDeliveryClaim: false,
    quiescenceClaim: false,
    events: [],
    commands: [],
    spawns: [],
    children: [],
    passed: false,
  };
  let runtime,
    deadline,
    rootThreadId,
    stopReason,
    watchdog,
    finished = false;
  const save = () =>
    writeFileSync(join(stateDirectory, "result.json"), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  const stop = async (reason) => {
    if (!stopReason) stopReason = reason;
    await runtime?.close();
  };
  try {
    runtime = await launchNative({
      home,
      stateDirectory,
      lock,
      config: { codexExecutable: executable, codexSha256: nativePin, executionMode: "isolated" },
    });
    report.executionIdentity = runtime.executionIdentity;
    runtime.setManagerAdapter({
      observe({ method, params }) {
        if (
          method === "rawResponseItem/completed" &&
          params.item?.type === "function_call" &&
          params.item.namespace === "collaboration" &&
          params.item.name === "spawn_agent"
        ) {
          let args;
          try {
            args = JSON.parse(params.item.arguments);
          } catch {
            void stop("malformed_spawn");
            return;
          }
          report.spawns.push({
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.item.call_id,
            model: args.model,
            effort: args.reasoning_effort,
          });
          if (
            report.spawns.length > 1 ||
            params.threadId !== rootThreadId ||
            args.model !== "gpt-6.1-sol" ||
            args.reasoning_effort !== "low"
          )
            void stop("spawn_bound_exceeded");
        }
        if (
          method === "item/completed" &&
          params.item?.type === "subAgentActivity" &&
          params.item.kind === "started"
        ) {
          const item = params.item;
          report.children.push({
            parentThreadId: params.threadId,
            callId: item.id,
            threadId: item.agentThreadId,
            model: item.model,
            effort: item.reasoningEffort,
          });
          if (report.children.length > 1) void stop("child_bound_exceeded");
        }
        if (method === "item/completed" && params.item?.type === "commandExecution")
          report.commands.push({
            threadId: params.threadId,
            turnId: params.turnId,
            command: params.item.command,
            cwd: params.item.cwd,
            exitCode: params.item.exitCode,
            status: params.item.status,
            output: String(params.item.aggregatedOutput ?? "").slice(0, 16000),
          });
        if (method === "turn/started" || method === "turn/completed")
          report.events.push({
            method,
            threadId: params.threadId,
            turnId: params.turn?.id,
            status: params.turn?.status,
            error: params.turn?.error ?? null,
          });
        save();
      },
    });
    const catalog = await runtime.call("model/list", { limit: 100, includeHidden: false });
    assert.equal(catalog.nextCursor, null);
    report.catalog = catalog.data.map((model) => ({
      id: model.id,
      model: model.model,
      efforts: model.supportedReasoningEfforts.map((value) => value.reasoningEffort),
      multiAgentVersion: model.multiAgentVersion,
    }));
    const selected = catalog.data.find((model) => model.model === "gpt-6.1-sol");
    assert.ok(selected, "requested Sol unavailable; no fallback");
    assert.ok(selected.supportedReasoningEfforts.some((value) => value.reasoningEffort === "low"));
    report.requested = { model: "gpt-6.1-sol", effort: "low", maxConcurrentChildren: 1 };
    save();
    process.stdout.write(
      `${JSON.stringify({
        phase: "catalogVerified",
        stateDirectory,
        fixtureRoot,
        selected: report.requested,
        catalog: report.catalog,
      })}\n`,
    );
    const start = await runtime.call("thread/start", {
      model: "gpt-6.1-sol",
      allowProviderModelFallback: false,
      cwd: checkout,
      approvalPolicy: "never",
      permissions: "hive-native-isolated",
      experimentalRawEvents: true,
      config: {
        model_reasoning_effort: "low",
        "agents.max_concurrent_threads_per_session": 1,
        "agents.default_subagent_model": "gpt-6.1-sol",
        "agents.default_subagent_reasoning_effort": "low",
      },
      developerInstructions:
        "This is a bounded integration fixture. Spawn exactly one child with model gpt-6.1-sol and reasoning_effort low. No other children, agent closure/replacement, network, dependencies, git commands, or files outside the current checkout. Stop after the child implementation and one independent root test run.",
    });
    rootThreadId = start.thread.id;
    report.root = {
      threadId: rootThreadId,
      model: start.model,
      effort: start.reasoningEffort,
      activePermissionProfile: start.activePermissionProfile?.id,
    };
    assert.equal(start.model, "gpt-6.1-sol");
    assert.equal(start.reasoningEffort, "low");
    assert.equal(start.activePermissionProfile?.id, "hive-native-isolated");
    const prompt =
      "Spawn exactly one child using collaboration.spawn_agent with task_name interval_fixture, fork_turns none, model gpt-6.1-sol, reasoning_effort low. Give it this bounded task: in the current checkout only, write intervals.py defining merge_intervals(intervals) for closed integer ranges. Return sorted merged (start,end) tuples; merge overlap and adjacency; empty input returns []; reject reversed endpoints with ValueError; do not mutate input. Write test_intervals.py using only Python unittest with six cases: empty, unsorted overlap, adjacency, separated ranges, reversed endpoints, and input unchanged. Run python3 -m unittest -v. Do not spawn children or install anything. Wait for that single child, inspect its two files, then independently run python3 -m unittest -v once from this checkout. Report the result and finish. Do not create any other files, sessions or agents. No network, git, package installation or external writes.";
    report.firstPromptAttempted = true;
    report.accountInferenceStarted = true;
    report.startedAt = new Date().toISOString();
    save();
    deadline = Date.now() + 300000;
    watchdog = setTimeout(() => {
      void stop("five_minute_deadline");
    }, 300000);
    const turn = await runtime.call("turn/start", {
      threadId: rootThreadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: "gpt-6.1-sol",
      effort: "low",
    });
    report.root.turnId = turn.turn.id;
    save();
    while (Date.now() < deadline && !stopReason) {
      const rootDone = report.events.some(
        (e) =>
          e.method === "turn/completed" &&
          e.threadId === rootThreadId &&
          e.turnId === turn.turn.id &&
          e.status === "completed",
      );
      const child = report.children[0];
      const childDone =
        child &&
        report.events.some(
          (e) =>
            e.method === "turn/completed" &&
            e.threadId === child.threadId &&
            e.status === "completed",
        );
      if (rootDone && childDone) break;
      await pause(500);
    }
    assert.ok(!stopReason, stopReason);
    assert.ok(Date.now() < deadline, "pilot_deadline");
    assert.equal(report.spawns.length, 1);
    assert.equal(report.children.length, 1);
    assert.equal(report.children[0].model, "gpt-6.1-sol");
    assert.equal(report.children[0].effort, "low");
    for (const threadId of [rootThreadId, report.children[0].threadId]) {
      const data = await runtime.call("thread/turns/list", {
        threadId,
        limit: 10,
        itemsView: "full",
      });
      assert.equal(data.nextCursor, null);
      writeFileSync(
        join(
          stateDirectory,
          threadId === rootThreadId ? "root-history.json" : "child-history.json",
        ),
        JSON.stringify(data, null, 2),
        { mode: 0o600 },
      );
    }
    const tests = report.commands.filter(
      (value) => value.command?.includes("unittest") && value.exitCode === 0,
    );
    assert.ok(tests.some((value) => value.threadId === rootThreadId));
    assert.ok(tests.some((value) => value.threadId === report.children[0].threadId));
    for (const name of ["intervals.py", "test_intervals.py"]) {
      const path = join(checkout, name);
      assert.equal(realpathSync(path), path);
      assert.ok(lstatSync(path).size < 32768);
    }
    assert.deepEqual(readFileSync(hostConfigPath), hostConfigBytes);
    assert.ok(!existsSync(official));
    report.passed = true;
    finished = true;
  } catch (error) {
    report.error = stopReason ?? String(error.message).slice(0, 800);
  } finally {
    clearTimeout(watchdog);
    await runtime?.close();
    closeSync(lock);
    report.finishedAt = new Date().toISOString();
    report.runtimeStopped = true;
    save();
    process.stdout.write(
      `${JSON.stringify({
        phase: "finished",
        stateDirectory,
        fixtureRoot,
        passed: report.passed,
        error: report.error ?? null,
        root: report.root ?? null,
        children: report.children,
        commandCount: report.commands.length,
      })}\n`,
    );
  }
  return finished;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3);
  assert.equal(process.argv[2], "--authorized-test-workspace");
  process.exitCode = (await pilot()) ? 0 : 2;
}
