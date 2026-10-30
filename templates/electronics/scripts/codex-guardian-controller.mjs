// Trusted installed outer only. Local journals are evidence; server receipts authorize.
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
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
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  drain: "independent-closed-barrier-required",
  sourceApplication: "terminal-root-reservation-and-protected-applied-receipt",
  metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
});
export const GUARDIAN_CONTROLLER_POLICY_DIGEST = digest(GUARDIAN_CONTROLLER_POLICY);
const PATH = "/api/codex-host/guardians";
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
    deadline,
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
  const initialize = (factual = false) => {
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
      ((!state.hold && !state.pending) || (factual && applicationUncertainty())) &&
        state.lifetimeId === s.lifetimeId &&
        state.identityDigest === digest(id),
    );
    return s;
  };
  const serial = (operation) => {
    const pending = queue.then(() => {
      deadline = Date.now() + 3000;
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  };
  async function send(action, fields, accept, mode) {
    initialize(mode === "factual" || mode === "readback");
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
    check(action === "enroll" || uuid(state.runtimeId));
    const issuedAt = Date.now(),
      body = {
        schemaVersion: 1,
        runtimeId: fields.runtimeId ?? state.runtimeId,
        eventId: randomUUID(),
        issuedAt,
        expiresAt: issuedAt + 3500,
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
    state.sequence++;
    save();
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
      const result = await boundedJson(response, abort.signal);
      check(Date.now() < body.expiresAt && !abort.signal.aborted);
      startup();
      accept(result);
      state.chainDigest = digest({ previous: state.chainDigest, request: frame, response: result });
      state.pending = mode === "factual" ? previous : null;
      state.hold = Boolean(state.pending);
      save();
      return structuredClone(result);
    } catch (error) {
      // The server may already have committed. No local retry can mint authority.
      state.pending = previous ?? state.pending;
      state.hold = true;
      save();
      throw error;
    } finally {
      clearTimeout(timer);
      void response?.body?.cancel().catch(() => {});
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
      ...(state.projects[projectId]?.producer
        ? { producer: state.projects[projectId].producer }
        : {}),
    };
  };
  function controllerProject(projectId, s) {
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
  async function admission(value) {
    check(
      exact(value, ["projectId", "bindingDigest"]) &&
        uuid(value.projectId) &&
        hex(value.bindingDigest),
    );
    const s = initialize(),
      { project, preparation } = controllerProject(value.projectId, s);
    check(sha(JSON.stringify(preparation)) === value.bindingDigest && uuid(state.runtimeId));
    if (!state.projects[value.projectId])
      await send("prepare", { preparation, preparationDigest: value.bindingDigest }, (r) =>
        acceptPair(r, value.projectId),
      );
    const prepared = project.task.guardianPrepared;
    if (prepared && state.projects[value.projectId].phase === "preparation") {
      check(
        prepared.preparationDigest === value.bindingDigest &&
          prepared.projectId === value.projectId &&
          prepared.taskId === preparation.taskId &&
          prepared.repositoryId === preparation.repositoryId,
      );
      await send(
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
        (r) => acceptPair(r, value.projectId),
      );
    }
    if (state.launch && state.projects[value.projectId].phase === "checkout") {
      const native = readEvidence(home, "codex-project-supervisor", "key");
      if (native.controllerRegistration?.status === "registered") {
        const evidence = nativeEvidence(value.projectId, s);
        await send(
          "native",
          {
            projectId: value.projectId,
            registrationId: evidence.registrationId,
            managerThreadId: evidence.managerThreadId,
            metadata: evidence.metadata,
          },
          (r) => acceptPair(r, value.projectId),
        );
      }
    }
    await send(
      "fence",
      { projectId: value.projectId, preparationDigest: value.bindingDigest },
      (r) => acceptPair(r, value.projectId),
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
        spool.progressionProtocol === 1 &&
        !spool.blocked[o.managerThreadId],
    );
    const cursor = spool.cursors[o.managerThreadId],
      claim = spool.attempts[o.attemptId],
      publication = spool.sourcePublications[o.attemptId],
      root = spool.rootTurns[digest([o.managerThreadId, o.parentTurnId])];
    check(
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
  return {
    identity(nonce) {
      check(hex(nonce));
      const s = initialize(),
        issuedAt = Date.now(),
        packet = {
          schemaVersion: 1,
          nonce,
          issuedAt,
          expiresAt: issuedAt + 30000,
          identity: identity(s),
          startup: s,
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
    },
    bootstrap(grant) {
      return serial(async () => {
        const s = initialize();
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
        await send("enroll", { runtimeId: claims.runtimeId, grant }, (r) => {
          check(
            r?.accepted === true &&
              r.runtimeId === claims.runtimeId &&
              r.runtimeGeneration === s.generation,
          );
          state.runtimeId = r.runtimeId;
          state.generation = r.runtimeGeneration;
        });
        challenge = null;
        return { enrolled: true, runtimeId: state.runtimeId };
      });
    },
    authorizeAdmission: (v) => serial(() => admission(v)),
    metadataAuthority: (projects) =>
      serial(async () => {
        initialize();
        check(
          Array.isArray(projects) && projects.length > 0 && projects.length <= 32 && !state.launch,
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
          { nativeLaunchId, launchIntentDigest, projectIds: ids },
          (r) => {
            check(
              r?.runtimeId === state.runtimeId &&
                r.runtimeGeneration === state.generation &&
                r.nativeLaunchId === nativeLaunchId &&
                r.launchIntentDigest === launchIntentDigest &&
                r.policyDigest === GUARDIAN_CONTROLLER_POLICY_DIGEST &&
                r.metadataPolicyDigest === GUARDIAN_CONTROLLER_POLICY.metadataPolicyDigest &&
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
      }),
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
      }),
    applyReserve: (value) => serial(() => application("reserve", value)),
    applyVerify: (value) => serial(() => application("verify", value)),
    applyCommit: (value) => serial(() => application("commit", value)),
    // No inference from a local terminal flag: fresh completed-root snapshots and
    // independently persisted closed-barrier authorization are a separate gate.
    authorizeDrain() {
      throw new Error("guardian_fresh_idle_snapshot_required");
    },
    get status() {
      return { enrolled: Boolean(state?.runtimeId), held: Boolean(state?.hold || state?.pending) };
    },
  };
}
