import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { guardianWire } from "../templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs";
import { openGuardedHost } from "../templates/ai-dev-k8s/scripts/codex-host-guardian.mjs";
import { processParentPid } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import { buildNativeGuardian } from "./build-native-guardian.mjs";

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("fixture_deadline");
}
function fixture(t, { tmux = false, rejectBarrier = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hive-host-guardian-")),
    packageDirectory = join(directory, "package");
  const build = buildNativeGuardian(resolve("."), packageDirectory);
  copyFileSync(
    "templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs",
    join(packageDirectory, "codex-guardian-worker.mjs"),
  );
  const project = { projectId: randomUUID(), bindingDigest: "b".repeat(64) };
  const marker = join(directory, "ready.json"),
    barrier = join(directory, "barrier.json"),
    ptyMarker = join(directory, "pty.json"),
    writer = join(directory, "writer");
  const ptyScript = `import os,pty,json\npid,master=pty.fork()\nif pid==0: os.execve('/usr/bin/tmux',['tmux','-S',${JSON.stringify(join(directory, "tmux.sock"))},'attach-session','-t','=guardian-fixture'],{'PATH':'/usr/bin:/bin','TERM':'xterm-256color'})\nwith open(${JSON.stringify(ptyMarker)},'w') as f: json.dump({'pid':os.getpid(),'child':pid},f)\nwhile True: os.read(master,8192)`;
  const script = `import {connectGuardianWorker} from './codex-guardian-worker.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
const guard=await connectGuardianWorker({onLost:()=>{},onCloseAdmission:async value=>{let rejected=false;try{guard.assertAdmission(token)}catch{rejected=true};writeFileSync(${JSON.stringify(barrier)},JSON.stringify({...value,executionRejected:rejected}));${rejectBarrier ? "throw new Error('fixture_barrier_failure');" : ""}}});
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
setInterval(()=>{},1000);`;
  writeFileSync(join(packageDirectory, "fixture-worker.mjs"), script, { mode: 0o600 });
  execFileSync(process.execPath, ["--check", join(packageDirectory, "fixture-worker.mjs")], {
    stdio: "pipe",
  });
  const files = Object.fromEntries(
    ["codex-native-guardian", "codex-guardian-worker.mjs", "fixture-worker.mjs"].map((name) => [
      name,
      hash(join(packageDirectory, name)),
    ]),
  );
  writeFileSync(
    join(packageDirectory, "package-manifest.json"),
    JSON.stringify({ schemaVersion: 1, guardian: build, files }),
    { mode: 0o600 },
  );
  let allow = false;
  const options = {
    packageDirectory,
    packageManifestSha256: hash(join(packageDirectory, "package-manifest.json")),
    workerName: "fixture-worker.mjs",
    nodeExecutable: realpathSync(process.execPath),
    nodeSha256: hash(realpathSync(process.execPath)),
    workerCwd: directory,
    stateDirectory: join(directory, "outer"),
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
  await assert.rejects(host.drain(), /active project/);
  assert.equal(host.state.phase, "open");
  assert.equal(existsSync(`/proc/${worker.pid}`), true);
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
