#!/usr/bin/env node
import assert from "node:assert/strict";
// Bounded, local-only protocol probe. No model turns, credentials, or existing sessions.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "hive-session-probe-"));
const codexHome = join(root, "codex");
const cwd = join(root, "project");
await mkdir(codexHome);
await mkdir(cwd);
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "SHELL", "LANG"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
Object.assign(env, { CODEX_HOME: codexHome, TERM: "xterm-256color" });
await writeFile(
  join(codexHome, "config.toml"),
  `model = "gpt-6.1-sol"
model_provider = "probe"
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.probe]
name = "Local no-inference probe"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
apps = false
plugins = false
memories = false
[analytics]
enabled = false
`,
);
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const endpoint = `ws://127.0.0.1:${reservation.address().port}`;
await new Promise((resolve) => reservation.close(resolve));
const tmuxSocket = join(root, "tmux.sock");
const children = [];
const sockets = [];
const evidence = {
  version: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  modelInferenceRequested: false,
};
let server;
let stderr = "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  console.error("Probe exceeded 60 seconds");
  cleanup().finally(() => process.exit(1));
}, 60_000);
function tmux(args) {
  return execFileSync("tmux", ["-S", tmuxSocket, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function cleanup() {
  clearTimeout(deadline);
  try {
    tmux(["kill-server"]);
  } catch {}
  for (const ws of sockets) ws.close();
  for (const p of children) p.kill("SIGTERM");
  server?.kill("SIGTERM");
  await sleep(150);
  for (const p of [...children, server].filter(Boolean)) if (p.exitCode === null) p.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
async function connect(name) {
  const ws = new WebSocket(endpoint);
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 1;
  const waiting = new Map();
  const events = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { resolve, reject, timer } = waiting.get(msg.id);
      clearTimeout(timer);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else events.push(msg);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${name}: ${method} timed out`));
      }, 8_000);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await call("initialize", {
    clientInfo: { name: `hive_probe_${name}`, version: "1" },
    capabilities: { experimentalApi: true },
  });
  ws.send(JSON.stringify({ method: "initialized" }));
  return { call, events, close: () => ws.close() };
}
async function until(predicate, label) {
  for (let i = 0; i < 60; i++) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  server = spawn("codex", ["app-server", "--listen", endpoint], {
    env,
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (data) => {
    stderr += data;
  });
  await sleep(800);
  const a = await connect("a");
  const start = await a.call("thread/start", {
    cwd,
    historyMode: "paginated",
    model: "gpt-6.1-sol",
    config: { model_reasoning_effort: "low" },
  });
  const threadId = start.thread.id;
  evidence.threadId = threadId;
  evidence.configuredModel = start.model;
  evidence.configuredEffort = start.reasoningEffort;
  const b = await connect("b");
  try {
    await b.call("thread/resume", { threadId, excludeTurns: true });
    evidence.emptyThreadResume = "supported";
  } catch (error) {
    if (!error.message.includes("no rollout found")) throw error;
    evidence.emptyThreadResume = "no rollout found";
  }
  const shell = async (marker) => {
    const prior = a.events.filter((e) => e.method === "turn/completed").length;
    await a.call("thread/shellCommand", {
      threadId,
      command: `printf '${marker}\\n'`,
      timeoutMs: 1000,
    });
    await until(
      () => a.events.filter((e) => e.method === "turn/completed").length > prior,
      `shell ${marker}`,
    );
  };
  await shell("HIVE_PROBE_SEED");
  const resume = await b.call("thread/resume", { threadId, excludeTurns: true });
  assert.equal(resume.thread.id, threadId);
  evidence.secondClientSameThread = true;
  tmux([
    "new-session",
    "-d",
    "-s",
    "probe",
    "-x",
    "140",
    "-y",
    "50",
    "-c",
    cwd,
    "codex",
    "resume",
    "--remote",
    endpoint,
    threadId,
    "--no-alt-screen",
  ]);
  await sleep(1500);
  await shell("HIVE_PROBE_LIVE");
  await until(
    () => b.events.some((e) => e.method === "turn/completed"),
    "second client turn event",
  );
  evidence.bothClientsReceivedSameTurn =
    a.events.filter((e) => e.method === "turn/completed").at(-1).params.turn.id ===
    b.events.find((e) => e.method === "turn/completed").params.turn.id;
  assert.ok(evidence.bothClientsReceivedSameTurn);
  await until(
    () => tmux(["capture-pane", "-p", "-S", "-200", "-t", "probe"]).includes("HIVE_PROBE_LIVE"),
    "CLI live output",
  );
  evidence.tmuxCliRenderedLiveMarker = true;
  evidence.loadedWithCli = (await a.call("thread/loaded/list")).data;
  assert.deepEqual(evidence.loadedWithCli, [threadId]);
  b.close();
  await sleep(100);
  await shell("HIVE_PROBE_OFFLINE");
  const c = await connect("reconnected");
  const rejoin = await c.call("thread/resume", { threadId, excludeTurns: true });
  const history = await c.call("thread/turns/list", {
    threadId,
    itemsView: "full",
    limit: 100,
    sortDirection: "asc",
  });
  evidence.reconnectHistoryRecoversOfflineMarker =
    JSON.stringify(history).includes("HIVE_PROBE_OFFLINE");
  assert.ok(evidence.reconnectHistoryRecoversOfflineMarker);
  evidence.resumeCursorAvailable = rejoin.turnsBackwardsCursor !== null;
  evidence.historyTurnIds = history.data.map((t) => t.id);
  await shell("HIVE_PROBE_RECONNECTED");
  await until(() => c.events.some((e) => e.method === "turn/completed"), "reconnected live event");
  evidence.reconnectReceivesNewLiveTurn = true;
  c.close();
  await a.call("thread/shellCommand", {
    threadId,
    command: "printf 'HIVE_PROBE_ACTIVE_BEGIN\\n'; sleep 1; printf 'HIVE_PROBE_ACTIVE_END\\n'",
    timeoutMs: 3000,
  });
  const d = await connect("active_rejoin");
  const active = await d.call("thread/resume", { threadId, excludeTurns: true });
  evidence.activeRejoinStatus = active.thread.status.type;
  assert.equal(evidence.activeRejoinStatus, "active");
  // Buffer notifications from connection initialization onward, before snapshot hydration.
  const during = await d.call("thread/turns/list", {
    threadId,
    itemsView: "full",
    limit: 100,
    sortDirection: "asc",
  });
  await until(
    () => d.events.some((e) => e.method === "turn/completed"),
    "active rejoin completion",
  );
  const after = await d.call("thread/turns/list", {
    threadId,
    itemsView: "full",
    limit: 100,
    sortDirection: "asc",
  });
  const merged = new Map(during.data.map((turn) => [turn.id, turn]));
  for (const event of d.events.filter((e) => e.method === "turn/completed"))
    merged.set(event.params.turn.id, event.params.turn);
  for (const turn of after.data) merged.set(turn.id, turn);
  assert.equal(merged.size, 5);
  assert.ok(JSON.stringify([...merged.values()]).includes("HIVE_PROBE_ACTIVE_END"));
  evidence.activeSnapshotReconciliation = { uniqueTurns: merged.size, finalMarkerPresent: true };
  evidence.realInferenceAndApprovalRecoveryTested = false;
  evidence.notificationMethods = [...new Set(a.events.map((e) => e.method))].sort();
  evidence.loadedAfterReconnect = (await d.call("thread/loaded/list")).data;
  assert.deepEqual(evidence.loadedAfterReconnect, [threadId]);
  const models = await d.call("model/list", { includeHidden: false });
  evidence.modelCatalogCount = models.data.length;
  evidence.catalogIsAccountEntitlementProof = false;
  evidence.result = "passed";
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ...evidence,
        result: "failed",
        error: error.message,
        isolatedServerDiagnostics: stderr.slice(-4000),
      },
      null,
      2,
    ),
  );
  try {
    console.error(tmux(["capture-pane", "-p", "-S", "-200", "-t", "probe"]));
  } catch {}
  process.exitCode = 1;
} finally {
  await cleanup();
}
