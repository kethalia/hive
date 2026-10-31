#!/usr/bin/env node
// NO INFERENCE. Real-path synthetic homes exercise alias creation skipped in /tmp.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  NATIVE_PROFILE,
  prepareNativeNamespace,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";

assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1");
const executable = realpathSync(
  process.env.HIVE_TEST_CODEX_EXECUTABLE ??
    "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
);
const report = { schemaVersion: 1, inference: false, productionChanged: false, cases: [] };
for (const mode of ["baseline", "readonlyAliases", "readonlyAliasesAndTmpfs"]) {
  const readonlyTmp = mode !== "baseline";
  const home = mkdtempSync(join(process.cwd(), ".native-alias-proof-"));
  let child;
  try {
    const stateDirectory = join(home, ".local/state/hive/pilot");
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDirectory, "native-token"), "SYNTHETIC_TOKEN", { mode: 0o600 });
    const ns = prepareNativeNamespace({
      home,
      stateDirectory,
      codexExecutable: executable,
      fixtureProvider: { baseUrl: "http://127.0.0.1:9/v1" },
    });
    const command = ns.command(["app-server"]);
    // Reconstruct the original bounded negative control even after the installed
    // constructor gains the fix; remove only these two reviewed mount additions.
    for (let i = command.length - 1; i >= 0; i--) {
      if (command[i] === "--tmpfs" && command[i + 1] === "/tmp") command.splice(i, 2);
      if (
        command[i] === "--ro-bind" &&
        command[i + 1]?.endsWith("/native-policy/empty-runtime-aliases")
      )
        command.splice(i, 3);
    }

    if (readonlyTmp) {
      const tmp = join(ns.codexHome, "tmp/arg0-linux");
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      command.splice(command.indexOf("--"), 0, "--ro-bind", tmp, tmp);
      if (mode === "readonlyAliasesAndTmpfs")
        command.splice(command.indexOf("--"), 0, "--tmpfs", "/tmp");
    }
    child = spawn(command[0], command.slice(1), { env: ns.env, stdio: ["pipe", "pipe", "pipe"] });
    let diagnostic = "",
      id = 0;
    const pending = new Map();
    child.stderr.on("data", (value) => {
      diagnostic = (diagnostic + value).slice(-8192);
    });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const entry = pending.get(value.id);
      if (!entry) return;
      pending.delete(value.id);
      clearTimeout(entry.timer);
      entry.resolve(value);
    });
    const call = (method, params) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error(`timeout:${method}:${diagnostic}`)), 5000);
        pending.set(requestId, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      });
    assert.ok(
      (
        await call("initialize", {
          clientInfo: { name: "hive_alias_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        })
      ).result,
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await call("command/exec", {
      cwd: ns.verificationCwd,
      permissionProfile: NATIVE_PROFILE,
      command: [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import sys\nfor path in sys.argv[1:]:\n try: open(path,'rb').close()\n except (PermissionError,FileNotFoundError): continue\n raise SystemExit(2)\nprint('CONTROL_PASSED')",
        ns.tokenPath,
        join(ns.codexHome, "config.toml"),
        "/etc/codex/requirements.toml",
      ],
      timeoutMs: 3000,
      outputBytesCap: 1024,
    });
    report.cases.push({
      mode,
      readonlyAliases: readonlyTmp,
      commandAccepted: Boolean(result.result),
      exitCode: result.result?.exitCode ?? null,
      denialControl: result.result?.stdout.trim() === "CONTROL_PASSED",
      errorCode: result.error?.code ?? null,
      managedDenyConflict: String(result.error?.message ?? "").includes("managed deny_read"),
      aliasCreationReadonlyWarning: diagnostic.includes("Read-only file system"),
      aliasCreationTmpPathRefusal: diagnostic.includes(
        "Refusing to create helper binaries under temporary dir",
      ),
    });
    if (mode === "readonlyAliasesAndTmpfs") {
      if (result.result?.exitCode !== 0) process.stderr.write(`${JSON.stringify(result)}\n`);
      assert.equal(result.result?.exitCode, 0);
      assert.equal(result.result.stdout.trim(), "CONTROL_PASSED");
    } else if (mode === "baseline")
      assert.ok(result.error && String(result.error.message).includes("managed deny_read"));
    else assert.equal(result.result?.exitCode, 1);
  } finally {
    child?.kill("SIGTERM");
    if (child && child.exitCode === null && child.signalCode === null)
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
