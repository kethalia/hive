#!/usr/bin/env node
// Local canned response only. Subreaper compatibility proof; never packaged.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import {
  NATIVE_PINS,
  NATIVE_PROFILE,
  prepareNativeNamespace,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";

assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1");
assert.ok(!realpathSync(process.cwd()).startsWith("/tmp/"));
const home = mkdtempSync(join(process.cwd(), ".sr-"));
const fixture = join(home, "subreaper");
execFileSync(
  "/usr/bin/cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "scripts/probe-native-subreaper.c",
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
  const child = spawn(fixture, ["--native-fixture", ...command], {
    env: ns.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let ws,
    sequence = 0,
    supervisorOutput = "";
  let nativeStderr = "";
  child.stderr.on("data", (v) => {
    nativeStderr = (nativeStderr + v).slice(-8192);
  });
  child.stdout.on("data", (v) => {
    supervisorOutput += v;
    assert.ok(supervisorOutput.length < 4096);
  });
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
      if (child.exitCode !== null) throw new Error("native_exited");
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
    for (const p of pending.values()) clearTimeout(p.timer);
    ws?.terminate();
    child.stdin.end("D");
    for (let n = 0; n < 600 && child.exitCode === null && child.signalCode === null; n++)
      await delay(10);
    assert.equal(child.exitCode, 0, "subreaper did not drain its native lifetime");
    record.supervisor = supervisorOutput
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(record.supervisor.at(-1).finalEchild, true);
    record.wrapperExited = true;
    record.stderrCategories = [
      ["fixture_assertion", /fixture_assertion/],
      ["permission_denied", /permission denied|operation not permitted/i],
      ["address_conflict", /address already in use/i],
      ["missing_path", /no such file or directory/i],
      ["panic", /panicked/i],
      ["sandbox_mount", /bwrap:.*mount/i],
    ]
      .filter(([, pattern]) => pattern.test(nativeStderr))
      .map(([category]) => category);
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
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  if (
    report.runs.length > 0 &&
    report.runs.every((run) => run.wrapperExited && run.supervisor?.at(-1)?.finalEchild)
  ) {
    rmSync(home, { recursive: true, force: true });
  } else {
    // Preserve owned state if failed drain leaves lifetime ownership uncertain.
    report.fixtureRetained = home;
  }
  report.sourceSha256 = Object.fromEntries(
    ["scripts/probe-native-subreaper.c", "scripts/probe-codex-subreaper.mjs"].map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
