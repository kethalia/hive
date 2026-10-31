import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { openNativeGuardian } from "../templates/ai-dev-k8s/scripts/codex-native-guardian.mjs";
import { validateGuardianArtifact } from "./build-native-guardian.mjs";

const scratch = mkdtempSync(join(tmpdir(), "hive-guardian-test-"));
const suppliedBinary = process.env.HIVE_GUARDIAN_TEST_BINARY;
const executable = suppliedBinary ? realpathSync(suppliedBinary) : join(scratch, "guardian");
if (suppliedBinary) {
  assert.equal(executable, join(realpathSync(dirname(executable)), "codex-native-guardian"));
  validateGuardianArtifact(resolve("."), dirname(executable));
} else
  execFileSync("/usr/bin/cc", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "templates/ai-dev-k8s/scripts/codex-native-guardian.c",
    "-o",
    executable,
  ]);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
// Avoid provider-specific multicall dispatch in sleep/true after realpath + fexecve.
// Python is already the pinned executable for the adversarial process fixtures.
const python = realpathSync("/usr/bin/python3");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let safeCleanup = true;
after(() => {
  if (safeCleanup) rmSync(scratch, { recursive: true, force: true });
});
function configuration(overrides = {}) {
  const events = [];
  const journal = Object.fromEntries(
    [
      "begin",
      "ready",
      "launchIntent",
      "admissionIntent",
      "admissionAccepted",
      "closeIntent",
      "acceptReceipt",
      "indeterminate",
    ].map((name) => [
      name,
      async (data) => {
        events.push({ name, data });
      },
    ]),
  );
  return {
    executable,
    sha256: hash(executable),
    bindingDigest: "a".repeat(64),
    projects: [{ projectId: randomUUID(), bindingDigest: "b".repeat(64) }],
    roots: [
      {
        id: "native",
        role: "native",
        executable: python,
        sha256: hash(python),
        cwd: scratch,
        args: ["-I", "-c", "import time; time.sleep(100)"],
        env: { PATH: "/usr/bin:/bin" },
      },
    ],
    journal,
    authorizeDrain: async (b) => b.projects.map((p) => ({ ...p, decisionId: randomUUID() })),
    events,
    ...overrides,
  };
}
test("an initially empty lifetime admits projects durably and never forgets earlier bindings", async () => {
  const config = configuration({ projects: [] });
  const guardian = await openNativeGuardian(config);
  try {
    const first = { projectId: randomUUID(), bindingDigest: "c".repeat(64) };
    const second = { projectId: randomUUID(), bindingDigest: "d".repeat(64) };
    assert.equal((await guardian.admitProject(first)).generation, 2);
    assert.equal((await guardian.admitProject(first)).generation, 2);
    await assert.rejects(guardian.admitProject({ ...first, bindingDigest: "e".repeat(64) }));
    assert.equal((await guardian.admitProject(second)).generation, 3);
    assert.deepEqual(guardian.state.projects, [first, second]);
    const receipt = await guardian.drain();
    assert.equal(receipt.generation, 4);
    assert.deepEqual(receipt.projects, [first, second]);
    assert.equal(config.events.filter((event) => event.name === "admissionIntent").length, 2);
    assert.equal(config.events.filter((event) => event.name === "admissionAccepted").length, 2);
  } finally {
    if (guardian.state.phase !== "closed") await guardian.abort();
  }
});

test("a pinned worker receives only its separate inherited channel and its descendants are drained", async () => {
  const root = pythonRoot(
    "import os,socket,time\ns=socket.socket(fileno=3)\ns.sendall(b'WORKER_READY')\nassert s.recv(4)==b'PING'\ns.sendall(b'PONG')\nwhile True: time.sleep(1)",
  );
  root.workerChannel = true;
  const guardian = await openNativeGuardian(configuration({ roots: [root] }));
  const channel = guardian.workerChannel("native");
  try {
    const ready = once(channel, "data");
    await guardian.launch("native");
    assert.equal((await ready)[0].toString(), "WORKER_READY");
    const reply = once(channel, "data");
    channel.write("PING");
    assert.equal((await reply)[0].toString(), "PONG");
    const receipt = await guardian.drain();
    assert.equal(receipt.finalWaitResult, "ECHILD");
  } finally {
    channel.destroy();
    if (guardian.state.phase !== "closed") await guardian.abort();
  }
});

test("agent environment is restricted to the essential host role and never admits owner sessions", async () => {
  for (const role of ["native", "tmux", "terminal"]) {
    const root = {
      ...configuration().roots[0],
      role,
      env: { CODER_AGENT_TOKEN: "synthetic-agent" },
    };
    await assert.rejects(openNativeGuardian(configuration({ roots: [root] })), /contract_rejected/);
  }
  for (const env of [
    { CODER_SESSION_TOKEN: "synthetic-owner" },
    { HIVE_WORKSPACE_PROFILE: "browser" },
  ]) {
    const root = { ...configuration().roots[0], role: "host", workerChannel: true, env };
    await assert.rejects(openNativeGuardian(configuration({ roots: [root] })), /contract_rejected/);
  }
  const root = {
    ...configuration().roots[0],
    role: "host",
    workerChannel: true,
    env: {
      PATH: "/usr/bin:/bin",
      HIVE_WORKSPACE_PROFILE: "software",
      CODER_AGENT_TOKEN: "synthetic-agent",
      CODER_AGENT_URL: "https://agent.invalid",
    },
  };
  const guardian = await openNativeGuardian(configuration({ roots: [root] }));
  try {
    await guardian.launch("native");
    await guardian.drain();
  } finally {
    await cleanAbort(guardian);
  }
});
function pythonRoot(script) {
  return {
    id: "native",
    role: "native",
    executable: python,
    sha256: hash(python),
    cwd: scratch,
    args: ["-I", "-c", script],
    env: { PATH: "/usr/bin:/bin", HOME: scratch },
  };
}
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("fixture readiness deadline");
}
function size(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
function writerScript(path, mode = "detached") {
  return `import os,time,signal,ctypes\np=${JSON.stringify(path)}\nmode=${JSON.stringify(mode)}\nlib=ctypes.CDLL(None)\nif mode=='nested': assert lib.prctl(36,1,0,0,0)==0\nif mode=='clone_parent':\n child=lib.syscall(56,0x8000|signal.SIGCHLD,0,0,0,0)\n assert child>=0\n if child>0:\n  while True: time.sleep(1)\nelif mode=='clone_signal':\n signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGUSR1})\n child=lib.syscall(56,signal.SIGUSR1,0,0,0,0)\n assert child>=0\n if child>0:\n  while True: time.sleep(1)\nelse:\n if os.fork()>0:\n  while True: time.sleep(1)\n os.setsid()\n if os.fork()>0: os._exit(0)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwith open(p,'ab',buffering=0) as f:\n while True:\n  f.write(b'x');time.sleep(.01)\n`;
}
async function cleanAbort(g) {
  const result = await g.abort();
  if (result.held) safeCleanup = false;
  assert.equal(result.held, undefined);
}

test("pinned roots drain only after complete project authorization, receipt persistence and ACK", async () => {
  const opts = configuration();
  let approve = false;
  opts.projects.push({ projectId: randomUUID(), bindingDigest: "c".repeat(64) });
  opts.authorizeDrain = async (b) => {
    if (!approve) throw new Error("deferred_active_project");
    return b.projects.map((p) => ({ ...p, decisionId: randomUUID() }));
  };
  const g = await openNativeGuardian(opts);
  try {
    await g.launch("native");
    const snapshot = g.state;
    snapshot.projects.length = 0;
    assert.equal(g.state.projects.length, 2);
    await assert.rejects(g.drain(), /deferred_active_project/);
    assert.equal(g.state.phase, "open");
    assert.equal(
      opts.events.some((e) => e.name === "closeIntent"),
      false,
    );
    approve = true;
    const receipt = await g.drain();
    assert.equal(receipt.finalWaitResult, "ECHILD");
    assert.equal(receipt.cleanupAuthorized, false);
    assert.equal(receipt.scope, "managed_native_tree_only");
    assert.deepEqual(
      opts.events.map((e) => e.name),
      ["begin", "ready", "launchIntent", "closeIntent", "acceptReceipt"],
    );
    assert.equal(g.state.phase, "closed");
    await assert.rejects(g.launch("native"));
  } finally {
    await cleanAbort(g);
  }
});
for (const mode of ["detached", "nested", "clone_parent", "clone_signal"])
  test(`adopts and drains ${mode} writers without touching an outside sibling`, async () => {
    const path = join(scratch, `${mode}.writes`),
      outside = join(scratch, `${mode}.outside`);
    const sibling = spawn(
      python,
      [
        "-I",
        "-c",
        `import time\nf=open(${JSON.stringify(outside)},'ab',buffering=0)\nwhile True: f.write(b'x');time.sleep(.01)`,
      ],
      { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } },
    );
    const ended = once(sibling, "exit");
    const opts = configuration({ roots: [pythonRoot(writerScript(path, mode))] });
    const g = await openNativeGuardian(opts);
    try {
      await g.launch("native");
      await until(() => size(path) > 2 && size(outside) > 2);
      const receipt = await g.drain();
      assert.ok(receipt.reaped >= 2);
      const n = size(path),
        other = size(outside);
      await delay(60);
      assert.equal(size(path), n);
      assert.ok(size(outside) > other);
    } finally {
      await cleanAbort(g);
      sibling.kill("SIGKILL");
      await ended;
    }
  });

test("root child inherits neither guardian control/descriptors nor ambient credential environment", async () => {
  const path = join(scratch, "fds.json");
  const root = pythonRoot(
    `import os,json,time\nfd=[]\nfor n in os.listdir('/proc/self/fd'):\n try: fd.append([n,os.readlink('/proc/self/fd/'+n)])\n except FileNotFoundError: pass\nwith open(${JSON.stringify(path)},'w') as f:json.dump({'fd':fd,'env':sorted(os.environ)},f)\nwhile True:time.sleep(1)`,
  );
  const g = await openNativeGuardian(configuration({ roots: [root] }));
  try {
    await g.launch("native");
    await until(() => size(path) > 0);
    const data = JSON.parse(readFileSync(path));
    assert.deepEqual(data.fd.map(([n]) => n).sort(), ["0", "1", "2"]);
    assert.ok(data.fd.every(([, p]) => p === "/dev/null"));
    assert.ok(data.env.includes("HOME") && data.env.includes("PATH"));
    assert.ok(data.env.every((key) => ["HOME", "LC_CTYPE", "PATH"].includes(key)));
    await g.drain();
  } finally {
    await cleanAbort(g);
  }
});

test("changed pinned executable between bootstrap and launch revokes the lifetime", async () => {
  const copy = join(scratch, "changed-root");
  copyFileSync(python, copy);
  chmodSync(copy, 0o500);
  const opts = configuration();
  opts.roots[0] = { ...opts.roots[0], executable: copy, sha256: hash(copy) };
  const g = await openNativeGuardian(opts);
  try {
    chmodSync(copy, 0o700);
    writeFileSync(copy, readFileSync(copy));
    chmodSync(copy, 0o500);
    await assert.rejects(g.launch("native"));
    assert.equal(g.state.phase, "indeterminate");
    assert.equal(
      opts.events.some((e) => e.name === "acceptReceipt"),
      false,
    );
  } finally {
    await cleanAbort(g);
  }
});

test("duplicate launch and incomplete stop authorization cannot create another root or certify a drain", async () => {
  const opts = configuration();
  const g = await openNativeGuardian(opts);
  try {
    await g.launch("native");
    await assert.rejects(g.launch("native"));
    assert.equal(g.state.phase, "indeterminate");
    assert.equal(
      opts.events.some((e) => e.name === "acceptReceipt"),
      false,
    );
  } finally {
    await cleanAbort(g);
  }
  const bad = configuration({ authorizeDrain: async () => [] });
  const g2 = await openNativeGuardian(bad);
  try {
    await assert.rejects(g2.drain());
    assert.equal(g2.state.phase, "open");
  } finally {
    await cleanAbort(g2);
  }
});

test("receipt journal failure never becomes successful cleanup authority", async () => {
  const opts = configuration();
  opts.journal.acceptReceipt = async () => {
    throw new Error("disk_failed");
  };
  const g = await openNativeGuardian(opts);
  try {
    await g.launch("native");
    await assert.rejects(g.drain(), /disk_failed/);
    assert.equal(g.state.phase, "indeterminate");
  } finally {
    await cleanAbort(g);
  }
});

test("controller channel loss drains descendants but produces no accepted receipt", async () => {
  const path = join(scratch, "abort.writes"),
    opts = configuration({ roots: [pythonRoot(writerScript(path))] });
  const g = await openNativeGuardian(opts);
  await g.launch("native");
  await until(() => size(path) > 2);
  await cleanAbort(g);
  const n = size(path);
  await delay(60);
  assert.equal(size(path), n);
  assert.equal(
    opts.events.some((e) => e.name === "acceptReceipt"),
    false,
  );
  assert.ok(opts.events.some((e) => e.name === "indeterminate"));
});

test("guardian crash cannot be certified by a replacement empty lifetime", async () => {
  const opts = configuration(),
    g = await openNativeGuardian(opts);
  process.kill(g.state.guardianIdentity.pid, "SIGKILL");
  await until(() => g.state.phase === "indeterminate");
  await cleanAbort(g);
  assert.equal(
    opts.events.some((e) => e.name === "acceptReceipt"),
    false,
  );
  const replacement = await openNativeGuardian(configuration());
  try {
    const receipt = await replacement.drain();
    assert.notEqual(receipt.lifetimeId, g.state.lifetimeId);
  } finally {
    await cleanAbort(replacement);
  }
});

test("oversize and out-of-order private frames fail closed before any spawn", async () => {
  for (const message of [
    Buffer.from([0, 0, 128, 1]),
    Buffer.from([0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 2]),
  ]) {
    const child = spawn(executable, ["--private-fd-v1"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const ended = once(child, "exit");
    child.stdio[3].on("error", () => {});
    child.stdio[3].resume();
    child.stdio[3].write(message);
    const [code] = await ended;
    assert.equal(code, 103);
  }
});

test("pin and environment errors are rejected before a lifetime is created", async () => {
  const opts = configuration({ sha256: "0".repeat(64) });
  await assert.rejects(openNativeGuardian(opts));
  assert.equal(opts.events.length, 0);
  const env = configuration();
  env.roots[0].env.CODER_SESSION_TOKEN = "SYNTHETIC_FORBIDDEN";
  await assert.rejects(openNativeGuardian(env));
  assert.equal(env.events.length, 0);
});

test("a leader's exit does not hide live writer threads", async () => {
  const path = join(scratch, "thread.writes");
  const script = `import ctypes,os,threading,time\ndef write():\n f=open(${JSON.stringify(path)},'ab',buffering=0)\n while True:f.write(b'x');time.sleep(.01)\nthreading.Thread(target=write).start()\ntime.sleep(.05)\nctypes.CDLL(None).syscall(60,0)\n`;
  const g = await openNativeGuardian(configuration({ roots: [pythonRoot(script)] }));
  try {
    await g.launch("native");
    await until(() => size(path) > 8);
    assert.equal(g.state.phase, "open");
    await g.drain();
    const n = size(path);
    await delay(60);
    assert.equal(size(path), n);
  } finally {
    await cleanAbort(g);
  }
});

test("bounded concurrent forks remain owned while drain closes the tree", async () => {
  const path = join(scratch, "fork.writes");
  const script = `import os,time\nfor i in range(16):\n if os.fork()==0:\n  f=open(${JSON.stringify(path)},'ab',buffering=0)\n  while True:f.write(b'x');time.sleep(.01)\n time.sleep(.01)\nwhile True:time.sleep(1)\n`;
  const g = await openNativeGuardian(configuration({ roots: [pythonRoot(script)] }));
  try {
    await g.launch("native");
    await until(() => size(path) > 3);
    const started = Date.now();
    const receipt = await g.drain();
    assert.ok(Date.now() - started < 5000);
    assert.ok(receipt.reaped >= 2);
    const n = size(path);
    await delay(60);
    assert.equal(size(path), n);
  } finally {
    await cleanAbort(g);
  }
});

test("owned ptrace relationships do not turn a stopped child into an empty tree", async () => {
  const path = join(scratch, "ptrace.writes");
  const script = `import ctypes,os,signal,time\nlib=ctypes.CDLL(None)\np=os.fork()\nif p==0:\n assert lib.ptrace(0,0,0,0)==0\n os.kill(os.getpid(),signal.SIGSTOP)\n f=open(${JSON.stringify(path)},'ab',buffering=0)\n while True:f.write(b'x');time.sleep(.01)\nos.waitpid(p,os.WUNTRACED)\nassert lib.ptrace(7,p,0,0)==0\nwhile True:time.sleep(1)\n`;
  const g = await openNativeGuardian(configuration({ roots: [pythonRoot(script)] }));
  try {
    await g.launch("native");
    await until(() => size(path) > 2);
    await g.drain();
    const n = size(path);
    await delay(60);
    assert.equal(size(path), n);
  } finally {
    await cleanAbort(g);
  }
});

test("an inherited unlinked writable FD stops changing only after the owned tree drains", async () => {
  const path = join(scratch, "unlinked.writes");
  writeFileSync(path, "");
  const observed = openSync(path, "r");
  const script = `import os,time\nf=open(${JSON.stringify(path)},'ab',buffering=0)\nos.unlink(${JSON.stringify(path)})\nif os.fork()>0:\n while True:time.sleep(1)\nos.setsid()\nif os.fork()>0:os._exit(0)\nwhile True:f.write(b'x');time.sleep(.01)\n`;
  const g = await openNativeGuardian(configuration({ roots: [pythonRoot(script)] }));
  try {
    await g.launch("native");
    await until(() => fstatSync(observed).size > 2);
    await g.drain();
    const n = fstatSync(observed).size;
    await delay(60);
    assert.equal(fstatSync(observed).size, n);
  } finally {
    await cleanAbort(g);
    closeSync(observed);
  }
});

test("an exact private-frame replay acknowledges the same PID without another fork", async () => {
  const root = python,
    rootFd = openSync(root, "r"),
    cwdFd = openSync(scratch, "r");
  const pinned = fstatSync(rootFd, { bigint: true }),
    project = randomUUID();
  const child = spawn(executable, ["--private-fd-v1"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", rootFd, cwdFd],
    env: { PATH: "/usr/bin:/bin" },
  });
  closeSync(rootFd);
  closeSync(cwdFd);
  const ended = once(child, "exit"),
    channel = child.stdio[3];
  channel.on("error", () => {});
  let input = Buffer.alloc(0),
    pending;
  channel.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4 && input.length >= 4 + input.readUInt32BE()) {
      const length = input.readUInt32BE(),
        value = JSON.parse(input.subarray(4, 4 + length));
      input = input.subarray(4 + length);
      assert.ok(pending);
      const resolve = pending;
      pending = null;
      resolve(value);
    }
  });
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(n);
    return b;
  };
  const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const send = (op, id, parts = []) =>
    new Promise((resolve) => {
      assert.equal(pending, undefined);
      pending = resolve;
      const body = Buffer.concat([u32(op), u32(id), ...parts]);
      channel.write(Buffer.concat([u32(body.length), body]));
    });
  // Explicit wire fixture, separate from the installed client's encoder.
  try {
    await send(1, 1, [
      u32(1),
      str(randomUUID()),
      str("a".repeat(64)),
      str("b".repeat(64)),
      str("c".repeat(64)),
      u32(1),
      str(project),
      str("d".repeat(64)),
      u32(1),
      str("native"),
      u32(1),
      u32(4),
      u32(5),
      u64(pinned.dev),
      u64(pinned.ino),
      u64(pinned.size),
      u32(Number(pinned.mode)),
      u32(Number(pinned.uid)),
      u64(pinned.mtimeNs / 1000000000n),
      u32(Number(pinned.mtimeNs % 1000000000n)),
      u64(pinned.ctimeNs / 1000000000n),
      u32(Number(pinned.ctimeNs % 1000000000n)),
      u32(4),
      str(root),
      str("-I"),
      str("-c"),
      str("import time; time.sleep(100)"),
      u32(1),
      str("PATH=/usr/bin:/bin"),
    ]);
    pending = undefined;
    await send(2, 2);
    pending = undefined;
    const first = await send(3, 3, [u32(1), u32(0)]);
    pending = undefined;
    const replay = await send(3, 3, [u32(1), u32(0)]);
    assert.deepEqual(replay, first);
    pending = undefined;
    await send(4, 4, [
      u32(1),
      str("b".repeat(64)),
      u32(1),
      str(project),
      str("d".repeat(64)),
      str(randomUUID()),
    ]);
    pending = undefined;
    const result = await send(5, 5, [u32(2)]);
    assert.equal(result.phase, "drained");
    assert.equal(result.reaped, 1);
    pending = undefined;
    await send(6, 6, [u32(2), u32(5)]);
    assert.equal((await ended)[0], 0);
  } finally {
    channel.destroy();
    await ended;
  }
});

test("a completed terminal helper does not revoke another active root", async () => {
  const options = configuration();
  const terminal = python;
  options.roots.push({
    id: "attach",
    role: "terminal",
    executable: terminal,
    sha256: hash(terminal),
    cwd: scratch,
    args: ["-I", "-c", "pass"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const g = await openNativeGuardian(options);
  try {
    await g.launch("native");
    await g.launch("attach");
    await delay(100);
    assert.equal(
      g.state.phase,
      "open",
      JSON.stringify({
        failure: g.state.failure ?? null,
        journalReasons: options.events
          .filter((event) => event.name === "indeterminate")
          .map((event) => event.data.reason),
      }),
    );
    const receipt = await g.drain();
    assert.equal(receipt.reaped, 2);
  } finally {
    await cleanAbort(g);
  }
});
