#!/usr/bin/env node
// Local mock only. Separate PID-namespace compatibility proof; never packaged.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";
import {
  NATIVE_PROFILE,
  prepareNativeNamespace,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";

assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1");
assert.ok(!realpathSync(process.cwd()).startsWith("/tmp/"));
const home = mkdtempSync(join(process.cwd(), ".pq-"));
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
    const item = {
      id: `message_${requests}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "WS_PID_PERSISTED_CONTROL", annotations: [] }],
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
const report = {
  schemaVersion: 1,
  transport: "WebSocket",
  realHome: true,
  accountInference: false,
  productionChanged: false,
  runs: [],
  integratedNamespaceReady: false,
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
  if (mode === "pidNamespace") command.splice(1, 0, "--unshare-pid");
  const child = spawn(command[0], command.slice(1), {
    env: ns.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "",
    ws,
    sequence = 0;
  child.stderr.on("data", (v) => {
    stderr = (stderr + v).slice(-4096);
  });
  const pending = new Map(),
    events = [];
  const socket = join(home, "tmux.sock");
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
    for (let n = 0; n < 100; n++) {
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
      v.error ? p.reject(new Error(`rpc:${v.error.code}:${v.error.message}`)) : p.resolve(v.result);
    });
    const initialized = await call("initialize", {
      clientInfo: { name: "hive_pid_ws_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    assert.match(initialized.userAgent, /\/0\.165\.0(?:\s|$)/);
    ws.send(JSON.stringify({ method: "initialized" }));
    record.steps.push("initialize");
    await call("configRequirements/read", {});
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
      assert.ok(JSON.stringify(resumed).includes("WS_PID_PERSISTED_CONTROL"));
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
    const before = requests;
    const cli = ns.command(
      [
        "resume",
        "--remote",
        endpoint,
        "--remote-auth-token-env",
        "HIVE_NATIVE_CODEX_TOKEN",
        threadId,
      ],
      { cwd: checkout },
    );
    execFileSync(
      "/usr/bin/tmux",
      [
        "-f",
        "/dev/null",
        "-S",
        socket,
        "new-session",
        "-d",
        "-s",
        "fixture",
        "-x",
        "120",
        "-y",
        "40",
        "-c",
        checkout,
        ...cli,
      ],
      { env: { ...ns.env, HIVE_NATIVE_CODEX_TOKEN: token }, stdio: "ignore", timeout: 3000 },
    );
    let pane = "";
    for (let n = 0; n < 150; n++) {
      try {
        pane = execFileSync(
          "/usr/bin/tmux",
          ["-S", socket, "capture-pane", "-p", "-t", "fixture:0.0"],
          { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch {}
      if (pane.includes("WS_PID_PERSISTED_CONTROL")) break;
      await delay(20);
    }
    assert.ok(pane.includes("WS_PID_PERSISTED_CONTROL"));
    assert.equal(requests, before);
    record.steps.push("sameThreadCLI/noInference");
  } catch (error) {
    record.error = error.message;
  } finally {
    try {
      execFileSync("/usr/bin/tmux", ["-S", socket, "kill-server"], {
        stdio: "ignore",
        timeout: 1000,
      });
    } catch {}
    for (const p of pending.values()) clearTimeout(p.timer);
    ws?.terminate();
    child.kill("SIGKILL");
    for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n++)
      await delay(10);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    record.wrapperExited = true;
    record.diagnostic = stderr.replaceAll(token, "[REDACTED]");
  }
}
try {
  await run("baseline");
  assert.equal(report.runs[0].error, null);
  await run("pidNamespace");
  await run("restoredBaseline");
  assert.equal(report.runs[2].error, null);
  report.integratedNamespaceReady = report.runs[1].error === null;
  report.localMockRequests = requests;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await new Promise((r) => provider.close(r));
  rmSync(home, { recursive: true, force: true });
}
