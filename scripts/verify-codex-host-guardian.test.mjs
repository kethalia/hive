import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import {
  guardianStartChallenge,
  readGuardianStart,
} from "../templates/ai-dev-k8s/scripts/codex-guardian-startup.mjs";
import {
  guardianApplicationRequest,
  guardianWire,
} from "../templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs";
import { openGuardedHost } from "../templates/ai-dev-k8s/scripts/codex-host-guardian.mjs";
import { processParentPid } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import {
  createGuardedRollover,
  installedWorkerCwd,
} from "../templates/ai-dev-k8s/scripts/codex-workspace-host-outer.mjs";
import { buildNativeGuardian } from "./build-native-guardian.mjs";

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

test("installed worker uses private package root even when home is group writable", (t) => {
  const home = mkdtempSync(join(tmpdir(), "hive-worker-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  chmodSync(home, 0o775);
  const root = join(home, ".local/share/hive/codex-host");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assert.equal(installedWorkerCwd(home), root);
  chmodSync(root, 0o770);
  assert.throws(() => installedWorkerCwd(home));
});
async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("fixture_deadline");
}
function fixture(
  t,
  {
    tmux = false,
    rejectBarrier = false,
    startup = false,
    mismatch = false,
    readyDelay = 0,
    applications = false,
    installerConfig = null,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "hive-host-guardian-")),
    packageDirectory = join(directory, "package");
  const build = buildNativeGuardian(resolve("."), packageDirectory);
  // setup-node caches can be owned by another account or group writable.
  // Pin a private copy; never relax the production executable ownership policy.
  const nodeExecutable = installerConfig ? realpathSync(process.execPath) : join(directory, "node");
  if (!installerConfig) {
    copyFileSync(realpathSync(process.execPath), nodeExecutable);
    chmodSync(nodeExecutable, 0o500);
  }
  const configSha = installerConfig
    ? createHash("sha256")
        .update(`${JSON.stringify(installerConfig)}\n`)
        .digest("hex")
    : "c".repeat(64);
  const listenPort = installerConfig?.port ?? 32123;
  copyFileSync(
    "templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs",
    join(packageDirectory, "codex-guardian-worker.mjs"),
  );
  const project = { projectId: randomUUID(), bindingDigest: "b".repeat(64) };
  const marker = join(directory, "ready.json"),
    barrier = join(directory, "barrier.json"),
    ptyMarker = join(directory, "pty.json"),
    writer = join(directory, "writer");
  const ptyScript = `import os,pty,json\npid,master=pty.fork()\nif pid==0: os.execve('/usr/bin/tmux',['tmux','-S',${JSON.stringify(join(directory, "tmux.sock"))},'attach-session','-t','=guardian-fixture'],{'PATH':'/usr/bin:/bin','TERM':'xterm-256color'})\nwith open(${JSON.stringify(`${ptyMarker}.tmp`)},'w') as f: json.dump({'pid':os.getpid(),'child':pid},f)\nos.replace(${JSON.stringify(`${ptyMarker}.tmp`)},${JSON.stringify(ptyMarker)})\nwhile True: os.read(master,8192)`;
  const script = `import {connectGuardianWorker} from './codex-guardian-worker.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
${installerConfig ? `import {createServer} from 'node:http'; const server=createServer((req,res)=>{res.writeHead(200);res.end('ok')});await new Promise(r=>server.listen(${listenPort},'127.0.0.1',r));` : ""}
const guard=await connectGuardianWorker({${startup ? `startup:{configSha256:'${mismatch ? "d".repeat(64) : configSha}',port:${listenPort}},` : ""}onLost:()=>{},onFinishClose:async()=>{},onCloseAdmission:async value=>{let rejected=false;try{guard.assertAdmission(token)}catch{rejected=true};writeFileSync(${JSON.stringify(barrier)},JSON.stringify({...value,executionRejected:rejected}));${rejectBarrier ? "throw new Error('fixture_barrier_failure');" : ""}return {closed:true,barrierId:value.barrierId,snapshots:value.projects.map(p=>({projectId:p.projectId}))}}});
let token=await guard.admit(${JSON.stringify(project)});token=await guard.executionFence(token);guard.assertAdmission(token);
${
  tmux
    ? `const socket=${JSON.stringify(join(directory, "tmux.sock"))};
const tmux=spawn('/usr/bin/tmux',['-D','-S',socket,'-f','/dev/null'],{env:{PATH:'/usr/bin:/bin',HOME:${JSON.stringify(directory)},TERM:'xterm-256color'},stdio:'ignore'});
for(let i=0;i<100&&!existsSync(socket);i++)await new Promise(r=>setTimeout(r,10));
execFileSync('/usr/bin/tmux',['-S',socket,'new-session','-d','-s','guardian-fixture','/usr/bin/python3','-I','-c',${JSON.stringify(`import time\nf=open(${JSON.stringify(writer)},'a')\nwhile True: f.write('x'); f.flush(); time.sleep(.01)`)}],{stdio:'ignore'});
spawn('/usr/bin/python3',['-I','-c',${JSON.stringify(ptyScript)}],{env:{PATH:'/usr/bin:/bin'},stdio:'ignore'});`
    : "const tmux={pid:null};"
}
writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,tmuxPid:tmux.pid,token}));
${startup ? `await new Promise(r=>setTimeout(r,${readyDelay}));await guard.ready({configSha256:'${configSha}',port:${listenPort}});` : ""}
${
  applications
    ? `const appId='${randomUUID()}',opId='${randomUUID()}',ctx={revisionId:'${randomUUID()}',version:1,headSha:'${"b".repeat(40)}'};
const results=[];results.push(await guard.applyReserve({projectId:'${project.projectId}',applicationId:appId,publicationOperationId:opId,targetSourceContext:ctx,expectedAppliedSourceContext:null}));
results.push(await guard.applyVerify({projectId:'${project.projectId}',applicationId:appId}));
results.push(await guard.applyCommit({projectId:'${project.projectId}',applicationId:appId}));
let rejected=false;try{await guard.applyCommit({projectId:'${project.projectId}',applicationId:appId,appliedReceipt:{untrusted:true}})}catch{rejected=true}
writeFileSync(${JSON.stringify(join(directory, "applications.json"))},JSON.stringify({results,rejected}));`
    : ""
}
setInterval(()=>{},1000);`;
  writeFileSync(join(packageDirectory, "fixture-worker.mjs"), script, { mode: 0o600 });
  if (installerConfig)
    copyFileSync(
      join(packageDirectory, "fixture-worker.mjs"),
      join(packageDirectory, "codex-workspace-host-worker.mjs"),
    );
  execFileSync(process.execPath, ["--check", join(packageDirectory, "fixture-worker.mjs")], {
    stdio: "pipe",
  });
  const files = Object.fromEntries(
    [
      "codex-native-guardian",
      "codex-guardian-worker.mjs",
      "fixture-worker.mjs",
      ...(installerConfig ? ["codex-workspace-host-worker.mjs"] : []),
    ].map((name) => [name, hash(join(packageDirectory, name))]),
  );
  writeFileSync(
    join(packageDirectory, "package-manifest.json"),
    JSON.stringify({ schemaVersion: 1, guardian: build, files }),
    { mode: 0o600 },
  );
  let allow = false;
  const applicationCalls = [];
  const options = {
    ...Object.fromEntries(
      ["ApplyReserve", "ApplyVerify", "ApplyCommit"].map((action) => [
        `controller${action}`,
        async (value) => {
          applicationCalls.push({ action, value });
          return { action };
        },
      ]),
    ),
    packageDirectory,
    packageManifestSha256: hash(join(packageDirectory, "package-manifest.json")),
    workerName: "fixture-worker.mjs",
    nodeExecutable,
    nodeSha256: hash(nodeExecutable),
    workerCwd: directory,
    stateDirectory: installerConfig
      ? join(directory, ".local/state/hive/codex-host-guardian")
      : join(directory, "outer"),
    bindingDigest: "a".repeat(64),
    authorizeAdmission: async (value) => {
      assert.deepEqual(value, project);
      return value;
    },
    authorizeDrain: async (value) => {
      assert.equal(allow, true, "active project must be preserved");
      return value.projects.map((entry) => ({ ...entry, decisionId: randomUUID() }));
    },
  };
  if (startup)
    options.startup = {
      schemaVersion: 1,
      type: "start",
      nonce: Buffer.alloc(32, 1).toString("base64url"),
      configSha256: configSha,
      port: listenPort,
      nodeSha256: options.nodeSha256,
      packageManifestSha256: options.packageManifestSha256,
    };
  let host;
  t.after(async () => {
    if (host && host.state.phase !== "closed") {
      const result = await host.abort();
      assert.notEqual(result.held, true);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    applicationCalls,
    options,
    project,
    marker,
    barrier,
    writer,
    ptyMarker,
    allow: () => {
      allow = true;
    },
    open: async () => {
      host = await openGuardedHost(options);
      return host;
    },
  };
}

test("outer worker barrier refuses active project then drains actual tmux descendants and preserves a durable receipt", async (t) => {
  const f = fixture(t, { tmux: true }),
    host = await f.open();
  await until(() => existsSync(f.marker) && existsSync(f.writer) && existsSync(f.ptyMarker));
  const worker = JSON.parse(readFileSync(f.marker));
  const pty = JSON.parse(readFileSync(f.ptyMarker));
  assert.equal(host.state.workerPid, worker.pid);
  assert.equal(processParentPid(worker.pid), host.state.guardian.guardianIdentity.pid);
  assert.equal(processParentPid(worker.tmuxPid), worker.pid);
  assert.equal(processParentPid(pty.pid), worker.pid);
  assert.equal(processParentPid(pty.child), pty.pid);
  assert.deepEqual(host.state.guardian.projects, [f.project]);
  const before = readFileSync(f.writer).length;
  await delay(40);
  assert.ok(readFileSync(f.writer).length > before);
  f.allow();
  const receipt = await host.drain();
  assert.equal(receipt.cleanupAuthorized, false);
  assert.equal(receipt.finalWaitResult, "ECHILD");
  assert.equal(existsSync(`/proc/${worker.pid}`), false);
  assert.equal(existsSync(`/proc/${worker.tmuxPid}`), false);
  assert.equal(existsSync(`/proc/${pty.pid}`), false);
  assert.equal(existsSync(`/proc/${pty.child}`), false);
  const after = readFileSync(f.writer).length;
  await delay(40);
  assert.equal(readFileSync(f.writer).length, after);
  const barrier = JSON.parse(readFileSync(f.barrier));
  assert.deepEqual(barrier.projects, [f.project]);
  assert.equal(barrier.executionRejected, true);
  const journal = JSON.parse(readFileSync(join(f.options.stateDirectory, "lifetime.json")));
  assert.equal(journal.state.phase, "closed");
  assert.equal(journal.state.receipts.length, 1);
  assert.equal(journal.state.receipts[0].lifetimeId, receipt.lifetimeId);
});
test("an exited guardian receipt must replay before starting a replacement lifetime", async (t) => {
  const f = fixture(t);
  f.options.acceptTreeReceipt = async () => {
    throw Error("lost_tree_ack");
  };
  const first = await f.open();
  await until(() => existsSync(f.marker));
  f.allow();
  await assert.rejects(first.drain(), /lost_tree_ack/);
  const journal = JSON.parse(readFileSync(join(f.options.stateDirectory, "lifetime.json")));
  assert.equal(journal.state.phase, "treeExited");
  let replayed;
  f.options.recoverTreeReceipt = async (receipt) => {
    replayed = receipt;
  };
  const second = await f.open();
  assert.equal(replayed.guardianExited, true);
  assert.notEqual(second.state.guardian.lifetimeId, replayed.lifetimeId);
});
test("rollover starts exactly one fresh worker only after durable closure and archive", async (t) => {
  const f = fixture(t);
  f.options.postTreeClosed = async () => ({ eligible: true, archived: true });
  f.allow();
  let launches = 0,
    archived = 0;
  const rollover = createGuardedRollover(async () => {
    launches++;
    return {
      host: await f.open(),
      authority: {
        archiveClosedController: async () => {
          assert.equal(
            JSON.parse(readFileSync(join(f.options.stateDirectory, "lifetime.json"))).state.phase,
            "closed",
          );
          archived++;
        },
      },
    };
  });
  const first = await rollover.start();
  const lifetime = first.state.guardian.lifetimeId;
  await Promise.all([rollover.trigger(first), rollover.trigger(first)]);
  assert.equal(launches, 2);
  assert.equal(archived, 1);
  assert.equal(rollover.state.held, false);
  assert.notEqual(rollover.state.host.guardian.lifetimeId, lifetime);
});
test("rollover retains an ineligible or failed closure without starting a new worker", async () => {
  for (const fails of [false, true]) {
    let launches = 0;
    const host = {
      state: { rolloverEligible: false },
      async drain() {
        if (fails) throw Error("uncertain");
        return {};
      },
    };
    const rollover = createGuardedRollover(async () => {
      launches++;
      return {
        host,
        authority: {
          archiveClosedController: async () => {
            throw Error("unexpected");
          },
        },
      };
    });
    await rollover.start();
    await rollover.trigger(host);
    assert.equal(launches, 1);
    assert.equal(rollover.state.held, true);
  }
});
test("installer re-entry recognizes the current worker after two real guardian lifetimes", async (t) => {
  // The installer requires the outer and worker to use the same pinned Node.
  // setup-node's cache may be root-owned or group-writable on hosted runners;
  // run this entire fixture under a private executable instead of weakening pinning.
  const currentNode = realpathSync(process.execPath),
    nodeStat = statSync(currentNode);
  if (nodeStat.uid !== process.getuid() || (nodeStat.mode & 0o22) !== 0) {
    const privateDir = mkdtempSync(join(tmpdir(), "hive-installer-node-"));
    try {
      const privateNode = join(privateDir, "node");
      copyFileSync(currentNode, privateNode);
      chmodSync(privateNode, 0o500);
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      let output;
      try {
        output = execFileSync(
          privateNode,
          [
            "--test",
            "--test-reporter=tap",
            "--test-name-pattern=^installer re-entry recognizes the current worker after two real guardian lifetimes$",
            resolve("scripts/verify-codex-host-guardian.test.mjs"),
          ],
          { encoding: "utf8", timeout: 120000, stdio: "pipe", env: childEnv },
        );
      } catch (error) {
        throw new Error(
          `private Node installer fixture failed: ${error.stdout ?? ""} ${error.stderr ?? ""}`,
          { cause: error },
        );
      }
      assert.match(output, /# pass 1\b/);
    } finally {
      rmSync(privateDir, { recursive: true, force: true });
    }
    return;
  }
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const config = {
    binding: { appOrigin: `http://127.0.0.1:${port}` },
    guardianEnabled: true,
    port,
  };
  const f = fixture(t, { startup: true, installerConfig: config });
  f.options.postTreeClosed = async () => ({ eligible: true, archived: true });
  f.allow();
  let archives = 0;
  const rollover = createGuardedRollover(async () => ({
    host: await f.open(),
    authority: {
      archiveClosedController: async () => {
        archives++;
      },
    },
  }));
  const first = await rollover.start();
  const ready = first.startupAttestation();
  const home = f.directory,
    state = join(home, ".local/state/hive/codex-host-install"),
    configDir = join(home, ".config/hive");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configBytes = `${JSON.stringify(config)}\n`,
    configSha = createHash("sha256").update(configBytes).digest("hex");
  writeFileSync(join(configDir, "codex-host.json"), configBytes, { mode: 0o600 });
  const identity = Object.fromEntries(
    ["pid", "startTime", "bootId", "executable"].map((key) => [key, ready.outerIdentity[key]]),
  );
  const receipt = {
    schemaVersion: 1,
    archiveSha256: "d".repeat(64),
    configSha256: configSha,
    bootstrapConfigSha256: configSha,
    runtimeIdentity: {},
    process: identity,
    guardianStartup: { start: f.options.startup, ready },
  };
  const receiptPath = join(state, "process.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rollover.trigger(first);
  assert.equal(archives, 1);
  assert.notEqual(rollover.state.host.guardian.lifetimeId, ready.lifetimeId);
  const python = `import importlib.util,json,os,sys,types\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('installer',sys.argv[1]);i=importlib.util.module_from_spec(s);s.loader.exec_module(i)\nhome,target,config=sys.argv[2],Path(sys.argv[3]),json.loads(sys.argv[4])\nos.environ['HIVE_WORKSPACE_PROFILE']='software'\ni.pwd.getpwuid=lambda _:types.SimpleNamespace(pw_dir=home)\ni.decode_archive=lambda _:b'fixture'\ni.validate_execution_config=lambda _:None\ni.install_package=lambda *_:target\ni.normalize_agent_config=lambda c,_:(c,{})\ni.same_build_identity=lambda *_:None\ni.subprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=0)\ni.subprocess.check_output=lambda *a,**k:b'24'\nprint(json.dumps(i.install({'schemaVersion':1,'archive':'fixture','config':config,'archiveSha256':'d'*64})))`;
  const result = JSON.parse(
    execFileSync(
      "/usr/bin/python3",
      [
        "-c",
        python,
        resolve("templates/ai-dev-k8s/scripts/install-codex-host.py"),
        home,
        f.options.packageDirectory,
        JSON.stringify(config),
      ],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
  assert.equal(result.status, "already_running");
  const updated = JSON.parse(readFileSync(receiptPath));
  assert.equal(updated.process.pid, ready.outerIdentity.pid);
  assert.equal(updated.guardianStartup.ready.lifetimeId, rollover.state.host.guardian.lifetimeId);
  assert.notEqual(updated.guardianStartup.ready.workerIdentity.pid, ready.workerIdentity.pid);
  assert.equal(updated.guardianStartup.start.nonce, receipt.guardianStartup.start.nonce);
  const journalPath = join(f.options.stateDirectory, "lifetime.json"),
    original = readFileSync(journalPath),
    key = readFileSync(join(f.options.stateDirectory, "key"));
  for (const corrupt of [
    (value) => {
      value.nonce = "A".repeat(43);
    },
    (value) => {
      value.workerIdentity.startTime = String(Number(value.workerIdentity.startTime) + 1);
    },
    (value) => {
      value.workerIdentity.parentPid = value.outerIdentity.pid;
    },
  ]) {
    const saved = JSON.parse(original),
      entry = [...saved.state.events].reverse().find((event) => event.name === "startupReady");
    corrupt(entry.value);
    saved.signature = createHmac("sha256", key).update(JSON.stringify(saved.state)).digest("hex");
    writeFileSync(journalPath, JSON.stringify(saved));
    assert.throws(() =>
      execFileSync(
        "/usr/bin/python3",
        [
          "-c",
          python,
          resolve("templates/ai-dev-k8s/scripts/install-codex-host.py"),
          home,
          f.options.packageDirectory,
          JSON.stringify(config),
        ],
        { encoding: "utf8", timeout: 10000, stdio: "pipe" },
      ),
    );
    assert.deepEqual(JSON.parse(readFileSync(receiptPath)), updated);
  }
  writeFileSync(journalPath, original);
});

test("startup attestation waits for worker readiness and pins nonce, config, package and exact kernel chain", async (t) => {
  const f = fixture(t, { startup: true, readyDelay: 150 });
  let resolved = false;
  const opening = f.open().then((host) => {
    resolved = true;
    return host;
  });
  await until(() => existsSync(f.marker));
  assert.equal(resolved, false);
  const host = await opening,
    ready = host.startupAttestation();
  for (const key of ["nonce", "configSha256", "nodeSha256", "packageManifestSha256", "port"])
    assert.equal(ready[key], f.options.startup[key]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.workerIdentity.pid, host.state.workerPid);
  assert.equal(ready.workerIdentity.parentPid, ready.guardianIdentity.pid);
  assert.equal(ready.guardianIdentity.parentPid, process.pid);
  assert.equal(ready.outerIdentity.pid, process.pid);
  assert.equal(
    ready.guardianSha256,
    hash(join(f.options.packageDirectory, "codex-native-guardian")),
  );
  assert.deepEqual(ready.projects, [f.project]);
  const saved = JSON.parse(readFileSync(join(f.options.stateDirectory, "lifetime.json")));
  assert.equal(saved.state.events.filter((event) => event.name === "startupReady").length, 1);
  await host.abort();
  assert.throws(() => host.startupAttestation(), /host_guardian_rejected/);
});

test("startup challenge mismatch cannot attest or leave a worker running", async (t) => {
  const f = fixture(t, { startup: true, mismatch: true });
  await assert.rejects(f.open());
  assert.equal(existsSync(f.marker), false);
  const saved = JSON.parse(readFileSync(join(f.options.stateDirectory, "lifetime.json")));
  assert.equal(
    saved.state.events.some((event) => event.name === "startupReady"),
    false,
  );
  assert.equal(saved.state.receipts.length, 0);
});

test("private installer startup framing rejects duplicates, extra keys, oversized input and timeout", async () => {
  const challenge = {
    schemaVersion: 1,
    type: "start",
    nonce: Buffer.alloc(32, 1).toString("base64url"),
    configSha256: "a".repeat(64),
    nodeSha256: "b".repeat(64),
    packageManifestSha256: "c".repeat(64),
    port: 32123,
  };
  assert.throws(
    () => guardianStartChallenge({ ...challenge, argv: [] }),
    /guardian_startup_rejected/,
  );
  for (const kind of ["duplicate", "oversized", "timeout"]) {
    const [server, client] = duplexPair();
    const start = readGuardianStart({ stream: server, timeoutMs: 30 });
    if (kind === "duplicate")
      client.write(`${JSON.stringify(challenge)}\n${JSON.stringify(challenge)}\n`);
    if (kind === "oversized") client.write("x".repeat(32769));
    await assert.rejects(start, /guardian_startup_channel_lost/);
    client.destroy();
  }
  const [server, client] = duplexPair();
  const start = readGuardianStart({ stream: server });
  client.write(`${JSON.stringify(challenge)}\n`);
  const channel = await start;
  await assert.rejects(
    channel.ready({
      ...challenge,
      type: "ready",
      nonce: Buffer.alloc(32, 2).toString("base64url"),
    }),
    /guardian_startup_rejected/,
  );
  let received = "";
  client.on("data", (data) => {
    received += data;
  });
  await channel.ready({ ...challenge, type: "ready" });
  assert.equal(JSON.parse(received).nonce, challenge.nonce);
  await assert.rejects(channel.ready({ ...challenge, type: "ready" }), /guardian_startup_rejected/);
  client.destroy();
});

test("uncertain old lifetime cannot be adopted or restarted from an empty new guardian", async (t) => {
  const f = fixture(t),
    host = await f.open();
  await until(() => existsSync(f.marker));
  await host.abort();
  await assert.rejects(openGuardedHost(f.options), /host_guardian_rejected/);
});

test("failed durable worker barrier cannot produce a planned drain receipt or permit restart", async (t) => {
  const f = fixture(t, { rejectBarrier: true }),
    host = await f.open();
  await until(() => existsSync(f.marker));
  f.allow();
  await assert.rejects(host.drain(), /guardian_worker_request_rejected/);
  assert.equal(host.state.phase, "indeterminate");
  await host.abort();
  const saved = JSON.parse(readFileSync(join(f.options.stateDirectory, "lifetime.json")));
  assert.equal(saved.state.receipts.length, 0);
  await assert.rejects(openGuardedHost(f.options), /host_guardian_rejected/);
});

test("worker import tampering is rejected before any guardian lifetime", async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.options.packageDirectory, "codex-guardian-worker.mjs"),
    "throw new Error('tampered')",
  );
  await assert.rejects(f.open(), /host_guardian_rejected/);
  assert.equal(existsSync(f.options.stateDirectory), false);
});

test("private worker channel rejects repeated request IDs and bounded oversized frames", async () => {
  for (const oversized of [false, true]) {
    const [server, client] = duplexPair();
    let lost = false,
      calls = 0;
    const wire = guardianWire(
      server,
      {
        fence: async () => {
          calls++;
          return null;
        },
      },
      () => {
        lost = true;
      },
    );
    client.resume();
    const frame = `${JSON.stringify({ protocolVersion: 1, type: "request", id: 1, method: "fence", value: null })}\n`;
    client.write(oversized ? "x".repeat(32769) : frame);
    if (!oversized) {
      await until(() => calls === 1);
      client.write(frame);
    }
    await until(() => lost);
    assert.equal(calls, oversized ? 0 : 1);
    wire.close();
    client.destroy();
  }
});

test("three fixed application FD3 methods admit only the owned project and carry no worker-provided journal receipt", async (t) => {
  const f = fixture(t, { startup: true, applications: true }),
    host = await f.open();
  await until(() => existsSync(join(f.directory, "applications.json")));
  const record = JSON.parse(readFileSync(join(f.directory, "applications.json")));
  assert.deepEqual(record.results, [
    { action: "ApplyReserve" },
    { action: "ApplyVerify" },
    { action: "ApplyCommit" },
  ]);
  assert.equal(record.rejected, true);
  assert.equal(host.state.phase, "open");
  assert.deepEqual(
    f.applicationCalls.map((c) => c.action),
    ["ApplyReserve", "ApplyVerify", "ApplyCommit"],
  );
  for (const c of f.applicationCalls) assert.equal(c.value.projectId, f.project.projectId);
});
test("application private request schemas reject nonfixed actions, foreign fields and malformed contexts", () => {
  const projectId = randomUUID(),
    applicationId = randomUUID(),
    publicationOperationId = randomUUID(),
    targetSourceContext = { revisionId: randomUUID(), version: 1, headSha: "a".repeat(40) };
  for (const action of ["applyReserve", "applyVerify", "applyCommit"]) {
    const v =
      action === "applyReserve"
        ? {
            projectId,
            applicationId,
            publicationOperationId,
            targetSourceContext,
            expectedAppliedSourceContext: null,
          }
        : { projectId, applicationId };
    assert.deepEqual(guardianApplicationRequest(action, v), v);
    assert.throws(() => guardianApplicationRequest(action, { ...v, appliedReceipt: {} }));
    assert.throws(() => guardianApplicationRequest(action, { ...v, projectId: "not-a-uuid" }));
  }
  assert.throws(() => guardianApplicationRequest("arbitrary", { projectId, applicationId }));
  assert.throws(() =>
    guardianApplicationRequest("applyReserve", {
      projectId,
      applicationId,
      publicationOperationId,
      targetSourceContext: { ...targetSourceContext, version: 0 },
      expectedAppliedSourceContext: null,
    }),
  );
});
