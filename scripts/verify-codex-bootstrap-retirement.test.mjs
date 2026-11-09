import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  applyEmptyRoot,
  initializeEmptyRoot,
  readUnusedBootstrapRoot,
} from "../templates/ai-dev-k8s/scripts/codex-empty-root.mjs";
import { openGuardedHost } from "../templates/ai-dev-k8s/scripts/codex-host-guardian.mjs";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import { archiveBootstrapProjectState } from "../templates/ai-dev-k8s/scripts/codex-project-controller.mjs";
import { readBootstrapConfigHistory } from "../templates/ai-dev-k8s/scripts/codex-workspace-host-outer.mjs";
import { buildNativeGuardian } from "./build-native-guardian.mjs";

const root = mkdtempSync(join(tmpdir(), "hive-bootstrap-retirement-")),
  node = join(root, "node");
copyFileSync(process.execPath, node);
chmodSync(node, 0o500);
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (v) => createHash("sha256").update(v).digest("hex"),
  hash = (p) => sha(readFileSync(p)),
  canonical = (v) =>
    `${JSON.stringify(
      (function sort(x) {
        return Array.isArray(x)
          ? x.map(sort)
          : x && typeof x === "object"
            ? Object.fromEntries(
                Object.keys(x)
                  .sort()
                  .map((k) => [k, sort(x[k])]),
              )
            : x;
      })(v),
    )}\n`,
  url = (name) => pathToFileURL(resolve("templates/ai-dev-k8s/scripts", name)).href,
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
function rewrite(path, key, mutate) {
  const saved = JSON.parse(readFileSync(path));
  mutate(saved.state);
  saved.signature = createHmac("sha256", readFileSync(key))
    .update(JSON.stringify(saved.state))
    .digest("hex");
  writeFileSync(path, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
}
// Scope only this fixture's process observation; CI may host unrelated same-UID
// nondumpable processes. Canonical /proc inspection remains fail closed. Old C
// actors are still checked directly by the actual bootstrap retirement code.
const captureFixtureCode = `import sys,json,os,importlib.util
from pathlib import Path
p=json.load(sys.stdin);spec=importlib.util.spec_from_file_location('fixture_managed',p['module']);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
original=Path.iterdir;tracked={os.getpid(),os.getppid()}
def scoped(path):
 return iter(Path('/proc')/str(pid) for pid in tracked) if path==Path('/proc') else original(path)
Path.iterdir=scoped
if p['denyTracked']:
 readlink=os.readlink
 def denied(path,*args,**kwargs):
  if str(path)==f'/proc/{os.getpid()}/cwd':raise PermissionError('fixture tracked actor denied')
  return readlink(path,*args,**kwargs)
 os.readlink=denied
manager=m.ManagedProjects(p['home']);print(json.dumps(manager._capture_unused_bootstrap_root()))`;
function captureFixtureRoot(home, denyTracked = false) {
  return JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-c", captureFixtureCode], {
      input: JSON.stringify({
        home,
        denyTracked,
        module: resolve("templates/ai-dev-k8s/scripts/managed-projects.py"),
      }),
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeout: 10000,
      maxBuffer: 32768,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}
async function fixture(t, unused = false) {
  const dir = mkdtempSync(join(root, "case-")),
    home = join(dir, "home"),
    pkg = join(dir, "package");
  mkdirSync(home, { mode: 0o700 });
  const guardianDir = join(home, ".local/state/hive/codex-host-guardian"),
    projectDir = join(home, ".local/state/hive/codex-project-controller"),
    history = join(home, ".local/state/hive/codex-host-install/config-history");
  for (const p of [guardianDir, projectDir, history])
    mkdirSync(p, { recursive: true, mode: 0o700 });
  const config = {
    schemaVersion: 1,
    enabled: true,
    profile: "software",
    binding: Object.fromEntries(
      ["ownerId", "workspaceId", "templateId", "buildId", "agentId", "appId", "hiveUserId"].map(
        (k) => [k, randomUUID()],
      ),
    ),
    hiveOrigin: "https://hive.fixture.invalid",
    issuerPublicKeyPem: generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString(),
    issuerKeyId: "fixture",
    port: 13341,
    model: "gpt-6.1-sol",
    effort: "low",
    managerEnabled: true,
    nativeIsolationEnabled: true,
    guardianEnabled: true,
  };
  config.binding.coderOrigin = "https://coder.fixture.invalid";
  config.binding.appOrigin = "https://app.fixture.invalid";
  const openedProject = unused
    ? {
        schemaVersion: 1,
        projectId: randomUUID(),
        requestId: randomUUID(),
        repositoryId: "123",
        expectedAccountId: "456",
      }
    : null;
  if (unused) initializeEmptyRoot(home);
  const worker = `import {connectGuardianWorker} from ${JSON.stringify(url("codex-guardian-worker.mjs"))};
import {createProjectController} from ${JSON.stringify(url("codex-project-controller.mjs"))};
import fs from 'node:fs';const {config,projectDir,openedProject}=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "worker-input.json"))}));let controller;
const guard=await connectGuardianWorker({startup:{configSha256:config.sha,port:config.port},onLost:()=>{},onCloseAdmission:v=>controller.closeAdmission(v),onFinishClose:async()=>{await controller.close();return{}}});
controller=createProjectController({stateDirectory:projectDir,ownerId:config.binding.ownerId,workspaceId:config.binding.workspaceId,model:config.model,effort:config.effort},{guardian:guard,guardianBuildId:config.binding.buildId,resolveRepository:async()=>({schemaVersion:1,providerAccountId:'456',repository:{providerRepositoryId:'123'},defaultRevision:'a'.repeat(40)})});
if(openedProject)await controller.handle('/projects/open',openedProject);
await guard.ready({configSha256:config.sha,port:config.port});setInterval(()=>{},1000);`;
  const build = buildNativeGuardian(resolve("."), pkg);
  writeFileSync(join(pkg, "worker.mjs"), worker, { mode: 0o600 });
  writeFileSync(
    join(pkg, "package-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      guardian: build,
      files: {
        "codex-native-guardian": hash(join(pkg, "codex-native-guardian")),
        "worker.mjs": hash(join(pkg, "worker.mjs")),
      },
    }),
    { mode: 0o600 },
  );
  const children = [];
  const prepare = (cfg) => {
    const raw = canonical(cfg),
      digest = sha(raw);
    writeFileSync(join(history, `${digest}.json`), raw, { mode: 0o600 });
    return {
      configSha256: digest,
      bindingDigest: sha(
        JSON.stringify({
          schemaVersion: 1,
          configSha256: digest,
          packageManifestSha256: hash(join(pkg, "package-manifest.json")),
        }),
      ),
    };
  };
  const options = (cfg) => {
    const pins = prepare(cfg);
    return {
      packageDirectory: pkg,
      packageManifestSha256: hash(join(pkg, "package-manifest.json")),
      workerName: "worker.mjs",
      nodeExecutable: node,
      nodeSha256: hash(node),
      workerCwd: home,
      stateDirectory: guardianDir,
      bindingDigest: pins.bindingDigest,
      startup: {
        schemaVersion: 1,
        type: "start",
        nonce: Buffer.alloc(32).toString("base64url"),
        configSha256: pins.configSha256,
        packageManifestSha256: hash(join(pkg, "package-manifest.json")),
        nodeSha256: hash(node),
        port: cfg.port,
      },
      authorizeAdmission: async () => {
        throw Error("fixture admits no projects");
      },
      authorizeDrain: async () => [],
      prepareBootstrapRetirement: (proof) => {
        readBootstrapConfigHistory(home, proof.configSha256, cfg);
        return archiveBootstrapProjectState(
          {
            stateDirectory: projectDir,
            guardianStateDirectory: guardianDir,
            ...Object.fromEntries(
              ["ownerId", "workspaceId", "templateId", "buildId"].map((k) => [k, cfg.binding[k]]),
            ),
            ...(unused ? { captureUnusedRoot: () => captureFixtureRoot(home) } : {}),
          },
          proof,
        );
      },
    };
  };
  const start = async (cfg, crashAfterProject = false) => {
    const opts = options(cfg),
      pins = prepare(cfg);
    writeFileSync(
      join(dir, "worker-input.json"),
      JSON.stringify({ config: { ...cfg, sha: pins.configSha256 }, projectDir, openedProject }),
      { mode: 0o600 },
    );
    const input = join(dir, "outer-input.json");
    writeFileSync(
      input,
      JSON.stringify({
        options: opts,
        config: cfg,
        home,
        projectDir,
        guardianDir,
        crashAfterProject,
        unused,
      }),
      { mode: 0o600 },
    );
    const entry = join(dir, "outer.mjs");
    writeFileSync(
      entry,
      `import fs from 'node:fs';import{openGuardedHost}from ${JSON.stringify(url("codex-host-guardian.mjs"))};import{archiveBootstrapProjectState}from ${JSON.stringify(url("codex-project-controller.mjs"))};import{execFileSync}from'node:child_process';import{resolve}from'node:path';const captureFixtureCode=${JSON.stringify(captureFixtureCode)};const captureFixtureRoot=${captureFixtureRoot.toString()};import{readBootstrapConfigHistory}from ${JSON.stringify(url("codex-workspace-host-outer.mjs"))};const v=JSON.parse(fs.readFileSync(${JSON.stringify(input)}));const host=await openGuardedHost({...v.options,authorizeAdmission:async()=>{throw Error('fixture admission forbidden')},authorizeDrain:async()=>[],prepareBootstrapRetirement:proof=>{readBootstrapConfigHistory(v.home,proof.configSha256,v.config);const result=archiveBootstrapProjectState({stateDirectory:v.projectDir,guardianStateDirectory:v.guardianDir,...Object.fromEntries(['ownerId','workspaceId','templateId','buildId'].map(k=>[k,v.config.binding[k]])),...(v.unused?{captureUnusedRoot:()=>captureFixtureRoot(v.home)}:{})},proof);if(v.crashAfterProject)process.exit(29);return result;}});console.log('ready');setInterval(()=>{},1000);`,
      { mode: 0o600 },
    );
    const child = spawn(node, [entry], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HIVE_WORKSPACE_PROFILE: "software" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "",
      error = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      error += b;
    });
    for (let n = 0; n < 500; n++) {
      if (output.includes("ready")) return child;
      if (child.exitCode !== null || child.signalCode) {
        if (crashAfterProject && child.exitCode === 29) return child;
        throw Error(error);
      }
      await delay(10);
    }
    throw Error("fixture readiness timeout");
  };
  const kill = async (child) => {
    if (child.exitCode === null && !child.signalCode) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
    await delay(100);
  };
  t.after(async () => {
    for (const c of children) await kill(c);
  });
  const old = await start(config);
  await kill(old);
  const next = { ...config, binding: { ...config.binding, buildId: randomUUID() } };
  return {
    dir,
    home,
    guardianDir,
    projectDir,
    history,
    config,
    next,
    options,
    start,
    kill,
    lifetime: join(guardianDir, "lifetime.json"),
    key: join(guardianDir, "key"),
    projects: join(projectDir, "projects.json"),
    projectKey: join(projectDir, "projects.key"),
    captureRoot: (denyTracked) => captureFixtureRoot(home, denyTracked),
  };
}

test("ordinary OPEN survives actual unused bootstrap restart with raw archives and unchanged auth bytes", async (t) => {
  const f = await fixture(t, true),
    oldOuter = readFileSync(f.lifetime),
    oldProject = readFileSync(f.projects),
    oldRoot = readFileSync(join(f.home, ".local/state/hive/managed-projects/root.json")),
    authDir = join(f.home, ".local/share/hive/codex-native/codex");
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const auth = Buffer.from('{"fixture":"opaque auth bytes, never consumed"}\n');
  writeFileSync(join(authDir, "auth.json"), auth, { mode: 0o600 });
  const originalEntries = JSON.parse(oldProject).state.projects;
  assert.equal(Object.keys(originalEntries).length, 1);
  const next = await f.start(f.next),
    current = JSON.parse(readFileSync(f.lifetime)).state.events[4].value,
    proof = readUnusedBootstrapRoot(f.home, current, f.next);
  assert.equal(proof.oldBuildId, f.config.binding.buildId);
  assert.equal(proof.newBuildId, f.next.binding.buildId);
  assert.equal(proof.rootRecordSha256, sha(oldRoot));
  assert.deepEqual(JSON.parse(readFileSync(f.projects)).state.projects, originalEntries);
  const archive = JSON.parse(
    readFileSync(join(f.projectDir, `projects-bootstrap-${sha(oldOuter)}.json`)),
  ).state;
  assert.equal(archive.projectRaw, oldProject.toString());
  assert.equal(archive.unusedRoot.raw, oldRoot.toString());
  assert(
    readFileSync(join(f.guardianDir, `lifetime-bootstrap-${sha(oldOuter)}.json`)).equals(oldOuter),
  );
  assert(readFileSync(join(authDir, "auth.json")).equals(auth));
  assert.equal(current.projects.length, 0);
  assert.equal(current.generation, 1);
  assert(!existsSync(join(f.home, ".local/state/hive/codex-project-supervisor/registry.json")));
  await f.kill(next);
});
test("unused bootstrap startup permits only a positive outer parent change and retains exact signed history", async (t) => {
  const f = await fixture(t, true),
    next = await f.start(f.next),
    retained = readFileSync(f.lifetime),
    startup = JSON.parse(retained).state.events[4].value,
    live = structuredClone(startup),
    rootPath = join(f.home, ".local/state/hive/managed-projects/root.json"),
    rootBytes = readFileSync(rootPath),
    projectBytes = readFileSync(f.projects);
  live.outerIdentity.parentPid = startup.outerIdentity.parentPid === 1 ? 2 : 1;
  const proof = readUnusedBootstrapRoot(f.home, live, f.next);
  assert.equal(proof.newBuildId, f.next.binding.buildId);
  for (const actor of ["outerIdentity", "guardianIdentity", "workerIdentity"]) {
    for (const field of ["pid", "startTime", "bootId", "executable", "device", "inode"]) {
      const changed = structuredClone(live);
      changed[actor][field] =
        field === "pid" ? changed[actor][field] + 1 : `${changed[actor][field]}-changed`;
      assert.throws(
        () => readUnusedBootstrapRoot(f.home, changed, f.next),
        /unused_bootstrap_proof_invalid/,
        `${actor}.${field}`,
      );
    }
  }
  for (const actor of ["guardianIdentity", "workerIdentity"]) {
    const changed = structuredClone(live);
    changed[actor].parentPid++;
    assert.throws(
      () => readUnusedBootstrapRoot(f.home, changed, f.next),
      /unused_bootstrap_proof_invalid/,
      `${actor}.parentPid`,
    );
  }
  for (const parentPid of [0, -1, 1.5, "1", undefined]) {
    const changed = structuredClone(live);
    changed.outerIdentity.parentPid = parentPid;
    assert.throws(
      () => readUnusedBootstrapRoot(f.home, changed, f.next),
      /unused_bootstrap_proof_invalid/,
    );
  }
  for (const [field, value] of [
    ["generation", 2],
    ["projects", [{ projectId: randomUUID() }]],
    ["workerSha256", "0".repeat(64)],
    ["guardianSha256", "0".repeat(64)],
    ["configSha256", "0".repeat(64)],
    ["packageManifestSha256", "0".repeat(64)],
    ["unexpected", true],
  ]) {
    assert.throws(
      () => readUnusedBootstrapRoot(f.home, { ...live, [field]: value }, f.next),
      /unused_bootstrap_proof_invalid/,
      field,
    );
  }
  rewrite(f.lifetime, f.key, (state) => {
    state.events[4].value.outerIdentity.parentPid = 0;
  });
  assert.throws(
    () => readUnusedBootstrapRoot(f.home, live, f.next),
    /unused_bootstrap_proof_invalid/,
  );
  writeFileSync(f.lifetime, retained);
  const archivePath = join(f.guardianDir, `lifetime-bootstrap-${proof.outerArchiveSha256}.json`),
    archiveBytes = readFileSync(archivePath);
  writeFileSync(archivePath, Buffer.concat([archiveBytes, Buffer.from(" ")]));
  assert.throws(
    () => readUnusedBootstrapRoot(f.home, live, f.next),
    /bootstrap_archive_history_invalid/,
  );
  writeFileSync(archivePath, archiveBytes);
  assert.deepEqual(readUnusedBootstrapRoot(f.home, live, f.next), proof);
  assert(readFileSync(f.lifetime).equals(retained));
  assert(readFileSync(f.projects).equals(projectBytes));
  assert(readFileSync(rootPath).equals(rootBytes));
  await f.kill(next);
});
test("unused OPEN retirement resumes after inner reset without duplicate archives or mapping root", async (t) => {
  const f = await fixture(t, true),
    raw = readFileSync(f.projects),
    outer = readFileSync(f.lifetime),
    rootPath = join(f.home, ".local/state/hive/managed-projects/root.json"),
    rootRaw = readFileSync(rootPath);
  await f.start(f.next, true);
  assert(readFileSync(rootPath).equals(rootRaw));
  const archivePath = join(f.projectDir, `projects-bootstrap-${sha(outer)}.json`),
    archive = readFileSync(archivePath),
    next = await f.start(f.next),
    current = JSON.parse(readFileSync(f.lifetime)).state.events[4].value;
  assert(readFileSync(archivePath).equals(archive));
  assert.equal(JSON.parse(archive).state.projectRaw, raw.toString());
  assert(readFileSync(rootPath).equals(rootRaw));
  assert.equal(readUnusedBootstrapRoot(f.home, current, f.next).rootRecordSha256, sha(rootRaw));
  await f.kill(next);
});
test("unused root descriptor is cross-language canonical and rejects foreign grant digest before mapping", () => {
  const proposal = JSON.parse(readFileSync(resolve("scripts/fixtures/unused-bootstrap-root.json"))),
    digest = sha(canonical(proposal).trimEnd()),
    python = execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        "import json,hashlib,sys;v=json.load(sys.stdin);print(hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest())",
      ],
      { input: JSON.stringify(proposal), encoding: "utf8" },
    ).trim();
  assert.equal(python, digest);
  assert.throws(
    () =>
      applyEmptyRoot("/unused", proposal, "not-an-enrollment", {
        exp: Math.floor(Date.now() / 1000) + 30,
        emptyRoot: { proposalDigest: digest, unusedBootstrapDigest: "0".repeat(64) },
      }),
    /empty_root_authority_rejected/,
  );
});
test("unused descriptor holds a pending locator and changed current project journal", async (t) => {
  const f = await fixture(t, true),
    next = await f.start(f.next),
    startup = JSON.parse(readFileSync(f.lifetime)).state.events[4].value,
    pointer = join(f.projectDir, "unused-bootstrap.json"),
    pointerRaw = readFileSync(pointer),
    projectRaw = readFileSync(f.projects);
  rewrite(pointer, f.projectKey, (p) => {
    p.phase = "pending";
  });
  assert.throws(
    () => readUnusedBootstrapRoot(f.home, startup, f.next),
    /unused_bootstrap_proof_invalid/,
  );
  writeFileSync(pointer, pointerRaw);
  rewrite(f.projects, f.projectKey, (s) => {
    Object.values(s.projects)[0].task = { phase: "preparing" };
  });
  assert.throws(
    () => readUnusedBootstrapRoot(f.home, startup, f.next),
    /unused_bootstrap_proof_invalid/,
  );
  writeFileSync(f.projects, projectRaw);
  assert(readUnusedBootstrapRoot(f.home, startup, f.next));
  await f.kill(next);
});
test("fixture projection still holds on a denied tracked process without changing root bytes", async (t) => {
  const f = await fixture(t, true),
    path = join(f.home, ".local/state/hive/managed-projects/root.json"),
    raw = readFileSync(path);
  assert.throws(
    () => f.captureRoot(true),
    (error) => error.stderr.toString().includes("process_inspection_unavailable"),
  );
  assert(readFileSync(path).equals(raw));
  assert(!existsSync(join(f.projectDir, "unused-bootstrap.json")));
});
test("two actual abrupt bootstrap restarts retain signed history without claiming native closure", async (t) => {
  const f = await fixture(t),
    first = readFileSync(f.lifetime);
  const second = await f.start(f.next);
  await f.kill(second);
  const third = await f.start({ ...f.next, binding: { ...f.next.binding, buildId: randomUUID() } });
  const archives = readdirSync(f.guardianDir).filter((p) => p.startsWith("lifetime-bootstrap-"));
  assert.equal(archives.length, 2);
  assert(archives.some((p) => readFileSync(join(f.guardianDir, p)).equals(first)));
  assert.equal(
    readdirSync(f.projectDir).filter((p) => p.startsWith("projects-bootstrap-")).length,
    2,
  );
  for (const name of readdirSync(f.guardianDir).filter((p) =>
    p.startsWith("bootstrap-retirement-"),
  )) {
    const saved = JSON.parse(readFileSync(join(f.guardianDir, name)));
    assert.equal(
      saved.signature,
      createHmac("sha256", readFileSync(f.key)).update(JSON.stringify(saved.state)).digest("hex"),
    );
    assert.equal(saved.state.nativeTreeExited, false);
    assert.equal(saved.state.cleanupAuthorized, false);
    assert.equal(saved.state.scope, "never_admitted_bootstrap_authorization_only");
  }
  await f.kill(third);
});
test("crash after the inner reset retries without duplicate retirement or loss of old signed bytes", async (t) => {
  const f = await fixture(t),
    raw = readFileSync(f.lifetime);
  await f.start(f.next, true);
  assert(readFileSync(f.lifetime).equals(raw));
  const next = await f.start(f.next);
  assert.equal(
    readdirSync(f.guardianDir).filter((p) => p.startsWith("lifetime-bootstrap-")).length,
    1,
  );
  assert.equal(
    readdirSync(f.projectDir).filter((p) => p.startsWith("projects-bootstrap-")).length,
    1,
  );
  await f.kill(next);
});
for (const sealedFacts of [false, true]) {
  test(`a different build resumes an actual interrupted bootstrap retirement (outer facts sealed: ${sealedFacts})`, async (t) => {
    const f = await fixture(t),
      raw = readFileSync(f.lifetime);
    await f.start(f.next, true);
    const pending = readdirSync(f.guardianDir).find((name) =>
        name.startsWith("bootstrap-pending-"),
      ),
      pendingPath = join(f.guardianDir, pending),
      pendingBytes = readFileSync(pendingPath),
      projectArchive = readdirSync(f.projectDir).find((name) =>
        name.startsWith("projects-bootstrap-"),
      ),
      projectBytes = readFileSync(join(f.projectDir, projectArchive)),
      proof = JSON.parse(pendingBytes).state,
      projectEvidence = JSON.parse(projectBytes).state.projectEvidence;
    assert.equal(projectEvidence.buildId, f.next.binding.buildId);
    const factPath = join(f.guardianDir, `bootstrap-retirement-${sha(raw)}.json`);
    if (sealedFacts) {
      // Fault boundary after the original outer fact write but before rename.
      const state = { ...proof, projectEvidence };
      writeFileSync(
        factPath,
        JSON.stringify({
          state,
          signature: createHmac("sha256", readFileSync(f.key))
            .update(JSON.stringify(state))
            .digest("hex"),
        }),
        { mode: 0o600 },
      );
    }
    const factBytes = sealedFacts ? readFileSync(factPath) : null;
    const configC = { ...f.next, binding: { ...f.next.binding, buildId: randomUUID() } },
      currentPins = f.options(configC),
      third = await f.start(configC);
    assert.notEqual(currentPins.bindingDigest, proof.nextBindingDigest);
    assert(readFileSync(pendingPath).equals(pendingBytes));
    assert(readFileSync(join(f.projectDir, projectArchive)).equals(projectBytes));
    if (factBytes) assert(readFileSync(factPath).equals(factBytes));
    assert.equal(
      JSON.parse(readFileSync(factPath)).state.projectEvidence.buildId,
      f.next.binding.buildId,
    );
    const archived = readdirSync(f.guardianDir).filter((name) =>
      name.startsWith("lifetime-bootstrap-"),
    );
    assert.equal(archived.length, 1);
    assert(readFileSync(join(f.guardianDir, archived[0])).equals(raw));
    const current = JSON.parse(readFileSync(f.lifetime)).state;
    assert.equal(current.bindingDigest, currentPins.bindingDigest);
    assert.equal(current.phase, "startupReady");
    assert.equal(current.receipts.length, 0);
    assert.deepEqual(
      current.events.map((event) => event.name),
      ["begin", "ready", "launchIntent", "open", "startupReady"],
    );
    await f.kill(third);
  });
}
for (const failure of ["signature", "foreign_lifetime", "old_binding"]) {
  test(`interrupted retirement rejects altered pending proof: ${failure}`, async (t) => {
    const f = await fixture(t);
    await f.start(f.next, true);
    const pending = readdirSync(f.guardianDir).find((name) =>
        name.startsWith("bootstrap-pending-"),
      ),
      path = join(f.guardianDir, pending);
    if (failure === "signature") {
      const saved = JSON.parse(readFileSync(path));
      saved.signature = "0".repeat(64);
      writeFileSync(path, JSON.stringify(saved));
    } else
      rewrite(path, f.key, (state) => {
        if (failure === "foreign_lifetime") state.lifetimeId = randomUUID();
        else state.nextBindingDigest = state.bindingDigest;
      });
    const outer = readFileSync(f.lifetime),
      project = readFileSync(f.projects);
    await assert.rejects(
      openGuardedHost(
        f.options({ ...f.next, binding: { ...f.next.binding, buildId: randomUUID() } }),
      ),
    );
    assert(readFileSync(f.lifetime).equals(outer));
    assert(readFileSync(f.projects).equals(project));
    assert.equal(
      readdirSync(f.guardianDir).filter((name) => name.startsWith("lifetime-bootstrap-")).length,
      0,
    );
  });
}
test("a tampered earlier bootstrap archive cannot authorize a later restart", async (t) => {
  const f = await fixture(t),
    next = await f.start(f.next);
  await f.kill(next);
  const prior = readdirSync(f.projectDir).find((name) => name.startsWith("projects-bootstrap-")),
    path = join(f.projectDir, prior),
    saved = JSON.parse(readFileSync(path));
  saved.state.projectState.projects[randomUUID()] = {};
  writeFileSync(path, JSON.stringify(saved));
  const raw = readFileSync(f.lifetime),
    current = readFileSync(f.projects);
  await assert.rejects(
    openGuardedHost(
      f.options({ ...f.next, binding: { ...f.next.binding, buildId: randomUUID() } }),
    ),
  );
  assert(readFileSync(f.lifetime).equals(raw));
  assert(readFileSync(f.projects).equals(current));
});
for (const failure of [
  "native_admission",
  "receipt",
  "controller",
  "pending_launch",
  "project",
  "project_hold",
  "project_open_extra",
  "project_open_badaccount",
  "project_open_duplicate",
  "project_tamper",
  "missing_project_proof",
  "tamper",
  "live_worker",
  "ambiguous_identity",
  "cross_workspace",
  "cross_template",
  "cross_hive_user",
  "config_tamper",
  "config_missing",
  "config_symlink",
  "real_history",
  "uncorroborated_history",
]) {
  test(`bootstrap retirement preserves uncertain history: ${failure}`, async (t) => {
    const f = await fixture(t);
    if (failure === "native_admission")
      rewrite(f.lifetime, f.key, (s) =>
        s.events.push({ name: "admissionIntent", value: {}, at: Date.now() }),
      );
    if (failure === "receipt") rewrite(f.lifetime, f.key, (s) => s.receipts.push({}));
    if (["controller", "pending_launch"].includes(failure))
      writeFileSync(
        join(f.guardianDir, "controller.json"),
        JSON.stringify({ state: { hold: true, pending: { action: "launch" } } }),
        { mode: 0o600 },
      );
    if (failure === "project")
      rewrite(f.projects, f.projectKey, (s) => {
        s.projects[randomUUID()] = { task: { phase: "preparing" } };
      });
    if (failure.startsWith("project_open_"))
      rewrite(f.projects, f.projectKey, (s) => {
        const id = randomUUID(),
          p = {
            projectId: id,
            repositoryId: "123",
            expectedAccountId: "456",
            createdAt: Date.now(),
            task: null,
          };
        s.projects[id] = p;
        if (failure === "project_open_extra") p.unknown = true;
        if (failure === "project_open_badaccount") p.expectedAccountId = "";
        if (failure === "project_open_duplicate") {
          const other = randomUUID();
          s.projects[other] = { ...p, projectId: other };
        }
      });
    if (failure === "project_hold")
      rewrite(f.projects, f.projectKey, (s) => {
        s.guardianBarrier = { reason: "guardian_channel_lost" };
      });
    if (failure === "project_tamper") {
      const s = JSON.parse(readFileSync(f.projects));
      s.state.projects[randomUUID()] = {};
      writeFileSync(f.projects, JSON.stringify(s));
    }
    if (failure === "missing_project_proof") rmSync(f.projects);
    if (failure === "tamper") {
      const s = JSON.parse(readFileSync(f.lifetime));
      s.state.events[0].value.projects.push({});
      writeFileSync(f.lifetime, JSON.stringify(s));
    }
    if (failure === "live_worker") {
      const p = processIdentity(process.pid);
      rewrite(f.lifetime, f.key, (s) => {
        s.events[3].value.workerPid = p.pid;
        s.events[4].value.workerIdentity = {
          ...p,
          parentPid: s.events[4].value.guardianIdentity.pid,
        };
      });
      rewrite(f.projects, f.projectKey, (s) => {
        s.hostProcess = p;
      });
    }
    if (failure === "cross_workspace") f.next.binding.workspaceId = randomUUID();
    if (failure === "cross_template") f.next.binding.templateId = randomUUID();
    if (failure === "cross_hive_user") f.next.binding.hiveUserId = randomUUID();
    const cfg = join(f.history, `${sha(canonical(f.config))}.json`);
    if (failure === "config_tamper") writeFileSync(cfg, "{}\n");
    if (failure === "config_missing") rmSync(cfg);
    if (failure === "config_symlink") {
      const other = join(f.dir, "old-public.json");
      copyFileSync(cfg, other);
      rmSync(cfg);
      symlinkSync(other, cfg);
    }
    if (failure === "real_history")
      writeFileSync(join(f.projectDir, "projects-idle-existing.json"), "{}");
    if (failure === "uncorroborated_history")
      copyFileSync(f.projects, join(f.projectDir, `projects-bootstrap-${"a".repeat(64)}.json`));
    const raw = readFileSync(f.lifetime),
      project = existsSync(f.projects) ? readFileSync(f.projects) : null;
    const options = f.options(f.next),
      read = fs.readFileSync,
      oldPid = JSON.parse(read(f.lifetime)).state.events[4].value.outerIdentity.pid;
    if (failure === "ambiguous_identity") {
      fs.readFileSync = (path, ...args) => {
        if (String(path) === `/proc/${oldPid}/stat`)
          throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
        return read(path, ...args);
      };
      syncBuiltinESMExports();
    }
    try {
      await assert.rejects(openGuardedHost(options));
    } finally {
      fs.readFileSync = read;
      syncBuiltinESMExports();
    }
    assert(readFileSync(f.lifetime).equals(raw));
    if (project) assert(readFileSync(f.projects).equals(project));
    assert.equal(
      readdirSync(f.guardianDir).filter((p) => p.startsWith("lifetime-bootstrap-")).length,
      0,
    );
  });
}
test("installer config preservation is bounded, private, no-follow and repeatable", (t) => {
  const dir = mkdtempSync(join(root, "config-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = resolve("templates/ai-dev-k8s/scripts/install-codex-host.py");
  execFileSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `import importlib.util,pathlib,os,sys,hashlib
os.umask(0o077);s=importlib.util.spec_from_file_location('installed',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);d=pathlib.Path(sys.argv[2]);p=d/'current.json';p.write_bytes(b'{}\\n');m.preserve_public_config(p,d);m.preserve_public_config(p,d);h=d/'config-history';files=list(h.iterdir());assert len(files)==1 and files[0].read_bytes()==b'{}\\n' and files[0].stat().st_mode&0o777==0o600
p.write_bytes(b'{"next":true}\\n');m.preserve_public_config(p,d);assert len(list(h.iterdir()))==2;files=list(h.iterdir())
(h/(hashlib.sha256(b'{}\\n').hexdigest()+'.json')).write_bytes(b'tampered');p.write_bytes(b'{}\\n')
try:m.preserve_public_config(p,d);raise AssertionError('accepted conflicting history')
except RuntimeError:pass
p.unlink();p.symlink_to(files[1])
try:m.preserve_public_config(p,d);raise AssertionError('followed symlink')
except OSError:pass
p.unlink();p.write_bytes(b'x'*16385)
try:m.preserve_public_config(p,d);raise AssertionError('accepted oversized configuration')
except RuntimeError:pass
p.write_bytes(b'{"next":true}\\n')
for i in range(254):(h/('bounded-'+str(i))).write_bytes(b'{}')
m.preserve_public_config(p,d)
p.write_bytes(b'{"new":true}\\n')
try:m.preserve_public_config(p,d);raise AssertionError('exceeded history bound')
except RuntimeError:pass
`,
      source,
      dir,
    ],
    { stdio: "pipe" },
  );
});
