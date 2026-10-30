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
  metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
});
export const GUARDIAN_CONTROLLER_POLICY_DIGEST = digest(GUARDIAN_CONTROLLER_POLICY);
const PATH = "/api/codex-host/guardians";
function privateRead(path, max = 2 * 1024 * 1024) {
  check(realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    check(s.isFile() && s.uid === process.getuid() && !(s.mode & 0o077) && s.size <= max);
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
  const save = () =>
    atomic(
      statePath,
      `${JSON.stringify({
        state,
        signature: sign(null, Buffer.from(guardianCanonical(state)), key).toString("base64url"),
      })}\n`,
    );
  const initialize = () => {
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
    check(
      !state.hold &&
        !state.pending &&
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
  async function send(action, fields, accept) {
    initialize();
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
      state.pending = null;
      save();
      return structuredClone(result);
    } catch (error) {
      // The server may already have committed. No local retry can mint authority.
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
    return { project, preparation };
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
        const s = initialize(),
          evidence = controllerProject(projectId, s);
        await admission({ projectId, bindingDigest: sha(JSON.stringify(evidence.preparation)) });
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
          },
        );
      }),
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
