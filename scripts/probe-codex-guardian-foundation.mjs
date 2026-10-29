#!/usr/bin/env node
// Local canned response only. Standalone installed guardian foundation proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import { openNativeGuardian } from "../templates/ai-dev-k8s/scripts/codex-native-guardian.mjs";
import {
  NATIVE_PINS,
  NATIVE_PROFILE,
  prepareNativeNamespace,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";

assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1");
assert.ok(!realpathSync(process.cwd()).startsWith("/tmp/"));
const home = mkdtempSync(join(process.cwd(), ".gf-"));
const fixture = join(home, "subreaper");
execFileSync(
  "/usr/bin/cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "templates/ai-dev-k8s/scripts/codex-native-guardian.c",
    "-o",
    fixture,
  ],
  { stdio: "pipe" },
);
const began = Date.now();
const stateDirectory = join(home, ".local/state/hive/pilot");
const checkout = join(home, "projects/.hive-managed/github/990001/checkout");
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
mkdirSync(checkout, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("hex");
writeFileSync(join(stateDirectory, "native-token"), token, { mode: 0o600 });
const executable = realpathSync(
  process.env.HIVE_TEST_CODEX_EXECUTABLE ??
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
const requestTimes = [];
const provider = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  let raw = "";
  req.on("data", (v) => {
    raw += v;
    if (raw.length > 1048576) req.destroy();
  });
  req.on("end", () => {
    requests++;
    requestTimes.push(Date.now() - began);
    assert.equal(requests, 1, "only one canned response authorized");
    const item = {
      id: `message_${requests}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "SUBREAPER_PERSISTED_CONTROL", annotations: [] }],
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const value of [
      {
        type: "response.created",
        response: { id: `r_${requests}`, status: "in_progress", output: [] },
      },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `r_${requests}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ])
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    res.end();
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const ns = prepareNativeNamespace({
  home,
  stateDirectory,
  codexExecutable: executable,
  fixtureProvider: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1` },
});
const syntheticAuth = join(home, ".local/share/hive/codex-native/codex/auth.json");
writeFileSync(syntheticAuth, '{"fixture":"SYNTHETIC_AUTH_SENTINEL"}', { mode: 0o600 });
symlinkSync(ns.tokenPath, join(checkout, "token-alias"));
const report = {
  schemaVersion: 1,
  transport: "WebSocket",
  realHome: true,
  accountInference: false,
  productionChanged: false,
  runs: [],
  productionAuthority: false,
  nativePins: NATIVE_PINS,
  writerHoldsRetained: true,
};
let threadId;
async function run(mode) {
  const record = { mode, steps: [], error: null };
  report.runs.push(record);
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const endpoint = `ws://127.0.0.1:${port}`;
  const command = ns.command([
    "app-server",
    "--listen",
    endpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    ns.tokenPath,
  ]);
  const eventsJournal = [];
  const journal = Object.fromEntries(
    ["begin", "ready", "launchIntent", "closeIntent", "acceptReceipt", "indeterminate"].map(
      (name) => [
        name,
        async (value) => {
          eventsJournal.push({ name, value });
        },
      ],
    ),
  );
  const guardian = await openNativeGuardian({
    executable: fixture,
    sha256: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
    bindingDigest: "a".repeat(64),
    projects: [
      { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bindingDigest: "b".repeat(64) },
    ],
    roots: [
      {
        id: "native",
        role: "native",
        executable: command[0],
        sha256: NATIVE_PINS["codex-resources/bwrap"],
        args: command.slice(1),
        cwd: home,
        env: ns.env,
      },
    ],
    journal,
    authorizeDrain: async (binding) =>
      binding.projects.map((p) => ({ ...p, decisionId: randomUUID() })),
  });
  record.guardianIdentity = guardian.state.guardianIdentity;
  const root = await guardian.launch("native");
  record.rootPid = root.pid;
  let ws,
    sequence = 0;
  const pending = new Map(),
    events = [];
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout:${method}`));
        }, 7000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    const connectBegan = Date.now();
    while (Date.now() - connectBegan < 8000) {
      ws = await new Promise((resolve) => {
        const s = new WebSocket(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: 250,
        });
        s.once("open", () => resolve(s));
        s.once("error", () => {
          s.terminate();
          resolve(null);
        });
      });
      if (ws) break;
      if (guardian.state.phase !== "open") throw new Error("native_exited");
      await delay(25);
    }
    record.connectElapsedMs = Date.now() - connectBegan;
    assert.ok(ws, "socket_unavailable");
    ws.on("message", (raw) => {
      const v = JSON.parse(String(raw));
      if (v.method) {
        events.push(v);
        return;
      }
      const p = pending.get(v.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(v.id);
      v.error ? p.reject(new Error(`rpc:${v.error.code}`)) : p.resolve(v.result);
    });
    const initialized = await call("initialize", {
      clientInfo: { name: "hive_pid_ws_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    assert.match(initialized.userAgent, /\/0\.165\.0(?:\s|$)/);
    ws.send(JSON.stringify({ method: "initialized" }));
    record.steps.push("initialize");
    const requirements = await call("configRequirements/read", {});
    assert.equal(requirements.requirements.defaultPermissions, NATIVE_PROFILE);
    record.steps.push("requirements");
    // Resume first: earlier stdio evidence isolates this exact method as blocked.
    if (threadId) {
      const resumed = await call("thread/resume", {
        threadId,
        cwd: checkout,
        permissions: NATIVE_PROFILE,
        approvalPolicy: "never",
      });
      assert.equal(resumed.thread.id, threadId);
      record.steps.push("resume");
      assert.ok(JSON.stringify(resumed).includes("SUBREAPER_PERSISTED_CONTROL"));
      record.steps.push("history");
    } else {
      const started = await call("thread/start", {
        cwd: checkout,
        model: "gpt-6.1-sol",
        permissions: NATIVE_PROFILE,
        approvalPolicy: "never",
      });
      threadId = started.thread.id;
      record.steps.push("thread/start");
      const turn = await call("turn/start", {
        threadId,
        input: [{ type: "text", text: "Local mock persistence fixture.", text_elements: [] }],
      });
      for (
        let n = 0;
        n < 250 &&
        !events.some((e) => e.method === "turn/completed" && e.params.turn.id === turn.turn.id);
        n++
      )
        await delay(20);
      assert.ok(
        events.some((e) => e.method === "turn/completed" && e.params.turn.id === turn.turn.id),
      );
      record.steps.push("localMockTurn");
    }
    const execution = await call("command/exec", {
      cwd: checkout,
      permissionProfile: NATIVE_PROFILE,
      command: ["/usr/bin/printf", "WS_COMMAND_CONTROL"],
      timeoutMs: 2000,
      outputBytesCap: 100,
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.stdout, "WS_COMMAND_CONTROL");
    record.steps.push("command/exec");
    const denied = await call("command/exec", {
      cwd: checkout,
      permissionProfile: NATIVE_PROFILE,
      command: [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import sys\nfor p in sys.argv[1:]:\n try: open(p).read(); print('LEAK')\n except PermissionError: print('DENIED')",
        ns.tokenPath,
        syntheticAuth,
        join(checkout, "token-alias"),
        "/proc/self/environ",
      ],
      timeoutMs: 2000,
      outputBytesCap: 100,
    });
    assert.equal(denied.exitCode, 0);
    assert.equal(denied.stdout.trim(), "DENIED\nDENIED\nDENIED\nDENIED");
    record.steps.push("credential/proc/symlinkDenied");
    assert.equal(readFileSync(syntheticAuth, "utf8"), '{"fixture":"SYNTHETIC_AUTH_SENTINEL"}');
  } catch (error) {
    record.error = error.message;
  } finally {
    record.nativePhaseAtEnd = guardian.state.phase;
    record.localMockRequestsAtEnd = requests;
    record.eventCounts = Object.fromEntries(
      [...new Set(events.map((e) => e.method))].map((method) => [
        method,
        events.filter((e) => e.method === method).length,
      ]),
    );
    record.errorCategories = events
      .filter((e) => e.method === "error")
      .map((e) => ({
        willRetry: e.params?.willRetry === true,
        hasNativeCode: !!e.params?.error?.codexErrorInfo,
      }));
    for (const p of pending.values()) clearTimeout(p.timer);
    ws?.terminate();
    try {
      const receipt = await guardian.drain();
      record.receipt = receipt;
      record.wrapperExited = guardian.state.phase === "closed";
      record.journalOperations = eventsJournal.map((e) => e.name);
    } finally {
      await guardian.abort();
    }
  }
}
try {
  await run("freshStart");
  assert.equal(report.runs[0].error, null);
  await run("restartResume");
  assert.equal(report.runs[1].error, null);
  report.localMockRequests = requests;
  assert.equal(requests, 1);
  report.elapsedMs = Date.now() - began;
  assert.ok(report.elapsedMs < 45000);
} catch {
  report.failed = true;
  process.exitCode = 1;
} finally {
  report.localMockRequests = requests;
  report.requestTimesMs = requestTimes;
  report.elapsedMs = Date.now() - began;
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  if (
    report.runs.length > 0 &&
    report.runs.every((run) => run.wrapperExited && run.receipt?.finalWaitResult === "ECHILD")
  ) {
    rmSync(home, { recursive: true, force: true });
  } else {
    // Preserve owned state if failed drain leaves lifetime ownership uncertain.
    report.fixtureRetained = home;
  }
  report.sourceSha256 = Object.fromEntries(
    [
      "templates/ai-dev-k8s/scripts/codex-native-guardian.c",
      "templates/ai-dev-k8s/scripts/codex-native-guardian.mjs",
      "scripts/probe-codex-guardian-foundation.mjs",
    ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
