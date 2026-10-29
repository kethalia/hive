#!/usr/bin/env node
// NO INFERENCE. Dedicated test-workspace installed namespace/RPC diagnostics.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = "/home/coder",
  stateDirectory = join(home, `.local/state/hive/native-account-readiness-${randomUUID()}`),
  packageDir = join(
    home,
    ".local/share/hive/codex-host/94a6c97e26238cfb6904cdfca699863e22e472014dd296d6cef6fc3eeae0f2d8",
  );
const report = {
  schemaVersion: 1,
  inference: false,
  stateDirectory,
  steps: [],
  profile: process.env.HIVE_WORKSPACE_PROFILE,
  apparmor: readFileSync("/proc/self/attr/current", "utf8").trim(),
};
const config = JSON.parse(readFileSync(join(home, ".config/hive/codex-host.json")));
assert.equal(config.binding.buildId, "ebafefde-23d7-46cb-948f-865a7c0fb464");
assert.equal(config.nativeIsolationEnabled, true);
assert.equal(config.managerEnabled, false);
const executable = join(
  home,
  ".local/share/hive/codex-runtime/0.165.0-linux-x64-c06a67fd8ac76508/vendor/x86_64-unknown-linux-musl/bin/codex",
);
const { prepareNativeNamespace, NATIVE_PROFILE } = await import(
  pathToFileURL(join(packageDir, "codex-native-namespace.mjs"))
);
const { WebSocket } = await import(pathToFileURL(join(packageDir, "vendor/ws.mjs")));
mkdirSync(stateDirectory, { mode: 0o700 });
writeFileSync(join(stateDirectory, "native-token"), randomBytes(32).toString("hex"), {
  mode: 0o600,
  flag: "wx",
});
writeFileSync(
  join(stateDirectory, "receipt.json"),
  JSON.stringify({
    task: "native-account-readiness",
    buildId: config.binding.buildId,
    stateDirectory,
    createdAt: new Date().toISOString(),
  }),
  { mode: 0o600, flag: "wx" },
);
const lock = openSync(
  join(stateDirectory, "pilot.lock"),
  constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  0o600,
);
execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
  stdio: ["ignore", "ignore", "ignore", lock],
});
const ns = prepareNativeNamespace({ home, stateDirectory, codexExecutable: executable });
const token = readFileSync(join(stateDirectory, "native-token"), "utf8");
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const endpoint = `ws://127.0.0.1:${reservation.address().port}`;
await new Promise((resolve) => reservation.close(resolve));
const command = ns.command(
  [
    "app-server",
    "--listen",
    endpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    ns.tokenPath,
  ],
  { holdLock: true },
);
const guardian =
  "import ctypes,os,signal,sys\np=int(sys.argv[1])\nr=ctypes.CDLL(None).prctl(1,signal.SIGTERM,0,0,0)\nif r!=0 or os.getppid()!=p: sys.exit(1)\nos.execv(sys.argv[2],sys.argv[2:])";
const child = spawn("/usr/bin/python3", ["-I", "-c", guardian, String(process.pid), ...command], {
  env: ns.env,
  stdio: ["ignore", "ignore", "pipe", lock],
});
let diagnostic = "",
  ws,
  seq = 0;
child.stderr.on("data", (v) => {
  diagnostic = (diagnostic + v).slice(-8192);
});
const pending = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codeCategory = (error) => ({
  code: error.code ?? null,
  categories: [
    "permission",
    "sandbox",
    "cwd",
    "path",
    "config",
    "approval",
    "auth",
    "denied",
    "unknown",
    "invalid",
    "read",
    "write",
    "profile",
    "absolute",
    "canonical",
    "unavailable",
  ].filter((word) =>
    String(error.message ?? "")
      .toLowerCase()
      .includes(word),
  ),
});
try {
  for (let n = 0; n < 30; n++) {
    try {
      ws = await new Promise((resolve, reject) => {
        const socket = new WebSocket(endpoint, {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: 300,
          maxPayload: 1024 * 1024,
        });
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      });
      break;
    } catch {
      await pause(100);
    }
  }
  assert.ok(ws);
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const p = pending.get(message.id);
    if (p) {
      pending.delete(message.id);
      clearTimeout(p.timer);
      p.resolve(message);
    }
  });
  const call = async (method, params) => {
    const id = ++seq;
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("diagnostic_rpc_timeout"));
      }, 5000);
      pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    if (message.error) {
      writeFileSync(
        join(stateDirectory, `diagnostic-error-${id}.json`),
        JSON.stringify({ method, error: message.error }, null, 2),
        { mode: 0o600 },
      );
      report.steps.push({
        method,
        passed: false,
        error: codeCategory(message.error),
        privateErrorFile: `diagnostic-error-${id}.json`,
      });
      return null;
    }
    report.steps.push({ method, passed: true });
    return message.result;
  };
  const init = await call("initialize", {
    clientInfo: { name: "hive_readiness_diagnostic", version: "1" },
    capabilities: { experimentalApi: true },
  });
  assert.ok(init);
  report.runtimeVersion = /\/([\d.]+)/.exec(init.userAgent)?.[1];
  ws.send(JSON.stringify({ method: "initialized" }));
  const requirements = await call("configRequirements/read", {});
  if (requirements) {
    const value = requirements.requirements;
    report.requirements = {
      defaultPermissions: value?.defaultPermissions,
      allowedPermissionProfiles: value?.allowedPermissionProfiles,
      allowedApprovalPolicies: value?.allowedApprovalPolicies,
      allowedSandboxModes: value?.allowedSandboxModes,
    };
  }
  for (const cwd of [ns.verificationCwd]) {
    const result = await call("command/exec", {
      command: ["/usr/bin/python3", "-I", "-c", "print('HIVE_READINESS_POSITIVE')"],
      cwd,
      permissionProfile: NATIVE_PROFILE,
      timeoutMs: 3000,
      outputBytesCap: 1024,
    });
    if (result)
      report.steps.at(-1).result = {
        exitCode: result.exitCode,
        positive: result.stdout.trim() === "HIVE_READINESS_POSITIVE",
      };
    report.steps.at(-1).cwdCategory =
      cwd === ns.verificationCwd ? "managedRoot" : "fixtureCheckout";
  }
  const script =
    "import sys\nfor p in sys.argv[1:]:\n try: open(p,'rb').close()\n except (PermissionError,FileNotFoundError): continue\n raise SystemExit(2)\nprint('HIVE_ISOLATION_READY')";
  const result = await call("command/exec", {
    command: [
      "/usr/bin/python3",
      "-I",
      "-c",
      script,
      ns.tokenPath,
      join(ns.codexHome, "config.toml"),
      "/etc/codex/requirements.toml",
      `/proc/${process.pid}/environ`,
    ],
    cwd: ns.verificationCwd,
    permissionProfile: NATIVE_PROFILE,
    timeoutMs: 3000,
    outputBytesCap: 1024,
  });
  if (result)
    report.steps.at(-1).result = {
      exitCode: result.exitCode,
      denialControl: result.stdout.trim() === "HIVE_ISOLATION_READY",
    };
} catch (error) {
  report.failureCategory = String(error.message).split(":")[0];
} finally {
  report.passed =
    !report.failureCategory &&
    report.steps.every(
      (step) =>
        step.passed &&
        (!step.result ||
          (step.result.exitCode === 0 && (step.result.positive || step.result.denialControl))),
    );
  ws?.terminate();
  child.kill("SIGTERM");
  for (let n = 0; n < 20 && child.exitCode === null && child.signalCode === null; n++)
    await pause(50);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  closeSync(lock);
  writeFileSync(join(stateDirectory, "diagnostic-private-stderr.txt"), diagnostic, { mode: 0o600 });
  writeFileSync(join(stateDirectory, "diagnostic.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
