// Fixed installed predecessor transfer. No model input, cleanup or tree-exit authority.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { processIdentity } from "./codex-process-identity.mjs";

const predecessor = "7eb52d53f4c6664743d4da182ff35dbe042bde53017647d18209b4eb885180c7";
const check = (v) => {
  if (!v) throw new Error("unstarted_transfer_rejected");
};
const sha = (v) => createHash("sha256").update(v).digest("hex");
const canonical = (v) => JSON.stringify(sort(v));
function sort(v) {
  return Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, sort(x)]),
        )
      : v;
}
const same = (a, b) => canonical(a) === canonical(b);
const known = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((k) => keys.includes(k));
function privatePath(path, directory = false) {
  const st = lstatSync(path);
  check(
    realpathSync(path) === path &&
      st.uid === process.getuid() &&
      !(st.mode & 0o077) &&
      (directory ? st.isDirectory() : st.isFile() && st.nlink === 1),
  );
  return st;
}
function read(path, max = 2097152) {
  check(privatePath(path).size <= max);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = readFileSync(fd);
    check(raw.length <= max);
    return raw;
  } finally {
    closeSync(fd);
  }
}
function syncDir(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function once(path, raw) {
  if (existsSync(path)) {
    check(read(path, 4194304).equals(raw));
    return;
  }
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDir(dirname(path));
}
function replace(path, raw) {
  const temp = `${path}.unstarted-tmp`;
  once(temp, raw);
  renameSync(temp, path);
  syncDir(dirname(path));
}
function hmac(raw, key) {
  const value = JSON.parse(raw),
    expected = createHmac("sha256", key).update(JSON.stringify(value.state)).digest("hex");
  check(
    /^[a-f0-9]{64}$/.test(value.signature) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(value.signature)),
  );
  return value.state;
}
const signedHmac = (state, key) =>
  Buffer.from(
    JSON.stringify({
      state,
      signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
    }),
  );

// Inaccessible /proc is uncertainty. A missing, replaced or positively dead exact
// identity suffices here only in conjunction with the immutable pre-launch marker.
export function assertUnstartedActorDead(old) {
  check(
    Number.isSafeInteger(old?.pid) &&
      old.pid > 0 &&
      /^\d+$/.test(old.startTime) &&
      /^[a-f0-9-]{36}$/.test(old.bootId) &&
      typeof old.executable === "string" &&
      old.executable.startsWith("/") &&
      /^\d+$/.test(old.device) &&
      /^\d+$/.test(old.inode),
  );
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const path = `/proc/${old.pid}/stat`;
  let before;
  try {
    before = readFileSync(path, "utf8");
  } catch (error) {
    check(["ENOENT", "ESRCH"].includes(error?.code));
    return;
  }
  const after = readFileSync(path, "utf8"),
    fields = (v) =>
      v
        .slice(v.lastIndexOf(") ") + 2)
        .trim()
        .split(/\s+/);
  const a = fields(before),
    b = fields(after);
  check(
    a[19] === b[19] &&
      /^\d+$/.test(a[19]) &&
      (boot !== old.bootId ||
        a[19] !== old.startTime ||
        (["Z", "X"].includes(a[0]) && a[0] === b[0])),
  );
}

export function readUnstartedTransfer(home) {
  const root = join(home, ".local/state/hive/codex-host-guardian"),
    path = join(root, "unstarted-transfer.json");
  if (!existsSync(path)) return null;
  const state = hmac(read(path, 17408), read(join(root, "key"), 32));
  check(state.schemaVersion === 1 && typeof state.transferId === "string");
  const archive = join(root, `unstarted-${state.transferId}`);
  privatePath(archive, true);
  const sources = {};
  for (const [name, field] of [
    ["outer", "lifetime"],
    ["controller", "controller"],
    ["project", "project"],
    ["supervisor", "supervisor"],
  ]) {
    const raw = read(join(archive, `${name}.json`), 4194304);
    check(sha(raw) === state.oldJournalDigests?.[field]);
    sources[name] = raw;
  }
  check(sha(read(join(archive, "config.json"), 16384)) === state.oldConfigSha256);
  check(same(hmac(read(join(archive, "proof.json"), 17408), read(join(root, "key"), 32)), state));
  check(same(JSON.parse(sources.controller), state.predecessorController));
  hmac(sources.outer, read(join(root, "key"), 32));
  hmac(sources.project, read(join(root, "..", "codex-project-controller", "projects.key"), 32));
  hmac(sources.supervisor, read(join(root, "..", "codex-project-supervisor", "key"), 32));
  const key = createPublicKey(read(join(root, "controller-key.pem"), 1024));
  check(
    verify(
      null,
      Buffer.from(canonical(state.predecessorController.state)),
      key,
      Buffer.from(state.predecessorController.signature, "base64url"),
    ),
  );
  const history = hmac(read(join(archive, "history.json"), 32768), read(join(root, "key"), 32));
  check(
    history.proofDigest === sha(canonical(state)) &&
      Array.isArray(history.files) &&
      history.files.length <= 192,
  );
  for (const file of history.files) {
    check(
      ["guardian", "project"].includes(file.directory) &&
        /^(?:projects-bootstrap|lifetime-bootstrap|bootstrap-retirement|bootstrap-pending)-[a-f0-9]{64}\.json$/.test(
          file.name,
        ),
    );
    const directory =
      file.directory === "guardian" ? root : join(root, "..", "codex-project-controller");
    check(sha(read(join(directory, file.name), 4194304)) === file.digest);
  }
  for (const [name, original] of [
    ["controller-active", sources.controller],
    ["supervisor-active", sources.supervisor],
  ]) {
    const archived = join(archive, `${name}.json`);
    if (existsSync(archived)) check(read(archived, 4194304).equals(original));
  }
  return state;
}

const unusedIntermediate = "b16854fee6f44c96652c5b8bd64b9b3025e28037f93ab4bfe86c9bd218dd4efe";
function unusedEpochRecord(home, proof) {
  const guard = join(home, ".local/state/hive/codex-host-guardian"),
    file = join(guard, "unstarted-epoch-hop.json");
  if (!existsSync(file)) return null;
  const key = read(join(guard, "key"), 32),
    saved = hmac(read(file, 16384), key),
    hop = saved.hop;
  check(
    saved.schemaVersion === 1 &&
      hop.schemaVersion === 1 &&
      hop.originalProofDigest === sha(canonical(proof)) &&
      hop.buildId === proof.newBuildId &&
      hop.configSha256 === proof.newConfigSha256 &&
      hop.packageManifestSha256 === unusedIntermediate &&
      hop.packageManifestSha256 === proof.newPackageManifestSha256 &&
      hop.neverEnrolled === true &&
      hop.nativeCreationAttempted === false &&
      hop.firstPromptSubmissionAttempted === false,
  );
  const archive = join(guard, `unused-epoch-${hop.lifetimeId}`);
  privatePath(archive, true);
  for (const name of ["lifetime", "project", "config", "controller", "supervisor"]) {
    const digest = hop.oldJournalDigests[name],
      path = join(archive, name + ".json");
    if (digest === null) check(!existsSync(path));
    else check(/^[a-f0-9]{64}$/.test(digest) && sha(read(path, 4194304)) === digest);
  }
  check(same(hmac(read(join(archive, "intent.json"), 16384), key), saved));
  const outer = hmac(read(join(archive, "lifetime.json")), key),
    ps = hmac(
      read(join(archive, "project.json"), 4194304),
      read(join(guard, "..", "codex-project-controller/projects.key"), 32),
    );
  check(
    same(ps.unstartedTransfer, proof) &&
      !ps.unstartedTransferConsumed &&
      !ps.unstartedTransferHistory &&
      Object.keys(ps.projects).join() === proof.projectId &&
      !ps.projects[proof.projectId].recovery &&
      outer.events[4].value.lifetimeId === hop.lifetimeId,
  );
  return saved;
}
export function readUnstartedTransferContinuation(home, startup) {
  const proof = readUnstartedTransfer(home);
  if (!proof) return null;
  const saved = unusedEpochRecord(home, proof);
  if (!saved) return null;
  const config = JSON.parse(read(join(home, ".config/hive/codex-host.json"), 16384));
  check(
    config.binding.buildId === saved.target.buildId &&
      sha(read(join(home, ".config/hive/codex-host.json"), 16384)) === saved.target.configSha256 &&
      startup.configSha256 === saved.target.configSha256 &&
      startup.packageManifestSha256 === saved.target.packageManifestSha256 &&
      startup.lifetimeId !== saved.hop.lifetimeId,
  );
  return {
    schemaVersion: 2,
    originalProofDigest: sha(canonical(proof)),
    unusedEpochHop: saved.hop,
    finalSuccessor: { ...saved.target, lifetimeId: startup.lifetimeId },
  };
}
export function unstartedReceiptMatches(home, receipt, proof, startup) {
  const continuation = readUnstartedTransferContinuation(home, startup);
  const expected = {
    transferId: proof.transferId,
    oldRuntimeId: proof.oldRuntimeId,
    proofDigest: sha(canonical(proof)),
  };
  if (continuation) {
    if (!/^[a-f0-9]{64}$/.test(receipt?.attestationDigest ?? "")) return false;
    expected.continuationDigest = sha(canonical(continuation));
    expected.attestationDigest = receipt.attestationDigest;
  }
  return same(receipt, expected);
}
export function effectiveUnstartedBuild(home, proof) {
  return unusedEpochRecord(home, proof)?.target.buildId ?? proof.newBuildId;
}
/** One never-enrolled held epoch may carry the original proof forward. The
 * immutable original transfer still names its original destination. */
export function prepareUnusedEpochHop({
  home,
  config,
  configSha256,
  packageManifestSha256,
  outerRaw,
  oldConfigRaw,
}) {
  const guard = join(home, ".local/state/hive/codex-host-guardian"),
    proof = readUnstartedTransfer(home);
  if (!proof) return null;
  check(config.binding.buildId !== proof.newBuildId);
  const project = join(home, ".local/state/hive/codex-project-controller"),
    supervisor = join(home, ".local/state/hive/codex-project-supervisor"),
    locks = [];
  try {
    for (const file of [join(project, "controller.lock"), join(supervisor, "supervisor.lock")]) {
      privatePath(file);
      const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
      locks.push(fd);
      execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", fd],
        timeout: 2000,
      });
    }
    const key = read(join(guard, "key"), 32),
      projectKey = read(join(project, "projects.key"), 32),
      old = hmac(outerRaw, key),
      initial = old.events?.[4]?.value,
      oldConfig = JSON.parse(oldConfigRaw),
      originalRaw = read(join(guard, `unstarted-${proof.transferId}`, "project.json"), 4194304),
      original = hmac(originalRaw, projectKey),
      intentFile = join(guard, "unstarted-epoch-hop.json"),
      existing = existsSync(intentFile) ? hmac(read(intentFile, 16384), key) : null,
      archive = join(guard, `unused-epoch-${initial?.lifetimeId}`),
      projectFile = join(project, "projects.json"),
      projectRaw = existing
        ? read(join(archive, "project.json"), 4194304)
        : read(projectFile, 4194304),
      ps = hmac(projectRaw, projectKey),
      task = ps.projects?.[proof.projectId]?.task;
    check(
      initial &&
        old.schemaVersion === 1 &&
        old.receipts.length === 0 &&
        ((old.phase === "startupReady" &&
          old.events.map((e) => e.name).join() === "begin,ready,launchIntent,open,startupReady") ||
          (old.phase === "indeterminate" &&
            old.events.map((e) => e.name).join() ===
              "begin,ready,launchIntent,open,startupReady,indeterminate" &&
            old.events.at(-1).value.reason === "guardian_controller_abort")) &&
        old.events
          .slice(0, 5)
          .every(
            (e) =>
              e.value.lifetimeId === initial.lifetimeId &&
              e.value.bindingDigest === old.bindingDigest &&
              e.value.ownershipDigest === sha(JSON.stringify([])),
          ) &&
        old.events
          .slice(0, 5)
          .filter((_, i) => i !== 3)
          .every((e) => Array.isArray(e.value.projects) && e.value.projects.length === 0),
    );
    check(
      initial.configSha256 === proof.newConfigSha256 &&
        initial.packageManifestSha256 === unusedIntermediate &&
        initial.configSha256 === sha(oldConfigRaw) &&
        oldConfig.binding.buildId === proof.newBuildId &&
        oldConfig.binding.workspaceId === config.binding.workspaceId &&
        oldConfig.binding.ownerId === config.binding.ownerId &&
        oldConfig.binding.templateId === config.binding.templateId &&
        config.binding.workspaceId === proof.workspaceId &&
        config.binding.ownerId === proof.coderOwnerId &&
        config.binding.hiveUserId === proof.ownerId &&
        same(ps.unstartedTransfer, proof) &&
        !ps.unstartedTransferConsumed &&
        !ps.unstartedTransferHistory &&
        Object.keys(ps.projects).join() === proof.projectId &&
        !ps.projects[proof.projectId].recovery &&
        task &&
        same(task, original.projects[proof.projectId].task) &&
        task.nativeCreationAttempted === false &&
        task.firstPromptSubmissionAttempted === false &&
        !task.nativeThreadId &&
        !task.terminalSessionName &&
        !task.sourceApplication &&
        !existsSync(join(supervisor, "registry.json")),
    );
    for (const actor of [
      initial.outerIdentity,
      initial.guardianIdentity,
      initial.workerIdentity,
      ps.hostProcess,
    ])
      assertUnstartedActorDead(actor);
    let controllerRaw = null;
    const controllerFile = join(guard, "controller.json");
    if (existsSync(controllerFile) || existing?.hop.oldJournalDigests.controller) {
      controllerRaw = existing?.hop.oldJournalDigests.controller
        ? read(join(archive, "controller.json"), 32768)
        : read(controllerFile, 32768);
      if (existsSync(controllerFile)) check(read(controllerFile, 32768).equals(controllerRaw));
      else check(read(join(archive, "controller-active.json"), 32768).equals(controllerRaw));
      const c = JSON.parse(controllerRaw),
        key = createPublicKey(read(join(guard, "controller-key.pem"), 1024));
      check(
        verify(null, Buffer.from(canonical(c.state)), key, Buffer.from(c.signature, "base64url")) &&
          c.state.schemaVersion === 1 &&
          c.state.lifetimeId === initial.lifetimeId &&
          c.state.generation === 1 &&
          c.state.runtimeId === null &&
          c.state.pending === null &&
          c.state.hold === false &&
          c.state.launch === null &&
          Object.keys(c.state.projects).length === 0 &&
          Object.keys(c.state.applications ?? {}).length === 0 &&
          !c.state.accountMaintenance &&
          !c.state.epicClosure &&
          !c.state.unstartedTransferReceipt,
      );
    }
    const hop = {
        schemaVersion: 1,
        buildId: proof.newBuildId,
        lifetimeId: initial.lifetimeId,
        configSha256: proof.newConfigSha256,
        packageManifestSha256: unusedIntermediate,
        originalProofDigest: sha(canonical(proof)),
        oldJournalDigests: {
          lifetime: sha(outerRaw),
          project: sha(projectRaw),
          supervisor: null,
          config: sha(oldConfigRaw),
          controller: controllerRaw ? sha(controllerRaw) : null,
        },
        neverEnrolled: true,
        nativeCreationAttempted: false,
        firstPromptSubmissionAttempted: false,
      },
      saved = {
        schemaVersion: 1,
        hop,
        target: { buildId: config.binding.buildId, configSha256, packageManifestSha256 },
      },
      next = structuredClone(ps);
    delete next.guardianLifetimeId;
    const nextRaw = signedHmac(next, projectKey),
      current = read(projectFile, 4194304);
    check(current.equals(projectRaw) || current.equals(nextRaw));
    if (existing) check(same(existing, saved));
    if (!existsSync(archive)) {
      mkdirSync(archive, { mode: 0o700 });
      syncDir(guard);
    }
    privatePath(archive, true);
    for (const [name, raw] of [
      ["lifetime", outerRaw],
      ["project", projectRaw],
      ["config", oldConfigRaw],
      ["controller", controllerRaw],
    ])
      if (raw) once(join(archive, name + ".json"), raw);
    once(join(archive, "intent.json"), signedHmac(saved, key));
    once(intentFile, signedHmac(saved, key));
    replace(projectFile, nextRaw);
    if (controllerRaw) {
      once(join(archive, "controller.json"), controllerRaw);
      const moved = join(archive, "controller-active.json");
      if (existsSync(controllerFile)) {
        check(!existsSync(moved));
        renameSync(controllerFile, moved);
        syncDir(guard);
        syncDir(archive);
      } else check(read(moved, 32768).equals(controllerRaw));
    }
    return saved;
  } finally {
    for (const fd of locks.reverse()) closeSync(fd);
  }
}

export function readPendingUnstartedTransfer(home) {
  const proof = readUnstartedTransfer(home);
  if (!proof) return null;
  const root = join(home, ".local/state/hive/codex-project-controller"),
    state = hmac(read(join(root, "projects.json"), 4194304), read(join(root, "projects.key"), 32));
  check(same(state.unstartedTransfer, proof));
  if (state.unstartedTransferConsumed) {
    check(
      state.unstartedTransferConsumed === true &&
        same(state.unstartedTransferHistory?.proof, proof),
    );
    return null;
  }
  return proof;
}

/** Called under the existing outer guardian flock, BEFORE any inner initializer.
 * Existing project/supervisor lock inodes are retained, never replaced/unlinked. */
export function prepareUnstartedTransfer({
  home,
  config,
  configSha256,
  packageManifestSha256,
  outerRaw,
  nextBindingDigest,
  oldConfigRaw,
  verifyBootstrapHistory = undefined,
}) {
  const root = join(home, ".local/state/hive"),
    guard = join(root, "codex-host-guardian"),
    projectDir = join(root, "codex-project-controller"),
    nativeDir = join(root, "codex-project-supervisor");
  for (const path of [guard, projectDir, nativeDir]) privatePath(path, true);
  const locks = [];
  try {
    for (const path of [join(projectDir, "controller.lock"), join(nativeDir, "supervisor.lock")]) {
      privatePath(path);
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      locks.push(fd);
      const st = fstatSync(fd);
      check(st.nlink === 1 && st.uid === process.getuid());
      execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", fd],
        timeout: 2000,
      });
    }
    const key = read(join(guard, "key"), 32),
      outer = hmac(outerRaw, key),
      startup = outer.events?.[4]?.value,
      oldConfig = JSON.parse(oldConfigRaw);
    check(
      key.length === 32 &&
        ["admissionAccepted", "indeterminate"].includes(outer.phase) &&
        outer.receipts?.length === 0 &&
        outer.events?.map((e) => e.name).join() ===
          `begin,ready,launchIntent,open,startupReady,admissionIntent,admissionAccepted${outer.phase === "indeterminate" ? ",indeterminate" : ""}` &&
        outer.bindingDigest !== nextBindingDigest &&
        startup?.generation === 1 &&
        startup.projects?.length === 0 &&
        startup.packageManifestSha256 === predecessor &&
        sha(oldConfigRaw) === startup.configSha256 &&
        oldConfig.binding.buildId !== config.binding.buildId &&
        oldConfig.guardianEnabled === true &&
        oldConfig.nativeIsolationEnabled === true &&
        config.guardianEnabled === true &&
        config.nativeIsolationEnabled === true &&
        ["ownerId", "workspaceId", "templateId", "hiveUserId", "coderOrigin"].every(
          (k) => oldConfig.binding[k] === config.binding[k],
        ) &&
        oldConfig.hiveOrigin === config.hiveOrigin &&
        oldConfig.issuerKeyId === config.issuerKeyId &&
        oldConfig.issuerPublicKeyPem === config.issuerPublicKeyPem &&
        outer.bindingDigest ===
          sha(
            JSON.stringify({
              schemaVersion: 1,
              configSha256: startup.configSha256,
              packageManifestSha256: predecessor,
            }),
          ),
    );
    [startup.outerIdentity, startup.guardianIdentity, startup.workerIdentity].forEach(
      assertUnstartedActorDead,
    );
    const transferHex = sha(
        canonical({ old: sha(outerRaw), nextBindingDigest, buildId: config.binding.buildId }),
      ),
      transferId = `${transferHex.slice(0, 8)}-${transferHex.slice(8, 12)}-4${transferHex.slice(13, 16)}-8${transferHex.slice(17, 20)}-${transferHex.slice(20, 32)}`,
      archive = join(guard, `unstarted-${transferId}`);
    if (!existsSync(archive)) {
      mkdirSync(archive, { mode: 0o700 });
      syncDir(guard);
    }
    privatePath(archive, true);
    const source = (name, active) => {
      const archived = join(archive, name);
      if (existsSync(archived)) return read(archived, 4194304);
      return read(active, 4194304);
    };
    const controllerRaw = source("controller.json", join(guard, "controller.json")),
      projectRaw = source("project.json", join(projectDir, "projects.json")),
      supervisorRaw = source("supervisor.json", join(nativeDir, "registry.json")),
      controller = JSON.parse(controllerRaw),
      projectKey = read(join(projectDir, "projects.key"), 32),
      nativeKey = read(join(nativeDir, "key"), 32),
      project = hmac(projectRaw, projectKey),
      native = hmac(supervisorRaw, nativeKey),
      publicKey = createPublicKey(read(join(guard, "controller-key.pem"), 1024)),
      c = controller.state;
    const oldIdentity = {
      lifetimeId: startup.lifetimeId,
      bindingDigest: startup.bindingDigest,
      outerPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      packageManifestSha256: startup.packageManifestSha256,
      guardianElfSha256: startup.guardianSha256,
      nodeSha256: startup.nodeSha256,
      policyDigest: c.launch?.policyDigest,
      metadataPolicyDigest: c.launch?.metadataPolicyDigest,
      configSha256: startup.configSha256,
    };
    check(
      known(c, [
        "schemaVersion",
        "lifetimeId",
        "identityDigest",
        "runtimeId",
        "generation",
        "projects",
        "applications",
        "launch",
        "pending",
        "hold",
        "sequence",
        "chainDigest",
      ]) &&
        known(c.launch, [
          "runtimeId",
          "runtimeGeneration",
          "policyDigest",
          "metadataPolicyDigest",
          "nativeLaunchId",
          "launchIntentDigest",
          "approvals",
        ]) &&
        Number.isSafeInteger(c.sequence) &&
        c.sequence > 0 &&
        /^[a-f0-9]{64}$/.test(c.chainDigest) &&
        known(native, [
          "schemaVersion",
          "ownerId",
          "workspaceId",
          "projects",
          "serverInstanceId",
          "buildId",
          "status",
          "hostProcess",
          "nativeProcess",
          "executionIdentity",
          "metadataLaunch",
        ]) &&
        known(project, [
          "schemaVersion",
          "ownerId",
          "workspaceId",
          "projects",
          "guardianLifetimeId",
          "hostProcess",
        ]),
    );
    check(
      publicKey.asymmetricKeyType === "ed25519" &&
        verify(
          null,
          Buffer.from(canonical(c)),
          publicKey,
          Buffer.from(controller.signature, "base64url"),
        ) &&
        c.lifetimeId === startup.lifetimeId &&
        c.identityDigest === sha(canonical(oldIdentity)) &&
        c.runtimeId &&
        c.generation === 2 &&
        c.pending === null &&
        c.hold === false &&
        Object.keys(c.applications ?? {}).length === 0 &&
        c.launch &&
        Object.keys(c.projects ?? {}).length === 1 &&
        c.launch.runtimeId === c.runtimeId &&
        c.launch.runtimeGeneration === c.generation &&
        c.launch.approvals?.length === 1 &&
        native.status === "starting" &&
        native.metadataLaunch?.phase === "reservationRequested" &&
        Object.keys(native.metadataLaunch).sort().join() === "phase,projectsDigest" &&
        native.nativeProcess === null &&
        native.executionIdentity === null &&
        Object.keys(native.projects ?? {}).length === 0 &&
        native.buildId === oldConfig.binding.buildId &&
        native.ownerId === oldConfig.binding.ownerId &&
        native.workspaceId === oldConfig.binding.workspaceId &&
        !native.accountMaintenance &&
        !native.guardianBarrier &&
        !native.maintenanceResume &&
        Object.keys(native.accountMaintenanceHistory ?? {}).length === 0 &&
        project.ownerId === oldConfig.binding.ownerId &&
        project.workspaceId === oldConfig.binding.workspaceId &&
        project.guardianLifetimeId === startup.lifetimeId &&
        Object.keys(project.projects ?? {}).length === 1 &&
        !project.guardianBarrier &&
        !project.accountMaintenance &&
        !project.unstartedTransfer,
    );
    assertUnstartedActorDead(native.hostProcess);
    assertUnstartedActorDead(project.hostProcess);
    const p = Object.values(project.projects)[0],
      t = p.task,
      admission = c.projects[p.projectId],
      a = c.launch.approvals[0],
      preparation = t?.guardianPreparation,
      checkout = admission?.checkout;
    check(
      known(p, ["projectId", "repositoryId", "expectedAccountId", "createdAt", "task"]) &&
        known(t, [
          "taskId",
          "digest",
          "request",
          "phase",
          "createdAt",
          "nativeThreadId",
          "terminalSessionName",
          "reason",
          "nativeCreationAttempted",
          "firstPromptSubmissionAttempted",
          "retries",
          "guardianPreparation",
          "guardianAdmission",
          "checkoutIncarnation",
          "checkoutIdentity",
          "renewalSequence",
          "prepared",
          "guardianPrepared",
        ]) &&
        known(admission, [
          "admissionId",
          "admissionGeneration",
          "phase",
          "checkout",
          "preparationDigest",
          "metadataPinsDigest",
        ]) &&
        admission.metadataPinsDigest == null,
    );
    check(
      t?.phase === "blocked" &&
        t.reason === "native_unavailable" &&
        t.nativeCreationAttempted === false &&
        t.firstPromptSubmissionAttempted === false &&
        t.nativeThreadId == null &&
        t.terminalSessionName == null &&
        !t.sourceApplication &&
        !t.executionRevoked &&
        !p.recovery &&
        !t.retries?.length &&
        !p.recoveryCount &&
        t.prepared &&
        native.metadataLaunch.projectsDigest === sha(JSON.stringify([t.prepared])) &&
        t.guardianPrepared &&
        sha(JSON.stringify(t.request)) === t.digest &&
        preparation?.buildId === oldConfig.binding.buildId &&
        preparation.taskId === t.taskId &&
        preparation.requestId === t.request.requestId &&
        preparation.requestDigest === t.digest &&
        preparation.ownerId === oldConfig.binding.ownerId &&
        preparation.workspaceId === oldConfig.binding.workspaceId &&
        preparation.projectId === p.projectId &&
        preparation.baseSha === t.request.revision &&
        preparation.repositoryId === p.repositoryId &&
        preparation.providerAccountId === p.expectedAccountId &&
        admission?.phase === "checkout" &&
        a.projectId === p.projectId &&
        a.taskId === t.taskId &&
        a.admissionId === admission.admissionId &&
        a.admissionGeneration === admission.admissionGeneration &&
        checkout?.preparationIntentId === t.taskId &&
        checkout.projectId === p.projectId &&
        checkout.leaseId === t.prepared.leaseId &&
        checkout.leaseGeneration === t.prepared.leaseGeneration &&
        checkout.checkoutIncarnation === t.checkoutIncarnation &&
        same(checkout.checkoutIdentity, t.checkoutIdentity) &&
        checkout.revision === t.request.revision &&
        a.firstNative === true &&
        a.leaseId === checkout.leaseId &&
        a.leaseGeneration === checkout.leaseGeneration &&
        a.checkoutIncarnation === checkout.checkoutIncarnation &&
        same(a.checkoutIdentity, checkout.checkoutIdentity) &&
        a.revision === checkout.revision,
    );
    const admitted = outer.events[6].value;
    check(
      admitted.phase === "open" &&
        admitted.lifetimeId === c.lifetimeId &&
        admitted.generation === c.generation &&
        same(admitted.projects, [
          { projectId: p.projectId, bindingDigest: sha(JSON.stringify(preparation)) },
        ]) &&
        admitted.bindingDigest === outer.bindingDigest,
    );
    if (outer.phase === "indeterminate") {
      const stopped = outer.events[7].value;
      check(
        stopped.reason === "guardian_controller_abort" &&
          stopped.lifetimeId === admitted.lifetimeId &&
          stopped.bindingDigest === admitted.bindingDigest &&
          same(stopped.projects, admitted.projects),
      );
    }
    const history = verifyBootstrapHistory?.() ?? { projectNames: [], guardianNames: [] };
    check(
      readdirSync(projectDir).every((n) =>
        [
          "projects.json",
          "projects.json.unstarted-tmp",
          "projects.key",
          "controller.lock",
          ...history.projectNames,
        ].includes(n),
      ) &&
        readdirSync(nativeDir).every((n) =>
          ["registry.json", "key", "supervisor.lock"].includes(n),
        ) &&
        readdirSync(guard).every((n) =>
          [
            "lifetime.json",
            "key",
            "guardian.lock",
            "controller.json",
            "controller-key.pem",
            `unstarted-${transferId}`,
            "unstarted-transfer.json",
            ...history.guardianNames,
          ].includes(n),
        ),
    );
    const proof = {
      schemaVersion: 1,
      transferId,
      ownerId: config.binding.hiveUserId,
      coderOwnerId: config.binding.ownerId,
      workspaceId: config.binding.workspaceId,
      templateId: config.binding.templateId,
      projectId: p.projectId,
      taskId: t.taskId,
      requestId: t.request.requestId,
      hostRequestDigest: t.digest,
      sourceSha: t.request.revision,
      repositoryId: p.repositoryId,
      providerAccountId: p.expectedAccountId,
      oldRuntimeId: c.runtimeId,
      oldBuildId: oldConfig.binding.buildId,
      oldLifetimeId: c.lifetimeId,
      oldIdentityDigest: c.identityDigest,
      oldConfigSha256: startup.configSha256,
      oldPackageManifestSha256: predecessor,
      newBuildId: config.binding.buildId,
      newConfigSha256: configSha256,
      newPackageManifestSha256: packageManifestSha256,
      nativeLaunchId: c.launch.nativeLaunchId,
      launchIntentDigest: c.launch.launchIntentDigest,
      preparation,
      checkout,
      oldJournalDigests: {
        lifetime: sha(outerRaw),
        controller: sha(controllerRaw),
        project: sha(projectRaw),
        supervisor: sha(supervisorRaw),
      },
      predecessorController: controller,
      neverStarted: {
        metadataPhase: "reservationRequested",
        status: "starting",
        nativeProcess: null,
        executionIdentity: null,
        projectCount: 0,
        nativeCreationAttempted: false,
        firstPromptSubmissionAttempted: false,
        nativeThreadId: null,
        terminalSessionName: null,
      },
    };
    check(Buffer.byteLength(canonical(c)) <= 8192 && Buffer.byteLength(canonical(proof)) <= 16384);
    // Archive every input BEFORE advancing any active file; exact bytes permit
    // replay of a crash between these changes, never rollback to a later state.
    for (const [name, raw] of Object.entries({
      "outer.json": outerRaw,
      "controller.json": controllerRaw,
      "project.json": projectRaw,
      "supervisor.json": supervisorRaw,
      "config.json": oldConfigRaw,
    }))
      once(join(archive, name), raw);
    once(join(archive, "proof.json"), signedHmac(proof, key));
    const historyFiles = [
      ...history.projectNames.map((name) => ({
        directory: "project",
        name,
        digest: sha(read(join(projectDir, name), 4194304)),
      })),
      ...history.guardianNames.map((name) => ({
        directory: "guardian",
        name,
        digest: sha(read(join(guard, name), 4194304)),
      })),
    ];
    once(
      join(archive, "history.json"),
      signedHmac({ proofDigest: sha(canonical(proof)), files: historyFiles }, key),
    );
    const held = structuredClone(project);
    held.unstartedTransfer = proof;
    delete held.guardianLifetimeId;
    const heldRaw = signedHmac(held, projectKey);
    const pendingProject = join(projectDir, "projects.json.unstarted-tmp");
    if (existsSync(pendingProject)) check(read(pendingProject, 4194304).equals(heldRaw));
    for (const [active, original, successor] of [
      [join(projectDir, "projects.json"), projectRaw, heldRaw],
      [join(guard, "controller.json"), controllerRaw, null],
      [join(nativeDir, "registry.json"), supervisorRaw, null],
    ]) {
      if (existsSync(active))
        check(
          read(active, 4194304).equals(original) ||
            (successor && read(active, 4194304).equals(successor)),
        );
    }
    once(join(guard, "unstarted-transfer.json"), signedHmac(proof, key));
    replace(join(projectDir, "projects.json"), heldRaw);
    for (const [active, archived] of [
      [join(guard, "controller.json"), join(archive, "controller-active.json")],
      [join(nativeDir, "registry.json"), join(archive, "supervisor-active.json")],
    ]) {
      if (existsSync(active)) {
        check(!existsSync(archived));
        renameSync(active, archived);
        syncDir(dirname(active));
        syncDir(archive);
      }
    }
    return proof;
  } finally {
    for (const fd of locks.reverse()) closeSync(fd);
  }
}

export function verifyUnstartedProject(home, state, p, buildId) {
  const proof = readUnstartedTransfer(home);
  check(
    proof &&
      same(proof, state.unstartedTransfer) &&
      !state.unstartedTransferConsumed &&
      effectiveUnstartedBuild(home, proof) === buildId &&
      p.projectId === proof.projectId &&
      p.task?.taskId === proof.taskId,
  );
  const path = join(
      home,
      ".local/state/hive/codex-host-guardian",
      `unstarted-${proof.transferId}`,
      "project.json",
    ),
    raw = read(path, 4194304),
    key = read(join(home, ".local/state/hive/codex-project-controller/projects.key"), 32),
    original = hmac(raw, key);
  check(sha(raw) === proof.oldJournalDigests.project);
  const originalTask = original.projects[p.projectId]?.task,
    history = state.unstartedTransferHistory;
  if (!history) check(same(p.task, originalTask));
  else {
    check(
      same(history.proof, proof) &&
        history.originalTaskDigest === sha(canonical(originalTask)) &&
        history.recoveryId === p.recovery?.scope.recoveryId &&
        history.authorizationDigest === sha(canonical(p.recovery.authorization)) &&
        history.inspectionDigest === sha(canonical(p.recovery.inspection)) &&
        p.recovery.authorization.expiresAt > Date.now() &&
        p.recovery.authorization.buildId === buildId &&
        p.recovery.authorization.lifetimeId === state.guardianLifetimeId &&
        ["held", "consuming"].includes(p.recovery.phase) &&
        ["blocked", "preparing"].includes(p.task.phase) &&
        history.renewalSequence === (originalTask.renewalSequence ?? 0) + 1 &&
        same(history.guardianPreparation, originalTask.guardianPreparation) &&
        same(history.guardianPrepared, originalTask.guardianPrepared) &&
        same(history.guardianAdmission, originalTask.guardianAdmission),
    );
    const expected = structuredClone(originalTask),
      actual = structuredClone(p.task);
    if (history.remount) {
      check(
        same(history.remount, p.recovery.inspection.remount) &&
          history.remount.mappingDigest === sha(canonical(history.remount.mapping)) &&
          same(history.remount.mapping.old.checkout, originalTask.checkoutIdentity),
      );
      expected.checkoutIdentity = structuredClone(history.remount.mapping.current.checkout);
    }
    expected.guardianPreparation = { ...originalTask.guardianPreparation, buildId };
    expected.guardianPrepared = {
      ...originalTask.guardianPrepared,
      preparationDigest: sha(JSON.stringify(expected.guardianPreparation)),
      checkoutIdentity: structuredClone(expected.checkoutIdentity),
    };
    expected.renewalSequence = history.renewalSequence;
    expected.phase = p.task.phase;
    delete expected.guardianAdmission;
    if (actual.guardianAdmission) {
      const token = actual.guardianAdmission;
      check(
        known(token, [
          "projectId",
          "projectBindingDigest",
          "lifetimeId",
          "bindingDigest",
          "ownershipDigest",
          "generation",
        ]) &&
          token.projectId === proof.projectId &&
          token.projectBindingDigest === sha(JSON.stringify(expected.guardianPreparation)) &&
          token.lifetimeId === state.guardianLifetimeId &&
          Number.isSafeInteger(token.generation) &&
          token.generation > 0 &&
          /^[a-f0-9]{64}$/.test(token.bindingDigest) &&
          /^[a-f0-9]{64}$/.test(token.ownershipDigest),
      );
    }
    delete actual.guardianAdmission;
    check(same(actual, expected));
  }
  return proof;
}

export function validateRemountTicket(ticket) {
  const exact = (v, keys) => known(v, keys) && Object.keys(v).length === keys.length,
    hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    id = (v) => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
  check(
    exact(ticket, [
      "attestationDigest",
      "continuationDigest",
      "originalProofDigest",
      "recoveryId",
      "ownerId",
      "workspaceId",
      "projectId",
      "taskId",
      "final",
      "volume",
      "mapping",
      "expiresAt",
    ]) &&
      [ticket.attestationDigest, ticket.continuationDigest, ticket.originalProofDigest].every(
        hex,
      ) &&
      [
        ticket.recoveryId,
        ticket.ownerId,
        ticket.workspaceId,
        ticket.projectId,
        ticket.taskId,
      ].every(id) &&
      Number.isSafeInteger(ticket.expiresAt) &&
      ticket.expiresAt > Date.now(),
  );
  check(
    exact(ticket.final, ["buildId", "lifetimeId", "configSha256", "packageManifestSha256"]) &&
      [ticket.final.buildId, ticket.final.lifetimeId].every(id) &&
      [ticket.final.configSha256, ticket.final.packageManifestSha256].every(hex),
  );
  const m = ticket.mapping;
  check(
    exact(m, [
      "old",
      "current",
      "oldRootRecordSha256",
      "oldProjectRecordSha256",
      "oldLeaseDigest",
    ]) && [m.oldRootRecordSha256, m.oldProjectRecordSha256, m.oldLeaseDigest].every(hex),
  );
  for (const group of [m.old, m.current]) {
    check(exact(group, ["root", "project", "checkout"]));
    for (const i of Object.values(group))
      check(
        exact(i, ["device", "inode"]) &&
          Object.values(i).every((v) => typeof v === "string" && /^[0-9]{1,24}$/.test(v)),
      );
    check(new Set(Object.values(group).map((v) => v.device)).size === 1);
  }
  check(
    m.old.root.device !== m.current.root.device &&
      ["root", "project", "checkout"].every((k) => m.old[k].inode === m.current[k].inode),
  );
  const v = ticket.volume;
  check(
    exact(v, [
      "pvcUid",
      "pvcName",
      "namespace",
      "storageClass",
      "capacity",
      "boundVolumeName",
      "accessModes",
      "containerName",
      "podVolumeName",
      "mountPath",
      "subPath",
      "subPathExpr",
      "readOnly",
      "claimReadOnly",
    ]) &&
      id(v.pvcUid) &&
      [v.pvcName, v.boundVolumeName].every(
        (x) => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(x),
      ) &&
      v.namespace === "coder" &&
      v.storageClass === "longhorn" &&
      /^[1-9][0-9]{0,3}Gi$/.test(v.capacity) &&
      same(v.accessModes, ["ReadWriteOnce"]) &&
      v.containerName === "dev" &&
      v.podVolumeName === "home" &&
      v.mountPath === "/home/coder" &&
      v.subPath === "" &&
      v.subPathExpr === "" &&
      v.readOnly === false &&
      v.claimReadOnly === false,
  );
  return ticket;
}
export function unstartedRemountAuthority(home, projectId, parentPid, phase) {
  check(["inspecting", "consuming"].includes(phase));
  const dir = join(home, ".local/state/hive/codex-project-controller"),
    state = hmac(read(join(dir, "projects.json"), 4194304), read(join(dir, "projects.key"), 32)),
    p = state.projects?.[projectId];
  if (!p?.recovery?.continuity) return null;
  const ticket = validateRemountTicket(p.recovery.continuity),
    proof = verifyUnstartedProject(home, state, p, ticket.final.buildId),
    guard = join(home, ".local/state/hive/codex-host-guardian"),
    controller = JSON.parse(read(join(guard, "controller.json"))),
    current = hmac(read(join(guard, "lifetime.json")), read(join(guard, "key"), 32)).events[4]
      .value,
    continuation = readUnstartedTransferContinuation(home, current),
    key = createPublicKey(read(join(guard, "controller-key.pem"), 1024)),
    receipt = controller.state.unstartedTransferReceipt;
  check(
    same(state.hostProcess, processIdentity(parentPid)) &&
      continuation &&
      ticket.originalProofDigest === sha(canonical(proof)) &&
      ticket.continuationDigest === sha(canonical(continuation)) &&
      ticket.attestationDigest === receipt?.attestationDigest &&
      ticket.continuationDigest === receipt?.continuationDigest &&
      same(ticket.final, continuation.finalSuccessor) &&
      ticket.recoveryId === p.recovery.scope.recoveryId &&
      ticket.ownerId === proof.ownerId &&
      ticket.workspaceId === proof.workspaceId &&
      ticket.projectId === proof.projectId &&
      ticket.taskId === proof.taskId &&
      same(ticket.mapping.old.checkout, proof.checkout.checkoutIdentity) &&
      verify(
        null,
        Buffer.from(canonical(controller.state)),
        key,
        Buffer.from(controller.signature, "base64url"),
      ) &&
      unstartedReceiptMatches(home, receipt, proof, current) &&
      controller.state.lifetimeId === ticket.final.lifetimeId &&
      controller.state.runtimeId &&
      controller.state.launch === null &&
      state.guardianLifetimeId === ticket.final.lifetimeId &&
      !p.task.nativeCreationAttempted &&
      !p.task.firstPromptSubmissionAttempted &&
      !p.task.nativeThreadId,
  );
  const c = controller.state,
    replay = Boolean(state.unstartedTransferHistory),
    pendingProject =
      c.pending?.projectId ?? c.pending?.preparation?.projectId ?? c.pending?.checkout?.projectId;
  check(
    replay
      ? Number.isSafeInteger(c.generation) &&
          c.generation >= 1 &&
          ((c.pending === null && c.hold === false) ||
            (c.hold === true &&
              ["prepare", "checkout", "fence"].includes(c.pending?.action) &&
              pendingProject === projectId)) &&
          (Object.keys(c.projects).length === 0 ||
            (Object.keys(c.projects).join() === projectId &&
              ["preparation", "checkout"].includes(c.projects[projectId].phase) &&
              !c.projects[projectId].producer &&
              !c.projects[projectId].nativeReceiptEventId &&
              !c.projects[projectId].metadataPinsDigest))
      : c.generation === 1 &&
          c.pending === null &&
          c.hold === false &&
          Object.keys(c.projects).length === 0,
  );
  if (p.recovery.inspection?.remount)
    check(
      same(p.recovery.inspection.remount.mapping, ticket.mapping) &&
        p.recovery.inspection.remount.mappingDigest === sha(canonical(ticket.mapping)) &&
        p.recovery.inspection.remount.attestationDigest === ticket.attestationDigest &&
        p.recovery.inspection.remount.continuationDigest === ticket.continuationDigest,
    );
  if (phase === "inspecting")
    check(
      ["inspecting", "inspected"].includes(p.recovery.phase) ||
        (p.recovery.phase === "held" && p.recovery.authorization?.expiresAt > Date.now()),
    );
  else
    check(
      p.recovery.phase === "consuming" &&
        p.recovery.authorization?.expiresAt > Date.now() &&
        p.recovery.authorization.inspectionDigest === sha(canonical(p.recovery.inspection)),
    );
  return ticket;
}

export function unstartedRemountGuardianAuthority(home, projectId, parentPid, phase) {
  const ticket = unstartedRemountAuthority(home, projectId, parentPid, phase);
  check(ticket);
  const guard = join(home, ".local/state/hive/codex-host-guardian"),
    life = hmac(read(join(guard, "lifetime.json")), read(join(guard, "key"), 32)),
    startup = life.events[4].value,
    begin = life.events[0].value,
    root = begin.hostRootInventory,
    packageRoot = join(home, ".local/share/hive/codex-host"),
    directory = join(
      packageRoot,
      JSON.parse(read(join(home, ".local/state/hive/codex-host-install/process.json"), 65536))
        .archiveSha256,
    ),
    manifestRaw = read(join(directory, "package-manifest.json"), 65536),
    manifest = JSON.parse(manifestRaw),
    cwd = privatePath(packageRoot, true),
    sourceSha256 = "3f633c951f47a99e885f5761146522a32793e6adbd274481d4dfc01b8d4ce4a3";
  check(
    sha(manifestRaw) === ticket.final.packageManifestSha256 &&
      manifest.guardian.sourceSha256 === sourceSha256 &&
      manifest.guardian.elfSha256 === startup.guardianSha256 &&
      manifest.files["codex-native-guardian"] === startup.guardianSha256 &&
      sha(read(join(directory, "codex-native-guardian"), 1048576)) === startup.guardianSha256 &&
      startup.guardianIdentity.executable === join(directory, "codex-native-guardian") &&
      startup.guardianIdentity.device ===
        String(privatePath(join(directory, "codex-native-guardian")).dev) &&
      startup.guardianIdentity.inode ===
        String(privatePath(join(directory, "codex-native-guardian")).ino) &&
      same(
        {
          ...processIdentity(startup.outerIdentity.pid),
          parentPid: startup.outerIdentity.parentPid,
        },
        startup.outerIdentity,
      ) &&
      Array.isArray(root) &&
      root.length === 1 &&
      sha(JSON.stringify(root)) === begin.launchSetDigest &&
      root[0].id === "host-worker" &&
      root[0].role === "host" &&
      root[0].workerChannelFd === 3 &&
      root[0].executable === realpathSync(process.execPath) &&
      root[0].sha256 === startup.nodeSha256 &&
      root[0].argvDigest ===
        sha(
          JSON.stringify([root[0].executable, join(directory, "codex-workspace-host-worker.mjs")]),
        ) &&
      root[0].cwdDevice === String(cwd.dev) &&
      root[0].cwdInode === String(cwd.ino) &&
      startup.guardianIdentity.parentPid === startup.outerIdentity.pid &&
      /^[a-f0-9]{64}$/.test(root[0].envDigest),
  );
  return {
    guardian: startup.guardianIdentity,
    outer: startup.outerIdentity,
    sourceSha256,
    guardianSha256: startup.guardianSha256,
    constructionDigest: begin.launchSetDigest,
    cwd: { path: packageRoot, device: String(cwd.dev), inode: String(cwd.ino) },
    lifetimeId: startup.lifetimeId,
    recoveryId: ticket.recoveryId,
    expiresAt: ticket.expiresAt,
  };
}

export function unstartedLeaseAuthority(home, projectId, parentPid) {
  const dir = join(home, ".local/state/hive/codex-project-controller"),
    state = hmac(read(join(dir, "projects.json"), 4194304), read(join(dir, "projects.key"), 32)),
    p = state.projects?.[projectId],
    proof = verifyUnstartedProject(
      home,
      state,
      p,
      effectiveUnstartedBuild(home, state.unstartedTransfer),
    ),
    recovery = p.recovery,
    authorization = recovery?.authorization,
    checkout = { ...proof.checkout, checkoutIdentity: p.task.checkoutIdentity },
    guard = join(home, ".local/state/hive/codex-host-guardian"),
    saved = JSON.parse(read(join(guard, "controller.json"))),
    key = createPublicKey(read(join(guard, "controller-key.pem"), 1024));
  const replay = Boolean(state.unstartedTransferHistory),
    current = saved.state,
    project = current.projects?.[projectId],
    pendingProject =
      current.pending?.projectId ??
      current.pending?.preparation?.projectId ??
      current.pending?.checkout?.projectId;
  if (project)
    check(
      project.preparationDigest === sha(JSON.stringify(p.task.guardianPreparation)) &&
        (project.phase === "preparation"
          ? project.checkout == null
          : same(project.checkout, checkout)),
    );
  if (current.pending)
    check(
      current.pending.runtimeId === current.runtimeId &&
        current.pending.runtimeGeneration === current.generation &&
        (current.pending.action !== "prepare" ||
          same(current.pending.preparation, p.task.guardianPreparation)) &&
        (current.pending.action !== "checkout" || same(current.pending.checkout, checkout)),
    );
  check(
    same(state.hostProcess, processIdentity(parentPid)) &&
      p.task.phase === "blocked" &&
      recovery?.phase === "consuming" &&
      authorization?.buildId === effectiveUnstartedBuild(home, proof) &&
      authorization.expiresAt > Date.now() &&
      authorization.lifetimeId === state.guardianLifetimeId &&
      recovery.scope?.taskId === proof.taskId &&
      recovery.scope.hostRequestDigest === proof.hostRequestDigest &&
      recovery.scope.originalRequestId === proof.requestId &&
      recovery.scope.ownerId === proof.ownerId &&
      recovery.scope.coderOwnerId === proof.coderOwnerId &&
      recovery.scope.workspaceId === proof.workspaceId &&
      recovery.scope.projectId === proof.projectId &&
      recovery.scope.revision === proof.sourceSha &&
      verify(
        null,
        Buffer.from(canonical(saved.state)),
        key,
        Buffer.from(saved.signature, "base64url"),
      ) &&
      saved.state.lifetimeId === authorization.lifetimeId &&
      saved.state.runtimeId &&
      (replay
        ? Number.isSafeInteger(current.generation) && current.generation >= 1
        : current.generation === 1) &&
      (replay
        ? (current.pending === null && current.hold === false) ||
          (current.hold === true &&
            ["prepare", "checkout", "fence"].includes(current.pending?.action) &&
            pendingProject === projectId)
        : current.pending === null && current.hold === false) &&
      saved.state.launch === null &&
      (Object.keys(current.projects).length === 0 ||
        (replay &&
          Object.keys(current.projects).join() === projectId &&
          ["preparation", "checkout"].includes(project.phase) &&
          !project.producer &&
          !project.nativeReceiptEventId &&
          !project.metadataPinsDigest)) &&
      unstartedReceiptMatches(
        home,
        saved.state.unstartedTransferReceipt,
        proof,
        hmac(read(join(guard, "lifetime.json")), read(join(guard, "key"), 32)).events[4].value,
      ),
  );
  return {
    transferId: proof.transferId,
    recoveryId: recovery.scope.recoveryId,
    expiresAt: Math.min(
      authorization.expiresAt,
      recovery.continuity?.expiresAt ?? authorization.expiresAt,
    ),
    proofDigest: sha(canonical(proof)),
    renewalSequence: replay
      ? state.unstartedTransferHistory.renewalSequence - 1
      : (p.task.renewalSequence ?? 0),
    replayOnly: replay,
    expected: {
      repositoryId: p.repositoryId,
      taskId: p.task.taskId,
      leaseId: p.task.prepared.leaseId,
      leaseGeneration: p.task.prepared.leaseGeneration,
      revision: p.task.request.revision,
      checkoutIncarnation: p.task.checkoutIncarnation,
      checkoutIdentity: recovery.continuity?.mapping.old.checkout ?? p.task.checkoutIdentity,
    },
  };
}
