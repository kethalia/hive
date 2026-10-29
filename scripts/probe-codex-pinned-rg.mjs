#!/usr/bin/env node
// NO INFERENCE. Candidate fixed PATH for the already-pinned read-only vendor rg.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
for (const mode of ["baseline", "pinnedRgPath", "pinnedRgPathAndExactRead"]) {
  const home = mkdtempSync(join(process.cwd(), ".native-rg-proof-"));
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
    const rgDirectory = join(dirname(dirname(executable)), "codex-path");
    assert.equal(realpathSync(rgDirectory), rgDirectory);
    assert.equal(lstatSync(rgDirectory).uid, process.getuid());
    assert.equal(lstatSync(rgDirectory).mode & 0o022, 0);
    assert.deepEqual(readdirSync(rgDirectory), ["rg"]);
    const policyPath = join(stateDirectory, "native-policy/requirements.toml");
    // Preserve the original negative controls after canonical adoption of the fix.
    const initialPolicy = readFileSync(policyPath, "utf8");
    writeFileSync(
      policyPath,
      initialPolicy.replace(`${JSON.stringify(join(rgDirectory, "rg"))}="read"\n`, ""),
    );
    if (mode === "pinnedRgPathAndExactRead") {
      const policy = join(stateDirectory, "native-policy/requirements.toml");
      const source = readFileSync(policy, "utf8"),
        section = `[permissions.${NATIVE_PROFILE}.filesystem.":workspace_roots"]`;
      assert.ok(source.includes(section));
      writeFileSync(
        policy,
        source.replace(section, `${JSON.stringify(join(rgDirectory, "rg"))}="read"\n${section}`),
      );
    }
    const env = {
      ...ns.env,
      PATH: "/usr/bin:/bin",
      ...(mode !== "baseline" ? { PATH: `${rgDirectory}:/usr/bin:/bin` } : {}),
    };
    child = spawn(command[0], command.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
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
          clientInfo: { name: "hive_rg_fixture", version: "1" },
          capabilities: { experimentalApi: true },
        })
      ).result,
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await call("command/exec", {
      cwd: ns.verificationCwd,
      permissionProfile: NATIVE_PROFILE,
      command: ["/bin/sh", "-c", "command -v rg && rg --version"],
      timeoutMs: 3000,
      outputBytesCap: 1024,
    });
    const denied = await call("command/exec", {
      cwd: ns.verificationCwd,
      permissionProfile: NATIVE_PROFILE,
      command: [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import sys,errno\nfor path in sys.argv[1:3]:\n try: open(path,'rb').close()\n except (PermissionError,FileNotFoundError): continue\n raise SystemExit(2)\ntry: open(sys.argv[3],'ab').close()\nexcept OSError as error:\n assert error.errno in [errno.EACCES,errno.EPERM,errno.EROFS,errno.ENOENT]\nelse: raise SystemExit(3)\nprint('DENIALS_PASSED')",
        ns.tokenPath,
        join(ns.codexHome, "config.toml"),
        join(rgDirectory, "rg"),
      ],
      timeoutMs: 3000,
      outputBytesCap: 1024,
    });
    report.cases.push({
      mode,
      exitCode: result.result?.exitCode ?? null,
      output: result.result?.stdout ?? null,
      stderr: result.result?.stderr ?? null,
      error: result.error ?? null,
      denialsPreserved:
        denied.result?.exitCode === 0 && denied.result?.stdout.trim() === "DENIALS_PASSED",
    });
    if (mode === "baseline") assert.notEqual(result.result?.exitCode, 0);
    else if (mode === "pinnedRgPath") assert.equal(result.result?.exitCode, 127);
    else {
      assert.equal(result.result?.exitCode, 0);
      assert.ok(result.result.stdout.startsWith(join(rgDirectory, "rg")));
    }
    assert.equal(denied.result?.exitCode, 0);
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
