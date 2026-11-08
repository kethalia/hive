// Installed local composition. HTTP callers reach this only after a signed,
// independently bound project capability is verified by codex-project-discovery.
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processIdentity } from "./codex-process-identity.mjs";
import {
  projectRecovery,
  recoveryHeld,
  recoveryScopes,
  validateRecoveryRequest,
} from "./codex-project-recovery.mjs";

const check = (v, code = "project_request_rejected") => {
  if (!v) throw new Error(code);
};
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const number = (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v);
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const projectScopes = Object.freeze({
  ...recoveryScopes,
  "/projects/discover": "projects:discover",
  "/projects/resolve": "projects:resolve",
  "/projects/resolve-ref": "projects:resolve-ref",
  "/projects/epic-read": "projects:epic:read",
  "/projects/epic-merge": "projects:epic:merge",
  "/projects/production-release": "projects:release:production",
  "/projects/open": "projects:open",
  "/projects/tasks/start": "projects:task:start",
  "/projects/tasks/status": "projects:task:read",
  "/projects/tasks/retry": "projects:task:retry",
});
export function validProjectBranch(v) {
  return (
    typeof v === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(v) &&
    !v.includes("..") &&
    !v.includes("//") &&
    !v.endsWith("/") &&
    !v.endsWith(".") &&
    v.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
export function validateProjectOperation(path, r) {
  if (Object.hasOwn(recoveryScopes, path)) return validateRecoveryRequest(path, r);
  const common = ["schemaVersion"];
  if (path === "/projects/discover")
    check(
      exact(r, [...common, "page", "perPage"]) &&
        r.schemaVersion === 1 &&
        Number.isInteger(r.page) &&
        r.page >= 1 &&
        r.page <= 10000 &&
        Number.isInteger(r.perPage) &&
        r.perPage >= 1 &&
        r.perPage <= 100,
    );
  else if (path === "/projects/resolve-ref")
    check(
      exact(r, [...common, "repositoryId", "expectedAccountId", "branch"]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId) &&
        validProjectBranch(r.branch),
    );
  else if (path === "/projects/epic-merge" || path === "/projects/production-release") {
    const production = path === "/projects/production-release";
    const database = production && r?.operation === "database";
    check(
      exact(r, [
        "schemaVersion",
        "requestId",
        "config",
        "source",
        "gates",
        "operation",
        ...(database
          ? ["catalog", "command"]
          : r?.operation === "prepare"
            ? r.test
              ? ["test"]
              : []
            : r?.operation === "lookup"
              ? ["identity", "reference"]
              : r?.operation === "builds" && production
                ? ["mergeSha"]
                : production
                  ? ["identity", "authorityExpiresAt"]
                  : ["identity"]),
      ]) &&
        r.schemaVersion === 1 &&
        uuid(r.requestId) &&
        (production
          ? ["prepare", "dispatch", "lookup", "builds", "database"]
          : ["prepare", "dispatch", "lookup"]
        ).includes(r.operation) &&
        exact(r.source, [
          "repositoryId",
          "pullRequestId",
          "pullNumber",
          "headSha",
          "baseRef",
          "sourceBranch",
        ]) &&
        number(r.source.repositoryId) &&
        number(r.source.pullRequestId) &&
        Number.isSafeInteger(r.source.pullNumber) &&
        r.source.pullNumber > 0 &&
        /^[a-f0-9]{40}$/.test(r.source.headSha) &&
        validProjectBranch(r.source.baseRef) &&
        validProjectBranch(r.source.sourceBranch) &&
        (production
          ? r.source.baseRef === "main"
          : !["main", "master"].includes(r.source.baseRef.toLowerCase())) &&
        (!database ||
          (r.catalog &&
            typeof r.catalog === "object" &&
            !Array.isArray(r.catalog) &&
            r.config?.mode === "automatic-main-builds" &&
            r.command &&
            typeof r.command === "object" &&
            [
              "prepare",
              "merge",
              "builds",
              "baseline",
              "verify",
              "workload",
              "dispatch",
              "lookup",
            ].includes(r.command.action))) &&
        Buffer.byteLength(JSON.stringify(r)) <= (database ? 98304 : 12000),
    );
  } else if (path === "/projects/epic-read") {
    const merge = r?.operation === "observe_merge";
    check(
      exact(r, [
        ...common,
        "requestId",
        "operation",
        "repositoryId",
        "expectedAccountId",
        "baseBranch",
        "headSha",
        ...(merge ? ["pullRequestId", "pullNumber", "sourceBranch"] : ["baseSha"]),
      ]) &&
        r.schemaVersion === 1 &&
        uuid(r.requestId) &&
        ["observe_merge", "lineage"].includes(r.operation) &&
        number(r.repositoryId) &&
        number(r.expectedAccountId) &&
        validProjectBranch(r.baseBranch) &&
        /^[a-f0-9]{40}$/.test(r.headSha) &&
        (merge
          ? number(r.pullRequestId) &&
            Number.isSafeInteger(r.pullNumber) &&
            r.pullNumber > 0 &&
            validProjectBranch(r.sourceBranch)
          : /^[a-f0-9]{40}$/.test(r.baseSha)),
    );
  } else if (path === "/projects/resolve")
    check(
      exact(r, [...common, "repositoryId", "expectedAccountId"]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId),
    );
  else if (path === "/projects/open")
    check(
      exact(r, [...common, "repositoryId", "expectedAccountId", "projectId", "requestId"]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId) &&
        uuid(r.projectId) &&
        uuid(r.requestId),
    );
  else if (["/projects/tasks/status", "/projects/tasks/retry"].includes(path))
    check(
      exact(r, [...common, "projectId", "taskId", "requestId"]) &&
        r.schemaVersion === 1 &&
        [r.projectId, r.taskId, r.requestId].every(uuid),
    );
  else if (path === "/projects/tasks/start")
    check(
      exact(r, [
        ...common,
        "repositoryId",
        "expectedAccountId",
        "projectId",
        "taskId",
        "requestId",
        "revision",
        "model",
        "effort",
        "text",
      ]) &&
        r.schemaVersion === 1 &&
        number(r.repositoryId) &&
        number(r.expectedAccountId) &&
        [r.projectId, r.taskId, r.requestId].every(uuid) &&
        /^[a-f0-9]{40}$/.test(r.revision) &&
        typeof r.model === "string" &&
        /^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.model) &&
        ["low", "medium", "high", "xhigh", "max", "ultra"].includes(r.effort) &&
        typeof r.text === "string" &&
        r.text.trim() &&
        Buffer.byteLength(r.text) <= 32768 &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Explicitly reject ASCII controls except tab, LF and CR before native input.
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(r.text),
    );
  else check(false);
  return r;
}
function privatePath(p, dir = false) {
  check(realpathSync(p) === p, "private_state_required");
  const s = lstatSync(p);
  check(
    s.uid === process.getuid() && !(s.mode & 0o077) && (dir ? s.isDirectory() : s.isFile()),
    "private_state_required",
  );
}
function writeAtomic(path, state) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
/** Called by the trusted bootstrap before opening a replacement guardian. Each
 * signed token binds a preserved, released task and the prior tree-exit receipt.
 * The old complete journal is durably archived before any task pointer resets. */
export function archiveClosedProjectState(config, tokens, issuerPublicKeyPem) {
  check(uuid(config.ownerId) && uuid(config.workspaceId) && Array.isArray(tokens));
  privatePath(config.stateDirectory, true);
  const lock = openSync(
    join(config.stateDirectory, "controller.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
    });
    const keyPath = join(config.stateDirectory, "projects.key"),
      statePath = join(config.stateDirectory, "projects.json");
    privatePath(keyPath);
    privatePath(statePath);
    check(lstatSync(statePath).size <= 4 * 1024 * 1024, "archive_state_invalid");
    const key = readFileSync(keyPath),
      saved = JSON.parse(readFileSync(statePath));
    const signature = createHmac("sha256", key).update(JSON.stringify(saved.state)).digest("hex");
    check(
      key.length === 32 &&
        typeof saved.signature === "string" &&
        saved.signature.length === signature.length &&
        timingSafeEqual(Buffer.from(saved.signature), Buffer.from(signature)),
      "journal_signature_invalid",
    );
    const state = saved.state;
    check(
      state.schemaVersion === 1 &&
        state.ownerId === config.ownerId &&
        state.workspaceId === config.workspaceId,
      "archive_state_invalid",
    );
    check(tokens.length > 0 && tokens.length <= 32, "archive_scope_invalid");
    const issuer = createPublicKey(issuerPublicKeyPem);
    check(issuer.asymmetricKeyType === "ed25519", "archive_issuer_invalid");
    const claims = tokens.map((token) => {
      check(typeof token === "string" && token.length <= 16384, "archive_token_invalid");
      const parts = token.split(".");
      check(
        parts.length === 2 &&
          /^[A-Za-z0-9_-]+$/.test(parts[0]) &&
          /^[A-Za-z0-9_-]+$/.test(parts[1]) &&
          verify(
            null,
            Buffer.from(`hive-project-archive-v1\n${parts[0]}`),
            issuer,
            Buffer.from(parts[1], "base64url"),
          ),
        "archive_token_invalid",
      );
      const c = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      check(
        exact(c, [
          "schemaVersion",
          "ownerId",
          "hiveUserId",
          "workspaceId",
          "buildId",
          "projectId",
          "repositoryId",
          "taskId",
          "requestId",
          "leaseId",
          "leaseGeneration",
          "checkoutIncarnation",
          "acceptedSourceSha",
          "priorLifetimeId",
          "barrierId",
          "treeReceiptDigest",
          "preservationDigest",
          "leaseReleaseDigest",
          "expiresAt",
        ]) &&
          c.schemaVersion === 1 &&
          [
            c.ownerId,
            c.hiveUserId,
            c.workspaceId,
            c.buildId,
            c.projectId,
            c.taskId,
            c.requestId,
            c.leaseId,
            c.checkoutIncarnation,
            c.priorLifetimeId,
            c.barrierId,
          ].every(uuid) &&
          number(c.repositoryId) &&
          Number.isSafeInteger(c.leaseGeneration) &&
          c.leaseGeneration > 0 &&
          /^[a-f0-9]{40}$/.test(c.acceptedSourceSha) &&
          [c.treeReceiptDigest, c.preservationDigest, c.leaseReleaseDigest].every((d) =>
            /^[a-f0-9]{64}$/.test(d),
          ) &&
          Number.isSafeInteger(c.expiresAt) &&
          c.expiresAt > Date.now() &&
          c.expiresAt <= Date.now() + 60000,
        "archive_token_invalid",
      );
      return c;
    });
    check(new Set(claims.map((c) => c.projectId)).size === claims.length, "archive_scope_invalid");
    if (!state.guardianBarrier && !state.guardianLifetimeId) {
      const comparable = (items) =>
        items
          .map(({ expiresAt: _expiresAt, ...item }) => item)
          .sort((a, b) => a.projectId.localeCompare(b.projectId));
      const entries = readdirSync(config.stateDirectory).filter((name) =>
        /^projects-archive-[a-f0-9]{64}\.json$/.test(name),
      );
      check(entries.length <= 256, "archive_scope_invalid");
      for (const name of entries) {
        const path = join(config.stateDirectory, name);
        privatePath(path);
        if (lstatSync(path).size > 5 * 1024 * 1024) continue;
        const prior = JSON.parse(readFileSync(path));
        const content = { state: prior.state, claims: prior.claims, tokens: prior.tokens };
        const mac = createHmac("sha256", key).update(JSON.stringify(content)).digest("hex");
        if (
          typeof prior.signature !== "string" ||
          prior.signature !== mac ||
          digest(content) !== name.slice(17, -5)
        )
          continue;
        if (
          JSON.stringify(comparable(prior.claims)) === JSON.stringify(comparable(claims)) &&
          claims.every((c) => state.projects[c.projectId]?.task === null)
        )
          return { archiveDigest: digest(content), taskCount: claims.length, replayed: true };
      }
      check(false, "archive_scope_invalid");
    }
    check(state.guardianBarrier && uuid(state.guardianBarrier.barrierId), "archive_state_invalid");
    const active = Object.values(state.projects).filter((p) => p.task);
    check(active.length === claims.length, "archive_scope_invalid");
    for (const p of active) {
      const t = p.task,
        c = claims.find((item) => item.projectId === p.projectId);
      check(
        c &&
          c.ownerId === state.ownerId &&
          c.workspaceId === state.workspaceId &&
          c.repositoryId === p.repositoryId &&
          c.buildId === t.guardianPreparation?.buildId &&
          c.taskId === t.taskId &&
          c.requestId === t.request?.requestId &&
          c.leaseId === t.prepared?.leaseId &&
          c.leaseGeneration === t.prepared?.leaseGeneration &&
          c.checkoutIncarnation === t.checkoutIncarnation &&
          c.acceptedSourceSha === (t.acceptedSource?.headSha ?? t.request?.revision) &&
          c.priorLifetimeId === state.guardianLifetimeId &&
          c.barrierId === state.guardianBarrier.barrierId,
        "archive_scope_invalid",
      );
    }
    const archiveDigest = digest({ state, claims, tokens });
    const archive = {
      state,
      claims,
      tokens,
      signature: createHmac("sha256", key)
        .update(JSON.stringify({ state, claims, tokens }))
        .digest("hex"),
    };
    writeAtomic(join(config.stateDirectory, `projects-archive-${archiveDigest}.json`), archive);
    const dir = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    for (const p of active) p.task = null;
    delete state.guardianBarrier;
    delete state.guardianLifetimeId;
    writeAtomic(statePath, {
      state,
      signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
    });
    const finalDir = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(finalDir);
    } finally {
      closeSync(finalDir);
    }
    return { archiveDigest, taskCount: active.length };
  } finally {
    closeSync(lock);
  }
}

/** Called only by the outer host after authenticating its idle ECHILD journal.
 * Archive before resetting, and require the same signed archive on replay. */
export function archiveIdleProjectState(config, receipt) {
  check(uuid(config.ownerId) && uuid(config.workspaceId), "idle_archive_identity_invalid");
  check(
    receipt?.guardianExited === true &&
      receipt.finalWaitResult === "ECHILD" &&
      receipt.waitFlags === "__WALL" &&
      receipt.scope === "managed_native_tree_only" &&
      receipt.cleanupAuthorized === false &&
      uuid(receipt.lifetimeId) &&
      uuid(receipt.receiptId) &&
      Array.isArray(receipt.projects) &&
      receipt.projects.length === 0 &&
      Array.isArray(receipt.decisions) &&
      receipt.decisions.length === 0 &&
      receipt.workerBarrier?.closed === true &&
      uuid(receipt.workerBarrier.barrierId),
    "idle_archive_receipt_invalid",
  );
  privatePath(config.stateDirectory, true);
  const lock = openSync(
    join(config.stateDirectory, "controller.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    privatePath(join(config.stateDirectory, "controller.lock"));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
    });
    const keyPath = join(config.stateDirectory, "projects.key"),
      statePath = join(config.stateDirectory, "projects.json"),
      receiptDigest = digest(receipt),
      archivePath = join(config.stateDirectory, `projects-idle-${receiptDigest}.json`);
    privatePath(keyPath);
    const key = readFileSync(keyPath);
    check(key.length === 32, "journal_key_invalid");
    const mac = (value) => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
    const readSigned = (path) => {
      privatePath(path);
      check(lstatSync(path).size <= 4 * 1024 * 1024, "idle_archive_state_invalid");
      const saved = JSON.parse(readFileSync(path));
      check(
        typeof saved.signature === "string" &&
          saved.signature.length === 64 &&
          timingSafeEqual(Buffer.from(saved.signature), Buffer.from(mac(saved.state))),
        "journal_signature_invalid",
      );
      return saved.state;
    };
    const current = readSigned(statePath),
      archived = existsSync(archivePath) ? readSigned(archivePath) : null,
      state = archived ? archived.projectState : current,
      barrier = state?.guardianBarrier;
    check(!archived || archived.receiptDigest === receiptDigest, "idle_archive_receipt_invalid");
    check(
      state?.schemaVersion === 1 &&
        state.ownerId === config.ownerId &&
        state.workspaceId === config.workspaceId &&
        state.projects &&
        typeof state.projects === "object" &&
        !Array.isArray(state.projects) &&
        Object.keys(state.projects).length === 0 &&
        state.guardianLifetimeId === receipt.lifetimeId &&
        state.hostProcess?.pid === receipt.workerPid &&
        Array.isArray(barrier?.projects) &&
        barrier.projects.length === 0 &&
        barrier.lifetimeId === receipt.lifetimeId &&
        barrier.bindingDigest === receipt.bindingDigest &&
        barrier.barrierId === receipt.workerBarrier.barrierId &&
        barrier.ownershipDigest === receipt.ownershipDigest &&
        receipt.workerBarrier.lifetimeId === barrier.lifetimeId &&
        receipt.workerBarrier.ownershipDigest === barrier.ownershipDigest &&
        receipt.workerBarrier.generation === barrier.generation &&
        Number.isSafeInteger(barrier.generation) &&
        barrier.generation > 0 &&
        receipt.generation === barrier.generation + 1,
      "idle_archive_state_invalid",
    );
    const reset = structuredClone(state);
    delete reset.guardianBarrier;
    delete reset.guardianLifetimeId;
    delete reset.hostProcess;
    check(
      digest(current) === digest(state) || (archived && digest(current) === digest(reset)),
      "idle_archive_state_changed",
    );
    const persist = (path, value) => {
      writeAtomic(path, { state: value, signature: mac(value) });
      const fd = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    if (!archived) persist(archivePath, { receiptDigest, projectState: state });
    persist(statePath, reset);
    return { receiptDigest };
  } finally {
    closeSync(lock);
  }
}
/** Only the installed outer calls this with its authenticated startup-only
 * journal proof while holding the guardian flock. This does not certify ECHILD,
 * native tree exit, or authorize checkout cleanup. */
export function archiveBootstrapProjectState(config, proof) {
  check(
    [config.ownerId, config.workspaceId, config.templateId, config.buildId].every(uuid) &&
      proof?.scope === "never_admitted_bootstrap_authorization_only" &&
      proof.nativeTreeExited === false &&
      proof.cleanupAuthorized === false &&
      uuid(proof.lifetimeId) &&
      /^[a-f0-9]{64}$/.test(proof.sourceJournalDigest),
    "bootstrap_archive_proof_invalid",
  );
  privatePath(config.stateDirectory, true);
  privatePath(config.guardianStateDirectory, true);
  check(
    join(config.stateDirectory, "..", "codex-host-guardian") === config.guardianStateDirectory &&
      lstatSync(config.stateDirectory).dev === lstatSync(config.guardianStateDirectory).dev,
    "bootstrap_archive_proof_invalid",
  );
  const lock = openSync(
    join(config.stateDirectory, "controller.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    privatePath(join(config.stateDirectory, "controller.lock"));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
    });
    const retirementDigest = digest(proof),
      archiveName = `projects-bootstrap-${proof.sourceJournalDigest}.json`,
      archivePath = join(config.stateDirectory, archiveName),
      statePath = join(config.stateDirectory, "projects.json"),
      keyPath = join(config.stateDirectory, "projects.key"),
      supervisor = join(config.stateDirectory, "..", "codex-project-supervisor");
    const history = readdirSync(config.stateDirectory);
    check(
      history.length <= 256 && !history.some((name) => /^projects-(?:archive|idle)-/.test(name)),
      "bootstrap_archive_history_present",
    );
    if (readdirSync(join(config.stateDirectory, "..")).includes("codex-project-supervisor")) {
      privatePath(supervisor, true);
      check(readdirSync(supervisor).length === 0, "bootstrap_archive_history_present");
    }
    privatePath(keyPath);
    const key = readFileSync(keyPath);
    check(key.length === 32, "journal_key_invalid");
    const mac = (value) => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex"),
      readSigned = (path) => {
        privatePath(path);
        check(lstatSync(path).size <= 4 * 1024 * 1024, "bootstrap_archive_state_invalid");
        const saved = JSON.parse(readFileSync(path));
        check(
          typeof saved.signature === "string" &&
            saved.signature.length === 64 &&
            timingSafeEqual(Buffer.from(saved.signature), Buffer.from(mac(saved.state))),
          "journal_signature_invalid",
        );
        return saved.state;
      };
    const assertEmpty = (state, lifetimeId, worker) => {
      check(
        exact(state, [
          "schemaVersion",
          "ownerId",
          "workspaceId",
          "projects",
          "guardianLifetimeId",
          "hostProcess",
        ]) &&
          state.schemaVersion === 1 &&
          state.ownerId === config.ownerId &&
          state.workspaceId === config.workspaceId &&
          state.projects &&
          typeof state.projects === "object" &&
          !Array.isArray(state.projects) &&
          Object.keys(state.projects).length === 0 &&
          state.guardianLifetimeId === lifetimeId &&
          exact(state.hostProcess, [
            "pid",
            "startTime",
            "bootId",
            "executable",
            "device",
            "inode",
          ]) &&
          Object.keys(state.hostProcess).every((key) => state.hostProcess[key] === worker?.[key]),
        "bootstrap_archive_state_invalid",
      );
    };
    for (const name of history.filter(
      (name) => name.startsWith("projects-bootstrap-") && name !== archiveName,
    )) {
      const match = /^projects-bootstrap-([a-f0-9]{64})\.json$/.exec(name);
      check(match, "bootstrap_archive_history_present");
      const prior = readSigned(join(config.stateDirectory, name)),
        outerDir = config.guardianStateDirectory;
      privatePath(outerDir, true);
      check(
        lstatSync(outerDir).dev === lstatSync(config.stateDirectory).dev,
        "bootstrap_archive_proof_invalid",
      );
      const outerKeyPath = join(outerDir, "key");
      privatePath(outerKeyPath);
      const outerKey = readFileSync(outerKeyPath);
      check(outerKey.length === 32, "journal_key_invalid");
      const readOuter = (path) => {
          privatePath(path);
          check(lstatSync(path).size <= 2 * 1024 * 1024, "bootstrap_archive_proof_invalid");
          const raw = readFileSync(path),
            saved = JSON.parse(raw),
            signature = createHmac("sha256", outerKey)
              .update(JSON.stringify(saved.state))
              .digest("hex");
          check(
            typeof saved.signature === "string" &&
              saved.signature.length === 64 &&
              timingSafeEqual(Buffer.from(saved.signature), Buffer.from(signature)),
            "journal_signature_invalid",
          );
          return { raw, state: saved.state };
        },
        original = readOuter(join(outerDir, `lifetime-bootstrap-${match[1]}.json`)),
        facts = readOuter(join(outerDir, `bootstrap-retirement-${match[1]}.json`)).state,
        { projectEvidence, ...oldProof } = facts;
      check(
        createHash("sha256").update(original.raw).digest("hex") === match[1] &&
          oldProof.scope === "never_admitted_bootstrap_authorization_only" &&
          oldProof.nativeTreeExited === false &&
          oldProof.cleanupAuthorized === false &&
          oldProof.sourceJournalDigest === match[1] &&
          digest(oldProof) === prior.retirementDigest &&
          original.state.phase === "startupReady" &&
          original.state.receipts.length === 0 &&
          original.state.events.map((event) => event.name).join() ===
            "begin,ready,launchIntent,open,startupReady" &&
          projectEvidence?.ownerId === config.ownerId &&
          projectEvidence.workspaceId === config.workspaceId &&
          projectEvidence.templateId === config.templateId &&
          uuid(projectEvidence.buildId) &&
          projectEvidence.retirementDigest === prior.retirementDigest &&
          projectEvidence.projectJournalDigest === digest(prior.projectState) &&
          (!prior.projectEvidence || digest(prior.projectEvidence) === digest(projectEvidence)),
        "bootstrap_archive_history_invalid",
      );
      assertEmpty(prior.projectState, oldProof.lifetimeId, oldProof.workerIdentity);
    }
    const current = readSigned(statePath),
      archived = existsSync(archivePath) ? readSigned(archivePath) : null,
      state = archived ? archived.projectState : current;
    check(
      !archived || archived.retirementDigest === retirementDigest,
      "bootstrap_archive_proof_invalid",
    );
    assertEmpty(state, proof.lifetimeId, proof.workerIdentity);
    const reset = {
      schemaVersion: 1,
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      projects: {},
    };
    check(
      digest(current) === digest(state) || (archived && digest(current) === digest(reset)),
      "bootstrap_archive_state_changed",
    );
    const persist = (path, value) => {
      writeAtomic(path, { state: value, signature: mac(value) });
      const fd = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    const storage = lstatSync(config.stateDirectory);
    const evidence = archived?.projectEvidence ?? {
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      templateId: config.templateId,
      buildId: config.buildId,
      retirementDigest,
      projectJournalDigest: digest(state),
      privateDirectoryIdentity: { device: String(storage.dev), inode: String(storage.ino) },
    };
    check(
      (!archived || archived.projectEvidence) &&
        exact(evidence, [
          "ownerId",
          "workspaceId",
          "templateId",
          "buildId",
          "retirementDigest",
          "projectJournalDigest",
          "privateDirectoryIdentity",
        ]) &&
        evidence.ownerId === config.ownerId &&
        evidence.workspaceId === config.workspaceId &&
        evidence.templateId === config.templateId &&
        uuid(evidence.buildId) &&
        evidence.retirementDigest === retirementDigest &&
        evidence.projectJournalDigest === digest(state) &&
        exact(evidence.privateDirectoryIdentity, ["device", "inode"]) &&
        evidence.privateDirectoryIdentity.device === String(storage.dev) &&
        evidence.privateDirectoryIdentity.inode === String(storage.ino),
      "bootstrap_archive_proof_invalid",
    );
    if (!archived)
      persist(archivePath, { retirementDigest, projectState: state, projectEvidence: evidence });
    persist(statePath, reset);
    return evidence;
  } finally {
    closeSync(lock);
  }
}
/** Dependencies are installed functions, never HTTP parameters. openRuntime must
 * return the ONE supervisor plus its registration authority for this host. */
/** Installed outer only, AFTER its authenticated actual ECHILD receipt and DB
 * maintenance-purpose close acknowledgment. This parks unfinished journals; it
 * does not consume completion archive grants, release a lease or touch checkout
 * files. Returned digest is private control metadata, never public evidence. */
export function parkAccountMaintenanceProjectState(config, receipt, maintenanceId) {
  check(
    uuid(config.ownerId) && uuid(config.workspaceId) && uuid(maintenanceId),
    "maintenance_park_scope_invalid",
  );
  check(
    receipt?.scope === "managed_native_tree_only" &&
      receipt.guardianExited === true &&
      receipt.finalWaitResult === "ECHILD" &&
      receipt.cleanupAuthorized === false &&
      uuid(receipt.lifetimeId) &&
      uuid(receipt.workerBarrier?.barrierId) &&
      receipt.workerBarrier.closed === true &&
      receipt.generation === receipt.workerBarrier.generation + 1 &&
      Array.isArray(receipt.projects) &&
      receipt.projects.length > 0 &&
      receipt.projects.length <= 32 &&
      new Set(receipt.projects.map((p) => p.projectId)).size === receipt.projects.length,
    "maintenance_tree_exit_unverified",
  );
  privatePath(config.stateDirectory, true);
  const locks = [];
  try {
    for (const path of [
      join(config.stateDirectory, "controller.lock"),
      join(config.stateDirectory, "..", "codex-project-supervisor", "supervisor.lock"),
    ]) {
      privatePath(path);
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      locks.push(fd);
      const info = fstatSync(fd);
      check(
        info.isFile() && info.nlink === 1 && info.uid === process.getuid() && !(info.mode & 0o077),
        "maintenance_park_private_state",
      );
      execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
        stdio: ["ignore", "ignore", "ignore", fd],
        timeout: 2000,
      });
    }
    const read = (path, limit) => {
      privatePath(path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        check(
          before.isFile() &&
            before.nlink === 1 &&
            before.uid === process.getuid() &&
            !(before.mode & 0o077) &&
            before.size <= limit,
          "maintenance_park_private_state",
        );
        const bytes = readFileSync(fd);
        const after = fstatSync(fd);
        check(
          bytes.length === before.size &&
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs,
          "maintenance_park_state_changed",
        );
        return bytes;
      } finally {
        closeSync(fd);
      }
    };
    const statePath = join(config.stateDirectory, "projects.json"),
      key = read(join(config.stateDirectory, "projects.key"), 32);
    check(key.length === 32, "maintenance_park_private_state");
    const mac = (v) => createHmac("sha256", key).update(JSON.stringify(v)).digest("hex");
    const decode = (bytes) => {
      const value = JSON.parse(bytes);
      check(
        typeof value.signature === "string" &&
          /^[a-f0-9]{64}$/.test(value.signature) &&
          timingSafeEqual(Buffer.from(value.signature), Buffer.from(mac(value.state))),
        "maintenance_park_signature_invalid",
      );
      return value.state;
    };
    const current = decode(read(statePath, 4 * 1024 * 1024));
    const archivePath = join(config.stateDirectory, `projects-maintenance-${maintenanceId}.json`);
    const archived = existsSync(archivePath) ? decode(read(archivePath, 8 * 1024 * 1024)) : null;
    const state = archived?.projectState ?? current;
    check(
      state.schemaVersion === 1 &&
        state.ownerId === config.ownerId &&
        state.workspaceId === config.workspaceId &&
        state.guardianLifetimeId === receipt.lifetimeId &&
        state.guardianBarrier?.barrierId === receipt.workerBarrier.barrierId &&
        state.guardianBarrier?.generation === receipt.workerBarrier.generation &&
        state.hostProcess?.pid === receipt.workerPid &&
        Array.isArray(state.guardianBarrier.projects) &&
        state.guardianBarrier.projects.length === receipt.projects.length &&
        receipt.projects.every((p) =>
          state.guardianBarrier.projects.some(
            (q) => q.projectId === p.projectId && q.bindingDigest === p.bindingDigest,
          ),
        ) &&
        Object.keys(state.projects).length === receipt.projects.length &&
        receipt.projects.every((p) => state.projects[p.projectId]?.task?.nativeThreadId),
      "maintenance_park_identity_changed",
    );
    const nativePath = join(
      config.stateDirectory,
      "..",
      "codex-project-supervisor",
      "registry.json",
    );
    const nativeBytes = read(nativePath, 1024 * 1024);
    const nativeKey = read(
      join(config.stateDirectory, "..", "codex-project-supervisor", "key"),
      32,
    );
    const native = JSON.parse(nativeBytes);
    check(
      nativeKey.length === 32 &&
        typeof native.signature === "string" &&
        /^[a-f0-9]{64}$/.test(native.signature) &&
        timingSafeEqual(
          Buffer.from(native.signature),
          Buffer.from(
            createHmac("sha256", nativeKey).update(JSON.stringify(native.state)).digest("hex"),
          ),
        ) &&
        native.state.ownerId === config.ownerId &&
        native.state.workspaceId === config.workspaceId &&
        receipt.projects.every(
          (p) =>
            native.state.projects[p.projectId]?.serverInstanceId ===
              native.state.serverInstanceId &&
            native.state.projects[p.projectId]?.threadId ===
              state.projects[p.projectId].task.nativeThreadId,
        ),
      "maintenance_park_native_history_changed",
    );
    const evidence = {
      schemaVersion: 1,
      purpose: "account-maintenance",
      maintenanceId,
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      priorLifetimeId: receipt.lifetimeId,
      treeReceiptDigest: digest(receipt),
      nativeRegistryDigest: digest(native),
      nativeRegistry: native,
      projectState: state,
    };
    check(!archived || digest(archived) === digest(evidence), "maintenance_park_evidence_changed");
    const parkedJournalDigest = digest(evidence);
    const reset = {
      schemaVersion: 1,
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      projects: {},
      accountMaintenance: {
        id: maintenanceId,
        parkedJournalDigest,
        priorLifetimeId: receipt.lifetimeId,
      },
    };
    check(
      digest(current) === digest(state) || digest(current) === digest(reset),
      "maintenance_park_state_changed",
    );
    const persist = (path, value) => {
      writeAtomic(path, { state: value, signature: mac(value) });
      const fd = openSync(
        config.stateDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    if (!archived) persist(archivePath, evidence); // Archive is durable BEFORE resetting the live controller pointer.
    persist(statePath, reset);
    return {
      parked: true,
      maintenanceId,
      parkedJournalDigest,
      projectCount: receipt.projects.length,
    };
  } finally {
    for (const fd of locks.reverse()) closeSync(fd);
  }
}

/** Fixed installed private archive reader. No caller-selected path, command or
 * credential root. The outer signs only the projected scope after verifying
 * both retained HMACs and the exact physical-close journal. */
export function readAccountMaintenanceArchive(config, maintenanceId) {
  check(
    uuid(config.ownerId) && uuid(config.workspaceId) && uuid(maintenanceId),
    "maintenance_archive_scope_invalid",
  );
  const read = (path, max) => {
    check(realpathSync(path) === path, "maintenance_archive_private_state");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const a = fstatSync(fd);
      check(
        a.isFile() &&
          a.uid === process.getuid() &&
          a.nlink === 1 &&
          !(a.mode & 0o077) &&
          a.size <= max,
        "maintenance_archive_private_state",
      );
      const bytes = readFileSync(fd),
        b = fstatSync(fd);
      check(
        bytes.length <= max &&
          a.ino === b.ino &&
          a.dev === b.dev &&
          a.size === b.size &&
          a.mtimeMs === b.mtimeMs,
        "maintenance_archive_changed",
      );
      return bytes;
    } finally {
      closeSync(fd);
    }
  };
  const key = read(join(config.stateDirectory, "projects.key"), 32);
  check(key.length === 32, "maintenance_archive_private_state");
  const signed = JSON.parse(
    read(
      join(config.stateDirectory, `projects-maintenance-${maintenanceId}.json`),
      8 * 1024 * 1024,
    ),
  );
  const mac = createHmac("sha256", key).update(JSON.stringify(signed.state)).digest("hex");
  check(
    typeof signed.signature === "string" &&
      signed.signature.length === mac.length &&
      timingSafeEqual(Buffer.from(signed.signature), Buffer.from(mac)),
    "maintenance_archive_signature_invalid",
  );
  const evidence = signed.state;
  check(
    evidence.schemaVersion === 1 &&
      evidence.purpose === "account-maintenance" &&
      evidence.maintenanceId === maintenanceId &&
      evidence.ownerId === config.ownerId &&
      evidence.workspaceId === config.workspaceId &&
      evidence.projectState?.ownerId === config.ownerId &&
      evidence.projectState?.workspaceId === config.workspaceId &&
      uuid(evidence.projectState?.guardianBarrier?.barrierId) &&
      evidence.priorLifetimeId === evidence.projectState?.guardianLifetimeId,
    "maintenance_archive_scope_invalid",
  );
  const nativeKey = read(join(config.stateDirectory, "..", "codex-project-supervisor", "key"), 32);
  const native = evidence.nativeRegistry;
  check(
    nativeKey.length === 32 &&
      native &&
      typeof native.signature === "string" &&
      /^[a-f0-9]{64}$/.test(native.signature) &&
      timingSafeEqual(
        Buffer.from(native.signature),
        Buffer.from(
          createHmac("sha256", nativeKey).update(JSON.stringify(native.state)).digest("hex"),
        ),
      ) &&
      digest(native) === evidence.nativeRegistryDigest &&
      native.state.ownerId === config.ownerId &&
      native.state.workspaceId === config.workspaceId,
    "maintenance_archive_native_history_changed",
  );
  const current = JSON.parse(
    read(
      join(config.stateDirectory, "..", "codex-project-supervisor", "registry.json"),
      1024 * 1024,
    ),
  );
  check(
    digest(current) === evidence.nativeRegistryDigest,
    "maintenance_archive_native_history_changed",
  );
  return { evidence, parkedJournalDigest: digest(evidence) };
}

export function createProjectController(config, deps) {
  check(exact(config, ["stateDirectory", "ownerId", "workspaceId", "model", "effort"]));
  check(
    uuid(config.ownerId) &&
      uuid(config.workspaceId) &&
      typeof config.model === "string" &&
      ["low", "medium", "high", "xhigh", "max", "ultra"].includes(config.effort),
  );
  const guardian = deps.guardian;
  if (guardian)
    check(
      uuid(deps.guardianBuildId) &&
        ["admit", "executionFence", "assertAdmission"].every(
          (name) => typeof guardian[name] === "function",
        ) &&
        guardian.state?.phase === "open",
      "guardian_dependency_rejected",
    );
  privatePath(config.stateDirectory, true);
  const lock = openSync(
    join(config.stateDirectory, "controller.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false,
    queue = Promise.resolve(),
    runtime = null;
  const admissions = new Map();
  const pending = new Set();
  const historyRecovered = new Set();
  const statePath = join(config.stateDirectory, "projects.json"),
    keyPath = join(config.stateDirectory, "projects.key");
  let state, key;
  try {
    const st = fstatSync(lock);
    check(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
    });
    if (!existsSync(keyPath)) {
      check(!existsSync(statePath), "journal_key_missing");
      const fd = openSync(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    privatePath(keyPath);
    key = readFileSync(keyPath);
    check(key.length === 32);
    state = {
      schemaVersion: 1,
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      projects: {},
    };
    if (existsSync(statePath)) {
      privatePath(statePath);
      check(lstatSync(statePath).size <= 4 * 1024 * 1024);
      const saved = JSON.parse(readFileSync(statePath));
      const expected = createHmac("sha256", key).update(JSON.stringify(saved.state)).digest("hex");
      check(
        typeof saved.signature === "string" &&
          saved.signature.length === expected.length &&
          timingSafeEqual(Buffer.from(saved.signature), Buffer.from(expected)),
        "journal_signature_invalid",
      );
      state = saved.state;
      check(
        state.schemaVersion === 1 &&
          state.ownerId === config.ownerId &&
          state.workspaceId === config.workspaceId &&
          Object.keys(state.projects).length <= 32,
        "journal_identity_changed",
      );
    }
  } catch (error) {
    closeSync(lock);
    throw error;
  }
  function save() {
    writeAtomic(statePath, {
      state,
      signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
    });
    const fd = openSync(config.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  if (guardian) {
    // A new guardian must not retroactively certify an earlier worker's tasks.
    try {
      check(
        !state.guardianBarrier &&
          (!state.guardianLifetimeId || state.guardianLifetimeId === guardian.state.lifetimeId) &&
          !Object.values(state.projects).some(
            (p) =>
              p.task &&
              !p.task.guardianPreparation &&
              (p.task.prepared || p.task.nativeCreationAttempted),
          ),
        "guardian_restart_reconciliation_required",
      );
    } catch (error) {
      closeSync(lock);
      throw error;
    }
    state.guardianLifetimeId = guardian.state.lifetimeId;
  }
  state.hostProcess = processIdentity(process.pid);
  save();
  function assertOpen() {
    check(!closed && !state.guardianBarrier, "controller_admission_closed");
    if (guardian) check(guardian.state.phase === "open", "controller_admission_closed");
  }
  function assertSourceInputOpen(p) {
    check(!recoveryHeld(p), "retry_not_available");
    const a = p.task?.sourceApplication;
    check(
      !a ||
        (a.phase === "released" &&
          /^[a-f0-9]{64}$/.test(a.serverCommitDigest ?? "") &&
          JSON.stringify(p.task.acceptedSource) === JSON.stringify(a.targetSourceContext)),
      "source_application_input_closed",
    );
  }
  function assertAdmission(projectId) {
    assertOpen();
    check(!recoveryHeld(state.projects[projectId]), "retry_not_available");
    if (guardian) {
      const token = admissions.get(projectId);
      check(token, "guardian_project_not_admitted");
      guardian.assertAdmission(token);
    }
  }
  async function admitPreparation(p) {
    assertOpen();
    if (!guardian) return;
    const t = p.task;
    check(t && t.digest === digest(t.request), "task_identity_conflict");
    const preparation = {
      schemaVersion: 1,
      stage: "preparation",
      ownerId: config.ownerId,
      workspaceId: config.workspaceId,
      buildId: deps.guardianBuildId,
      projectId: p.projectId,
      repositoryId: p.repositoryId,
      providerAccountId: p.expectedAccountId,
      taskId: t.taskId,
      requestId: t.request.requestId,
      baseSha: t.request.revision,
      requestDigest: t.digest,
    };
    check(
      !t.guardianPreparation || digest(t.guardianPreparation) === digest(preparation),
      "guardian_preparation_identity_changed",
    );
    if (!t.guardianPreparation) {
      t.guardianPreparation = preparation;
      save(); // Before admission and every Git/helper spawn, not after checkout preparation.
    }
    if (!admissions.has(p.projectId)) {
      const token = await guardian.admit({
        projectId: p.projectId,
        bindingDigest: digest(preparation),
      });
      assertOpen();
      guardian.assertAdmission(token);
      admissions.set(p.projectId, token);
      t.guardianAdmission = structuredClone(token); // Historical ACK, never restart authority.
      save();
    }
  }
  async function fence(p, prepared = false) {
    assertOpen();
    if (!guardian) return;
    await admitPreparation(p);
    if (prepared) check(p.task.guardianPrepared, "guardian_prepared_binding_missing");
    const token = await guardian.executionFence(admissions.get(p.projectId));
    assertOpen();
    guardian.assertAdmission(token);
    admissions.set(p.projectId, token);
    // Appending another project changes the shared ownership generation. Refresh
    // existing opaque tokens before any shared worker/helper assertion; an old
    // token is never silently treated as current authority.
    for (const [projectId, other] of admissions) {
      if (other.generation === guardian.state.generation) continue;
      const refreshed = await guardian.executionFence(other);
      assertOpen();
      guardian.assertAdmission(refreshed);
      admissions.set(projectId, refreshed);
    }
  }
  function bindPrepared(p) {
    if (!guardian) return;
    assertAdmission(p.projectId);
    const t = p.task;
    const binding = {
      schemaVersion: 1,
      preparationDigest: digest(t.guardianPreparation),
      projectId: p.projectId,
      repositoryId: p.repositoryId,
      taskId: t.taskId,
      revision: t.request.revision,
      leaseId: t.prepared.leaseId,
      leaseGeneration: t.prepared.leaseGeneration,
      checkoutIncarnation: t.checkoutIncarnation,
      checkoutIdentity: t.checkoutIdentity,
    };
    check(
      typeof binding.checkoutIncarnation === "string" &&
        binding.checkoutIncarnation.length > 0 &&
        binding.checkoutIdentity &&
        Object.keys(binding.checkoutIdentity).sort().join() === "device,inode" &&
        /^[0-9]{1,24}$/.test(binding.checkoutIdentity.device) &&
        /^[1-9][0-9]{0,24}$/.test(binding.checkoutIdentity.inode) &&
        (!t.guardianPrepared || digest(t.guardianPrepared) === digest(binding)),
      "guardian_prepared_identity_changed",
    );
    if (!t.guardianPrepared) {
      t.guardianPrepared = binding;
      save(); // Separate immutable actual binding; never rewrites the earlier admission digest.
    }
  }
  function project(id) {
    const p = state.projects[id];
    check(p, "project_not_enrolled");
    return p;
  }
  function status(p) {
    const t = p.task;
    return {
      schemaVersion: 1,
      projectId: p.projectId,
      taskId: t.taskId,
      phase: t.phase,
      nativeThreadId: t.nativeThreadId ?? null,
      terminalSessionName: t.terminalSessionName ?? null,
      reason: t.reason ?? null,
    };
  }
  async function resolve(r) {
    assertOpen();
    const result = await deps.resolveRepository({
      schemaVersion: 1,
      operation: r.branch === undefined ? "resolve" : "resolve_ref",
      ...(r.branch === undefined ? {} : { branch: r.branch }),
      repositoryId: r.repositoryId,
      expectedAccountId: r.expectedAccountId,
    });
    assertOpen();
    if (result?.error)
      throw new Error(
        result.error === "github_auth_required"
          ? "github_auth_required"
          : "repository_identity_changed",
      );
    check(
      result?.schemaVersion === 1 &&
        result.providerAccountId === r.expectedAccountId &&
        result.repository?.providerRepositoryId === r.repositoryId &&
        (r.branch === undefined
          ? /^[a-f0-9]{40}$/.test(result.defaultRevision)
          : result.branch === r.branch && /^[a-f0-9]{40}$/.test(result.revision)),
      "repository_identity_changed",
    );
    return result;
  }
  function blocked(t, error) {
    if (state.guardianBarrier) return; // Preserve the exact durable closed-barrier snapshot.
    const known = new Set([
      "github_auth_required",
      "repository_identity_changed",
      "checkout_busy",
      "checkout_unavailable",
      "revision_unavailable",
      "model_unavailable",
      "native_unavailable",
      "registration_unavailable",
      "prompt_submission_uncertain",
      "task_identity_conflict",
    ]);
    t.phase = "blocked";
    t.reason = known.has(error?.message) ? error.message : "native_unavailable";
    save();
  }
  async function advance(p) {
    const t = p.task;
    if (recoveryHeld(p)) return;
    if (t?.sourceApplication && t.sourceApplication.phase !== "released") return;
    if (closed || !t || (t.phase === "blocked" && !(t.executionRevoked && t.prepared))) return;
    if (t.executionRevoked) historyRecovered.add(p.projectId);
    try {
      await fence(p);
      assertAdmission(p.projectId);
      if (!t.prepared) {
        const resolved = await resolve(t.request);
        await fence(p);
        assertAdmission(p.projectId);
        check(
          resolved.repository.permissions?.push === true && !resolved.repository.archived,
          "repository_identity_changed",
        );
        const inspected = await deps.inspectCheckout(p.repositoryId);
        await fence(p);
        assertAdmission(p.projectId);
        let ready;
        if (
          inspected?.status === "ready" &&
          inspected.lease?.taskId === t.taskId &&
          inspected.revision === t.request.revision &&
          inspected.checkoutVerified === true &&
          inspected.lease.expiresAt > Date.now() / 1000
        )
          ready = inspected;
        else {
          check(!inspected?.lease || inspected.lease.taskId === t.taskId, "checkout_busy");
          ready = await deps.prepareCheckout({
            ...t.request,
            ...(inspected?.lease
              ? { leaseId: inspected.lease.id, generation: inspected.lease.generation }
              : {}),
          });
          await fence(p);
          assertAdmission(p.projectId);
        }
        check(
          ready?.status === "ready" &&
            ready.lease?.taskId === t.taskId &&
            ready.lease.expiresAt > Date.now() / 1000,
          "checkout_unavailable",
        );
        t.checkoutIncarnation = ready.checkoutIncarnation;
        if (guardian) t.checkoutIdentity = structuredClone(ready.checkoutIdentity);
        t.renewalSequence = ready.renewalSequence ?? 0;
        t.prepared = {
          projectId: p.projectId,
          repositoryId: p.repositoryId,
          taskId: t.taskId,
          leaseId: ready.lease.id,
          leaseGeneration: ready.lease.generation,
          model: t.request.model,
          effort: t.request.effort,
        };
        save();
      }
      bindPrepared(p);
      await fence(p, true);
      assertAdmission(p.projectId);
      if (!runtime)
        runtime = await deps.openRuntime(
          Object.values(state.projects).flatMap((q) => (q.task?.prepared ? [q.task.prepared] : [])),
        );
      await fence(p, true);
      assertAdmission(p.projectId);
      const supervisor = runtime.supervisor;
      supervisor.enrollPreparedProject(t.prepared);
      let snap = supervisor.snapshot(p.projectId);
      if (snap.phase === "not-created") {
        check(!t.executionRevoked, "native_unavailable");
        t.nativeCreationAttempted = true;
        save();
        snap = await supervisor.command({
          operation: "ensureProject",
          projectId: p.projectId,
          creationIntentId: t.taskId,
        });
        await fence(p, true);
        assertAdmission(p.projectId);
      }
      if (snap.phase === "rejoinRequired")
        snap = await supervisor.command({ operation: "rejoin", projectId: p.projectId });
      await fence(p, true);
      assertAdmission(p.projectId);
      check(
        snap.threadId && (!t.nativeThreadId || t.nativeThreadId === snap.threadId),
        "native_unavailable",
      );
      if (t.executionRevoked) check(snap.phase === "persisted", "native_unavailable");
      t.nativeThreadId = snap.threadId;
      t.nativeServerInstanceId = snap.serverInstanceId;
      const active = runtime.registration.currentRegistration();
      if (
        !active ||
        active.serverInstanceId !== snap.serverInstanceId ||
        !active.threads.some((x) => x.projectId === p.projectId && x.threadId === snap.threadId)
      ) {
        t.phase = "awaitingRegistration";
        save();
        return;
      }
      if (t.executionRevoked) {
        t.phase = "blocked";
        t.reason = "checkout_unavailable";
        t.terminalSessionName = null;
        save();
        return;
      }
      if (snap.phase === "firstPromptUncertain") {
        throw new Error("prompt_submission_uncertain");
      }
      if (snap.phase === "awaitingFirstTurn") {
        check(!t.maintenanceResume, "account_maintenance_first_prompt_replay_denied");
        t.phase = "awaitingFirstPrompt";
        t.firstPromptSubmissionAttempted = true;
        save();
        snap = await supervisor.command({
          operation: "firstPrompt",
          projectId: p.projectId,
          requestId: t.request.requestId,
          text: t.request.text,
        });
        await fence(p, true);
        assertAdmission(p.projectId);
      }
      if (snap.phase === "awaitingPersistence")
        snap = await supervisor.command({ operation: "refresh", projectId: p.projectId });
      await fence(p, true);
      assertAdmission(p.projectId);
      if (state.accountMaintenance?.phase === "resuming") {
        check(
          snap.phase === "persisted" && snap.firstPromptRequestId === t.request.requestId,
          "account_maintenance_history_changed",
        );
        t.phase = "running";
        save();
        return; // No PTY/new model input until the fresh server epoch-ready callback.
      }
      if (snap.phase === "persisted") {
        snap = await supervisor.command({ operation: "attach", projectId: p.projectId });
        await fence(p, true);
        assertAdmission(p.projectId);
        t.phase = "running";
        t.terminalSessionName = snap.attached
          ? `project-${createHash("sha256").update(p.projectId).digest("hex").slice(0, 24)}`
          : null;
      } else t.phase = "awaitingFirstPrompt";
      save();
    } catch (error) {
      blocked(t, error);
    }
  }
  function schedule(p) {
    if (
      closed ||
      state.guardianBarrier ||
      recoveryHeld(p) ||
      (p.task?.sourceApplication && p.task.sourceApplication.phase !== "released") ||
      pending.has(p.projectId) ||
      (p.task?.phase === "blocked" &&
        !(
          p.task.executionRevoked &&
          p.task.prepared &&
          p.task.nativeThreadId &&
          !historyRecovered.has(p.projectId)
        ))
    )
      return;
    pending.add(p.projectId);
    queue = queue.then(() => advance(p)).finally(() => pending.delete(p.projectId));
  }
  async function proveRecovery(p) {
    assertOpen();
    const t = p.task;
    check(
      t && !t.executionRevoked && !t.terminalSessionName && !t.sourceApplication,
      "retry_not_available",
    );
    check(
      t.phase === "blocked" &&
        [
          "github_auth_required",
          "checkout_busy",
          "checkout_unavailable",
          "revision_unavailable",
          "native_unavailable",
          "registration_unavailable",
        ].includes(t.reason),
      "retry_not_available",
    );
    check(
      t.firstPromptSubmissionAttempted === false && typeof t.nativeCreationAttempted === "boolean",
      "retry_not_available",
    );
    const inspected = await deps.inspectCheckout(p.repositoryId);
    if (!t.prepared) {
      check(
        !t.nativeCreationAttempted &&
          !t.nativeThreadId &&
          inspected?.status === "not_created" &&
          inspected.lease === null,
        "retry_not_available",
      );
    } else {
      check(
        runtime &&
          inspected?.status === "ready" &&
          inspected.checkoutVerified === true &&
          inspected.revision === t.request.revision &&
          inspected.checkoutIncarnation === t.checkoutIncarnation &&
          inspected.lease?.taskId === t.taskId &&
          inspected.lease.id === t.prepared.leaseId &&
          inspected.lease.generation === t.prepared.leaseGeneration &&
          inspected.lease.expiresAt > Date.now() / 1000,
        "retry_not_available",
      );
      // Missing native history is never evidence that no input occurred.
      const proof = await runtime.supervisor.provePreExecution(p.projectId, t.taskId);
      check(
        proof.threadId === (t.nativeThreadId ?? null) &&
          (proof.threadId || t.nativeCreationAttempted === false),
        "retry_not_available",
      );
    }
  }
  function retry(p, request) {
    const operation = queue.then(async () => {
      assertOpen();
      check(!guardian, "retry_not_available"); // Guarded recovery must use inspect/authorize/consume.
      const t = p.task;
      assertSourceInputOpen(p);
      check(
        t && t.taskId === request.taskId && t.digest === digest(t.request),
        "task_identity_conflict",
      );
      check(!t.executionRevoked, "retry_not_available");
      if (t.phase === "running" || t.retries?.some((r) => r.requestId === request.requestId))
        return status(p);
      try {
        await proveRecovery(p);
      } catch (error) {
        if (error?.message === "retry_history_unavailable") return status(p);
        throw error;
      }
      check((t.retries?.length ?? 0) < 32, "retry_limit");
      t.retries ??= [];
      t.retries.push({
        requestId: request.requestId,
        acceptedAt: Date.now(),
        intentDigest: t.digest,
      });
      t.phase = "preparing";
      t.reason = null;
      save();
      schedule(p);
      return status(p);
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  const recovery = projectRecovery({
    config,
    guardian,
    buildId: deps.guardianBuildId,
    save,
    taskDigest: digest,
    prove: proveRecovery,
    fence,
    schedule,
    absent: async (p) => {
      check(
        !p.task && !guardian.state.projects.some((v) => v.projectId === p.projectId),
        "retry_not_available",
      );
      // A reset/archived journal is not evidence that this immutable task never ran.
      const archives = readdirSync(config.stateDirectory).filter((name) =>
        /^projects-(archive|idle)-/.test(name),
      );
      check(archives.length === 0, "retry_not_available");
      const inspected = await deps.inspectCheckout(p.repositoryId);
      check(inspected?.status === "not_created" && inspected.lease === null, "retry_not_available");
      if (runtime) {
        const snapshot = runtime.supervisor.snapshot(p.projectId);
        check(!snapshot.threadId && snapshot.phase === "not-created", "retry_not_available");
      }
    },
  });
  return {
    async handle(path, r) {
      assertOpen();
      validateProjectOperation(path, r);
      if (
        state.accountMaintenance &&
        state.accountMaintenance.phase !== "finished" &&
        ["/projects/open", "/projects/tasks/start", "/projects/tasks/retry"].includes(path)
      )
        throw new Error("account_maintenance_pending");
      if (["/projects/resolve", "/projects/resolve-ref"].includes(path)) return resolve(r);
      if (path === "/projects/open") {
        const verified = await resolve(r);
        let p = state.projects[r.projectId];
        if (p)
          check(
            p.repositoryId === r.repositoryId && p.expectedAccountId === r.expectedAccountId,
            "repository_identity_changed",
          );
        else {
          check(
            Object.keys(state.projects).length < 32 &&
              !Object.values(state.projects).some((q) => q.repositoryId === r.repositoryId),
            "project_limit_or_identity_conflict",
          );
          p = {
            projectId: r.projectId,
            repositoryId: r.repositoryId,
            expectedAccountId: r.expectedAccountId,
            createdAt: Date.now(),
            task: null,
          };
          state.projects[r.projectId] = p;
          save();
        }
        if (p.task) schedule(p);
        return {
          ...verified,
          projectId: p.projectId,
          phase: p.task?.phase ?? "awaitingTask",
          currentTaskId: p.task?.taskId ?? null,
          nativeThreadId: p.task?.nativeThreadId ?? null,
          terminalSessionName: p.task?.terminalSessionName ?? null,
        };
      }
      if (Object.hasOwn(recoveryScopes, path)) {
        const p = project(r.scope.projectId);
        const operation = queue.then(() => recovery(path, p, r));
        queue = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      }
      const p = project(r.projectId);
      if (path === "/projects/tasks/start") {
        check(!recoveryHeld(p), "retry_not_available");
        if (!p.task && p.recovery?.inspection?.outcome === "task_absent")
          check(
            p.recovery.scope.taskId === r.taskId &&
              p.recovery.scope.hostRequestDigest === digest(r),
            "task_identity_conflict",
          );
        check(
          p.repositoryId === r.repositoryId && p.expectedAccountId === r.expectedAccountId,
          "repository_identity_changed",
        );
        check(r.model === config.model && r.effort === config.effort, "model_unavailable");
        if (p.task)
          check(
            p.task.taskId === r.taskId && p.task.digest === digest(r),
            "task_identity_conflict",
          );
        else {
          p.task = {
            taskId: r.taskId,
            digest: digest(r),
            request: structuredClone(r),
            phase: "preparing",
            createdAt: Date.now(),
            nativeThreadId: null,
            terminalSessionName: null,
            reason: null,
            nativeCreationAttempted: false,
            firstPromptSubmissionAttempted: false,
            retries: [],
          };
          save();
        }
      } else check(p.task?.taskId === r.taskId, "task_identity_conflict");
      if (path === "/projects/tasks/retry") return retry(p, r);
      schedule(p);
      return status(p);
    },
    renewLeases() {
      if (closed || state.guardianBarrier || !runtime) return;
      for (const p of Object.values(state.projects)) {
        if (
          recoveryHeld(p) ||
          !p.task?.prepared ||
          !p.task.nativeThreadId ||
          p.task.executionRevoked ||
          pending.has(p.projectId)
        )
          continue;
        const application = p.task.sourceApplication;
        if (
          application &&
          application.phase !== "released" &&
          Number.isFinite(application.leaseExpiresAt) &&
          application.leaseExpiresAt > Date.now() / 1000
        )
          continue; // No renewal/queue race while metadata applies; expiry is never extended.
        pending.add(p.projectId);
        queue = queue
          .then(async () => {
            if (closed) return;
            const t = p.task;
            if (t.executionRevoked) return;
            try {
              await fence(p, true);
              assertAdmission(p.projectId);
              if (t.sourceApplication && t.sourceApplication.phase !== "released") {
                // Metadata helper owns the managed lock. Do not race its pending
                // HEAD/index transaction with inspect/renew. The captured exact
                // active lease deadline still applies, with no extension here.
                check(
                  Number.isFinite(t.sourceApplication.leaseExpiresAt) &&
                    t.sourceApplication.leaseExpiresAt > Date.now() / 1000,
                  "checkout_unavailable",
                );
                return;
              }
              // Phase transitions never exempt a live native task from expiry.
              // Inspection also fails closed on changed checkout provenance.
              const lease = runtime.supervisor.lease(t.prepared);
              check(lease?.lease?.expiresAt > Date.now() / 1000, "checkout_unavailable");
              if (
                (t.sourceApplication && t.sourceApplication.phase !== "released") ||
                !["running", "awaitingFirstPrompt"].includes(t.phase) ||
                typeof deps.renewLease !== "function"
              )
                return;
              const binding = runtime.supervisor.registrationBinding(p.projectId),
                active = runtime.registration.currentRegistration();
              check(
                active?.serverInstanceId === binding.serverInstanceId &&
                  active.threads.some(
                    (x) => x.projectId === p.projectId && x.threadId === binding.threadId,
                  ),
                "registration_unavailable",
              );
              if (lease.lease.expiresAt * 1000 - Date.now() > 15 * 60 * 1000) return;
              check(typeof t.checkoutIncarnation === "string", "checkout_unavailable");
              const next = await deps.renewLease(p.projectId);
              await fence(p, true);
              assertAdmission(p.projectId);
              check(
                next?.checkoutIncarnation === t.checkoutIncarnation &&
                  next.revision === t.request.revision &&
                  next.lease?.id === t.prepared.leaseId &&
                  next.lease.taskId === t.taskId &&
                  next.lease.generation === t.prepared.leaseGeneration &&
                  next.lease.expiresAt > Date.now() / 1000 &&
                  Number.isSafeInteger(next.renewalSequence) &&
                  next.renewalSequence > t.renewalSequence,
                "checkout_unavailable",
              );
              t.renewalSequence = next.renewalSequence;
              save();
            } catch {
              if (state.guardianBarrier) return;
              t.executionRevoked = { reason: "lease_renewal_failed", at: Date.now() };
              t.phase = "blocked";
              t.reason = "checkout_unavailable";
              t.terminalSessionName = null;
              save();
              await runtime.supervisor.revokeExecution(p.projectId).catch(() => {});
            }
          })
          .finally(() => pending.delete(p.projectId));
      }
    },
    currentProjectContext(threadId) {
      assertOpen();
      check(runtime, "native_unavailable");
      const p = Object.values(state.projects).find(
        (value) => value.task?.nativeThreadId === threadId,
      );
      check(p?.task?.prepared, "task_identity_conflict");
      if (guardian) {
        check(p.task.guardianPrepared, "guardian_prepared_binding_missing");
        assertAdmission(p.projectId);
      }
      const binding = runtime.supervisor.registrationBinding(p.projectId);
      const registration = runtime.registration.currentRegistration();
      check(
        binding.threadId === threadId &&
          registration?.serverInstanceId === binding.serverInstanceId &&
          registration.threads.some((t) => t.projectId === p.projectId && t.threadId === threadId),
        "registration_unavailable",
      );
      const application = p.task.sourceApplication;
      if (application && application.phase !== "released") {
        // Factual immutable context must not reenter the managed flock while the
        // apply helper asks the parent for fresh authority. No execution grant.
        check(
          application.leaseExpiresAt > Date.now() / 1000 &&
            JSON.stringify(application) ===
              JSON.stringify(runtime.supervisor.state.projects[p.projectId]?.sourceApplication),
          "source_application_journal_mismatch",
        );
      } else runtime.supervisor.lease(p.task.prepared);
      return {
        projectId: p.projectId,
        preparationIntentId: p.task.taskId,
        repositoryId: p.repositoryId,
        revision: p.task.request.revision,
        leaseId: p.task.prepared.leaseId,
        leaseGeneration: p.task.prepared.leaseGeneration,
      };
    },
    currentSource(threadId) {
      const checkoutBinding = this.currentProjectContext(threadId),
        p = project(checkoutBinding.projectId),
        a = p.task.sourceApplication;
      const entry = runtime.supervisor.state.projects[p.projectId];
      check(
        JSON.stringify(p.task.acceptedSource ?? null) ===
          JSON.stringify(entry.acceptedSource ?? null),
        "source_application_journal_mismatch",
      );
      return {
        checkoutBinding,
        headSha: p.task.acceptedSource?.headSha ?? checkoutBinding.revision,
        ...(p.task.acceptedSource ? { sourceContext: structuredClone(p.task.acceptedSource) } : {}),
        phase:
          p.task.executionRevoked || a?.phase === "held"
            ? "held"
            : a && a.phase !== "released"
              ? "updating"
              : "ready",
      };
    },
    sourceApplication(projectId) {
      return structuredClone(project(projectId).task?.sourceApplication ?? null);
    },
    syncSourceApplication(record) {
      assertOpen();
      const p = project(record?.projectId),
        t = p.task;
      check(
        t?.prepared && !t.executionRevoked && !pending.has(p.projectId),
        "source_application_controller_busy",
      );
      assertAdmission(p.projectId);
      const entry = runtime?.supervisor.state.projects[p.projectId];
      check(
        entry?.threadId === t.nativeThreadId &&
          entry.serverInstanceId === runtime.supervisor.state.serverInstanceId &&
          JSON.stringify(entry.sourceApplication) === JSON.stringify(record),
        "source_application_journal_mismatch",
      );
      const old = t.sourceApplication;
      check(
        !old ||
          old.applicationId === record.applicationId ||
          (old.phase === "released" &&
            record.phase === "closing" &&
            record.barrier.generation > old.barrier.generation),
        "source_application_conflict",
      );
      if (old?.applicationId === record.applicationId) {
        check(
          [
            "publicationOperationId",
            "projectId",
            "targetSourceContext",
            "expectedAppliedSourceContext",
            "serverInstanceId",
            "managerThreadId",
            "cohort",
            "boundaryRequestDigest",
          ].every((k) => JSON.stringify(old[k]) === JSON.stringify(record[k])) &&
            old.barrier.id === record.barrier.id &&
            old.barrier.generation === record.barrier.generation,
          "source_application_conflict",
        );
      }
      if (["applied", "committed", "released"].includes(record.phase)) {
        check(
          JSON.stringify(entry.acceptedSource) === JSON.stringify(record.targetSourceContext),
          "source_application_journal_mismatch",
        );
        t.acceptedSource = structuredClone(entry.acceptedSource);
      }
      t.sourceApplication = structuredClone(record);
      save();
      return structuredClone(t.sourceApplication);
    },
    resumePending() {
      if (
        state.accountMaintenance?.phase === "resuming" &&
        runtime &&
        Object.values(state.projects).every((p) => p.task?.phase === "running") &&
        !pending.size
      ) {
        pending.add("account-maintenance");
        queue = queue
          .then(async () => {
            try {
              const authorized = await guardian.maintenanceResumeReady();
              await runtime.supervisor.finishAccountMaintenanceResume(
                state.accountMaintenance,
                authorized,
              );
              state.accountMaintenance.phase = "finished";
              save();
            } catch {
              state.accountMaintenance.phase = "held";
              save(); // Never retry an uncertain continuation or erase its input reservation.
            }
          })
          .finally(() => pending.delete("account-maintenance"));
        return;
      }
      if (
        closed ||
        state.guardianBarrier ||
        (state.accountMaintenance && state.accountMaintenance.phase !== "resuming")
      )
        return;
      for (const p of Object.values(state.projects))
        if (p.task && (!runtime || p.task.phase !== "running")) schedule(p);
    },
    async beginAccountMaintenance(maintenanceId) {
      check(
        uuid(maintenanceId) &&
          guardian &&
          runtime?.supervisor &&
          !state.guardianBarrier &&
          !pending.size,
        "account_maintenance_unavailable",
      );
      check(
        !state.accountMaintenance ||
          state.accountMaintenance.phase === "finished" ||
          state.accountMaintenance.id === maintenanceId,
        "account_maintenance_changed",
      );
      state.accountMaintenance = { id: maintenanceId, phase: "waiting-boundary" };
      save();
      await runtime.supervisor.beginAccountMaintenance(maintenanceId);
      return { accepted: true };
    },
    maintenanceId() {
      return state.accountMaintenance?.phase === "waiting-boundary"
        ? state.accountMaintenance.id
        : null;
    },
    async resumeAccountMaintenance(scope) {
      check(
        guardian &&
          uuid(scope?.id) &&
          uuid(scope.requestId) &&
          uuid(scope.ownerIntentRuntimeId) &&
          uuid(scope.ownerIntentEventId) &&
          /^[a-f0-9]{64}$/.test(scope.parkedJournalDigest) &&
          !runtime &&
          !pending.size &&
          !Object.keys(state.projects).length &&
          !state.guardianBarrier &&
          state.accountMaintenance?.id === scope.id,
        "account_maintenance_resume_unavailable",
      );
      const parked = readAccountMaintenanceArchive(config, scope.id);
      check(
        parked.parkedJournalDigest === scope.parkedJournalDigest,
        "account_maintenance_archive_changed",
      );
      const projects = structuredClone(parked.evidence.projectState.projects);
      check(
        Array.isArray(scope.projects) && scope.projects.length === Object.keys(projects).length,
        "account_maintenance_scope_changed",
      );
      for (const p of Object.values(projects)) {
        const t = p.task,
          expected = scope.projects.find((v) => v.preparationIntentId === t?.taskId),
          n = parked.evidence.nativeRegistry.state.projects[p.projectId];
        check(
          t?.prepared &&
            expected &&
            !t.executionRevoked &&
            !recoveryHeld(p) &&
            (!t.sourceApplication || t.sourceApplication.phase === "released") &&
            n?.firstPrompt?.phase === "accepted" &&
            n.firstPrompt.requestId === t.request.requestId &&
            n.firstPrompt.digest === expected.firstPromptDigest &&
            n.threadId === expected.nativeThreadId &&
            (t.phase !== "blocked" || t.reason === "native_unavailable"),
          "account_maintenance_history_changed",
        );
        const physical = await deps.inspectCheckout(p.repositoryId);
        check(
          physical?.status === "ready" &&
            physical.checkoutVerified === true &&
            physical.revision === t.request.revision &&
            physical.lease?.taskId === t.taskId &&
            physical.lease.id === t.prepared.leaseId &&
            physical.lease.generation === t.prepared.leaseGeneration &&
            physical.lease.expiresAt > Date.now() / 1000 &&
            physical.checkoutIncarnation === t.checkoutIncarnation &&
            digest(physical.checkoutIdentity) === digest(t.checkoutIdentity),
          "account_maintenance_source_or_lease_changed",
        );
        t.phase = "preparing";
        t.reason = null;
        t.terminalSessionName = null;
        t.maintenanceResume = {
          maintenanceId: scope.id,
          requestId: scope.requestId,
          ownerIntentRuntimeId: scope.ownerIntentRuntimeId,
          ownerIntentEventId: scope.ownerIntentEventId,
        };
      }
      state.projects = projects;
      state.accountMaintenance = { ...structuredClone(scope), phase: "restoring" };
      state.maintenanceParking = {
        maintenanceId: scope.id,
        priorLifetimeId: parked.evidence.priorLifetimeId,
        oldBarrierId: parked.evidence.projectState.guardianBarrier.barrierId,
        parkedJournalDigest: parked.parkedJournalDigest,
      };
      save(); // Retained archive survives a failed or uncertain fresh startup.
      for (const p of Object.values(projects)) {
        await admitPreparation(p);
        bindPrepared(p);
        await fence(p, true);
      }
      runtime = await deps.openRuntime(
        Object.values(projects).map((p) => p.task.prepared),
        {
          ...structuredClone(scope),
          nativeRegistryDigest: parked.evidence.nativeRegistryDigest,
        },
      );
      for (const p of Object.values(projects)) {
        const snapshot = await runtime.supervisor.rejoinAccountMaintenanceProject(p.projectId);
        check(
          snapshot.threadId === p.task.nativeThreadId &&
            snapshot.firstPromptRequestId === p.task.request.requestId &&
            snapshot.phase === "persisted",
          "account_maintenance_history_changed",
        );
      }
      await runtime.supervisor.verifyAccountMaintenanceResumeHistory(scope);
      for (const p of Object.values(projects)) {
        p.task.nativeServerInstanceId = runtime.supervisor.state.serverInstanceId;
        p.task.phase = "awaitingRegistration";
      }
      state.accountMaintenance.phase = "resuming";
      save();
      return { accepted: true };
    },
    async drain() {
      await queue;
    },
    assertExecution(projectId) {
      const p = project(projectId);
      assertSourceInputOpen(p);
      if (guardian) check(p.task?.guardianPrepared, "guardian_prepared_binding_missing");
      assertAdmission(projectId);
    },
    async executionFence(projectId) {
      const p = project(projectId);
      assertSourceInputOpen(p);
      await fence(p, true);
      assertSourceInputOpen(p);
    },
    assertRuntimeExecution() {
      assertOpen();
      if (guardian)
        for (const p of Object.values(state.projects))
          if (p.task?.guardianPreparation) assertAdmission(p.projectId);
    },
    async fenceRuntimeExecution() {
      assertOpen();
      if (guardian)
        for (const p of Object.values(state.projects))
          if (p.task?.guardianPreparation) {
            await fence(p, Boolean(p.task.prepared));
            assertAdmission(p.projectId);
          }
    },
    closeAdmission(barrier) {
      check(guardian && !state.guardianBarrier, "guardian_barrier_rejected");
      // This is deliberately synchronous: never await an outer RPC from inside
      // its close barrier. The FD client has already closed local admission.
      state.guardianBarrier = structuredClone(barrier);
      save();
      const current = guardian.state;
      const enrolled = Object.values(state.projects).filter((p) => p.task?.guardianPreparation);
      check(
        current.phase === "closed" &&
          barrier?.lifetimeId === current.lifetimeId &&
          barrier.bindingDigest === current.bindingDigest &&
          Number.isSafeInteger(barrier.generation) &&
          barrier.generation >= current.generation &&
          /^[a-f0-9]{64}$/.test(barrier.ownershipDigest) &&
          uuid(barrier.barrierId) &&
          Array.isArray(barrier.projects) &&
          (barrier.projects.length > 0 || Object.keys(state.projects).length === 0) &&
          barrier.projects.length === enrolled.length &&
          new Set(barrier.projects.map((p) => p.projectId)).size === enrolled.length &&
          enrolled.every(
            (p) =>
              p.task.guardianAdmission &&
              p.task.guardianPrepared &&
              barrier.projects.some(
                (candidate) =>
                  candidate.projectId === p.projectId &&
                  candidate.bindingDigest === digest(p.task.guardianPreparation),
              ),
          ),
        "guardian_barrier_preparation_uncertain",
      );
      return { closed: true, barrierId: barrier.barrierId, journalDigest: digest(state) };
    },
    loseAdmission() {
      if (!guardian || state.guardianBarrier) return;
      state.guardianBarrier = {
        reason: "guardian_channel_lost",
        lifetimeId: state.guardianLifetimeId,
        at: Date.now(),
      };
      save();
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      closeSync(lock);
    },
  };
}
