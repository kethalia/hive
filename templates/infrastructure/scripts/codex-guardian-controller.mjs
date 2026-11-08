// Trusted installed outer only. Local journals are evidence; server receipts authorize.
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARDIAN_ADMISSION_BUDGET } from "./codex-guardian-worker.mjs";
import {
  archiveClosedProjectState,
  parkAccountMaintenanceProjectState,
  readAccountMaintenanceArchive,
} from "./codex-project-controller.mjs";
import { readPendingUnstartedTransfer } from "./codex-unstarted-transfer.mjs";

const check = (v) => {
  if (!v) throw new Error("guardian_controller_authority_rejected");
};
const hex = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === keys.slice().sort().join();
export const guardianCanonical = (value) =>
  JSON.stringify(
    (function sort(v) {
      return Array.isArray(v)
        ? v.map(sort)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, sort(x)]),
            )
          : v;
    })(value),
  );
const sha = (v) => createHash("sha256").update(v).digest("hex");
const digest = (v) => sha(guardianCanonical(v));
export const GUARDIAN_CONTROLLER_POLICY = Object.freeze({
  schemaVersion: 1,
  protocol: "guardian-v1",
  enrollment: "owner-app-one-use-issuer-grant",
  preparation: "persisted-intent-before-helper",
  checkout: "immutable-lease-inode-incarnation",
  native: "one-use-fixed-inventory-before-launch",
  producer: "fresh-signed-server-fence",
  uncertainty: "durable-hold",
  admissionRecovery: "exact-committed-envelope-then-fresh-fence",
  admissionBudget: GUARDIAN_ADMISSION_BUDGET,
  ownerRecovery: "signed-inspect-cas-consume-fresh-fence",
  drain: "independent-closed-barrier-required",
  sourceApplication: "terminal-root-reservation-and-protected-applied-receipt",
  metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
});
export const GUARDIAN_CONTROLLER_POLICY_DIGEST = digest(GUARDIAN_CONTROLLER_POLICY);
const PATH = "/api/codex-host/guardians";
const admissionActions = ["prepare", "checkout", "native", "fence"];
function privateRead(path, max = 2 * 1024 * 1024) {
  check(realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    check(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === process.getuid() &&
        !(s.mode & 0o077) &&
        s.size <= max,
    );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`,
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function readEvidence(home, name, keyName) {
  const directory = join(home, ".local/state/hive", name),
    key = privateRead(join(directory, keyName), 32),
    saved = JSON.parse(
      privateRead(
        join(directory, name === "codex-project-controller" ? "projects.json" : "registry.json"),
      ),
    ),
    expected = createHmac("sha256", key).update(JSON.stringify(saved.state)).digest("hex");
  check(
    key.length === 32 &&
      hex(saved.signature) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(saved.signature)),
  );
  return saved.state;
}
// Python's signed managed receipts sort keys and retain float lexemes (1.0).
// Compact the original record bytes rather than reserializing parsed JS numbers.
function managedReceipt(home, repositoryId) {
  check(/^[1-9][0-9]{0,19}$/.test(repositoryId));
  const root = join(home, ".local/state/hive/managed-projects"),
    raw = privateRead(join(root, `github-${repositoryId}.json`), 1048576).toString("utf8"),
    saved = JSON.parse(raw),
    key = privateRead(join(root, "key"), 32);
  check(exact(saved, ["record", "signature"]) && hex(saved.signature) && key.length === 32);
  let compact = "",
    quoted = false,
    escaped = false;
  for (const c of raw) {
    if (quoted) {
      compact += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      compact += c;
      quoted = true;
    } else if (!/[ \t\r\n]/.test(c)) compact += c;
  }
  const prefix = '{"record":';
  check(compact.startsWith(prefix));
  let depth = 0,
    end = 0;
  quoted = false;
  escaped = false;
  for (let i = prefix.length; i < compact.length; i++) {
    const c = compact[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (!depth) {
        end = i + 1;
        break;
      }
    }
  }
  check(end && compact.slice(end) === `,"signature":"${saved.signature}"}`);
  const body = compact.slice(prefix.length, end),
    expected = createHmac("sha256", key).update(body).digest("hex");
  check(timingSafeEqual(Buffer.from(expected), Buffer.from(saved.signature)));
  return { record: saved.record, digest: sha(body) };
}
function pinnedMetadata(home, checkout, pins) {
  const path = join(home, "projects/.hive-managed/github", checkout.repositoryId, "checkout");
  check(realpathSync(path) === path);
  const descriptors = [],
    open = (path, flags) => {
      const fd = openSync(path, flags | constants.O_NOFOLLOW);
      descriptors.push(fd);
      return fd;
    },
    pin = (fd, expected) => {
      const v = fstatSync(fd, { bigint: true });
      check(
        v.isDirectory() &&
          v.uid === BigInt(process.getuid()) &&
          !(v.mode & 0o22n) &&
          String(v.dev) === expected.device &&
          String(v.ino) === expected.inode,
      );
    };
  try {
    const root = open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    pin(root, pins.checkout);
    const git = open(`/proc/self/fd/${root}/.git`, constants.O_RDONLY | constants.O_DIRECTORY);
    pin(git, pins.git);
    const read = (name, limit) => {
      const fd = open(`/proc/self/fd/${git}/${name}`, constants.O_RDONLY),
        before = fstatSync(fd, { bigint: true });
      check(
        before.isFile() &&
          before.uid === BigInt(process.getuid()) &&
          before.nlink === 1n &&
          !(before.mode & 0o22n) &&
          before.size <= BigInt(limit),
      );
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      for (let i = 0; i < 4096; i++) {
        const n = readSync(fd, buffer, offset, buffer.length - offset, null);
        offset += n;
        check(offset <= limit);
        if (!n) break;
        check(i < 4095);
      }
      const after = fstatSync(fd, { bigint: true });
      check(
        before.dev === after.dev &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeNs === after.mtimeNs &&
          after.nlink === 1n &&
          BigInt(offset) === after.size,
      );
      return {
        bytes: buffer.subarray(0, offset),
        identity: { device: String(after.dev), inode: String(after.ino) },
      };
    };
    const head = read("HEAD", 100),
      index = read("index", 16777216);
    check(/^[a-f0-9]{40}\n$/.test(head.bytes.toString("ascii")));
    return {
      headSha: head.bytes.toString("ascii").trim(),
      headIdentity: head.identity,
      indexDigest: sha(index.bytes),
      indexIdentity: index.identity,
    };
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

async function boundedJson(response, signal) {
  check(response.status === 200 && !response.headers.has("location"));
  const reader = response.body?.getReader();
  check(reader);
  let bytes = 0,
    count = 0;
  const chunks = [];
  let rejectAborted;
  const abortedPromise = new Promise((_, reject) => {
    rejectAborted = reject;
  });
  const aborted = () => {
    rejectAborted(new Error("guardian_response_aborted"));
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await Promise.race([reader.read(), abortedPromise]);
      signal.throwIfAborted();
      if (done) break;
      count++;
      bytes += value.byteLength;
      check(count <= 256 && bytes <= 131072);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", aborted);
    void reader.cancel().catch(() => {});
  }
}

// All arguments are supplied by the verified fixed outer entry, never an HTTP body.
export function openGuardianController({
  config,
  configSha256,
  home,
  stateDirectory,
  packageManifestSha256,
  guardianElfSha256,
  nodeSha256,
  startupAttestation,
  fetchImpl = fetch,
}) {
  check(
    config.guardianEnabled === true &&
      config.nativeIsolationEnabled === true &&
      [configSha256, packageManifestSha256, guardianElfSha256, nodeSha256].every(hex) &&
      resolve(home) === home &&
      resolve(stateDirectory) === stateDirectory &&
      typeof startupAttestation === "function",
  );
  const origin = new URL(config.hiveOrigin);
  check(
    origin.protocol === "https:" &&
      origin.origin === config.hiveOrigin &&
      !origin.username &&
      !origin.password,
  );
  const issuer = createPublicKey(config.issuerPublicKeyPem);
  check(issuer.asymmetricKeyType === "ed25519");
  mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
  check(realpathSync(stateDirectory) === stateDirectory);
  const directoryFd = openSync(
    stateDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const s = fstatSync(directoryFd);
    check(s.uid === process.getuid() && !(s.mode & 0o077));
  } finally {
    closeSync(directoryFd);
  }
  const keyPath = join(stateDirectory, "controller-key.pem"),
    statePath = join(stateDirectory, "controller.json");
  if (!existsSync(keyPath)) {
    check(!existsSync(statePath));
    const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
      fd = openSync(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    try {
      writeFileSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const key = createPrivateKey(privateRead(keyPath, 512)),
    publicKey = createPublicKey(key);
  check(key.asymmetricKeyType === "ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  let state,
    challenge,
    drainStartup,
    deadline,
    admissionRecoveryUsed = false,
    queue = Promise.resolve();
  const startup = () => {
    const value = startupAttestation();
    check(
      value.phase === "open" &&
        value.configSha256 === configSha256 &&
        value.packageManifestSha256 === packageManifestSha256 &&
        value.guardianSha256 === guardianElfSha256 &&
        value.nodeSha256 === nodeSha256 &&
        value.port === config.port,
    );
    return value;
  };
  const identity = (s) => ({
    lifetimeId: s.lifetimeId,
    bindingDigest: s.bindingDigest,
    outerPublicKeyPem: publicPem,
    packageManifestSha256,
    guardianElfSha256,
    nodeSha256,
    policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
    metadataPolicyDigest: GUARDIAN_CONTROLLER_POLICY.metadataPolicyDigest,
    configSha256,
  });
  const save = () => {
    const encoded = `${JSON.stringify({
      state,
      signature: sign(null, Buffer.from(guardianCanonical(state)), key).toString("base64url"),
    })}\n`;
    check(Buffer.byteLength(encoded) <= 2097152);
    atomic(statePath, encoded);
  };
  const applicationUncertainty = () => {
    const frame = state?.pending,
      app = state?.applications?.[frame?.applicationId];
    return Boolean(
      app &&
        frame.runtimeId === state.runtimeId &&
        frame.projectId === app.request.projectId &&
        ["apply_reserve", "apply_verify", "apply_commit"].includes(frame.action),
    );
  };
  const admissionUncertainty = () =>
    state?.hold &&
    state.pending?.runtimeId === state.runtimeId &&
    admissionActions.includes(state.pending?.action);
  const initialize = (
    factual = false,
    enrollmentHold = false,
    expiredDrain = false,
    admissionHold = false,
  ) => {
    const s = startup(),
      id = identity(s);
    if (!state) {
      state = {
        schemaVersion: 1,
        lifetimeId: s.lifetimeId,
        identityDigest: digest(id),
        runtimeId: null,
        generation: 1,
        projects: {},
        applications: {},
        launch: null,
        pending: null,
        hold: false,
        sequence: 0,
        chainDigest: "0".repeat(64),
      };
      if (existsSync(statePath)) {
        const saved = JSON.parse(privateRead(statePath));
        check(
          verify(
            null,
            Buffer.from(guardianCanonical(saved.state)),
            publicKey,
            Buffer.from(saved.signature, "base64url"),
          ),
        );
        check(saved.state.lifetimeId === s.lifetimeId && saved.state.identityDigest === digest(id));
        state = saved.state;
      }
    }
    state.applications ??= {};
    check(
      ((!state.hold && !state.pending) ||
        (factual && applicationUncertainty()) ||
        (admissionHold && admissionUncertainty()) ||
        (enrollmentHold && state.hold && state.pending?.action === "enroll")) &&
        (expiredDrain ||
          !state.enrollmentRecovery ||
          // An accepted admission leaves enrollment-only authority behind;
          // ordinary admission/fence requests still require Hive authorization.
          Object.keys(state.projects).length > 0 ||
          Date.now() < state.enrollmentRecovery.receipt.authorityUntil) &&
        state.lifetimeId === s.lifetimeId &&
        state.identityDigest === digest(id),
    );
    return s;
  };
  const serial = (operation, timeout = 3000, submittedDeadline) => {
    const pending = queue.then(() => {
      deadline = submittedDeadline ?? Date.now() + timeout;
      check(Date.now() < deadline);
      admissionRecoveryUsed = false;
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  };
  async function send(action, fields, accept, mode) {
    if (["prepare", "checkout", "native", "fence"].includes(action)) {
      const id = fields.projectId ?? fields.preparation?.projectId ?? fields.checkout?.projectId;
      const { project } = controllerProject(id, startup(), true);
      const recovery = project.recovery;
      if (recovery?.authorization) {
        check(["consuming", "consumed"].includes(recovery.phase));
        fields = {
          ...fields,
          recovery: {
            recoveryId: recovery.scope.recoveryId,
            authorizationDigest: digest(recovery.authorization),
          },
        };
      }
    }
    if (mode === "closure") {
      check(
        state &&
          drainStartup &&
          !state.hold &&
          !state.pending &&
          state.lifetimeId === drainStartup.lifetimeId &&
          state.identityDigest === digest(identity(drainStartup)),
      );
    } else initialize(mode === "factual" || mode === "readback", false, false, mode === "recovery");
    if (mode === "recovery")
      check(action === "fence" && state.operationRecovery?.phase === "needs_fence");
    const previous = applicationUncertainty() ? structuredClone(state.pending) : null;
    if (previous) {
      const app = state.applications[previous.applicationId];
      app.uncertainRequest ??= previous;
      check(
        mode === "factual" ||
          (mode === "readback" &&
            fields.applicationId === previous.applicationId &&
            fields.projectId === previous.projectId),
      );
    }
    check((action === "enroll" || uuid(state.runtimeId)) && Date.now() < deadline);
    // Launch checks the same persisted admission inventory. Share its transport
    // budget without treating an uncertain launch as a recoverable receipt.
    const issuedAt = Date.now(),
      admissionTransport = admissionActions.includes(action) || action === "launch",
      networkDeadline = Math.min(
        deadline,
        issuedAt +
          (admissionTransport
            ? GUARDIAN_ADMISSION_BUDGET.frameMs
            : action === "enroll"
              ? 15000
              : action.startsWith("epic_")
                ? 30000
                : 3000),
      ),
      body = {
        schemaVersion: 1,
        runtimeId: fields.runtimeId ?? state.runtimeId,
        eventId: randomUUID(),
        issuedAt,
        expiresAt: admissionTransport
          ? Math.min(deadline + 500, networkDeadline + 500)
          : issuedAt + (action === "enroll" ? 20000 : action.startsWith("epic_") ? 30500 : 3500),
        action,
        ...(action === "enroll" ? {} : { runtimeGeneration: state.generation }),
        ...fields,
      };
    const frame = {
      ...body,
      proof: sign(
        null,
        Buffer.from(`hive-guardian-controller-v1\nPOST\n${PATH}\n${guardianCanonical(body)}`),
        key,
      ).toString("base64url"),
    };
    if (action.startsWith("apply_")) {
      const app = state.applications[fields.applicationId];
      check(app);
      app.requests ??= {};
      app.requests[action] ??= structuredClone(frame);
    }
    state.pending = frame;
    if (mode === "recovery") state.operationRecovery.phase = "fencing";
    state.sequence++;
    save();
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), Math.max(1, networkDeadline - Date.now()));
    let response;
    let failureCategory = "transport";
    const startedAt = Date.now();
    try {
      response = await fetchImpl(`${config.hiveOrigin}${PATH}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
        signal: abort.signal,
      });
      failureCategory = "response";
      const result = await boundedJson(response, abort.signal);
      check(Date.now() < networkDeadline && Date.now() < body.expiresAt && !abort.signal.aborted);
      if (mode !== "closure") startup();
      accept(result);
      state.chainDigest = digest({ previous: state.chainDigest, request: frame, response: result });
      state.pending = mode === "factual" ? previous : null;
      state.hold = Boolean(state.pending);
      if (mode === "recovery") delete state.operationRecovery;
      if (action === "enroll") delete state.enrollmentFailure;
      save();
      return structuredClone(result);
    } catch (error) {
      // The server may already have committed. No local retry can mint authority.
      state.pending = previous ?? state.pending;
      state.hold = true;
      if (action === "enroll")
        state.enrollmentFailure = {
          category: abort.signal.aborted ? "timeout" : failureCategory,
          elapsedMs: Math.max(0, Math.min(15000, Date.now() - startedAt)),
        };
      save();
      throw error;
    } finally {
      clearTimeout(timer);
      void response?.body?.cancel().catch(() => {});
    }
  }
  async function sendClosure(action, fields, accept) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(action, fields, accept, "closure");
      } catch (error) {
        const pending = state?.pending;
        if (
          attempt >= 1 ||
          !pending ||
          pending.action !== action ||
          pending.runtimeId !== state.runtimeId ||
          Object.entries(fields).some(([key, value]) => !same(pending[key], value))
        )
          throw error;
        // Only the same immutable closure operation may recover an uncertain ACK.
        state.pending = null;
        state.hold = false;
        save();
        deadline = Date.now() + (action.startsWith("epic_") ? 30000 : 3000);
      }
    }
  }
  const acceptPair = (result, projectId) => {
    check(
      result?.runtime?.id === state.runtimeId &&
        result.runtime.lifetimeId === state.lifetimeId &&
        result.runtime.phase === "open" &&
        positive(result.runtime.generation) &&
        result.runtime.generation >= state.generation &&
        result.admission?.projectId === projectId &&
        result.admission.runtimeId === state.runtimeId &&
        uuid(result.admission.id) &&
        positive(result.admission.generation),
    );
    if (result.admission.phase === "native") {
      const fresh = nativeEvidence(projectId, startup());
      check(
        result.admission.registrationId === fresh.registrationId &&
          result.admission.nativeThreadId === fresh.managerThreadId &&
          result.admission.metadataPinsDigest === digest(fresh.metadata),
      );
    }
    state.generation = result.runtime.generation;
    state.projects[projectId] = {
      admissionId: result.admission.id,
      admissionGeneration: result.admission.generation,
      phase: result.admission.phase,
      checkout: result.admission.checkoutBinding,
      preparationDigest: result.admission.preparationDigest,
      metadataPinsDigest: result.admission.metadataPinsDigest,
      ...(state.pending?.action === "native"
        ? { nativeReceiptEventId: state.pending.eventId }
        : state.projects[projectId]?.nativeReceiptEventId
          ? { nativeReceiptEventId: state.projects[projectId].nativeReceiptEventId }
          : {}),
      ...(state.projects[projectId]?.producer
        ? { producer: state.projects[projectId].producer }
        : {}),
    };
  };
  function controllerProject(projectId, s, recovering = false) {
    const journal = readEvidence(home, "codex-project-controller", "projects.key");
    check(
      !journal.guardianBarrier &&
        journal.schemaVersion === 1 &&
        journal.ownerId === config.binding.ownerId &&
        journal.workspaceId === config.binding.workspaceId &&
        journal.guardianLifetimeId === s.lifetimeId &&
        guardianCanonical(journal.hostProcess) ===
          guardianCanonical(
            Object.fromEntries(Object.entries(s.workerIdentity).filter(([k]) => k !== "parentPid")),
          ),
    );
    const project = journal.projects[projectId],
      preparation = project?.task?.guardianPreparation;
    check(
      (!project?.recovery ||
        project.recovery.phase === "consumed" ||
        (recovering && project.recovery.phase === "consuming")) &&
        !project?.task?.executionRevoked &&
        project?.task?.phase !== "blocked" &&
        preparation?.projectId === projectId &&
        preparation.ownerId === config.binding.ownerId &&
        preparation.workspaceId === config.binding.workspaceId &&
        preparation.buildId === config.binding.buildId &&
        preparation.repositoryId === project.repositoryId &&
        preparation.taskId === project.task.taskId &&
        preparation.requestDigest === sha(JSON.stringify(project.task.request)),
    );
    return { project, preparation, journal };
  }
  function nativeEvidence(projectId, s) {
    const native = readEvidence(home, "codex-project-supervisor", "key"),
      pins = native.metadataLaunch?.pins,
      pin = pins?.pins?.find((p) => p.projectId === projectId),
      thread = native.projects?.[projectId];
    check(
      native.status === "ready" &&
        native.buildId === config.binding.buildId &&
        native.workspaceId === config.binding.workspaceId &&
        guardianCanonical(native.hostProcess) ===
          guardianCanonical(
            Object.fromEntries(Object.entries(s.workerIdentity).filter(([k]) => k !== "parentPid")),
          ) &&
        native.controllerRegistration?.status === "registered" &&
        native.metadataLaunch?.phase === "started" &&
        digest(native.metadataLaunch.approval) === digest(state.launch) &&
        pins.metadataPolicyDigest === GUARDIAN_CONTROLLER_POLICY.metadataPolicyDigest &&
        pin &&
        thread?.serverInstanceId === native.serverInstanceId &&
        typeof thread.threadId === "string",
    );
    return {
      native,
      thread,
      registrationId: native.controllerRegistration.grantId,
      managerThreadId: thread.threadId,
      metadata: {
        pins: { checkout: pin.checkout, git: pin.metadata },
        namespaceReceiptDigest: digest({
          serverInstanceId: native.serverInstanceId,
          metadataLaunch: native.metadataLaunch,
          executionIdentity: native.executionIdentity,
        }),
        nativeLaunchId: state.launch.nativeLaunchId,
        launchIntentDigest: state.launch.launchIntentDigest,
        metadataPolicyDigest: GUARDIAN_CONTROLLER_POLICY.metadataPolicyDigest,
      },
    };
  }
  function validateHistoricalAdmission(original, result, target) {
    const { project, preparation } = controllerProject(target.projectId, startup(), true);
    check(
      sha(JSON.stringify(preparation)) === target.bindingDigest &&
        result?.runtime?.operationReceiptsEnabled === true &&
        result?.admission?.preparationDigest === target.bindingDigest &&
        ["preparation", "checkout", "native"].includes(result.admission.phase) &&
        result.runtime?.generation >= original.runtimeGeneration &&
        result.runtime.generation <=
          original.runtimeGeneration + (original.action === "prepare" ? 1 : 0),
    );
    if (original.action === "prepare")
      check(
        same(original.preparation, preparation) &&
          original.preparationDigest === target.bindingDigest,
      );
    else if (original.action === "checkout")
      check(
        original.checkout.projectId === target.projectId &&
          same(original.checkout, result.admission.checkoutBinding),
      );
    else check(original.projectId === target.projectId);
    if (original.action === "fence") check(original.preparationDigest === target.bindingDigest);
    if (result.admission.checkoutBinding) {
      const bound = result.admission.checkoutBinding,
        prepared = project.task.guardianPrepared;
      check(
        prepared &&
          bound.projectId === target.projectId &&
          bound.preparationIntentId === preparation.taskId,
      );
      for (const name of [
        "repositoryId",
        "revision",
        "leaseId",
        "leaseGeneration",
        "checkoutIncarnation",
        "checkoutIdentity",
      ])
        check(same(bound[name], prepared[name]));
      const path = join(home, "projects/.hive-managed/github", bound.repositoryId, "checkout");
      check(realpathSync(path) === path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const verifyPin = (descriptor, expected) => {
        const physical = fstatSync(descriptor, { bigint: true });
        check(
          physical.isDirectory() &&
            physical.uid === BigInt(process.getuid()) &&
            !(physical.mode & 0o22n) &&
            String(physical.dev) === expected.device &&
            String(physical.ino) === expected.inode,
        );
      };
      try {
        verifyPin(fd, bound.checkoutIdentity);
        if (result.admission.phase === "native") {
          const fresh = nativeEvidence(target.projectId, startup()),
            git = openSync(
              `/proc/self/fd/${fd}/.git`,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
          try {
            verifyPin(git, fresh.metadata.pins.git);
          } finally {
            closeSync(git);
          }
        }
      } finally {
        closeSync(fd);
      }
    } else check(result.admission.phase === "preparation");
    if (original.action === "native")
      check(
        result.admission.phase === "native" &&
          result.admission.registrationId === original.registrationId &&
          result.admission.nativeThreadId === original.managerThreadId &&
          result.admission.metadataPinsDigest === digest(original.metadata),
      );
    // A historical fence cannot renew an expired runtime. Its remaining lifetime
    // is only a prerequisite for asking Hive for new authority.
    check(Date.parse(result.runtime.authorityUntil) > Date.now());
  }
  async function recoverAdmission(target) {
    initialize(false, false, false, true);
    check(admissionUncertainty());
    check(!admissionRecoveryUsed);
    admissionRecoveryUsed = true;
    const original = structuredClone(state.pending);
    if (!state.operationRecovery) {
      state.operationRecovery = { phase: "reading", requestDigest: digest(original), target };
      for (const project of Object.values(state.projects)) delete project.producer;
      save();
      const issuedAt = Date.now(),
        networkDeadline = Math.min(deadline, issuedAt + GUARDIAN_ADMISSION_BUDGET.frameMs),
        nonce = randomBytes(32).toString("hex"),
        body = {
          schemaVersion: 1,
          action: "operation_readback",
          runtimeId: state.runtimeId,
          runtimeGeneration: original.runtimeGeneration,
          eventId: randomUUID(),
          issuedAt,
          expiresAt: networkDeadline + 500,
          nonce,
          lifetimeId: state.lifetimeId,
          configSha256,
          originalRequest: original,
        },
        frame = {
          ...body,
          proof: sign(
            null,
            Buffer.from(`hive-guardian-controller-v1\nPOST\n${PATH}\n${guardianCanonical(body)}`),
            key,
          ).toString("base64url"),
        },
        abort = new AbortController(),
        timer = setTimeout(() => abort.abort(), Math.max(1, networkDeadline - Date.now()));
      let response;
      try {
        check(Date.now() < networkDeadline);
        response = await fetchImpl(`${config.hiveOrigin}${PATH}`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frame),
          signal: abort.signal,
        });
        const receipt = await boundedJson(response, abort.signal);
        check(Date.now() < networkDeadline && !abort.signal.aborted);
        startup();
        check(
          receipt?.accepted === true &&
            receipt.historical === true &&
            receipt.executionAuthorized === false &&
            receipt.nonce === nonce &&
            receipt.runtimeId === state.runtimeId &&
            receipt.lifetimeId === state.lifetimeId &&
            receipt.configSha256 === configSha256 &&
            receipt.eventId === original.eventId &&
            receipt.requestDigest === digest(original) &&
            receipt.action === original.action &&
            receipt.inputRuntimeGeneration === original.runtimeGeneration &&
            receipt.resultRuntimeGeneration === receipt.result?.runtime?.generation &&
            receipt.resultAdmissionGeneration === receipt.result?.admission?.generation &&
            Number.isSafeInteger(receipt.committedAt) &&
            receipt.committedAt >= original.issuedAt &&
            receipt.committedAt <= Date.now() &&
            Buffer.byteLength(JSON.stringify(receipt.result)) <= 65536 &&
            same(state.pending, original) &&
            state.hold,
        );
        validateHistoricalAdmission(original, receipt.result, target);
        acceptPair(receipt.result, target.projectId);
        state.chainDigest = digest({ previous: state.chainDigest, readback: frame, receipt });
        state.operationRecovery = {
          phase: "needs_fence",
          requestDigest: digest(original),
          target,
          receipt: structuredClone(receipt),
        };
        // Learned generations and admission facts remain held across a crash.
        save();
      } finally {
        clearTimeout(timer);
        void response?.body?.cancel().catch(() => {});
      }
    }
    const recovery = state.operationRecovery;
    check(
      recovery.phase === "needs_fence" &&
        recovery.requestDigest === digest(original) &&
        same(recovery.target, target),
    );
    validateHistoricalAdmission(original, recovery.receipt.result, target);
    await send(
      "fence",
      { projectId: target.projectId, preparationDigest: target.bindingDigest },
      (result) => {
        validateHistoricalAdmission(
          {
            ...original,
            action: "fence",
            runtimeGeneration: state.generation,
            projectId: target.projectId,
            preparationDigest: target.bindingDigest,
          },
          result,
          target,
        );
        acceptPair(result, target.projectId);
      },
      "recovery",
    );
  }
  async function sendAdmission(action, fields, target) {
    try {
      return await send(action, fields, (result) => acceptPair(result, target.projectId));
    } catch (error) {
      if (!admissionUncertainty() || state.operationRecovery) throw error;
      await recoverAdmission(target);
    }
  }
  async function admission(value) {
    check(
      exact(value, ["projectId", "bindingDigest"]) &&
        uuid(value.projectId) &&
        hex(value.bindingDigest),
    );
    const s = initialize(false, false, false, true);
    if (state.hold) await recoverAdmission(value);
    const { project, preparation } = controllerProject(value.projectId, s, true);
    check(sha(JSON.stringify(preparation)) === value.bindingDigest && uuid(state.runtimeId));
    if (!state.projects[value.projectId])
      await sendAdmission(
        "prepare",
        { preparation, preparationDigest: value.bindingDigest },
        value,
      );
    const prepared = project.task.guardianPrepared;
    if (prepared && state.projects[value.projectId].phase === "preparation") {
      check(
        prepared.preparationDigest === value.bindingDigest &&
          prepared.projectId === value.projectId &&
          prepared.taskId === preparation.taskId &&
          prepared.repositoryId === preparation.repositoryId,
      );
      await sendAdmission(
        "checkout",
        {
          checkout: {
            projectId: prepared.projectId,
            preparationIntentId: prepared.taskId,
            repositoryId: prepared.repositoryId,
            revision: prepared.revision,
            leaseId: prepared.leaseId,
            leaseGeneration: prepared.leaseGeneration,
            checkoutIncarnation: prepared.checkoutIncarnation,
            checkoutIdentity: prepared.checkoutIdentity,
          },
        },
        value,
      );
    }
    if (state.launch && state.projects[value.projectId].phase === "checkout") {
      const native = readEvidence(home, "codex-project-supervisor", "key");
      if (native.controllerRegistration?.status === "registered") {
        const evidence = nativeEvidence(value.projectId, s);
        let maintenanceRebind;
        if (state.accountMaintenance?.phase === "resuming") {
          const hold = state.accountMaintenance,
            proof = evidence.native.maintenanceResume,
            retained = hold.projects.find((p) => p.nativeThreadId === evidence.managerThreadId),
            history = proof?.historyProof?.[value.projectId],
            checkout = state.projects[value.projectId].checkout,
            managed = managedReceipt(home, checkout.repositoryId).record;
          check(
            retained &&
              proof.id === hold.id &&
              proof.requestId === hold.requestId &&
              proof.ownerIntentRuntimeId === hold.ownerIntentRuntimeId &&
              proof.ownerIntentEventId === hold.ownerIntentEventId &&
              proof.parkedJournalDigest === hold.parkedJournalDigest &&
              history?.historyDigest === retained.historyDigest &&
              managed.lease?.id === checkout.leaseId &&
              managed.lease.generation === checkout.leaseGeneration &&
              managed.lease.taskId === checkout.preparationIntentId &&
              Number.isFinite(managed.lease.expiresAt) &&
              managed.lease.expiresAt > Date.now() / 1000 &&
              managed.revision === checkout.revision &&
              !managed.sourceUpdating,
          );
          maintenanceRebind = {
            maintenanceId: hold.id,
            ownerIntentRuntimeId: hold.ownerIntentRuntimeId,
            ownerIntentEventId: hold.ownerIntentEventId,
            parkedJournalDigest: hold.parkedJournalDigest,
            historyDigest: retained.historyDigest,
            leaseValidUntil: new Date(managed.lease.expiresAt * 1000).toISOString(),
          };
        }
        await sendAdmission(
          "native",
          {
            ...(maintenanceRebind ? { maintenanceRebind } : {}),
            projectId: value.projectId,
            registrationId: evidence.registrationId,
            managerThreadId: evidence.managerThreadId,
            metadata: evidence.metadata,
          },
          value,
        );
      }
    }
    await sendAdmission(
      "fence",
      { projectId: value.projectId, preparationDigest: value.bindingDigest },
      value,
    );
    return { ...value };
  }
  async function currentMetadata(projectId) {
    const s = initialize(true),
      evidence = controllerProject(projectId, s);
    if (state.projects[projectId]?.phase !== "native") {
      check(!state.hold && !state.pending);
      await admission({ projectId, bindingDigest: sha(JSON.stringify(evidence.preparation)) });
    }
    const a = state.projects[projectId],
      fresh = nativeEvidence(projectId, startup());
    check(a.phase === "native" && a.metadataPinsDigest === digest(fresh.metadata));
    return send(
      "metadata",
      {
        projectId,
        admissionId: a.admissionId,
        admissionGeneration: a.admissionGeneration,
        metadataPinsDigest: a.metadataPinsDigest,
      },
      (r) => {
        const current = nativeEvidence(projectId, startup());
        check(
          r?.runtimeId === state.runtimeId &&
            r.runtimeGeneration === state.generation &&
            r.admissionId === a.admissionId &&
            r.admissionGeneration === a.admissionGeneration &&
            r.barrierGeneration === 0 &&
            r.metadataPinsDigest === digest(current.metadata) &&
            digest(r.metadataPins) === digest(current.metadata.pins),
        );
        a.producer = structuredClone(r);
      },
      "factual",
    );
  }
  const same = (a, b) => guardianCanonical(a ?? null) === guardianCanonical(b ?? null);
  function applicationEvidence(projectId, applicationId) {
    const s = initialize(true),
      c = controllerProject(projectId, s),
      n = nativeEvidence(projectId, s),
      a = c.project.task.sourceApplication,
      local = state.projects[projectId];
    check(
      local?.phase === "native" &&
        uuid(applicationId) &&
        a?.applicationId === applicationId &&
        a.projectId === projectId &&
        a.reserveAttempted === true &&
        ["closing", "reserved", "applied", "committed", "held"].includes(a.phase) &&
        same(a, n.thread.sourceApplication) &&
        a.serverInstanceId === n.native.serverInstanceId &&
        a.managerThreadId === n.managerThreadId &&
        a.leaseExpiresAt > Date.now() / 1000 &&
        same(
          Object.fromEntries(
            [
              "projectId",
              "preparationIntentId",
              "repositoryId",
              "revision",
              "leaseId",
              "leaseGeneration",
            ].map((k) => [k, local.checkout?.[k]]),
          ),
          a.sourceObservation?.checkoutBinding,
        ) &&
        local.metadataPinsDigest === digest(n.metadata),
    );
    const o = a.sourceObservation,
      b = a.barrier,
      i = a.inputInventory,
      idle = a.idleSnapshot;
    check(
      o.scope === "native_observer_journal_only" &&
        o.writerHeld === true &&
        o.quiescenceAuthority === false &&
        o.metadataApplyAuthorized === false &&
        o.pendingSourceEvents === 0 &&
        o.unknownInputs === 0 &&
        o.registrationId === n.registrationId &&
        o.serverInstanceId === a.serverInstanceId &&
        o.managerThreadId === a.managerThreadId &&
        o.operationId === a.publicationOperationId &&
        same(o.acceptedSourceContext, a.targetSourceContext) &&
        b.closed === true &&
        b.rootCompleted === true &&
        b.projectId === projectId &&
        uuid(b.id) &&
        positive(b.generation) &&
        b.sourceSpoolDigest === o.sourceJournalDigest &&
        [b.pendingCommands, b.activeCli, b.pendingInputs, b.unknownInputs].every((v) => v === 0) &&
        i.terminals.projectId === projectId &&
        i.terminals.closed === true &&
        [
          i.terminals.activeTerminals,
          i.terminals.helpersPendingClose,
          i.terminals.pendingInputs,
          i.terminals.unknownInputs,
          i.cli.activeCli,
          i.cli.unknownInputs,
          i.routing.pendingObservers,
          i.routing.activeHandlers,
        ].every((v) => v === 0) &&
        Array.isArray(i.routing.observerFailures) &&
        !i.routing.observerFailures.length &&
        i.routing.receiveSequence === a.boundary.receiveSequence &&
        b.commandInventoryDigest === sha(JSON.stringify(i.routing)) &&
        b.terminalInventoryDigest === sha(JSON.stringify({ terminals: i.terminals, cli: i.cli })) &&
        idle.admissionId === local.admissionId &&
        idle.admissionGeneration === local.admissionGeneration &&
        idle.managerBindingId === o.managerBindingId &&
        idle.currentAttemptId === o.attemptId &&
        idle.parentTurnId === o.parentTurnId &&
        idle.managerThreadId === o.managerThreadId &&
        idle.cursorVersion === o.cursorVersion &&
        idle.nativeSequence === o.nativeSequence &&
        idle.fullHistory === true &&
        idle.historyDigest === a.boundary.historyDigest &&
        idle.loadedInventoryDigest === a.boundary.loadedInventoryDigest &&
        idle.rootTurns === a.boundary.rootTurns &&
        idle.historyBytes === a.boundary.historyBytes &&
        [idle.pendingHandlers, idle.pendingObservers, idle.unknownFacts, idle.activeRoots].every(
          (v) => v === 0,
        ),
    );
    const raw = privateRead(
        join(home, ".local/state/hive/delivery-manager/native/source.json"),
        4194304,
      ),
      saved = JSON.parse(raw),
      spool = saved.state,
      mac = createHmac("sha256", sha(`hive-native-spool-v1\n${n.native.controllerPrivateKeyPem}`))
        .update(JSON.stringify(spool))
        .digest("hex");
    check(
      typeof n.native.controllerPrivateKeyPem === "string" &&
        hex(saved.signature) &&
        timingSafeEqual(Buffer.from(mac), Buffer.from(saved.signature)) &&
        sha(raw) === o.sourceJournalDigest &&
        spool.sourceProtocol === 1 &&
        !spool.blocked[o.managerThreadId],
    );
    const cursor = spool.cursors[o.managerThreadId],
      claim = spool.attempts[o.attemptId],
      publication = spool.sourcePublications[o.attemptId],
      root = spool.rootTurns[digest([o.managerThreadId, o.parentTurnId])];
    check(
      // Progression version belongs to the immutable admitted claim, not the
      // journal header. Source mode requires progression in the pinned writer.
      claim?.progressionProtocol === 1 &&
        cursor?.attemptId === o.attemptId &&
        cursor.cursorVersion === o.cursorVersion &&
        cursor.sequence === o.nativeSequence &&
        cursor.acknowledgedSequence === o.nativeSequence &&
        root?.status === "completed" &&
        spool.results[o.attemptId] &&
        [
          "managerThreadId",
          "managerBindingId",
          "taskId",
          "stepId",
          "attemptId",
          "parentTurnId",
          "registrationId",
          "serverInstanceId",
          "checkoutBindingDigest",
          "inputSourceSha",
        ].every((k) => claim?.[k] === o[k]) &&
        same(claim.checkoutBinding, o.checkoutBinding) &&
        same(claim.sourceContext, o.inputSourceContext) &&
        publication?.operationId === a.publicationOperationId &&
        same(publication.sourceContext, a.targetSourceContext) &&
        publication.parentSha === claim.inputSourceSha &&
        publication.previousRevisionId === (a.expectedAppliedSourceContext?.revisionId ?? null) &&
        !spool.events.some((v) => v.managerThreadId === o.managerThreadId && !v.acknowledged) &&
        !Object.values(spool.violations).some((v) => v.managerThreadId === o.managerThreadId),
    );
    const cohort = Object.values(spool.fragments)
      .filter((f) => f.managerThreadId === o.managerThreadId)
      .map((f) => {
        check(
          f.requested && f.resolved && uuid(f.attemptId) && typeof f.childThreadId === "string",
        );
        const turns = [
          ...new Set(
            spool.events
              .filter(
                (v) =>
                  v.input.attemptId === f.attemptId &&
                  v.input.source.childThreadId === f.childThreadId,
              )
              .map((v) => v.input.source.childTurnId)
              .filter(Boolean),
          ),
        ];
        check(turns.length === 1);
        return {
          parentTurnId: f.parentTurnId,
          spawnCallId: f.spawnCallId,
          childThreadId: f.childThreadId,
          childTurnId: turns[0],
          ...f.requested,
          ...f.resolved,
        };
      });
    check(
      Array.isArray(a.cohort) &&
        same(a.cohort, cohort) &&
        !Object.values(spool.rootTurns).some(
          (r) => r.managerThreadId === o.managerThreadId && r.status !== "completed",
        ),
    );
    for (const child of a.cohort)
      check(
        spool.events.some(
          (v) =>
            v.acknowledged &&
            v.managerThreadId === o.managerThreadId &&
            v.input.source.kind === "turn_completed" &&
            v.input.source.childThreadId === child.childThreadId &&
            v.input.source.childTurnId === child.childTurnId &&
            v.input.source.status === "completed",
        ),
      );
    return {
      a,
      c,
      n,
      local,
      publication,
      controllerJournalDigest: digest(c.journal),
      supervisorJournalDigest: digest(n.native),
    };
  }
  const applicationIdentity = (a) =>
    digest({
      serverInstanceId: a.serverInstanceId,
      managerThreadId: a.managerThreadId,
      cohort: a.cohort,
      leaseExpiresAt: a.leaseExpiresAt,
      boundaryRequestDigest: a.boundaryRequestDigest,
      sourceObservation: Object.fromEntries(
        Object.entries(a.sourceObservation).filter(([k]) => k !== "sourceJournalIdentity"),
      ),
    });
  function appliedPhysical(evidence, saved) {
    const a = evidence.a;
    check(
      saved.authority &&
        same(evidence.c.project.task.acceptedSource, a.targetSourceContext) &&
        same(evidence.n.thread.acceptedSource, a.targetSourceContext),
    );
    const managed = managedReceipt(home, evidence.local.checkout.repositoryId),
      r = managed.record,
      op = r.sourceLastApplied,
      checkout = evidence.local.checkout,
      physical = pinnedMetadata(home, checkout, evidence.n.metadata.pins);
    const inode = (x) => ({ device: String(x?.device), inode: String(x?.inode) });
    check(
      r.provider === "github" &&
        String(r.repositoryId) === checkout.repositoryId &&
        r.revision === checkout.revision &&
        r.checkoutIncarnation === evidence.local.producer.checkoutIncarnation &&
        same(inode(r.checkoutIdentity), evidence.n.metadata.pins.checkout) &&
        r.lease.id === checkout.leaseId &&
        r.lease.generation === checkout.leaseGeneration &&
        r.lease.taskId === checkout.preparationIntentId &&
        r.lease.expiresAt > Date.now() / 1000 &&
        same(r.acceptedSource, a.targetSourceContext) &&
        !r.sourceUpdating &&
        r.sourceAppliedOperation === a.publicationOperationId &&
        op?.phase === "applied" &&
        op.operationId === a.publicationOperationId &&
        same(op.expected.currentSource, a.expectedAppliedSourceContext) &&
        same(op.approval.sourceContext, a.targetSourceContext) &&
        same(op.approval.producer, saved.authority.producer) &&
        same(op.approval.metadataIdentity, evidence.n.metadata.pins) &&
        physical.headSha === a.targetSourceContext.headSha &&
        physical.indexDigest === op.candidateIndexDigest &&
        same(physical.headIdentity, inode(op["candidate-headIdentity"])) &&
        same(physical.indexIdentity, inode(op["candidate-indexIdentity"])),
    );
    return {
      managedReceiptDigest: managed.digest,
      sourceOperationDigest: digest(op),
      appliedHeadSha: physical.headSha,
      appliedIndexDigest: physical.indexDigest,
    };
  }
  function acceptApplication(r, saved, evidence) {
    const { a, n, local, publication } = evidence,
      producer = local.producer;
    check(
      saved.evidenceDigest === applicationIdentity(a) &&
        same(saved.request.idleSnapshot, a.idleSnapshot) &&
        Object.keys(a.barrier).every((k) => same(saved.request.inputBarrier[k], a.barrier[k])),
    );
    check(
      exact(r, [
        "schemaVersion",
        "applicationId",
        "phase",
        "operationId",
        "sourceContext",
        "previousSourceContext",
        "parentSha",
        "treeSha",
        "manifestDigest",
        "metadataIdentity",
        "producer",
        "inputBarrier",
        "expiresAt",
        "applicationAuthorized",
        "executionAuthorized",
        "cleanupAuthorized",
      ]) &&
        r.schemaVersion === 1 &&
        r.applicationId === a.applicationId &&
        ["pending", "applied"].includes(r.phase) &&
        r.operationId === a.publicationOperationId &&
        same(r.sourceContext, a.targetSourceContext) &&
        same(r.previousSourceContext, a.expectedAppliedSourceContext) &&
        r.parentSha === publication.parentSha &&
        r.treeSha === publication.treeSha &&
        r.manifestDigest === publication.manifestDigest &&
        same(r.metadataIdentity, n.metadata.pins) &&
        exact(r.producer, [
          "runtimeId",
          "runtimeGeneration",
          "admissionId",
          "admissionGeneration",
          "producerDigest",
          "checkoutIncarnation",
          "barrierGeneration",
          "metadataPinsDigest",
          "metadataPolicyDigest",
          "namespaceReceiptDigest",
        ]) &&
        Object.keys(r.producer).every((k) => r.producer[k] === producer?.[k]) &&
        r.producer.runtimeId === state.runtimeId &&
        r.producer.runtimeGeneration === state.generation &&
        r.producer.metadataPinsDigest === digest(n.metadata) &&
        exact(r.inputBarrier, ["id", "digest", "generation"]) &&
        r.inputBarrier.id === saved.request.inputBarrier.id &&
        r.inputBarrier.generation === saved.request.inputBarrier.generation &&
        r.inputBarrier.digest === digest(saved.request.inputBarrier) &&
        Number.isSafeInteger(r.expiresAt) &&
        r.expiresAt > Date.now() / 1000 &&
        r.expiresAt <= Date.now() / 1000 + 30 &&
        r.applicationAuthorized === true &&
        r.executionAuthorized === false &&
        r.cleanupAuthorized === false,
    );
    if (saved.authority)
      check(
        same(saved.authority.producer, r.producer) &&
          same(saved.authority.inputBarrier, r.inputBarrier) &&
          (saved.authority.phase !== "applied" || r.phase === "applied"),
      );
    if (r.phase === "applied") {
      check(saved.receipt);
      const current = appliedPhysical(evidence, saved);
      check(Object.keys(current).every((k) => current[k] === saved.receipt[k]));
    }
    saved.authority = structuredClone(r);
  }
  async function application(action, value) {
    check(
      exact(
        value,
        action === "reserve"
          ? [
              "projectId",
              "applicationId",
              "publicationOperationId",
              "targetSourceContext",
              "expectedAppliedSourceContext",
            ]
          : ["projectId", "applicationId"],
      ) &&
        uuid(value.projectId) &&
        uuid(value.applicationId),
    );
    initialize(true);
    state.applications ??= {};
    let evidence = applicationEvidence(value.projectId, value.applicationId),
      saved = state.applications[value.applicationId];
    const a = evidence.a;
    if (action === "reserve")
      check(
        value.publicationOperationId === a.publicationOperationId &&
          same(value.targetSourceContext, a.targetSourceContext) &&
          same(value.expectedAppliedSourceContext, a.expectedAppliedSourceContext),
      );
    if (!saved) {
      check(
        action === "reserve" &&
          !state.pending &&
          !state.hold &&
          Object.keys(state.applications).length < 64,
      );
      const { controllerJournalDigest, supervisorJournalDigest } = evidence;
      saved = state.applications[value.applicationId] = {
        evidenceDigest: applicationIdentity(a),
        request: {
          projectId: value.projectId,
          applicationId: value.applicationId,
          publicationOperationId: a.publicationOperationId,
          expectedAppliedSourceContext: structuredClone(a.expectedAppliedSourceContext),
          targetSourceContext: structuredClone(a.targetSourceContext),
          idleSnapshot: structuredClone(a.idleSnapshot),
          inputBarrier: {
            ...structuredClone(a.barrier),
            controllerJournalDigest,
            supervisorJournalDigest,
          },
        },
      };
      save(); // Immutable attempted reservation, before any network effect.
    } else {
      check(
        saved.evidenceDigest === applicationIdentity(a) &&
          saved.request.projectId === value.projectId &&
          saved.request.publicationOperationId === a.publicationOperationId &&
          same(saved.request.targetSourceContext, a.targetSourceContext) &&
          same(saved.request.expectedAppliedSourceContext, a.expectedAppliedSourceContext) &&
          same(saved.request.idleSnapshot, a.idleSnapshot) &&
          Object.keys(a.barrier).every((k) => same(saved.request.inputBarrier[k], a.barrier[k])),
      );
      if (action === "reserve") action = "verify";
    }
    await currentMetadata(value.projectId);
    evidence = applicationEvidence(value.projectId, value.applicationId);
    const fields = { projectId: value.projectId, applicationId: value.applicationId };
    if (action === "commit") {
      check(
        !state.pending &&
          !state.hold &&
          saved.authority &&
          evidence.a.phase === "applied" &&
          same(
            evidence.c.project.task.acceptedSource ?? evidence.c.project.acceptedSource,
            a.targetSourceContext,
          ) &&
          same(evidence.n.thread.acceptedSource, a.targetSourceContext),
      );
      if (!saved.receipt) {
        const physical = appliedPhysical(evidence, saved);
        saved.receipt = {
          schemaVersion: 1,
          applicationId: value.applicationId,
          publicationOperationId: a.publicationOperationId,
          sourceContext: a.targetSourceContext,
          previousSourceContext: a.expectedAppliedSourceContext,
          inputBarrierId: saved.authority.inputBarrier.id,
          inputBarrierDigest: saved.authority.inputBarrier.digest,
          metadataPinsDigest: saved.authority.producer.metadataPinsDigest,
          namespaceReceiptDigest: saved.authority.producer.namespaceReceiptDigest,
          managedReceiptDigest: physical.managedReceiptDigest,
          sourceOperationDigest: physical.sourceOperationDigest,
          controllerJournalDigest: evidence.controllerJournalDigest,
          supervisorJournalDigest: evidence.supervisorJournalDigest,
          appliedHeadSha: physical.appliedHeadSha,
          appliedIndexDigest: physical.appliedIndexDigest,
          sourceUpdating: false,
          controllerSourceContext: a.targetSourceContext,
          supervisorSourceContext: a.targetSourceContext,
          observedAt: new Date().toISOString(),
        };
        save();
      }
      fields.appliedReceipt = structuredClone(saved.receipt);
    }
    const result = await send(
      `apply_${action}`,
      action === "reserve" ? saved.request : fields,
      (r) => acceptApplication(r, saved, applicationEvidence(value.projectId, value.applicationId)),
      action === "verify" ? "readback" : undefined,
    );
    // Preserve the exact server ACK in the durable chain. Only the downstream
    // scoped permission is shortened by the worker's captured unextended lease.
    result.expiresAt = Math.min(result.expiresAt, Math.floor(a.leaseExpiresAt));
    check(result.expiresAt > Date.now() / 1000);
    return result;
  }
  async function recoverEnrollment() {
    const s = initialize(false, true, true),
      originalEnrollment = structuredClone(state.pending);
    check(
      state.hold &&
        originalEnrollment?.action === "enroll" &&
        !state.runtimeId &&
        state.generation === 1 &&
        !state.launch &&
        !Object.keys(state.projects).length &&
        !Object.keys(state.applications).length &&
        typeof originalEnrollment.grant === "string",
    );
    const claims = JSON.parse(Buffer.from(originalEnrollment.grant.split(".")[1], "base64url"));
    const unstarted = readPendingUnstartedTransfer(home);
    check(
      uuid(claims.jti) &&
        uuid(originalEnrollment.runtimeId) &&
        claims.runtimeId === originalEnrollment.runtimeId &&
        claims.lifetimeId === s.lifetimeId &&
        claims.bindingDigest === s.bindingDigest &&
        claims.identityDigest ===
          digest({ identity: identity(s), binding: { ...config.binding, projects: [] } }) &&
        claims.startupDigest === digest(s),
    );
    if (unstarted)
      check(
        same(claims.unstartedTransfer, {
          transferId: unstarted.transferId,
          oldRuntimeId: unstarted.oldRuntimeId,
          proofDigest: digest(unstarted),
        }),
      );
    const now = Date.now(),
      body = {
        schemaVersion: 1,
        runtimeId: originalEnrollment.runtimeId,
        runtimeGeneration: 1,
        eventId: randomUUID(),
        issuedAt: now,
        expiresAt: now + 20000,
        action: "enrollment_readback",
        nonce: randomBytes(32).toString("hex"),
        grantId: claims.jti,
        tokenDigest: sha(originalEnrollment.grant),
        consumptionDigest: digest(originalEnrollment),
        identityDigest: claims.identityDigest,
        lifetimeId: claims.lifetimeId,
        configSha256,
        startupDigest: claims.startupDigest,
        originalEnrollment,
      };
    const frame = {
      ...body,
      proof: sign(
        null,
        Buffer.from(`hive-guardian-controller-v1\nPOST\n${PATH}\n${guardianCanonical(body)}`),
        key,
      ).toString("base64url"),
    };
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), Math.max(1, deadline - Date.now()));
    let response;
    try {
      response = await fetchImpl(`${config.hiveOrigin}${PATH}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
        signal: abort.signal,
      });
      const r = await boundedJson(response, abort.signal);
      check(
        Date.now() < body.expiresAt &&
          !abort.signal.aborted &&
          r?.accepted === true &&
          r.empty === true &&
          r.runtimeId === body.runtimeId &&
          r.runtimeGeneration === 1 &&
          r.nonce === body.nonce &&
          r.grantId === body.grantId &&
          r.tokenDigest === body.tokenDigest &&
          r.consumptionDigest === body.consumptionDigest &&
          r.identityDigest === body.identityDigest &&
          r.lifetimeId === body.lifetimeId &&
          r.configSha256 === body.configSha256 &&
          r.startupDigest === body.startupDigest &&
          Number.isSafeInteger(r.enrolledAt) &&
          Number.isSafeInteger(r.authorityUntil) &&
          r.authorityUntil > r.enrolledAt,
      );
      check(same(startup(), s));
      check(same(state.pending, originalEnrollment) && state.hold && !state.runtimeId);
      state.enrollmentRecovery = { originalEnrollment, receipt: structuredClone(r) };
      state.runtimeId = r.runtimeId;
      state.generation = 1;
      state.pending = null;
      state.hold = false;
      if (unstarted) state.unstartedTransferReceipt = structuredClone(claims.unstartedTransfer);
      save();
    } finally {
      clearTimeout(timer);
      void response?.body?.cancel().catch(() => {});
    }
  }
  function issueIdentity(nonce) {
    const transfer = readPendingUnstartedTransfer(home);
    const s = initialize(),
      issuedAt = Date.now(),
      packet = {
        schemaVersion: 1,
        nonce,
        issuedAt,
        expiresAt: issuedAt + 30000,
        identity: identity(s),
        startup: s,
        ...(transfer ? { unstartedTransfer: transfer } : {}),
        ...(state.unstartedTransferReceipt
          ? { unstartedTransferReceipt: state.unstartedTransferReceipt }
          : {}),
      };
    challenge = structuredClone(packet);
    return {
      ...packet,
      proof: sign(
        null,
        Buffer.from(`hive-guardian-identity-v1\n${guardianCanonical(packet)}`),
        key,
      ).toString("base64url"),
    };
  }
  return {
    canIdleShutdown() {
      return !state && !challenge && !existsSync(statePath);
    },
    identity(nonce) {
      check(hex(nonce));
      initialize(false, true, true);
      if (state.hold && state.pending?.action === "enroll")
        return serial(async () => {
          await recoverEnrollment();
          return issueIdentity(nonce);
        }, 15000);
      return issueIdentity(nonce);
    },
    bootstrap(grant) {
      return serial(async () => {
        const s = initialize();
        const unstarted = readPendingUnstartedTransfer(home);
        check(challenge && !state.runtimeId && typeof grant === "string" && grant.length <= 16384);
        const parts = grant.split(".");
        check(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
        const header = JSON.parse(Buffer.from(parts[0], "base64url")),
          claims = JSON.parse(Buffer.from(parts[1], "base64url")),
          now = Math.floor(Date.now() / 1000),
          binding = { ...config.binding, projects: [] };
        check(
          exact(header, ["alg", "typ", "kid"]) &&
            header.alg === "EdDSA" &&
            header.typ === "JWT" &&
            header.kid === config.issuerKeyId &&
            verify(
              null,
              Buffer.from(`${parts[0]}.${parts[1]}`),
              issuer,
              Buffer.from(parts[2], "base64url"),
            ),
        );
        check(
          exact(claims, [
            "iss",
            "aud",
            "scope",
            "jti",
            "iat",
            "exp",
            "runtimeId",
            "hiveUserId",
            "coderOwnerId",
            "workspaceId",
            "agentId",
            "buildId",
            "appId",
            "lifetimeId",
            "outerKeyFingerprint",
            "bindingDigest",
            "identityDigest",
            "startupDigest",
            ...(unstarted ? ["unstartedTransfer"] : []),
          ]) &&
            claims.iss === config.hiveOrigin &&
            claims.aud === "hive:workspace-guardian" &&
            claims.scope === "workspace:guardian:enroll" &&
            [claims.jti, claims.runtimeId, claims.hiveUserId].every(uuid) &&
            claims.iat <= now &&
            claims.exp > now &&
            claims.exp - claims.iat > 0 &&
            claims.exp - claims.iat <= 60 &&
            claims.coderOwnerId === binding.ownerId &&
            claims.workspaceId === binding.workspaceId &&
            claims.agentId === binding.agentId &&
            claims.buildId === binding.buildId &&
            claims.appId === binding.appId &&
            claims.hiveUserId === binding.hiveUserId &&
            claims.lifetimeId === s.lifetimeId &&
            claims.bindingDigest === s.bindingDigest &&
            claims.outerKeyFingerprint === sha(publicKey.export({ type: "spki", format: "der" })) &&
            claims.identityDigest === digest({ identity: identity(s), binding }) &&
            claims.startupDigest === digest(challenge.startup) &&
            Date.now() < challenge.expiresAt &&
            digest(s) === digest(challenge.startup),
        );
        if (unstarted)
          check(
            same(claims.unstartedTransfer, {
              transferId: unstarted.transferId,
              oldRuntimeId: unstarted.oldRuntimeId,
              proofDigest: digest(unstarted),
            }),
          );
        await send("enroll", { runtimeId: claims.runtimeId, grant }, (r) => {
          check(
            r?.accepted === true &&
              r.runtimeId === claims.runtimeId &&
              r.runtimeGeneration === s.generation,
          );
          state.runtimeId = r.runtimeId;
          state.generation = r.runtimeGeneration;
          if (unstarted) state.unstartedTransferReceipt = structuredClone(claims.unstartedTransfer);
        });
        challenge = null;
        return {
          enrolled: true,
          runtimeId: state.runtimeId,
          ...(state.unstartedTransferReceipt
            ? { unstartedTransfer: state.unstartedTransferReceipt }
            : {}),
        };
      }, 15000);
    },
    authorizeAdmission: (v) => serial(() => admission(v), GUARDIAN_ADMISSION_BUDGET.controllerMs),
    metadataAuthority: (projects, { authorityVersion } = {}) =>
      serial(
        async () => {
          initialize();
          check(authorityVersion === undefined || authorityVersion === 1);
          check(
            Array.isArray(projects) &&
              projects.length > 0 &&
              projects.length <= 32 &&
              !state.launch,
          );
          const ids = projects.map((p) => p.projectId).sort();
          check(
            new Set(ids).size === ids.length &&
              ids.join() === Object.keys(state.projects).sort().join(),
          );
          for (const id of ids) {
            const evidence = controllerProject(id, startup());
            await admission({
              projectId: id,
              bindingDigest: sha(JSON.stringify(evidence.preparation)),
            });
          }
          const inventory = ids.map((id) => {
            const a = state.projects[id];
            check(a.phase === "checkout");
            return {
              admissionId: a.admissionId,
              admissionGeneration: a.admissionGeneration,
              checkout: a.checkout,
            };
          });
          const nativeLaunchId = randomUUID(),
            launchIntentDigest = digest({
              runtimeId: state.runtimeId,
              runtimeGeneration: state.generation,
              nativeLaunchId,
              inventory,
            });
          const answer = await send(
            "launch",
            {
              nativeLaunchId,
              launchIntentDigest,
              projectIds: ids,
              ...(authorityVersion === 1 ? { authorityVersion } : {}),
            },
            (r) => {
              check(
                r?.runtimeId === state.runtimeId &&
                  r.runtimeGeneration === state.generation &&
                  r.nativeLaunchId === nativeLaunchId &&
                  r.launchIntentDigest === launchIntentDigest &&
                  r.policyDigest === GUARDIAN_CONTROLLER_POLICY_DIGEST &&
                  r.metadataPolicyDigest === GUARDIAN_CONTROLLER_POLICY.metadataPolicyDigest &&
                  (authorityVersion !== 1 ||
                    (Number.isSafeInteger(r.authorityUntil) && r.authorityUntil > Date.now())) &&
                  r.approvals?.length === ids.length &&
                  r.approvals.every(
                    (a, i) =>
                      a.firstNative === true &&
                      a.projectId === ids[i] &&
                      a.admissionId === inventory[i].admissionId &&
                      a.admissionGeneration === inventory[i].admissionGeneration &&
                      a.checkoutIncarnation === inventory[i].checkout.checkoutIncarnation,
                  ),
              );
              state.launch = r;
            },
          );
          return answer;
        },
        GUARDIAN_ADMISSION_BUDGET.controllerMs,
        Date.now() + GUARDIAN_ADMISSION_BUDGET.controllerMs,
      ),
    currentMetadata: (projectId) =>
      serial(async () => {
        try {
          return await currentMetadata(projectId);
        } catch (error) {
          if (state) {
            state.hold = true;
            save();
          }
          throw error;
        }
      }, GUARDIAN_ADMISSION_BUDGET.controllerMs),
    applyReserve: (value) => serial(() => application("reserve", value)),
    applyVerify: (value) => serial(() => application("verify", value)),
    applyCommit: (value) => serial(() => application("commit", value)),
    drainReady: (maintenanceId) =>
      serial(async () => {
        initialize();
        if (state.accountMaintenance?.phase === "resuming") return false;
        if (state.accountMaintenance?.phase === "waiting-boundary") {
          check(
            state.accountMaintenance.id === maintenanceId &&
              state.accountMaintenance.phase === "waiting-boundary",
          );
          return true;
        }
        check(maintenanceId === undefined);
        const issuedAt = Date.now(),
          body = {
            schemaVersion: 1,
            runtimeId: state.runtimeId,
            eventId: randomUUID(),
            issuedAt,
            expiresAt: issuedAt + 3500,
            action: "drain_ready",
            runtimeGeneration: state.generation,
          };
        const frame = {
          ...body,
          proof: sign(
            null,
            Buffer.from(`hive-guardian-controller-v1\nPOST\n${PATH}\n${guardianCanonical(body)}`),
            key,
          ).toString("base64url"),
        };
        const signal = AbortSignal.timeout(3000);
        const response = await fetchImpl(`${config.hiveOrigin}${PATH}`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frame),
          signal,
        });
        const result = await boundedJson(response, signal);
        startup();
        check(
          Date.now() < body.expiresAt &&
            result?.runtimeId === state.runtimeId &&
            result.runtimeGeneration === state.generation &&
            typeof result.ready === "boolean",
        );
        return result.ready;
      }),
    requestAccountMaintenance: (grant) =>
      serial(() => {
        const s = initialize();
        check(
          typeof grant === "string" &&
            grant.length >= 100 &&
            grant.length <= 16384 &&
            !state.hold &&
            !state.pending,
        );
        const parts = grant.split(".");
        check(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
        const header = JSON.parse(Buffer.from(parts[0], "base64url")),
          c = JSON.parse(Buffer.from(parts[1], "base64url")),
          now = Math.floor(Date.now() / 1000);
        check(
          exact(header, ["alg", "typ", "kid"]) &&
            header.alg === "EdDSA" &&
            header.typ === "JWT" &&
            header.kid === config.issuerKeyId &&
            verify(
              null,
              Buffer.from(`${parts[0]}.${parts[1]}`),
              issuer,
              Buffer.from(parts[2], "base64url"),
            ) &&
            exact(c, [
              "iss",
              "aud",
              "scope",
              "action",
              "jti",
              "iat",
              "exp",
              "runtimeId",
              "runtimeGeneration",
              "lifetimeId",
              "hiveUserId",
              "coderOwnerId",
              "workspaceId",
              "buildId",
              "maintenanceId",
              "maintenanceVersion",
              "ownerIntentRuntimeId",
              "ownerIntentEventId",
              "parkedJournalDigest",
            ]) &&
            c.iss === config.hiveOrigin &&
            c.aud === "hive:workspace-guardian" &&
            c.scope === "workspace:guardian:account-maintenance" &&
            ["pause", "inspect-resume", "resume"].includes(c.action) &&
            uuid(c.jti) &&
            Number.isSafeInteger(c.iat) &&
            Number.isSafeInteger(c.exp) &&
            c.iat <= now &&
            c.exp > now &&
            c.exp - c.iat > 0 &&
            c.exp - c.iat <= 60 &&
            c.runtimeId === state.runtimeId &&
            c.runtimeGeneration === state.generation &&
            c.lifetimeId === s.lifetimeId &&
            c.hiveUserId === config.binding.hiveUserId &&
            c.coderOwnerId === config.binding.ownerId &&
            c.workspaceId === config.binding.workspaceId &&
            c.buildId === config.binding.buildId &&
            uuid(c.maintenanceId) &&
            positive(c.maintenanceVersion),
        );
        if (c.action !== "pause") {
          check(!state.launch && !Object.keys(state.projects).length && c.runtimeGeneration === 1);
          const parked = readAccountMaintenanceArchive(
            {
              stateDirectory: join(home, ".local/state/hive/codex-project-controller"),
              ownerId: config.binding.ownerId,
              workspaceId: config.binding.workspaceId,
            },
            c.maintenanceId,
          );
          const archives = readdirSync(stateDirectory).filter((name) =>
            /^controller-archive-[a-f0-9]{64}\.json$/.test(name),
          );
          check(archives.length <= 256);
          const matching = [];
          for (const name of archives) {
            const encoded = privateRead(join(stateDirectory, name));
            check(sha(encoded) === name.slice(19, -5));
            const saved = JSON.parse(encoded);
            check(
              verify(
                null,
                Buffer.from(guardianCanonical(saved.state)),
                publicKey,
                Buffer.from(saved.signature, "base64url"),
              ),
            );
            if (saved.state.accountMaintenance?.id === c.maintenanceId) matching.push(saved.state);
          }
          check(matching.length === 1);
          const prior = matching[0],
            hold = prior.accountMaintenance,
            ps = parked.evidence.projectState;
          check(
            hold.phase === "parked" &&
              hold.parkedJournalDigest === parked.parkedJournalDigest &&
              hold.treeReceiptDigest === parked.evidence.treeReceiptDigest &&
              prior.lifetimeId === parked.evidence.priorLifetimeId &&
              Array.isArray(hold.snapshots) &&
              hold.snapshots.length === Object.keys(ps.projects).length,
          );
          const directory = dirname(fileURLToPath(import.meta.url)),
            manifestBytes = readFileSync(join(directory, "package-manifest.json"));
          check(sha(manifestBytes) === packageManifestSha256);
          const manifest = JSON.parse(manifestBytes),
            helper = join(directory, "managed-projects.py");
          check(sha(readFileSync(helper)) === manifest.files?.["managed-projects.py"]);
          const inspectUntil = Date.now() + 10000;
          const projects = Object.values(ps.projects).map((p) => {
            const t = p.task,
              o = hold.snapshots.find((s) => s.projectId === p.projectId),
              n = parked.evidence.nativeRegistry.state.projects[p.projectId];
            check(Date.now() < inspectUntil);
            const inspection = JSON.parse(
              execFileSync("/usr/bin/python3", [helper], {
                input: JSON.stringify({
                  schemaVersion: 1,
                  operation: "inspect",
                  provider: "github",
                  repositoryId: p.repositoryId,
                }),
                encoding: "utf8",
                timeout: Math.max(1, Math.min(2000, inspectUntil - Date.now())),
                maxBuffer: 65536,
                env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
                stdio: ["pipe", "pipe", "ignore"],
              }),
            );
            check(
              inspection.ok === true &&
                inspection.data?.checkoutVerified === true &&
                inspection.data.revision === t.request?.revision,
            );
            const managed = managedReceipt(home, p.repositoryId).record;
            check(
              t?.prepared &&
                o &&
                n?.threadId === t.nativeThreadId &&
                t.guardianPreparation?.buildId === config.binding.buildId &&
                t.request.requestId === o.firstPromptRequestId &&
                n.firstPrompt?.requestId === o.firstPromptRequestId &&
                n.firstPrompt?.digest === o.firstPromptDigest &&
                n.firstPrompt?.phase === "accepted" &&
                managed.status === "ready" &&
                !managed.sourceUpdating &&
                managed.lease?.id === t.prepared.leaseId &&
                managed.lease.generation === t.prepared.leaseGeneration &&
                managed.lease.taskId === t.taskId &&
                managed.lease.expiresAt > Date.now() / 1000 &&
                managed.revision === t.request.revision &&
                managed.checkoutIncarnation === t.checkoutIncarnation &&
                same(
                  {
                    device: String(managed.checkoutIdentity?.device),
                    inode: String(managed.checkoutIdentity?.inode),
                  },
                  t.checkoutIdentity,
                ),
            );
            return {
              preparationIntentId: t.taskId,
              nativeThreadId: t.nativeThreadId,
              firstPromptRequestId: o.firstPromptRequestId,
              firstPromptDigest: o.firstPromptDigest,
              historyDigest: o.historyDigest,
              checkoutDigest: digest(o.checkoutBinding ?? prior.projects[p.projectId].checkout),
              leaseId: t.prepared.leaseId,
              leaseGeneration: t.prepared.leaseGeneration,
            };
          });
          if (c.action === "inspect-resume") {
            check(
              c.ownerIntentRuntimeId === null &&
                c.ownerIntentEventId === null &&
                c.parkedJournalDigest === null,
            );
            const issuedAt = Date.now(),
              body = {
                schemaVersion: 1,
                purpose: "account-maintenance-archive",
                ownerId: config.binding.hiveUserId,
                workspaceId: config.binding.workspaceId,
                buildId: config.binding.buildId,
                maintenanceId: c.maintenanceId,
                maintenanceVersion: c.maintenanceVersion,
                runtimeId: state.runtimeId,
                runtimeGeneration: state.generation,
                requestId: c.jti,
                issuedAt,
                expiresAt: issuedAt + 30000,
                parkedJournalDigest: parked.parkedJournalDigest,
                projects,
              };
            return {
              ...body,
              proof: sign(
                null,
                Buffer.from(`hive-account-maintenance-archive-v1\n${guardianCanonical(body)}`),
                key,
              ).toString("base64url"),
            };
          }
          check(
            uuid(c.ownerIntentRuntimeId) &&
              uuid(c.ownerIntentEventId) &&
              c.parkedJournalDigest === parked.parkedJournalDigest,
          );
          state.accountMaintenance = {
            id: c.maintenanceId,
            version: c.maintenanceVersion,
            phase: "resuming",
            requestId: c.jti,
            ownerIntentRuntimeId: c.ownerIntentRuntimeId,
            ownerIntentEventId: c.ownerIntentEventId,
            parkedJournalDigest: parked.parkedJournalDigest,
            projects,
            historyThreads: hold.snapshots.map((o) => ({
              projectId: o.projectId,
              threadIds: o.threadIds,
            })),
          };
          save();
          return {
            action: "resume",
            maintenanceId: c.maintenanceId,
            scope: structuredClone(state.accountMaintenance),
          };
        }
        check(
          c.ownerIntentRuntimeId === null &&
            c.ownerIntentEventId === null &&
            c.parkedJournalDigest === null,
        );
        if (state.accountMaintenance?.phase === "resumed") {
          state.accountMaintenanceHistory ??= {};
          state.accountMaintenanceHistory[state.accountMaintenance.id] = structuredClone(
            state.accountMaintenance,
          );
          delete state.accountMaintenance;
        }
        check(
          !state.accountMaintenance ||
            (state.accountMaintenance.id === c.maintenanceId &&
              state.accountMaintenance.version === c.maintenanceVersion),
        );
        state.accountMaintenance ??= {
          id: c.maintenanceId,
          version: c.maintenanceVersion,
          phase: "waiting-boundary",
        };
        save();
        return { action: "pause", maintenanceId: c.maintenanceId };
      }),
    maintenanceResumeReady: () =>
      serial(async () => {
        initialize();
        const hold = state.accountMaintenance;
        check(
          hold &&
            ["resuming", "resumed"].includes(hold.phase) &&
            Object.keys(state.projects).length === hold.projects.length &&
            Object.values(state.projects).every(
              (p) => p.phase === "native" && uuid(p.nativeReceiptEventId),
            ),
        );
        const result = await send(
          "maintenance_resume_ready",
          {
            maintenanceId: hold.id,
            ownerIntentRuntimeId: hold.ownerIntentRuntimeId,
            ownerIntentEventId: hold.ownerIntentEventId,
          },
          (r) => {
            check(
              r?.ready === true &&
                r.maintenanceId === hold.id &&
                r.ownerIntentRuntimeId === hold.ownerIntentRuntimeId &&
                r.ownerIntentEventId === hold.ownerIntentEventId &&
                Array.isArray(r.authorizations) &&
                r.authorizations.length === hold.projects.length &&
                new Set(r.authorizations.map((a) => a.projectId)).size === hold.projects.length &&
                r.authorizations.every(
                  (a) =>
                    state.projects[a.projectId]?.nativeReceiptEventId === a.nativeReceiptEventId &&
                    typeof a.runnable === "boolean" &&
                    Number.isSafeInteger(a.executionEpochVersion) &&
                    ((a.managerBindingId === null && a.executionEpochVersion === 0) ||
                      (uuid(a.managerBindingId) && a.executionEpochVersion > 0)),
                ),
            );
          },
          "factual",
        );
        hold.phase = "resumed";
        save();
        return { ...result, runtimeId: state.runtimeId };
      }),
    requestExpiredEmptyDrain: (grant) =>
      serial(() => {
        const s = initialize(false, false, true),
          recovery = state.enrollmentRecovery;
        check(
          recovery &&
            Date.now() >= recovery.receipt.authorityUntil &&
            !state.hold &&
            !state.pending &&
            !state.launch &&
            state.generation === 1 &&
            !Object.keys(state.projects).length &&
            !Object.keys(state.applications).length &&
            typeof grant === "string" &&
            grant.length <= 16384,
        );
        const parts = grant.split(".");
        check(parts.length === 3 && parts.every((v) => /^[A-Za-z0-9_-]+$/.test(v)));
        const header = JSON.parse(Buffer.from(parts[0], "base64url")),
          claims = JSON.parse(Buffer.from(parts[1], "base64url")),
          now = Math.floor(Date.now() / 1000);
        check(
          exact(header, ["alg", "typ", "kid"]) &&
            header.alg === "EdDSA" &&
            header.typ === "JWT" &&
            header.kid === config.issuerKeyId &&
            verify(
              null,
              Buffer.from(`${parts[0]}.${parts[1]}`),
              issuer,
              Buffer.from(parts[2], "base64url"),
            ) &&
            exact(claims, [
              "iss",
              "aud",
              "scope",
              "jti",
              "iat",
              "exp",
              "runtimeId",
              "hiveUserId",
              "coderOwnerId",
              "workspaceId",
              "buildId",
              "lifetimeId",
              "runtimeGeneration",
            ]) &&
            claims.iss === config.hiveOrigin &&
            claims.aud === "hive:workspace-guardian" &&
            claims.scope === "workspace:guardian:recover-empty-close" &&
            uuid(claims.jti) &&
            Number.isSafeInteger(claims.iat) &&
            Number.isSafeInteger(claims.exp) &&
            claims.iat <= now &&
            claims.exp > now &&
            claims.exp - claims.iat <= 60 &&
            claims.runtimeId === state.runtimeId &&
            claims.runtimeGeneration === 1 &&
            claims.lifetimeId === s.lifetimeId &&
            claims.hiveUserId === config.binding.hiveUserId &&
            claims.coderOwnerId === config.binding.ownerId &&
            claims.workspaceId === config.binding.workspaceId &&
            claims.buildId === config.binding.buildId,
        );
        state.expiredEmptyDrain = { grant, expiresAt: claims.exp * 1000 };
        save();
        return true;
      }),
    beginDrain: () =>
      serial(() => {
        drainStartup = structuredClone(initialize(false, false, Boolean(state?.expiredEmptyDrain)));
        if (state.accountMaintenance?.phase === "waiting-boundary") {
          state.accountMaintenance.phase = "closing";
          save();
        }
      }),
    authorizeDrain: (binding, barrier) =>
      serial(async () => {
        check(
          drainStartup &&
            barrier?.closed === true &&
            barrier.lifetimeId === state.lifetimeId &&
            barrier.ownershipDigest === binding.ownershipDigest &&
            barrier.generation === state.generation &&
            uuid(barrier.barrierId) &&
            Array.isArray(barrier.snapshots) &&
            barrier.snapshots.length === binding.projects.length,
        );
        const snapshots = binding.projects.map((p) => {
          const item = barrier.snapshots.find((v) => v.projectId === p.projectId),
            local = state.projects[p.projectId];
          if (state.accountMaintenance?.phase === "closing") {
            check(
              item?.maintenanceId === state.accountMaintenance.id &&
                local?.phase === "native" &&
                local.preparationDigest === p.bindingDigest &&
                item.history?.projectId === p.projectId &&
                item.history?.managerThreadId &&
                hex(item.history?.historyDigest),
            );
            return {
              ...item.history,
              admissionId: local.admissionId,
              admissionGeneration: local.admissionGeneration,
            };
          }
          check(
            item &&
              local?.phase === "native" &&
              local.preparationDigest === p.bindingDigest &&
              item.observation?.managerThreadId &&
              item.history?.observedAt,
          );
          const o = item.observation,
            h = item.history;
          return {
            projectId: p.projectId,
            admissionId: local.admissionId,
            admissionGeneration: local.admissionGeneration,
            managerBindingId: o.managerBindingId,
            currentAttemptId: o.attemptId,
            managerThreadId: o.managerThreadId,
            parentTurnId: o.parentTurnId,
            cursorVersion: o.cursorVersion,
            nativeSequence: o.nativeSequence,
            observedAt: h.observedAt,
            historyDigest: h.historyDigest,
            loadedInventoryDigest: h.loadedInventoryDigest,
            fullHistory: true,
            rootTurns: h.rootTurns,
            historyBytes: h.historyBytes,
            pendingHandlers: 0,
            pendingObservers: 0,
            unknownFacts: 0,
            activeRoots: 0,
          };
        });
        if (state.accountMaintenance?.phase === "closing") {
          check(
            !state.accountMaintenance.snapshots ||
              same(state.accountMaintenance.snapshots, snapshots),
          );
          state.accountMaintenance.snapshots = structuredClone(snapshots);
          save();
        }
        if (state.expiredEmptyDrain)
          check(
            Date.now() < state.expiredEmptyDrain.expiresAt &&
              binding.projects.length === 0 &&
              snapshots.length === 0,
          );
        const result = await sendClosure(
          state.accountMaintenance?.phase === "closing" ? "maintenance_close" : "close",
          {
            ...(state.accountMaintenance?.phase === "closing"
              ? { maintenanceId: state.accountMaintenance.id }
              : {}),
            barrierId: barrier.barrierId,
            ownershipDigest: binding.ownershipDigest,
            projectBindings: binding.projects,
            snapshots,
            ...(state.expiredEmptyDrain ? { emptyCloseGrant: state.expiredEmptyDrain.grant } : {}),
          },
          (r) => {
            check(
              r?.runtimeId === state.runtimeId &&
                r.runtimeGeneration === state.generation + 1 &&
                r.barrierId === barrier.barrierId &&
                r.ownershipDigest === binding.ownershipDigest &&
                r.treeExited === false &&
                r.cleanupAuthorized === false &&
                Array.isArray(r.decisions) &&
                r.decisions.length === binding.projects.length,
            );
            state.generation = r.runtimeGeneration;
          },
        );
        return binding.projects.map((p) => {
          const local = state.projects[p.projectId],
            decision = result.decisions.find(
              (d) =>
                d.admissionId === local.admissionId &&
                d.admissionGeneration === local.admissionGeneration,
            );
          check(decision && uuid(decision.decisionId));
          return { ...p, decisionId: decision.decisionId };
        });
      }),
    acceptTreeReceipt: (receipt) =>
      serial(async () => {
        check(
          drainStartup &&
            receipt?.guardianExited === true &&
            receipt.workerBarrier?.barrierId &&
            receipt.generation === state.generation,
        );
        return sendClosure(
          "tree_closed",
          { barrierId: receipt.workerBarrier.barrierId, receipt },
          (r) =>
            check(
              r?.runtimeId === state.runtimeId &&
                r.runtimeGeneration === state.generation &&
                r.barrierId === receipt.workerBarrier.barrierId &&
                r.treeExited === true &&
                r.cleanupAuthorized === false,
            ),
        );
      }),
    recoverTreeReceipt: (receipt) =>
      serial(async () => {
        check(
          receipt?.guardianExited === true &&
            uuid(receipt.lifetimeId) &&
            hex(receipt.bindingDigest) &&
            receipt.packageManifestSha256 === packageManifestSha256 &&
            receipt.guardianSha256 === guardianElfSha256 &&
            receipt.nodeSha256 === nodeSha256 &&
            uuid(receipt.workerBarrier?.barrierId),
        );
        const saved = JSON.parse(privateRead(statePath));
        check(
          verify(
            null,
            Buffer.from(guardianCanonical(saved.state)),
            publicKey,
            Buffer.from(saved.signature, "base64url"),
          ),
        );
        state = saved.state;
        drainStartup = { lifetimeId: receipt.lifetimeId, bindingDigest: receipt.bindingDigest };
        check(
          state.lifetimeId === receipt.lifetimeId &&
            state.identityDigest === digest(identity(drainStartup)) &&
            uuid(state.runtimeId) &&
            state.generation === receipt.generation,
        );
        if (state.pending) {
          check(
            state.pending.runtimeId === state.runtimeId &&
              state.pending.runtimeGeneration === state.generation &&
              [
                "tree_closed",
                "epic_release_prepare",
                "epic_release_submit",
                "epic_archive_ack",
              ].includes(state.pending.action),
          );
          if (state.pending.action === "tree_closed")
            check(
              same(state.pending.receipt, receipt) &&
                state.pending.barrierId === receipt.workerBarrier.barrierId,
            );
          state.recoveredClosurePending = structuredClone(state.pending);
          state.pending = null;
          state.hold = false;
          save();
        } else check(!state.hold);
        deadline = Date.now() + 30000;
        const treeResult = await sendClosure(
          "tree_closed",
          { barrierId: receipt.workerBarrier.barrierId, receipt },
          (r) =>
            check(
              r?.runtimeId === state.runtimeId &&
                r.runtimeGeneration === state.generation &&
                r.barrierId === receipt.workerBarrier.barrierId &&
                r.treeExited === true &&
                r.cleanupAuthorized === false,
            ),
        );
        const pending = state.recoveredClosurePending;
        if (pending && pending.action !== "tree_closed") {
          const {
            schemaVersion: _schemaVersion,
            runtimeId: _runtimeId,
            runtimeGeneration: _runtimeGeneration,
            eventId: _eventId,
            issuedAt: _issuedAt,
            expiresAt: _expiresAt,
            proof: _proof,
            action,
            ...fields
          } = pending;
          check(receipt.projects.some((project) => project.projectId === fields.projectId));
          deadline = Date.now() + 30000;
          await sendClosure(action, fields, () => {});
        }
        delete state.recoveredClosurePending;
        save();
        return treeResult;
      }),
    postTreeClosed: (receipt) =>
      serial(async () => {
        check(
          receipt?.guardianExited === true &&
            receipt.workerBarrier?.barrierId &&
            receipt.generation === state.generation,
        );
        if (["closing", "parked"].includes(state.accountMaintenance?.phase)) {
          const parked = parkAccountMaintenanceProjectState(
            {
              stateDirectory: join(home, ".local/state/hive/codex-project-controller"),
              ownerId: config.binding.ownerId,
              workspaceId: config.binding.workspaceId,
            },
            receipt,
            state.accountMaintenance.id,
          );
          state.accountMaintenance.phase = "parked";
          state.accountMaintenance.parkedJournalDigest = parked.parkedJournalDigest;
          state.accountMaintenance.treeReceiptDigest = digest(receipt);
          save();
          return { archived: true }; // Retained maintenance park, NEVER completion/lease release.
        }
        const projects = receipt.projects.map((p) => p.projectId);
        const call = async (action, fields, accept = () => {}) => {
          deadline = Date.now() + 30000;
          return sendClosure(action, fields, accept);
        };
        const prepared = [];
        let ineligible = 0;
        const projectJournal = projects.length
          ? readEvidence(home, "codex-project-controller", "projects.key")
          : { projects: {} };
        for (const projectId of projects) {
          const result = await call("epic_release_prepare", { projectId });
          if (result?.eligible === false) {
            ineligible++;
            continue;
          }
          const bound = state.projects[projectId],
            checkout = bound?.checkout,
            old = state.epicClosure?.projects?.[projectId]?.scope,
            task = projectJournal.projects?.[projectId]?.task;
          check(
            result?.schemaVersion === 1 &&
              result.ownerId === config.binding.ownerId &&
              result.hiveUserId === config.binding.hiveUserId &&
              result.workspaceId === config.binding.workspaceId &&
              result.buildId === config.binding.buildId &&
              result.projectId === projectId &&
              result.barrierId === receipt.workerBarrier.barrierId &&
              result.priorLifetimeId === receipt.lifetimeId &&
              result.treeReceiptDigest === digest(receipt) &&
              hex(result.preservationDigest) &&
              checkout &&
              result.taskId === checkout.preparationIntentId &&
              result.repositoryId === checkout.repositoryId &&
              result.leaseId === checkout.leaseId &&
              result.leaseGeneration === checkout.leaseGeneration &&
              result.checkoutIncarnation === checkout.checkoutIncarnation &&
              ((task &&
                result.requestId === task.request?.requestId &&
                result.acceptedSourceSha ===
                  (task.acceptedSource?.headSha ?? task.request?.revision)) ||
                (!task && old && same(old, result))),
          );
          prepared.push(result);
        }
        check(!ineligible || !prepared.length);
        if (!prepared.length) return { eligible: false };
        const directory = dirname(fileURLToPath(import.meta.url));
        const manifestBytes = readFileSync(join(directory, "package-manifest.json"));
        check(sha(manifestBytes) === packageManifestSha256);
        const manifest = JSON.parse(manifestBytes);
        const runHelper = (name, body) => {
          const path = join(directory, name);
          check(
            ["managed-projects.py", "managed-epic-archive.py"].includes(name) &&
              sha(readFileSync(path)) === manifest.files?.[name],
          );
          const output = execFileSync("/usr/bin/python3", [path], {
            input: JSON.stringify(body),
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 65536,
            env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
            stdio: ["pipe", "pipe", "ignore"],
          });
          return JSON.parse(output);
        };
        state.epicClosure ??= { barrierId: receipt.workerBarrier.barrierId, projects: {} };
        check(state.epicClosure.barrierId === receipt.workerBarrier.barrierId);
        for (const item of prepared) {
          state.epicClosure.projects[item.projectId] ??= {};
          const local = state.epicClosure.projects[item.projectId];
          check(!local.scope || same(local.scope, item));
          local.scope = structuredClone(item);
        }
        save();
        const tokens = [];
        for (const item of prepared) {
          state.epicClosure.projects[item.projectId] ??= {};
          const local = state.epicClosure.projects[item.projectId];
          const release = runHelper("managed-projects.py", {
            schemaVersion: 1,
            operation: "releaseLease",
            provider: "github",
            repositoryId: item.repositoryId,
            taskId: item.taskId,
            leaseId: item.leaseId,
            generation: item.leaseGeneration,
            revision: item.acceptedSourceSha,
          });
          check(release?.ok === true && release.data?.releaseReceipt);
          const reply = await call("epic_release_submit", {
            projectId: item.projectId,
            releaseReceipt: release.data.releaseReceipt,
          });
          check(typeof reply?.token === "string");
          const source = runHelper("managed-epic-archive.py", { token: reply.token });
          check(hex(source?.archiveDigest));
          local.sourceArchiveDigest = source.archiveDigest;
          local.token = reply.token;
          save();
          tokens.push(reply.token);
        }
        const archived = archiveClosedProjectState(
          {
            stateDirectory: join(home, ".local/state/hive/codex-project-controller"),
            ownerId: config.binding.ownerId,
            workspaceId: config.binding.workspaceId,
          },
          tokens,
          config.issuerPublicKeyPem,
        );
        state.epicClosure.archiveDigest = archived.archiveDigest;
        save();
        for (const item of prepared) {
          const local = state.epicClosure.projects[item.projectId];
          await call(
            "epic_archive_ack",
            {
              projectId: item.projectId,
              archiveDigest: archived.archiveDigest,
              sourceArchiveDigest: local.sourceArchiveDigest,
            },
            (r) => check(r?.archived === true),
          );
          local.acknowledged = true;
          save();
        }
        return { eligible: true, archived: true };
      }),
    archiveClosedController: (receipt) =>
      serial(() => {
        check(
          receipt?.guardianExited === true &&
            uuid(receipt.lifetimeId) &&
            uuid(receipt.workerBarrier?.barrierId),
        );
        const validate = (encoded) => {
          const saved = JSON.parse(encoded);
          check(
            verify(
              null,
              Buffer.from(guardianCanonical(saved.state)),
              publicKey,
              Buffer.from(saved.signature, "base64url"),
            ),
          );
          const current = saved.state,
            closure = current.epicClosure;
          if (current.accountMaintenance?.phase === "parked") {
            check(
              current.lifetimeId === receipt.lifetimeId &&
                current.generation === receipt.generation &&
                !current.pending &&
                !current.hold &&
                current.accountMaintenance.phase === "parked" &&
                current.accountMaintenance.treeReceiptDigest === digest(receipt) &&
                hex(current.accountMaintenance.parkedJournalDigest),
            );
            return;
          }
          check(
            current.lifetimeId === receipt.lifetimeId &&
              current.generation === receipt.generation &&
              current.identityDigest ===
                digest(
                  identity({
                    lifetimeId: receipt.lifetimeId,
                    bindingDigest: receipt.bindingDigest,
                  }),
                ) &&
              !current.pending &&
              !current.hold &&
              closure?.barrierId === receipt.workerBarrier.barrierId &&
              hex(closure.archiveDigest) &&
              receipt.projects.length > 0 &&
              Object.keys(closure.projects).length === receipt.projects.length &&
              receipt.projects.every(
                (project) => closure.projects?.[project.projectId]?.acknowledged === true,
              ),
          );
        };
        if (!existsSync(statePath)) {
          const files = readdirSync(stateDirectory).filter((name) =>
            /^controller-archive-[a-f0-9]{64}\.json$/.test(name),
          );
          check(files.length <= 256);
          for (const name of files) {
            try {
              const encoded = privateRead(join(stateDirectory, name));
              if (sha(encoded) !== name.slice(19, -5)) continue;
              validate(encoded);
              return { archived: true, digest: sha(encoded), replayed: true };
            } catch {
              /* A different historical archive cannot authorize this lifetime. */
            }
          }
          check(false);
        }
        const encoded = privateRead(statePath);
        validate(encoded);
        const path = join(stateDirectory, `controller-archive-${sha(encoded)}.json`);
        check(!existsSync(path));
        renameSync(statePath, path);
        const directory = openSync(
          stateDirectory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
        state = null;
        drainStartup = undefined;
        return { archived: true, digest: sha(encoded) };
      }),
    get status() {
      return { enrolled: Boolean(state?.runtimeId), held: Boolean(state?.hold || state?.pending) };
    },
  };
}
