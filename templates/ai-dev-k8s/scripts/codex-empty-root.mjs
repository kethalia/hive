// Fixed private installed enrollment seam. No CLI/model-selected mapping authority.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBootstrapProjectHistory } from "./codex-project-controller.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (v) =>
  JSON.stringify(
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
  );
function run(home, operation, proposal, grant, claims, lifetimeId, unusedBootstrap) {
  const code = `import sys,json,importlib.util,pathlib,time
sys.dont_write_bytecode=True
p=json.load(sys.stdin);source=pathlib.Path(p['module']);spec=importlib.util.spec_from_file_location('empty_managed',source);m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m);manager=m.ManagedProjects.installed(p['home'])
if p['operation']=='initialize':
 if not (manager.state/'root.json').exists():
  with manager.lock():pass
 result=None
elif p['operation']=='capture':result=manager._capture_unused_bootstrap_root()
elif p['operation']=='inspect':result=manager._inspect_empty_root(manager._installed_observer,p["lifetimeId"],p.get("unusedBootstrap"))
else:
 class Authority:
  guardian=manager._installed_observer
  def verify(self,proposal):
   m.require(manager._empty_digest(proposal)==p['claims']['emptyRoot']['proposalDigest'] and p['claims']['exp']*1000>time.time()*1000,'empty_root_authority_expired')
   m.require(proposal.get('mode')!='initial-unused-remount' or p['claims']['emptyRoot'].get('unusedBootstrapDigest')==manager._empty_digest(proposal['unusedBootstrap']),'unused_bootstrap_grant_changed')
   return {'expiresAt':p['claims']['exp']*1000,'enrollmentToken':p['grant'],'anchor':p['claims']['emptyRoot']}
 result=manager._revalidate_empty_root(p['proposal'],Authority())
print(json.dumps(result,separators=(',',':')))`;
  const result = execFileSync("/usr/bin/python3", ["-I", "-c", code], {
    input: JSON.stringify({
      home,
      operation,
      proposal,
      grant,
      claims,
      lifetimeId,
      unusedBootstrap,
      module: join(dirname(fileURLToPath(import.meta.url)), "managed-projects.py"),
    }),
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
    maxBuffer: 32768,
  });
  return JSON.parse(result);
}
export function initializeEmptyRoot(home) {
  return run(home, "initialize");
}
export function captureUnusedBootstrapRoot(home) {
  return run(home, "capture");
}
export function inspectEmptyRoot(home, lifetimeId, startup, config) {
  if (!existsSync(join(home, ".local/state/hive/managed-projects/root.json"))) return null;
  const unusedBootstrap = startup && config ? readUnusedBootstrapRoot(home, startup, config) : null;
  const proposal = run(home, "inspect", null, null, null, lifetimeId, unusedBootstrap);
  if (proposal && Buffer.byteLength(JSON.stringify(proposal)) > 16384)
    throw new Error("empty_root_inventory_bound");
  return proposal;
}
export function applyEmptyRoot(home, proposal, grant, claims) {
  if (
    !proposal ||
    claims.emptyRoot?.proposalDigest !== sha(canonical(proposal)) ||
    claims.exp * 1000 <= Date.now() ||
    (proposal.mode === "initial-unused-remount" &&
      claims.emptyRoot?.unusedBootstrapDigest !== sha(canonical(proposal.unusedBootstrap)))
  )
    throw new Error("empty_root_authority_rejected");
  return run(home, "apply", proposal, grant, claims);
}

// A private locator is only an index into authenticated, fully retained bytes.
// It never authorizes mapping: the issuer's normal emptyRoot enrollment does.
export function readUnusedBootstrapRoot(home, startup, config) {
  const projectDir = join(home, ".local/state/hive/codex-project-controller"),
    outerDir = join(home, ".local/state/hive/codex-host-guardian"),
    locator = join(projectDir, "unused-bootstrap.json");
  try {
    lstatSync(locator);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const check = (v) => {
      if (!v) throw new Error("unused_bootstrap_proof_invalid");
    },
    read = (path, max = 4194304) => {
      check(realpathSync(path) === path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        check(
          st.isFile() &&
            st.nlink === 1 &&
            st.uid === process.getuid() &&
            !(st.mode & 0o077) &&
            st.size <= max,
        );
        const raw = readFileSync(fd);
        check(raw.length <= max);
        return raw;
      } finally {
        closeSync(fd);
      }
    },
    signed = (path, key) => {
      const raw = read(path),
        v = JSON.parse(raw),
        mac = createHmac("sha256", key).update(JSON.stringify(v.state)).digest("hex");
      check(
        typeof v.signature === "string" &&
          v.signature.length === 64 &&
          timingSafeEqual(Buffer.from(mac), Buffer.from(v.signature)),
      );
      return { raw, state: v.state };
    },
    key = read(join(projectDir, "projects.key"), 32),
    outerKey = read(join(outerDir, "key"), 32);
  check(key.length === 32 && outerKey.length === 32);
  for (const dir of [projectDir, outerDir]) {
    const st = lstatSync(dir);
    check(
      realpathSync(dir) === dir &&
        st.isDirectory() &&
        st.uid === process.getuid() &&
        !(st.mode & 0o077),
    );
  }
  const pointer = signed(locator, key).state;
  check(
    Object.keys(pointer).sort().join() ===
      "phase,projectArchiveSha256,schemaVersion,sourceJournalDigest" &&
      pointer.schemaVersion === 1 &&
      pointer.phase === "complete" &&
      /^[a-f0-9]{64}$/.test(pointer.sourceJournalDigest),
  );
  const name = `projects-bootstrap-${pointer.sourceJournalDigest}.json`,
    archive = signed(join(projectDir, name), key),
    previous = archive.state,
    original = signed(
      join(outerDir, `lifetime-bootstrap-${pointer.sourceJournalDigest}.json`),
      outerKey,
    ),
    facts = signed(
      join(outerDir, `bootstrap-retirement-${pointer.sourceJournalDigest}.json`),
      outerKey,
    ).state,
    history = verifyBootstrapProjectHistory({
      stateDirectory: projectDir,
      guardianStateDirectory: outerDir,
      ownerId: config.binding.ownerId,
      workspaceId: config.binding.workspaceId,
      templateId: config.binding.templateId,
    }),
    current = signed(join(projectDir, "projects.json"), key).state;
  check(
    sha(archive.raw) === pointer.projectArchiveSha256 &&
      sha(original.raw) === pointer.sourceJournalDigest &&
      previous.projectRaw &&
      previous.unusedRoot &&
      current.guardianLifetimeId === startup.lifetimeId &&
      canonical(current.projects) === canonical(previous.projectState.projects) &&
      Object.keys(current).sort().join() ===
        "guardianLifetimeId,hostProcess,ownerId,projects,schemaVersion,workspaceId" &&
      canonical(current.hostProcess) ===
        canonical(
          Object.fromEntries(
            ["pid", "startTime", "bootId", "executable", "device", "inode"].map((k) => [
              k,
              startup.workerIdentity[k],
            ]),
          ),
        ),
  );
  check(
    current.ownerId === config.binding.ownerId &&
      current.workspaceId === config.binding.workspaceId &&
      startup.generation === 1 &&
      startup.projects?.length === 0,
  );
  const currentOuter = signed(join(outerDir, "lifetime.json"), outerKey).state;
  check(
    currentOuter.phase === "startupReady" &&
      currentOuter.receipts.length === 0 &&
      currentOuter.events.map((e) => e.name).join() ===
        "begin,ready,launchIntent,open,startupReady" &&
      canonical(currentOuter.events[4].value) === canonical(startup),
  );
  const outerAllowed = new Set([
    "key",
    "guardian.lock",
    "lifetime.json",
    "controller-key.pem",
    "controller.json",
    ...history.guardianNames,
  ]);
  check(readdirSync(outerDir).every((n) => outerAllowed.has(n)));
  const allowed = new Set([
    "controller.lock",
    "projects.key",
    "projects.json",
    "unused-bootstrap.json",
    ...history.projectNames,
  ]);
  check(readdirSync(projectDir).every((n) => allowed.has(n)));
  const supervisor = join(home, ".local/state/hive/codex-project-supervisor");
  let supervisorExists = true;
  try {
    lstatSync(supervisor);
  } catch (error) {
    if (error.code === "ENOENT") supervisorExists = false;
    else throw error;
  }
  if (supervisorExists)
    check(
      lstatSync(supervisor).isDirectory() &&
        realpathSync(supervisor) === supervisor &&
        readdirSync(supervisor).length === 0,
    );
  const oldConfigRaw = read(
      join(
        home,
        ".local/state/hive/codex-host-install/config-history",
        `${facts.configSha256}.json`,
      ),
      16384,
    ),
    old = JSON.parse(oldConfigRaw),
    rootRaw = previous.unusedRoot.raw,
    root = JSON.parse(rootRaw);
  // Python owns its sort-keys envelope encoding; it rechecks this exact archived
  // root through its normal HMAC reader below. No cross-language MAC guessing.
  check(
    typeof rootRaw === "string" &&
      Buffer.byteLength(rootRaw) <= 16384 &&
      root.record?.path === join(home, "projects/.hive-managed") &&
      sha(oldConfigRaw) === facts.configSha256 &&
      old.binding.buildId !== config.binding.buildId &&
      ["ownerId", "workspaceId", "templateId", "hiveUserId", "coderOrigin"].every(
        (k) => old.binding[k] === config.binding[k],
      ) &&
      ["hiveOrigin", "issuerKeyId", "issuerPublicKeyPem"].every((k) => old[k] === config[k]) &&
      old.guardianEnabled === true &&
      old.nativeIsolationEnabled === true &&
      startup.configSha256 &&
      startup.packageManifestSha256 &&
      facts.lifetimeId !== startup.lifetimeId,
  );
  const inventory = [
    ...history.projectNames.map((n) => [`project/${n}`, sha(read(join(projectDir, n)))]),
    ...history.guardianNames.map((n) => [`guardian/${n}`, sha(read(join(outerDir, n)))]),
  ].sort(([a], [b]) => a.localeCompare(b));
  return {
    schemaVersion: 1,
    purpose: "unused-bootstrap-root",
    coderOrigin: config.binding.coderOrigin,
    hiveUserId: config.binding.hiveUserId,
    ownerId: config.binding.ownerId,
    workspaceId: config.binding.workspaceId,
    templateId: config.binding.templateId,
    oldBuildId: old.binding.buildId,
    oldLifetimeId: facts.lifetimeId,
    oldConfigSha256: facts.configSha256,
    oldPackageManifestSha256: original.state.events[4].value.packageManifestSha256,
    newBuildId: config.binding.buildId,
    newConfigSha256: startup.configSha256,
    newPackageManifestSha256: startup.packageManifestSha256,
    outerArchiveSha256: sha(original.raw),
    projectArchiveSha256: sha(archive.raw),
    rootRecordSha256: sha(rootRaw),
    openedProjectsDigest: sha(canonical(previous.projectState.projects)),
    historyDigest: sha(canonical(inventory)),
  };
}
