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
async function fixture(t) {
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
  const worker = `import {connectGuardianWorker} from ${JSON.stringify(url("codex-guardian-worker.mjs"))};
import {createProjectController} from ${JSON.stringify(url("codex-project-controller.mjs"))};
import fs from 'node:fs';const {config,projectDir}=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "worker-input.json"))}));let controller;
const guard=await connectGuardianWorker({startup:{configSha256:config.sha,port:config.port},onLost:()=>{},onCloseAdmission:v=>controller.closeAdmission(v),onFinishClose:async()=>{await controller.close();return{}}});
controller=createProjectController({stateDirectory:projectDir,ownerId:config.binding.ownerId,workspaceId:config.binding.workspaceId,model:config.model,effort:config.effort},{guardian:guard,guardianBuildId:config.binding.buildId});
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
      JSON.stringify({ config: { ...cfg, sha: pins.configSha256 }, projectDir }),
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
      }),
      { mode: 0o600 },
    );
    const entry = join(dir, "outer.mjs");
    writeFileSync(
      entry,
      `import fs from 'node:fs';import{openGuardedHost}from ${JSON.stringify(url("codex-host-guardian.mjs"))};import{archiveBootstrapProjectState}from ${JSON.stringify(url("codex-project-controller.mjs"))};import{readBootstrapConfigHistory}from ${JSON.stringify(url("codex-workspace-host-outer.mjs"))};const v=JSON.parse(fs.readFileSync(${JSON.stringify(input)}));const host=await openGuardedHost({...v.options,authorizeAdmission:async()=>{throw Error('fixture admission forbidden')},authorizeDrain:async()=>[],prepareBootstrapRetirement:proof=>{readBootstrapConfigHistory(v.home,proof.configSha256,v.config);const result=archiveBootstrapProjectState({stateDirectory:v.projectDir,guardianStateDirectory:v.guardianDir,...Object.fromEntries(['ownerId','workspaceId','templateId','buildId'].map(k=>[k,v.config.binding[k]]))},proof);if(v.crashAfterProject)process.exit(29);return result;}});console.log('ready');setInterval(()=>{},1000);`,
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
  };
}

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
