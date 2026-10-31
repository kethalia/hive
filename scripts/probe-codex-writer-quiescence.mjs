#!/usr/bin/env node
// Local fixture only. Never imported by host packaging or a public route.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  NATIVE_PROFILE,
  prepareNativeNamespace,
} from "../templates/ai-dev-k8s/scripts/codex-native-namespace.mjs";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label) => {
  for (let n = 0; n < 150; n++) {
    const value = fn();
    if (value) return value;
    await delay(20);
  }
  throw new Error(label);
};
const pidfdScript = `import os,sys,json,signal,select
v=json.loads(sys.argv[1]); p=v['pid']; fd=os.pidfd_open(p)
s=open('/proc/%s/stat'%p).read(); start=s[s.rindex(') ')+2:].split()[19]
assert start==v['startTime']
assert os.readlink('/proc/%s/ns/pid'%p)==v['namespace']
print('PINNED',flush=True)
assert sys.stdin.readline().strip() in ['KILL','WAIT']
if sys.argv[2]=='kill': signal.pidfd_send_signal(fd,signal.SIGKILL)
assert select.select([fd],[],[],5)[0]
print('EXITED',flush=True)
os.close(fd)
`;
async function pinLifetime(identity, namespace, mode = "kill") {
  const watcher = spawn(
    "/usr/bin/python3",
    ["-I", "-c", pidfdScript, JSON.stringify({ ...identity, namespace }), mode],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  watcher.stdout.on("data", (v) => {
    output += v;
  });
  watcher.stderr.on("data", (v) => {
    errors += v;
  });
  await until(() => output.includes("PINNED"), "pidfd_open_failed");
  return {
    async finish() {
      watcher.stdin.end(mode === "kill" ? "KILL\n" : "WAIT\n");
      await until(
        () => output.includes("EXITED") || watcher.exitCode !== null,
        "pidfd_exit_timeout",
      );
      assert.ok(output.includes("EXITED"), errors);
    },
    close() {
      watcher.kill("SIGKILL");
    },
  };
}
async function nativeFixture({
  home,
  providerUrl,
  executable,
  pidNamespace = true,
  freshProc = false,
}) {
  const stateDirectory = join(home, ".local/state/hive/codex-project-supervisor");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDirectory, "native-token"), "SYNTHETIC_FIXTURE_TOKEN", { mode: 0o600 });
  const ns = prepareNativeNamespace({
    home,
    stateDirectory,
    codexExecutable: executable,
    fixtureProvider: { baseUrl: providerUrl },
  });
  const command = ns.command(["app-server"]);
  // Separate proof variant only; do not mutate the frozen installed launcher.
  command.splice(1, 0, ...(pidNamespace ? ["--unshare-pid"] : []), "--json-status-fd", "3");
  const procIndex = command.findIndex((v, i) => v === "--bind" && command[i + 1] === "/proc");
  assert.ok(procIndex > 0);
  if (freshProc) command.splice(procIndex, 3, "--proc", "/proc");
  // Current pod forbids fresh proc mounts; retain the installed protected bind.
  // Kernel namespace identity is attested by the host, not inferred from /proc PIDs.
  const child = spawn(command[0], command.slice(1), {
    env: ns.env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  let diagnostic = "",
    status = "";
  child.stderr.on("data", (v) => {
    diagnostic = (diagnostic + v).slice(-2000);
  });
  child.stdio[3].on("data", (v) => {
    status += v;
  });
  let sequence = 0;
  const pending = new Map(),
    events = [];
  child.stdin.on("error", () => {});
  child.once("exit", () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`native_exited:${diagnostic}`));
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
      events.push(value);
      return;
    }
    const p = pending.get(value.id);
    if (!p) return;
    pending.delete(value.id);
    clearTimeout(p.timer);
    value.error ? p.reject(new Error(value.error.message)) : p.resolve(value.result);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`native_timeout:${method}:${diagnostic}`));
        }, 10000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  try {
    const init = await call("initialize", {
      clientInfo: { name: "hive_quiescence_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    assert.match(init.userAgent, /\/0\.165\.0(?:\s|$)/);
    send({ method: "initialized" });
    const childPid = await until(() => {
      const match = status.match(/"child-pid"\s*:\s*(\d+)/);
      return match ? Number(match[1]) : null;
    }, "native_pid_missing");
    const identity = processIdentity(childPid),
      namespace = readlinkSync(`/proc/${childPid}/ns/pid`),
      nspid = readFileSync(`/proc/${childPid}/status`, "utf8")
        .match(/^NSpid:\s*(.*)$/m)[1]
        .trim()
        .split(/\s+/)
        .map(Number);
    assert.equal(identity.executable, pidNamespace ? ns.bwrap : executable);
    if (pidNamespace) {
      assert.equal(nspid.at(-1), 1);
      assert.notEqual(namespace, readlinkSync("/proc/self/ns/pid"));
    }
    return {
      call,
      events,
      identity,
      namespace,
      nspid,
      wrapper: child,
      async close() {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await until(
          () => child.exitCode !== null || child.signalCode !== null,
          "wrapper_close_timeout",
        );
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "failed_fixture_exit_timeout",
    );
    throw error;
  }
}
function daemonScript(workspace) {
  return `import os,time,signal,json\nfrom pathlib import Path\nroot=Path(${JSON.stringify(workspace)})\n# Open before detaching; unlinked output remains writable through inherited FD.\nfd=os.open(root/'unlinked',os.O_WRONLY|os.O_APPEND)\nif os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nfor n in [0,1,2]:\n try: os.close(n)\n except OSError: pass\n(root/'daemon.json').write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'sid':os.getsid(0),'namespace':os.readlink('/proc/self/ns/pid')}))\nos.unlink(root/'unlinked')\nfor i in range(400):\n os.write(fd,b'x'); (root/'heartbeat').write_text(str(i)); time.sleep(.025)\nos.close(fd)\n`;
}
export async function probeQuiescence() {
  const root = mkdtempSync(join(tmpdir(), "hive-native-quiescence-")),
    home = join(root, "home"),
    other = join(root, "unrelated-heartbeat");
  mkdirSync(home, { mode: 0o700 });
  const workspace = join(home, "projects/.hive-managed/github/123/checkout");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const executable = realpathSync(
    process.env.HIVE_TEST_CODEX_EXECUTABLE ??
      "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  let requests = 0;
  const provider = createServer((req, res) => {
    let raw = "";
    req.on("data", (v) => {
      raw += v;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      requests++;
      const item = {
        id: `message_${requests}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "PERSISTED_QUIESCENCE_FIXTURE", annotations: [] }],
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const value of [
        {
          type: "response.created",
          response: { id: `response_${requests}`, status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `response_${requests}`,
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
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const unrelated = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      `import time;from pathlib import Path;p=Path(${JSON.stringify(other)});[(p.write_text(str(i)),time.sleep(.025)) for i in range(1200)]`,
    ],
    { stdio: "ignore" },
  );
  const report = {
    schemaVersion: 1,
    runtimeVersion: "0.165.0",
    modelInference: "local mock only",
    productionReady: false,
    localProcessBoundaryOnly: true,
    sameSharedRuntimeOtherProjectsAreNotIsolated: true,
    scope: "whole native PID namespace; not per-thread",
    runs: [],
  };
  let native, watcher, unlinkedFd;
  try {
    native = await nativeFixture({ home, providerUrl, executable, pidNamespace: false });
    const started = await native.call("thread/start", {
      cwd: workspace,
      model: "gpt-6.1-sol",
      permissions: NATIVE_PROFILE,
      approvalPolicy: "never",
      experimentalRawEvents: true,
    });
    const turn = await native.call("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Persist this local fixture.", text_elements: [] }],
    });
    await until(
      () =>
        native.events.find(
          (e) => e.method === "turn/completed" && e.params.turn.id === turn.turn.id,
        ),
      "first_turn_timeout",
    );
    for (const mode of ["native-inventory-control", "pidfd-init-kill", "abrupt-wrapper-death"]) {
      if (mode !== "native-inventory-control")
        native = await nativeFixture({ home, providerUrl, executable });
      const writer = join(workspace, "daemon.py");
      writeFileSync(writer, daemonScript(workspace));
      writeFileSync(join(workspace, "unlinked"), "");
      unlinkedFd = openSync(join(workspace, "unlinked"), "r");
      for (const path of ["heartbeat", "daemon.json"])
        rmSync(join(workspace, path), { force: true });
      // Trusted fixture-only process/spawn intentionally bypasses per-tool sandbox
      // to stress outer lifetime with an untracked daemon; never model/browser API.
      await native.call("process/spawn", {
        processHandle: mode,
        command: ["/usr/bin/python3", "-I", writer],
        cwd: workspace,
        timeoutMs: 10000,
        outputBytesCap: 1024,
      });
      await until(() => {
        try {
          return JSON.parse(readFileSync(join(workspace, "daemon.json"), "utf8"));
        } catch {
          return null;
        }
      }, "daemon_start_timeout");
      const daemon = JSON.parse(readFileSync(join(workspace, "daemon.json"), "utf8"));
      assert.equal(daemon.namespace, native.namespace);
      assert.notEqual(daemon.pid, daemon.sid, "double-fork daemon left the original session");
      if (mode !== "native-inventory-control") assert.equal(daemon.ppid, 1);
      const before = fstatSync(unlinkedFd).size;
      await delay(100);
      assert.ok(
        fstatSync(unlinkedFd).size > before,
        "detached inherited-FD writer positive control",
      );
      await until(
        () =>
          native.events.find(
            (e) => e.method === "process/exited" && e.params.processHandle === mode,
          ),
        "tracked_process_exit_timeout",
      );
      let inventory = null;
      if (mode === "native-inventory-control") {
        inventory = await native.call("thread/backgroundTerminals/list", {
          threadId: started.thread.id,
          limit: 20,
        });
        assert.equal(inventory.data.length, 0);
        assert.equal(inventory.nextCursor, null);
        await native.call("thread/backgroundTerminals/clean", { threadId: started.thread.id });
      }
      const afterClean = fstatSync(unlinkedFd).size;
      await delay(100);
      assert.ok(
        fstatSync(unlinkedFd).size > afterClean,
        "native terminal cleanup is not outer daemon quiescence",
      );
      watcher = await pinLifetime(
        mode === "native-inventory-control" ? processIdentity(daemon.pid) : native.identity,
        native.namespace,
        mode === "abrupt-wrapper-death" ? "wait" : "kill",
      );
      if (mode === "abrupt-wrapper-death") native.wrapper.kill("SIGKILL");
      await watcher.finish();
      watcher.close();
      watcher = null;
      const settled = fstatSync(unlinkedFd).size,
        otherBefore = readFileSync(other, "utf8");
      await delay(150);
      assert.equal(fstatSync(unlinkedFd).size, settled);
      assert.notEqual(
        readFileSync(other, "utf8"),
        otherBefore,
        "unrelated project process must remain running",
      );
      report.runs.push({
        mode,
        lifetimeRootIdentity: native.identity,
        pidNamespace: native.namespace,
        nspid: native.nspid,
        daemonDoubleFork: true,
        daemonSessionEscaped: true,
        inheritedUnlinkedFdWritesBeforeDrain: true,
        trackedProcessExited: true,
        backgroundTerminalCount: inventory?.data.length ?? null,
        writerContinuedAfterTerminalClean: inventory ? true : null,
        initPidfdExit: mode !== "native-inventory-control",
        exactDaemonPidfdExit: mode === "native-inventory-control",
        inheritedFdStableAfterExit: true,
        unrelatedWriterContinued: true,
      });
      closeSync(unlinkedFd);
      unlinkedFd = null;
      await native.close();
      native = null;
    }
    try {
      native = await nativeFixture({ home, providerUrl, executable, freshProc: true });
      report.freshProcMount = "unexpectedly_supported";
      await native.close();
      native = null;
    } catch (error) {
      report.freshProcMount = String(error.message).slice(0, 300);
    }
    native = await nativeFixture({ home, providerUrl, executable });
    try {
      await native.call("thread/resume", {
        threadId: started.thread.id,
        excludeTurns: true,
        permissions: NATIVE_PROFILE,
      });
      report.pidNamespaceResume = "supported";
    } catch (error) {
      report.pidNamespaceResume = String(error.message).split(":").slice(0, 2).join(":");
    }
    await native.close();
    native = null;
    native = await nativeFixture({ home, providerUrl, executable, pidNamespace: false });
    const resumed = await native.call("thread/resume", {
      threadId: started.thread.id,
      excludeTurns: true,
      permissions: NATIVE_PROFILE,
      approvalPolicy: "never",
    });
    assert.equal(resumed.thread.id, started.thread.id);
    const history = await native.call("thread/turns/list", {
      threadId: started.thread.id,
      limit: 20,
      itemsView: "full",
    });
    assert.ok(JSON.stringify(history).includes("PERSISTED_QUIESCENCE_FIXTURE"));
    report.historyPreservedWithCurrentLauncher = true;
    report.integratedNamespaceReady = false;
    report.providerRequests = requests;
    report.passed = true;
    return report;
  } finally {
    watcher?.close();
    await native?.close();
    if (unlinkedFd !== null && unlinkedFd !== undefined) closeSync(unlinkedFd);
    unrelated.kill("SIGKILL");
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.HIVE_TEST_NATIVE_CODEX, "1", "Explicit native fixture opt-in required");
  assert.equal(process.argv.length, 2);
  const report = await probeQuiescence();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
