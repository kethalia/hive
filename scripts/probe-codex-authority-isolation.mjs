#!/usr/bin/env node
// Bounded opt-in proof using synthetic files and a local Responses provider only.
// This does not install policy, activate the host, or use account credentials.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
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
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";

const check = (value, message) => {
  if (!value) throw new Error(message);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runAuthorityIsolationProbe({ profileOnlyControl = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-authority-proof-"));
  const home = join(root, "native-home"),
    workspace = join(root, "workspace"),
    authority = join(root, "authority"),
    managed = join(root, "managed");
  for (const path of [home, workspace, authority, managed]) mkdirSync(path, { mode: 0o700 });
  const executable = realpathSync(
    process.env.HIVE_TEST_CODEX_EXECUTABLE ??
      "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  const vendor = dirname(dirname(executable)),
    bwrap = join(vendor, "codex-resources/bwrap");
  const secret = join(authority, "synthetic-signer"),
    allowed = join(workspace, "allowed");
  writeFileSync(secret, "SYNTHETIC_AUTHORITY_ONLY", { mode: 0o600 });
  writeFileSync(allowed, "ALLOWED_FIXTURE");
  symlinkSync(secret, join(workspace, "alias"));
  const fd = openSync(secret, "r");
  const observations = [],
    requests = [];
  let child, nativePid, rootThreadId;
  const cases = {
    inside: allowed,
    insideWrite: join(workspace, "writable"),
    authorityWrite: secret,
    configWrite: join(home, "config.toml"),
    authority: secret,
    symlink: join(workspace, "alias"),
    parentRoot: `/proc/${process.pid}/root${secret}`,
    parentFd: `/proc/${process.pid}/fd/${fd}`,
    parentEnviron: `/proc/${process.pid}/environ`,
    nativeConfig: join(home, "config.toml"),
    managedPolicy: "/etc/codex/requirements.toml",
  };
  const heartbeat = join(workspace, "background-heartbeat");
  const background = join(workspace, "background.py");
  writeFileSync(
    background,
    `import subprocess,sys,time,json\nfrom pathlib import Path\npath=Path(${JSON.stringify(heartbeat)})\ncode="import time; from pathlib import Path; p=Path("+repr(str(path))+"); [(p.write_text(str(i)),time.sleep(.1)) for i in range(30)]"\nsubprocess.Popen(["/usr/bin/python3","-I","-c",code],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)\nfor _ in range(100):\n if path.exists(): break\n time.sleep(.01)\ntime.sleep(.2)\nprint(json.dumps({"backgroundStarted":path.exists()}))\n`,
  );
  const probe = join(workspace, "probe.py");
  writeFileSync(
    probe,
    `import json,sys,errno,socket\nfrom pathlib import Path\ncases=json.loads(sys.argv[1])\nout=[]\nfor name,path in cases.items():\n try:\n  if name == "network":\n   socket.create_connection(("127.0.0.1",int(path)),timeout=1).close()\n  elif name.endswith("Write"):\n   Path(path).write_text("SYNTHETIC_WRITE")\n  else:\n   Path(path).read_bytes()\n  out.append({'case':name,'outcome':'allowed'})\n except OSError as e:\n  out.append({'case':name,'outcome':'denied' if e.errno in [errno.EACCES,errno.EPERM,errno.ENOENT] else 'unavailable','errno':e.errno})\nprint(json.dumps(out))\n`,
  );
  const allCommand = () =>
    `/usr/bin/python3 -I ${probe} '${JSON.stringify({ ...cases, nativeRoot: `/proc/${nativePid}/root${secret}`, nativeEnviron: `/proc/${nativePid}/environ` })}'`;
  let responseId = 0;
  const servedMarkers = new Set();
  const provider = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      if (requests.length >= 32) {
        res.writeHead(503);
        res.end();
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const input = body.input ?? [];
      const last = input.at(-1);
      const output = last?.type === "function_call_output";
      const lastUser = [...input].reverse().find((item) => item.role === "user");
      const marker = JSON.stringify(lastUser).includes("ISOLATION_SPAWN_CHILD");
      const escalated = JSON.stringify(lastUser).includes("ISOLATION_ESCALATION");
      const backgroundTurn = JSON.stringify(lastUser).includes("ISOLATION_BACKGROUND");
      const markerKey =
        req.headers["x-codex-parent-thread-id"] === rootThreadId
          ? "ISOLATION_CHILD_COMMAND"
          : JSON.stringify(lastUser).match(/ISOLATION_[A-Z_]+/)?.[0];
      const fresh = markerKey && !servedMarkers.has(markerKey);
      if (fresh) servedMarkers.add(markerKey);
      let item;
      if (!output && marker && fresh) {
        item = {
          id: `fc_${++responseId}`,
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          call_id: `spawn_${responseId}`,
          arguments: JSON.stringify({
            task_name: "isolation_fixture",
            message: "ISOLATION_CHILD_COMMAND",
            fork_turns: "none",
            model: "gpt-6.1-sol",
            reasoning_effort: "low",
          }),
          status: "completed",
        };
      } else if (!output && fresh) {
        item = {
          id: `fc_${++responseId}`,
          type: "function_call",
          namespace: "functions",
          name: "exec_command",
          call_id: `exec_${responseId}`,
          arguments: JSON.stringify({
            cmd: backgroundTurn ? `/usr/bin/python3 -I ${background}` : allCommand(),
            login: false,
            max_output_tokens: 2000,
            ...(escalated
              ? {
                  sandbox_permissions: "require_escalated",
                  justification: "Synthetic isolation test only",
                }
              : {}),
          }),
          status: "completed",
        };
      } else {
        item = {
          id: `msg_${++responseId}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ISOLATION_FIXTURE_DONE", annotations: [] }],
        };
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: `response_${responseId}`, status: "in_progress", output: [] },
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
            id: `response_${responseId}`,
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
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const report = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    runtimeSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
    credentialSource: "none-local-mock-only",
    managedPolicy: false,
    commands: [],
    overrides: [],
    modelTurns: [],
    passed: false,
    profileOnlyControl,
    productionActivated: false,
    productionReady: false,
  };
  const fsEntries = {
    ":minimal": "read",
    [executable]: "read",
    [workspace]: "write",
    [authority]: "deny",
    [home]: "deny",
    "/proc": "deny",
    "/etc/codex": "deny",
  };
  const requirements = `allowed_approval_policies=["never"]\n${profileOnlyControl ? "" : 'allowed_sandbox_modes=["read-only","workspace-write"]\n'}allowed_web_search_modes=["disabled"]\ndefault_permissions="hive-isolated"\nmcp_servers={}\n${profileOnlyControl ? "" : `[permissions.filesystem]\ndeny_read=${JSON.stringify([authority, home, "/proc", "/etc/codex"])}\n`}[allowed_permission_profiles]\nhive-isolated=true\n[permissions.hive-isolated.filesystem]\n${Object.entries(
    fsEntries,
  )
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(
      "\n",
    )}\n[permissions.hive-isolated.network]\nenabled=false\n[features]\napps=false\nplugins=false\nhooks=false\n`;
  cases.network = String(provider.address().port);
  const mcpMarker = join(authority, "mcp-was-run");
  writeFileSync(join(managed, "requirements.toml"), requirements, { mode: 0o600 });
  writeFileSync(
    join(home, "config.toml"),
    `model="gpt-6.1-sol"\nmodel_provider="fixture"\napproval_policy="never"\ndefault_permissions="hive-isolated"\nweb_search="disabled"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Local mock only"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.untrusted_fixture]\ncommand="/usr/bin/python3"\nargs=${JSON.stringify(["-I", "-c", `from pathlib import Path; Path(${JSON.stringify(mcpMarker)}).write_text("UNTRUSTED_MCP_RAN")`])}\n[features]\napps=false\nplugins=false\nhooks=false\nmemories=false\n`,
    { mode: 0o600 },
  );
  const args = [
    "--unshare-user",
    "--die-with-parent",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--tmpfs",
    "/etc",
    "--ro-bind",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind",
    managed,
    "/etc/codex",
    "--bind",
    root,
    root,
    "--ro-bind",
    vendor,
    vendor,
    "--bind",
    "/proc",
    "/proc",
    "--dev",
    "/dev",
    "--chdir",
    workspace,
    "--",
    executable,
    "app-server",
    "--listen",
    "stdio://",
  ];
  const pending = new Map();
  let sequence = 0,
    stderr = "";
  try {
    child = spawn(bwrap, args, {
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home, LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.once("exit", () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("native_exited"));
      }
      pending.clear();
    });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (value.method) {
        observations.push(value);
        return;
      }
      const wait = pending.get(value.id);
      if (!wait) return;
      pending.delete(value.id);
      clearTimeout(wait.timer);
      if (value.error) wait.reject(new Error(value.error.message ?? "native_rejected"));
      else wait.resolve(value.result);
    });
    const call = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`timeout:${method}`));
          }, 10000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    check(
      report.runtimeSha256 === "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5",
      "unreviewed_native_digest",
    );
    const init = await call("initialize", {
      clientInfo: { name: "hive_isolation_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    check(/0\.165\.0/.test(init.userAgent), "unsupported_runtime");
    send({ method: "initialized" });
    // bwrap execs native in its child; only inspect this fixture's descendants.
    const childPids = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    nativePid = childPids.map(Number).find((pid) => {
      try {
        return realpathSync(`/proc/${pid}/exe`) === executable;
      } catch {
        return false;
      }
    });
    check(Number.isInteger(nativePid), "native_process_identity_unverified");
    report.processChain = {
      wrapperPid: child.pid,
      nativePid,
      wrapperIdentity: processIdentity(child.pid),
      nativeIdentity: processIdentity(nativePid),
      wrapperParent: Number(
        readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ").at(-1).split(" ")[1],
      ),
      nativeParent: Number(
        readFileSync(`/proc/${nativePid}/stat`, "utf8").split(") ").at(-1).split(" ")[1],
      ),
    };
    check(
      report.processChain.nativeParent === child.pid &&
        report.processChain.wrapperParent === process.pid,
      "native_wrapper_parent_changed",
    );
    const requirementsResult = await call("configRequirements/read", {});
    report.managedPolicy =
      requirementsResult.requirements?.defaultPermissions === "hive-isolated" &&
      requirementsResult.requirements?.allowedPermissionProfiles?.["hive-isolated"] === true;
    for (const [name, patch] of [
      ["selected-profile", {}],
      ["unrestricted-override", { permissionProfile: ":danger-full-access" }],
      [
        "legacy-override",
        { permissionProfile: undefined, sandboxPolicy: { type: "dangerFullAccess" } },
      ],
    ]) {
      try {
        const result = await call("command/exec", {
          command: [
            "/usr/bin/python3",
            "-I",
            probe,
            JSON.stringify({
              ...cases,
              nativeRoot: `/proc/${nativePid}/root${secret}`,
              nativeEnviron: `/proc/${nativePid}/environ`,
            }),
          ],
          cwd: workspace,
          permissionProfile: "hive-isolated",
          timeoutMs: 5000,
          outputBytesCap: 8192,
          ...patch,
        });
        let results;
        try {
          results = JSON.parse(result.stdout);
        } catch {}
        report.commands.push({
          name,
          exitCode: result.exitCode,
          results: results ?? null,
          error: result.stderr.slice(0, 600),
        });
      } catch (error) {
        report.commands.push({ name, rejected: true, error: error.message.slice(0, 400) });
      }
    }
    for (const [name, patch] of [
      ["named-override", { permissions: ":danger-full-access" }],
      ["legacy-override", { permissions: undefined, sandbox: "danger-full-access" }],
      [
        "profile-redefinition",
        { config: { "permissions.hive-isolated.filesystem": { ":root": "read" } } },
      ],
    ]) {
      try {
        const result = await call("thread/start", {
          cwd: workspace,
          permissions: "hive-isolated",
          model: "gpt-6.1-sol",
          ...patch,
        });
        report.overrides.push({
          name,
          rejected: false,
          activeProfile: result.activePermissionProfile?.id,
          sandbox: result.sandbox?.type,
        });
      } catch (error) {
        report.overrides.push({ name, rejected: true, error: error.message.slice(0, 400) });
      }
    }
    const started = await call("thread/start", {
      cwd: workspace,
      permissions: "hive-isolated",
      model: "gpt-6.1-sol",
      experimentalRawEvents: true,
    });
    rootThreadId = started.thread.id;
    const turn = async (text, patch = {}) => {
      const result = await call("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text, text_elements: [] }],
        ...patch,
      });
      for (let n = 0; n < 200; n++) {
        const done = observations.find(
          (x) =>
            x.method === "turn/completed" &&
            x.params.threadId === started.thread.id &&
            x.params.turn.id === result.turn.id,
        );
        if (done) return done.params.turn;
        await pause(25);
      }
      throw new Error("model_turn_timeout");
    };
    for (const text of [
      "ISOLATION_ROOT_COMMAND",
      "ISOLATION_RESUME_COMMAND",
      "ISOLATION_SPAWN_CHILD",
      "ISOLATION_ESCALATION",
      "ISOLATION_BACKGROUND",
    ]) {
      if (text.includes("RESUME")) {
        const resumed = await call("thread/resume", {
          threadId: started.thread.id,
          permissions: ":danger-full-access",
          excludeTurns: true,
        });
        report.resumeOverrideProfile = resumed.activePermissionProfile?.id;
      }
      if (text.includes("RESUME")) {
        try {
          await turn("ISOLATION_TURN_OVERRIDE", { permissions: ":danger-full-access" });
          report.turnOverrideRejected = false;
        } catch {
          report.turnOverrideRejected = true;
        }
      }
      const captured = new Map();
      let inspectionIncomplete = false;
      const inspectOwnedDescendants = () => {
        const todo = [nativePid],
          seen = new Set();
        while (todo.length && seen.size < 128) {
          const pid = todo.shift();
          if (seen.has(pid)) continue;
          seen.add(pid);
          try {
            const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map(Number);
            todo.push(...children);
            if (pid !== nativePid) {
              const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
              if (command.includes(heartbeat) && command.includes("range(30)"))
                captured.set(pid, processIdentity(pid));
            }
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ESRCH") inspectionIncomplete = true;
          }
        }
        if (todo.length) inspectionIncomplete = true;
      };
      const poll =
        text === "ISOLATION_BACKGROUND" ? setInterval(inspectOwnedDescendants, 10) : null;
      const began = Date.now();
      let result;
      try {
        result = await turn(text);
      } finally {
        if (poll) clearInterval(poll);
      }
      report.modelTurns.push({ name: text, id: result.id, status: result.status });
      if (text === "ISOLATION_BACKGROUND") {
        const before = existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : null;
        await pause(500);
        const after = existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : null;
        report.background = {
          turnCompletedInMs: Date.now() - began - 500,
          heartbeatBefore: before,
          heartbeatAfter: after,
          writingAfterCompletion: before !== after,
          processesObserved: captured.size,
          inspectionIncomplete,
          exactObservedProcessesExited:
            captured.size > 0 &&
            [...captured].every(([pid, identity]) => {
              try {
                return JSON.stringify(processIdentity(pid)) !== JSON.stringify(identity);
              } catch {
                return true;
              }
            }),
          quiescenceAuthority: false,
        };
      }
    }
    await pause(500);
    report.commandEvents = observations
      .filter((x) => x.method === "item/completed" && x.params.item?.type === "commandExecution")
      .map((x) => {
        let results;
        try {
          results = JSON.parse(x.params.item.aggregatedOutput);
        } catch {}
        return {
          isRoot: x.params.threadId === started.thread.id,
          turnId: x.params.turnId,
          status: x.params.item.status,
          exitCode: x.params.item.exitCode,
          results: results ?? null,
        };
      });
    report.escalationRejected = requests.some((body) =>
      (body.input ?? []).some(
        (item) =>
          item.type === "function_call_output" &&
          /approval policy is Never|approval policy.*never|escalat.*not allowed/i.test(
            String(item.output),
          ),
      ),
    );
    report.childStarted = observations.some(
      (x) => x.params?.item?.type === "subAgentActivity" && x.params.item.kind === "started",
    );
    report.providerRequests = requests.length;
    report.untrustedMcpBlocked = !existsSync(mcpMarker);
    report.externalFixtureUnchanged = readFileSync(secret, "utf8") === "SYNTHETIC_AUTHORITY_ONLY";
    report.workspaceWriteVerified = existsSync(cases.insideWrite);
    report.profileOnlyControl = profileOnlyControl;
    const correct = (results) =>
      Array.isArray(results) &&
      results.length === Object.keys(cases).length + 2 &&
      results.every(
        (x) => x.outcome === (["inside", "insideWrite"].includes(x.case) ? "allowed" : "denied"),
      );
    report.passed =
      report.managedPolicy &&
      report.untrustedMcpBlocked &&
      report.externalFixtureUnchanged &&
      report.workspaceWriteVerified &&
      !profileOnlyControl &&
      correct(report.commands[0]?.results) &&
      report.commands.slice(1).every((x) => x.rejected) &&
      report.overrides.every((x) => x.rejected || x.activeProfile === "hive-isolated") &&
      report.resumeOverrideProfile === "hive-isolated" &&
      report.turnOverrideRejected &&
      report.escalationRejected &&
      report.commandEvents.length === 4 &&
      report.commandEvents
        .filter((x) => Array.isArray(x.results))
        .every((x) => x.exitCode === 0 && correct(x.results)) &&
      report.commandEvents.filter((x) => x.isRoot && Array.isArray(x.results)).length === 2 &&
      report.commandEvents.filter((x) => !x.isRoot).length === 1 &&
      report.commandEvents.some((x) => x.exitCode === 0 && x.results?.backgroundStarted === true);
  } catch (error) {
    report.error = error.message;
    report.stderr = stderr.slice(0, 1200);
  } finally {
    report.externalFixtureUnchanged =
      existsSync(secret) && readFileSync(secret, "utf8") === "SYNTHETIC_AUTHORITY_ONLY";
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", resolve);
        }),
        pause(1000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const wait of pending.values()) clearTimeout(wait.timer);
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  check(process.env.HIVE_TEST_NATIVE_CODEX === "1", "Explicit HIVE_TEST_NATIVE_CODEX=1 required");
  check(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === "--profile-only-control"),
    "Unknown probe argument",
  );
  const report = await runAuthorityIsolationProbe({
    profileOnlyControl: process.argv[2] === "--profile-only-control",
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 2;
}
