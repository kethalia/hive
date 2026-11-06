#!/usr/bin/env node
// No inference. Four independent native lifetimes with synthetic private homes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import {
  NATIVE_PINS,
  NATIVE_PROFILE,
  prepareNativeNamespace,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";

assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1");
assert.ok(!realpathSync(process.cwd()).startsWith("/tmp/"));
const executable = realpathSync(
  process.env.HIVE_TEST_CODEX_EXECUTABLE ??
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  schemaVersion: 1,
  runtimeVersion: "0.165.0",
  nativePins: NATIVE_PINS,
  accountInference: false,
  turnStartCalls: 0,
  policyChanged: false,
  procMount: "unchanged protected inherited bind",
  cases: [],
};
const start = Date.now();
function snapshot(wrapperPid) {
  const queue = [wrapperPid],
    records = [];
  for (let i = 0; i < queue.length && i < 12; i++) {
    const pid = queue[i];
    try {
      const identity = processIdentity(pid);
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const threads = readdirSync(`/proc/${pid}/task`)
        .slice(0, 8)
        .map((tid) => {
          try {
            return {
              tid: Number(tid),
              wait: readFileSync(`/proc/${pid}/task/${tid}/wchan`, "utf8").trim(),
            };
          } catch {
            return { tid: Number(tid), wait: "unavailable" };
          }
        });
      records.push({
        identity,
        pidNamespace: readlinkSync(`/proc/${pid}/ns/pid`),
        namespacePids: status
          .match(/^NSpid:\s*(.*)$/m)?.[1]
          .trim()
          .split(/\s+/)
          .map(Number),
        state: status.match(/^State:\s*(.)/m)?.[1],
        threads,
      });
      queue.push(
        ...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      );
    } catch {}
  }
  return records;
}
for (const pidNamespace of [false, true])
  for (const ephemeral of [true, false]) {
    const home = mkdtempSync(join(process.cwd(), ".pi-"));
    let child, ws;
    const pending = new Map();
    let id = 0;
    const record = { pidNamespace, ephemeral };
    report.cases.push(record);
    try {
      const stateDirectory = join(home, ".local/state/hive/pilot");
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(stateDirectory, "native-token"), "SYNTHETIC_FIXTURE_TOKEN", {
        mode: 0o600,
      });
      const checkout = join(home, "projects/.hive-managed/github/990002/checkout");
      mkdirSync(checkout, { recursive: true, mode: 0o700 });
      const ns = prepareNativeNamespace({
        home,
        stateDirectory,
        codexExecutable: executable,
        fixtureProvider: { baseUrl: "http://127.0.0.1:9/v1" },
      });
      const server = createServer();
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const endpoint = `ws://127.0.0.1:${server.address().port}`;
      await new Promise((r) => server.close(r));
      const command = ns.command([
        "app-server",
        "--listen",
        endpoint,
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        ns.tokenPath,
      ]);
      if (pidNamespace) command.splice(1, 0, "--unshare-pid");
      child = spawn(command[0], command.slice(1), {
        env: ns.env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      for (let n = 0; n < 60; n++) {
        ws = await new Promise((resolve) => {
          const socket = new WebSocket(endpoint, {
            headers: { Authorization: "Bearer SYNTHETIC_FIXTURE_TOKEN" },
            handshakeTimeout: 100,
          });
          socket.once("open", () => resolve(socket));
          socket.once("error", () => {
            socket.terminate();
            resolve(null);
          });
        });
        if (ws) break;
        await pause(20);
      }
      assert.ok(ws);
      ws.on("message", (raw) => {
        const v = JSON.parse(String(raw));
        const p = pending.get(v.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(v.id);
        p.resolve(
          v.error
            ? { outcome: "rpcError", code: v.error.code }
            : { outcome: "ok", result: v.result },
        );
      });
      const call = (method, params, timeout = 1000) =>
        new Promise((resolve) => {
          const requestId = ++id;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            resolve({ outcome: "timeout" });
          }, timeout);
          pending.set(requestId, { resolve, timer });
          ws.send(JSON.stringify({ id: requestId, method, params }));
        });
      const init = await call("initialize", {
        clientInfo: { name: "hive_pid_startup_fixture", version: "1" },
        capabilities: { experimentalApi: true },
      });
      assert.equal(init.outcome, "ok");
      assert.match(init.result.userAgent, /\/0\.165\.0(?:\s|$)/);
      ws.send(JSON.stringify({ method: "initialized" }));
      const requirements = await call("configRequirements/read", {});
      assert.equal(requirements.outcome, "ok");
      assert.equal(requirements.result.requirements.defaultPermissions, NATIVE_PROFILE);
      record.initialized = true;
      const began = Date.now();
      const started = call(
        "thread/start",
        {
          cwd: checkout,
          model: "gpt-6.1-sol",
          permissions: NATIVE_PROFILE,
          approvalPolicy: "never",
          ephemeral,
        },
        8000,
      );
      await pause(200);
      record.kernelDuringStartup = snapshot(child.pid);
      const responsive = await call("configRequirements/read", {}, 1000);
      record.readWhileStartupPending = responsive.outcome;
      const response = await started;
      record.startup = response.outcome;
      record.elapsedStartupMs = Date.now() - began;
      if (response.outcome === "rpcError") record.rpcCode = response.code;
      record.kernelAfterStartup = snapshot(child.pid);
    } catch {
      record.harnessError = true;
    } finally {
      for (const p of pending.values()) clearTimeout(p.timer);
      ws?.terminate();
      child?.kill("SIGKILL");
      for (let n = 0; n < 100 && child && child.exitCode === null && child.signalCode === null; n++)
        await pause(10);
      record.wrapperExited = !child || child.exitCode !== null || child.signalCode !== null;
      rmSync(home, { recursive: true, force: true });
    }
  }
report.elapsedMs = Date.now() - start;
assert.ok(report.elapsedMs < 60000);
report.productionReady = false;
report.writerHoldsRetained = true;
console.log(JSON.stringify(report, null, 2));
