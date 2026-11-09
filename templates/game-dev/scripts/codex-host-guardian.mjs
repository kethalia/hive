// Trusted outer host. No HTTP listener, automatic cleanup authority or model tools.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { join, resolve } from "node:path";
import { guardianKernelIdentity, guardianStartChallenge } from "./codex-guardian-startup.mjs";
import {
  GUARDIAN_ADMISSION_BUDGET,
  guardianApplicationRequest,
  guardianProject,
  guardianStartup,
  guardianWire,
} from "./codex-guardian-worker.mjs";
import { openNativeGuardian } from "./codex-native-guardian.mjs";
import { processIdentity, processParentPid } from "./codex-process-identity.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const check = (value) => {
  if (!value) throw new Error("host_guardian_rejected");
};
async function boundedAuthority(operation, timeout = 4000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("guardian_authority_unavailable")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function privateFile(path, directory = false) {
  check(realpathSync(path) === path);
  const stat = lstatSync(path);
  check(
    stat.uid === process.getuid() &&
      !(stat.mode & 0o077) &&
      (directory ? stat.isDirectory() : stat.isFile()),
  );
  return stat;
}
function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dir = openSync(resolve(path, ".."), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function bootstrapRetirement(state, bindingDigest, sourceDigest) {
  check(
    state.phase === "startupReady" &&
      state.bindingDigest !== bindingDigest &&
      state.receipts.length === 0 &&
      state.events.map((event) => event.name).join() ===
        "begin,ready,launchIntent,open,startupReady",
  );
  const [begin, ready, launch, opened, startup] = state.events.map((event) => event.value),
    id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
    hex = /^[a-f0-9]{64}$/;
  check(
    id.test(begin.lifetimeId) &&
      [begin, ready, launch, opened, startup].every(
        (value) =>
          value.lifetimeId === begin.lifetimeId &&
          value.bindingDigest === state.bindingDigest &&
          value.ownershipDigest === sha(JSON.stringify([])),
      ) &&
      [begin, ready, launch, startup].every(
        (value) => Array.isArray(value.projects) && value.projects.length === 0,
      ) &&
      state.events.every((event) => Number.isSafeInteger(event.at) && event.at > 0) &&
      [
        startup.packageManifestSha256,
        startup.nodeSha256,
        startup.workerSha256,
        startup.guardianSha256,
        begin.launchSetDigest,
      ].every((value) => hex.test(value)) &&
      [ready, launch].every((value) => value.launchSetDigest === begin.launchSetDigest) &&
      launch.rootId === "host-worker" &&
      launch.generation === 1 &&
      opened.generation === 1 &&
      startup.generation === 1 &&
      startup.schemaVersion === 1 &&
      Number.isInteger(startup.port) &&
      startup.port >= 1024 &&
      startup.port <= 65535 &&
      /^[A-Za-z0-9_-]{43}$/.test(startup.nonce) &&
      startup.guardianIdentity?.parentPid === startup.outerIdentity?.pid &&
      startup.workerIdentity?.parentPid === startup.guardianIdentity?.pid &&
      ["pid", "startTime", "bootId", "executable", "device", "inode"].every(
        (key) => ready.guardianIdentity?.[key] === startup.guardianIdentity?.[key],
      ) &&
      opened.workerPid === startup.workerIdentity?.pid &&
      startup.type === "ready" &&
      startup.phase === "open" &&
      hex.test(startup.configSha256) &&
      startup.packageManifestSha256 === begin.packageManifestSha256 &&
      startup.nodeSha256 === begin.nodeSha256 &&
      startup.workerSha256 === begin.workerSha256 &&
      startup.guardianSha256 === begin.guardianSha256 &&
      state.bindingDigest ===
        sha(
          JSON.stringify({
            schemaVersion: 1,
            configSha256: startup.configSha256,
            packageManifestSha256: startup.packageManifestSha256,
          }),
        ),
  );
  const observations = ["outerIdentity", "guardianIdentity", "workerIdentity"].map((name) => {
    const old = startup[name];
    check(
      Number.isSafeInteger(old?.pid) &&
        old.pid > 0 &&
        /^\d+$/.test(old.startTime) &&
        id.test(old.bootId) &&
        typeof old.executable === "string" &&
        old.executable.startsWith("/") &&
        /^\d+$/.test(old.device) &&
        /^\d+$/.test(old.inode),
    );
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      path = `/proc/${old.pid}/stat`,
      tick = (text) =>
        text
          .slice(text.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/)[19];
    check(id.test(boot));
    let first;
    try {
      first = readFileSync(path, "utf8");
    } catch (error) {
      check(["ENOENT", "ESRCH"].includes(error?.code));
    }
    if (first !== undefined) {
      const next = readFileSync(path, "utf8");
      check(tick(first) === tick(next) && /^\d+$/.test(tick(first)));
      const phase = (text) =>
        text
          .slice(text.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/)[0];
      check(
        boot !== old.bootId ||
          tick(first) !== old.startTime ||
          (["Z", "X"].includes(phase(first)) && phase(first) === phase(next)),
      );
    }
    return {
      name,
      identity: old,
      observed: "no_live_exact_identity_in_current_namespace",
    };
  });
  return {
    schemaVersion: 1,
    scope: "never_admitted_bootstrap_authorization_only",
    sourceJournalDigest: sourceDigest,
    lifetimeId: begin.lifetimeId,
    bindingDigest: state.bindingDigest,
    nextBindingDigest: bindingDigest,
    configSha256: startup.configSha256,
    workerIdentity: startup.workerIdentity,
    identityObservations: observations,
    nativeTreeExited: false,
    cleanupAuthorized: false,
  };
}
async function openJournal(
  directory,
  bindingDigest,
  prepareIdleLifetime,
  prepareBootstrapRetirement,
  prepareUnstartedRetirement,
  prepareUnusedEpochRetirement,
  prepareClosedEmptyLifetime,
) {
  check(resolve(directory) === directory && /^[a-f0-9]{64}$/.test(bindingDigest));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateFile(directory, true);
  const lock = openSync(
    join(directory, "guardian.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      closeSync(lock);
    }
  };
  try {
    const stat = fstatSync(lock);
    check(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077));
    execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock],
      timeout: 2000,
    });
    const path = join(directory, "lifetime.json"),
      keyPath = join(directory, "key");
    if (!existsSync(keyPath)) {
      check(!existsSync(path));
      const keyFd = openSync(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(keyFd, randomBytes(32));
        fsyncSync(keyFd);
      } finally {
        closeSync(keyFd);
      }
    }
    check(privateFile(keyPath).size === 32);
    const key = readFileSync(keyPath);
    const mac = (state) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
    let state = { schemaVersion: 1, bindingDigest, phase: "new", events: [], receipts: [] };
    if (existsSync(path)) {
      check(privateFile(path).size <= 2 * 1024 * 1024);
      const encoded = readFileSync(path),
        saved = JSON.parse(encoded);
      const expected = mac(saved.state);
      check(
        typeof saved.signature === "string" &&
          saved.signature.length === 64 &&
          timingSafeEqual(Buffer.from(saved.signature), Buffer.from(expected)),
      );
      check(saved.state.schemaVersion === 1 && saved.state.receipts.length < 32);
      const unusedEpoch = prepareUnusedEpochRetirement
        ? await prepareUnusedEpochRetirement({
            outerRaw: encoded,
            nextBindingDigest: bindingDigest,
          })
        : null;
      if (unusedEpoch) {
        check(
          unusedEpoch.hop.oldJournalDigests.lifetime === sha(encoded) &&
            unusedEpoch.hop.lifetimeId === saved.state.events[4].value.lifetimeId &&
            sha(readFileSync(path)) === sha(encoded) &&
            !existsSync(join(directory, "controller.json")),
        );
        const archive = join(directory, `lifetime-unused-${unusedEpoch.hop.lifetimeId}.json`);
        check(!existsSync(archive));
        renameSync(path, archive);
        const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else if (
        ["admissionAccepted", "indeterminate"].includes(saved.state.phase) &&
        prepareUnstartedRetirement
      ) {
        const proof = await prepareUnstartedRetirement({
          outerRaw: encoded,
          nextBindingDigest: bindingDigest,
        });
        check(
          proof.oldJournalDigests.lifetime === sha(encoded) &&
            proof.oldLifetimeId === saved.state.events[0].value.lifetimeId &&
            proof.newBuildId !== proof.oldBuildId &&
            !existsSync(join(directory, "controller.json")) &&
            sha(readFileSync(path)) === sha(encoded),
        );
        const archive = join(directory, `lifetime-unstarted-${proof.transferId}.json`);
        check(!existsSync(archive));
        renameSync(path, archive);
        const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else if (saved.state.phase === "startupReady" && prepareBootstrapRetirement) {
        check(
          !readdirSync(directory).some(
            (name) => name === "controller.json" || name.startsWith("controller-archive-"),
          ),
        );
        const digest = sha(encoded),
          currentProof = bootstrapRetirement(saved.state, bindingDigest, digest),
          pendingPath = join(directory, `bootstrap-pending-${digest}.json`);
        let proof = currentProof;
        if (existsSync(pendingPath)) {
          check(privateFile(pendingPath).size <= 32768);
          const prior = JSON.parse(readFileSync(pendingPath)),
            { nextBindingDigest: priorNext, ...priorSource } = prior.state ?? {},
            { nextBindingDigest: _currentNext, ...currentSource } = currentProof;
          check(
            typeof prior.signature === "string" &&
              prior.signature.length === 64 &&
              timingSafeEqual(Buffer.from(prior.signature), Buffer.from(mac(prior.state))) &&
              /^[a-f0-9]{64}$/.test(priorNext) &&
              priorNext !== saved.state.bindingDigest &&
              JSON.stringify(priorSource) === JSON.stringify(currentSource),
          );
          // This is the original retirement attempt, not authority for its
          // replacement build. Independently rechecking A above allows C to
          // finish B's interrupted archive without rewriting its signed facts.
          proof = prior.state;
        } else atomic(pendingPath, { state: proof, signature: mac(proof) });
        const facts = await prepareBootstrapRetirement(structuredClone(proof)),
          retirement = { ...proof, projectEvidence: facts },
          factPath = join(directory, `bootstrap-retirement-${digest}.json`),
          archivePath = join(directory, `lifetime-bootstrap-${digest}.json`);
        if (existsSync(factPath)) {
          privateFile(factPath);
          const prior = JSON.parse(readFileSync(factPath));
          check(
            typeof prior.signature === "string" &&
              prior.signature.length === 64 &&
              timingSafeEqual(Buffer.from(prior.signature), Buffer.from(mac(prior.state))),
          );
          check(JSON.stringify(prior.state) === JSON.stringify(retirement));
        } else atomic(factPath, { state: retirement, signature: mac(retirement) });
        check(
          !existsSync(join(directory, "controller.json")) && sha(readFileSync(path)) === digest,
        );
        check(!existsSync(archivePath));
        renameSync(path, archivePath);
        const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        // Retire unused authorization only. No ECHILD, native-tree exit or
        // physical writer/checkout cleanup authority is manufactured here.
      } else {
        if (saved.state.phase === "idleTreeExited") {
          const exited = saved.state.events.at(-1),
            prior = saved.state.receipts.at(-1);
          check(
            exited?.name === "idleTreeExited" && exited.value?.guardianExited === true && prior,
          );
          const { guardianExited: _ignored, ...preExit } = exited.value;
          check(JSON.stringify(preExit) === JSON.stringify(prior));
          saved.state.events.push({
            name: "idleClosed",
            value: { lifetimeId: prior.lifetimeId, receiptId: prior.receiptId },
            at: Date.now(),
          });
          saved.state.phase = "idleClosed";
          atomic(path, { state: saved.state, signature: mac(saved.state) });
        }
        if (saved.state.phase === "idleClosed") {
          const receipt = saved.state.events.at(-2),
            closed = saved.state.events.at(-1),
            prior = saved.state.receipts.at(-1);
          check(receipt?.value && prior);
          const { guardianExited: _ignored, ...preExit } = receipt.value;
          check(
            receipt?.name === "idleTreeExited" &&
              closed?.name === "idleClosed" &&
              receipt.value?.guardianExited === true &&
              receipt.value.finalWaitResult === "ECHILD" &&
              receipt.value.scope === "managed_native_tree_only" &&
              receipt.value.waitFlags === "__WALL" &&
              receipt.value.cleanupAuthorized === false &&
              receipt.value.projects?.length === 0 &&
              receipt.value.decisions?.length === 0 &&
              closed.value?.receiptId === receipt.value.receiptId &&
              closed.value?.lifetimeId === receipt.value.lifetimeId &&
              receipt.value.bindingDigest === saved.state.bindingDigest &&
              JSON.stringify(preExit) === JSON.stringify(prior) &&
              !existsSync(join(directory, "controller.json")) &&
              !saved.state.events.some((event) =>
                ["admissionIntent", "admissionAccepted"].includes(event.name),
              ),
          );
          // Keep the authenticated outer journal in place until inner idle state
          // is durably archived/reset. A crash retries the same receipt first.
          if (prepareIdleLifetime) await prepareIdleLifetime(structuredClone(receipt.value));
          const archive = join(directory, `lifetime-idle-${sha(readFileSync(path))}.json`);
          check(!existsSync(archive));
          renameSync(path, archive);
          const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            fsyncSync(dir);
          } finally {
            closeSync(dir);
          }
        } else if (
          saved.state.phase === "closed" &&
          saved.state.receipts.at(-1)?.projects?.length === 0 &&
          typeof prepareClosedEmptyLifetime === "function"
        ) {
          // Completed predecessors remain authenticated history. Only the
          // latest lifetime segment can authorize this empty closure.
          const events = saved.state.events.slice(
              saved.state.events.findLastIndex((event) => event.name === "begin"),
            ),
            exited = events.at(-2),
            closed = events.at(-1),
            receipt = exited?.value,
            prior = saved.state.receipts.at(-1),
            startup = events.find((event) => event.name === "startupReady")?.value;
          check(exited?.name === "treeExited" && closed?.name === "closed" && receipt && startup);
          const { guardianExited: _ignored, ...preExit } = receipt;
          check(
            JSON.stringify(events.map((event) => event.name)) ===
              JSON.stringify([
                "begin",
                "ready",
                "launchIntent",
                "open",
                "startupReady",
                "closing",
                "workerClosed",
                "receipt",
                "treeExited",
                "closed",
              ]) &&
              receipt.guardianExited === true &&
              receipt.finalWaitResult === "ECHILD" &&
              receipt.scope === "managed_native_tree_only" &&
              receipt.waitFlags === "__WALL" &&
              receipt.cleanupAuthorized === false &&
              receipt.projects.length === 0 &&
              receipt.decisions.length === 0 &&
              receipt.bindingDigest === saved.state.bindingDigest &&
              events[0].value.lifetimeId === receipt.lifetimeId &&
              events[0].value.bindingDigest === receipt.bindingDigest &&
              receipt.lifetimeId === startup.lifetimeId &&
              startup.phase === "open" &&
              startup.generation === 1 &&
              startup.projects?.length === 0 &&
              startup.bindingDigest === receipt.bindingDigest &&
              startup.workerIdentity?.pid === receipt.workerPid &&
              closed.value.receiptId === receipt.receiptId &&
              closed.value.lifetimeId === receipt.lifetimeId &&
              JSON.stringify(preExit) === JSON.stringify(prior) &&
              !events.some((event) =>
                ["admissionIntent", "admissionAccepted", "indeterminate"].includes(event.name),
              ),
          );
          check(
            (
              await prepareClosedEmptyLifetime({
                receipt: structuredClone(receipt),
                startup: structuredClone(startup),
              })
            )?.archived === true,
          );
          const archive = join(directory, `lifetime-empty-${sha(encoded)}.json`);
          check(!existsSync(archive));
          renameSync(path, archive);
          const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } else {
          check(
            saved.state.bindingDigest === bindingDigest &&
              ["closed", "treeExited"].includes(saved.state.phase),
          );
          state = saved.state;
        }
      }
    }
    const record = (name, value) => {
      check(!closed && state.events.length < 1024);
      state.events.push({ name, value, at: Date.now() });
      state.phase = name;
      if (name === "receipt") state.receipts.push(value);
      const encoded = { state, signature: mac(state) };
      check(Buffer.byteLength(JSON.stringify(encoded)) <= 2 * 1024 * 1024);
      atomic(path, encoded);
    };
    return { record, close, snapshot: () => structuredClone(state) };
  } catch (error) {
    close();
    throw error;
  }
}

// Artifact metadata is trusted only as part of the already verified immutable
// package. Each exact executable/script is rehashed here before any spawn.
export function verifyGuardianPackage(directory, expectedManifestSha256, workerName) {
  check(realpathSync(directory) === directory && /^[a-f0-9]{64}$/.test(expectedManifestSha256));
  check(typeof workerName === "string" && /^[a-z0-9-]+\.mjs$/.test(workerName));
  const bytes = readFileSync(join(directory, "package-manifest.json"));
  check(sha(bytes) === expectedManifestSha256 && bytes.length <= 65536);
  const manifest = JSON.parse(bytes),
    build = manifest.guardian;
  check(
    build?.schemaVersion === 1 &&
      build.platform === "linux" &&
      build.architecture === "x64" &&
      /^[a-f0-9]{64}$/.test(build.sourceSha256) &&
      /^[a-f0-9]{64}$/.test(build.recipeSha256) &&
      build.elfSha256 === manifest.files?.["codex-native-guardian"],
  );
  check(manifest.files?.[workerName] && Object.keys(manifest.files).length <= 128);
  for (const name of Object.keys(manifest.files)) {
    check(
      /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-z0-9]+$/.test(name) ||
        name === "codex-native-guardian",
    );
    const path = join(directory, name),
      stat = lstatSync(path);
    check(
      realpathSync(path) === path &&
        stat.isFile() &&
        [0, process.getuid()].includes(stat.uid) &&
        !(stat.mode & 0o022) &&
        /^[a-f0-9]{64}$/.test(manifest.files[name]) &&
        sha(readFileSync(path)) === manifest.files[name],
    );
  }
  return {
    executable: join(directory, "codex-native-guardian"),
    sha256: build.elfSha256,
    worker: join(directory, workerName),
    workerSha256: manifest.files[workerName],
  };
}

export async function openGuardedHost(options) {
  check(
    typeof options.authorizeAdmission === "function" &&
      typeof options.authorizeDrain === "function",
  );
  const files = verifyGuardianPackage(
    options.packageDirectory,
    options.packageManifestSha256,
    options.workerName,
  );
  const startup =
    options.startup === undefined ? undefined : guardianStartChallenge(options.startup);
  if (startup)
    check(
      startup.packageManifestSha256 === options.packageManifestSha256 &&
        startup.nodeSha256 === options.nodeSha256,
    );
  const journal = await openJournal(
    options.stateDirectory,
    options.bindingDigest,
    options.prepareIdleLifetime,
    options.prepareBootstrapRetirement,
    options.prepareUnstartedRetirement,
    options.prepareUnusedEpochRetirement,
    options.prepareClosedEmptyLifetime,
  );
  const recovered = journal.snapshot();
  if (recovered.phase === "treeExited") {
    try {
      const exited = recovered.events.at(-1),
        prior = recovered.receipts.at(-1);
      check(exited?.name === "treeExited" && exited.value?.guardianExited === true && prior);
      const { guardianExited: _ignored, ...preExit } = exited.value;
      check(JSON.stringify(preExit) === JSON.stringify(prior));
      check(typeof options.recoverTreeReceipt === "function");
      await options.recoverTreeReceipt(structuredClone(exited.value));
      if (options.postTreeClosed) await options.postTreeClosed(structuredClone(exited.value));
      journal.record("closed", {
        lifetimeId: exited.value.lifetimeId,
        receiptId: exited.value.receiptId,
      });
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  const closedState = journal.snapshot();
  if (closedState.phase === "closed" && options.prepareNextLifetime) {
    try {
      const exited = [...closedState.events].reverse().find((event) => event.name === "treeExited");
      check(exited?.value?.guardianExited === true);
      await options.prepareNextLifetime(structuredClone(exited.value));
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  let guardian,
    wire,
    phase = "starting",
    workerPid,
    hello = false,
    startupReady = false,
    workerIdentity,
    closedBarrier,
    acceptedReceipt,
    rolloverEligible = false,
    idleDrain = false;
  let serial = Promise.resolve();
  let markLaunch, markReady;
  const launched = new Promise((resolve) => {
    markLaunch = resolve;
  });
  const enqueue = (operation) => {
    const value = serial.then(operation);
    serial = value.catch(() => {});
    return value;
  };
  const unavailable = () => {
    if (["closed", "draining", "indeterminate"].includes(phase)) return;
    phase = "indeterminate";
    void guardian?.abort();
  };
  const runtimeBinding = () => {
    const state = guardian.state;
    return {
      lifetimeId: state.lifetimeId,
      bindingDigest: state.bindingDigest,
      ownershipDigest: state.ownershipDigest,
      generation: state.generation,
    };
  };
  const startupAttestation = () => {
    check(startup && startupReady && phase === "open" && guardian.state.phase === "open");
    const outer = processIdentity(process.pid),
      worker = processIdentity(workerPid);
    check(
      JSON.stringify(worker) === JSON.stringify(workerIdentity) &&
        sha(readFileSync(outer.executable)) === options.nodeSha256 &&
        sha(readFileSync(worker.executable)) === options.nodeSha256,
    );
    return {
      ...startup,
      type: "ready",
      phase: "open",
      ...runtimeBinding(),
      workerSha256: files.workerSha256,
      guardianSha256: files.sha256,
      projects: guardian.state.projects,
      outerIdentity: guardianKernelIdentity(outer, processParentPid(process.pid)),
      guardianIdentity: guardianKernelIdentity(guardian.state.guardianIdentity, process.pid),
      workerIdentity: guardianKernelIdentity(worker, guardian.state.guardianIdentity.pid),
    };
  };
  try {
    guardian = await openNativeGuardian({
      executable: files.executable,
      sha256: files.sha256,
      bindingDigest: options.bindingDigest,
      projects: [],
      roots: [
        {
          id: "host-worker",
          role: "host",
          executable: options.nodeExecutable,
          sha256: options.nodeSha256,
          cwd: options.workerCwd,
          args: [files.worker],
          env: options.workerEnvironment ?? {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            HIVE_WORKSPACE_PROFILE: "software",
          },
          workerChannel: true,
        },
      ],
      prepareDrain: options.beginDrain
        ? () => (idleDrain ? undefined : boundedAuthority(() => options.beginDrain()))
        : undefined,
      authorizeDrain: async (binding, barrier) => {
        let decisions;
        if (idleDrain) {
          check(binding.projects.length === 0 && barrier.snapshots.length === 0);
          decisions = [];
        } else {
          decisions = await boundedAuthority(() =>
            options.authorizeDrain(structuredClone(binding), structuredClone(barrier)),
          );
        }
        check(phase === "draining");
        const finished = await wire.request("finishClose", { barrierId: barrier.barrierId }, 10000);
        check(finished?.closed === true && finished.barrierId === barrier.barrierId);
        return decisions;
      },
      journal: {
        begin: (value) =>
          journal.record("begin", {
            ...value,
            packageManifestSha256: options.packageManifestSha256,
            workerSha256: files.workerSha256,
            nodeSha256: options.nodeSha256,
          }),
        ready: (value) => journal.record("ready", value),
        launchIntent: (value) => journal.record("launchIntent", value),
        admissionIntent: (value) => journal.record("admissionIntent", value),
        admissionAccepted: (value) => journal.record("admissionAccepted", value),
        async closeIntent(value) {
          check(phase === "open" && hello);
          phase = "closing";
          const barrier = {
            ...runtimeBinding(),
            barrierId: randomUUID(),
            projects: value.projects,
          };
          journal.record("closing", { ...value, barrier });
          const ack = await wire.request("closeAdmission", barrier, 10000);
          check(
            ack?.closed === true &&
              ack.lifetimeId === barrier.lifetimeId &&
              ack.generation === barrier.generation &&
              ack.ownershipDigest === barrier.ownershipDigest &&
              ack.barrierId === barrier.barrierId,
          );
          journal.record("workerClosed", ack);
          closedBarrier = {
            lifetimeId: ack.lifetimeId,
            generation: ack.generation,
            ownershipDigest: ack.ownershipDigest,
            barrierId: ack.barrierId,
            closed: true,
          };
          phase = "draining";
          return { ...closedBarrier, snapshots: ack.snapshots };
        },
        acceptReceipt: (value) => {
          check(phase === "draining" && closedBarrier?.closed === true);
          acceptedReceipt = {
            ...value,
            workerBarrier: closedBarrier,
            workerPid,
            packageManifestSha256: options.packageManifestSha256,
            workerSha256: files.workerSha256,
            nodeSha256: options.nodeSha256,
          };
          journal.record("receipt", acceptedReceipt);
        },
        indeterminate: (value) => {
          phase = "indeterminate";
          journal.record("indeterminate", value);
        },
      },
    });
    wire = guardianWire(
      guardian.workerChannel("host-worker"),
      {
        async hello(value) {
          await launched;
          check(
            !hello &&
              phase === "starting" &&
              Object.keys(value ?? {})
                .sort()
                .join() === (startup ? "pid,startup" : "pid") &&
              value.pid === workerPid,
          );
          if (startup) {
            const actual = guardianStartup(value.startup);
            check(actual.configSha256 === startup.configSha256 && actual.port === startup.port);
          }
          hello = true;
          phase = "open";
          journal.record("open", { ...runtimeBinding(), workerPid });
          if (!startup) markReady?.();
          return runtimeBinding();
        },
        ready: (value) =>
          enqueue(async () => {
            check(startup && hello && phase === "open" && !startupReady);
            const actual = guardianStartup(value);
            check(actual.configSha256 === startup.configSha256 && actual.port === startup.port);
            workerIdentity = processIdentity(workerPid);
            check(processParentPid(workerPid) === guardian.state.guardianIdentity.pid);
            startupReady = true;
            journal.record("startupReady", startupAttestation());
            markReady?.();
            return { ready: true, ...actual };
          }),
        admit: (value) =>
          enqueue(async () => {
            check(phase === "open" && hello);
            const project = guardianProject(value),
              approved = guardianProject(
                await boundedAuthority(
                  () => options.authorizeAdmission(structuredClone(project)),
                  GUARDIAN_ADMISSION_BUDGET.outerMs,
                ),
              );
            check(
              phase === "open" &&
                approved.projectId === project.projectId &&
                approved.bindingDigest === project.bindingDigest,
            );
            await guardian.admitProject(project);
            check(phase === "open");
            return runtimeBinding();
          }),
        fence: (value) =>
          enqueue(async () => {
            check(phase === "open" && hello);
            const project = guardianProject(value);
            check(
              guardian.state.projects.some(
                (entry) =>
                  entry.projectId === project.projectId &&
                  entry.bindingDigest === project.bindingDigest,
              ),
            );
            const approved = guardianProject(
              await boundedAuthority(
                () => options.authorizeAdmission(structuredClone(project)),
                GUARDIAN_ADMISSION_BUDGET.outerMs,
              ),
            );
            check(
              phase === "open" &&
                approved.projectId === project.projectId &&
                approved.bindingDigest === project.bindingDigest,
            );
            return runtimeBinding();
          }),
        identity: (value) =>
          enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                Object.keys(value ?? {}).join() === "nonce" &&
                /^[a-f0-9]{64}$/.test(value.nonce) &&
                typeof options.controllerIdentity === "function",
            );
            const result = await boundedAuthority(
              () => options.controllerIdentity(value.nonce),
              25000,
            );
            check(phase === "open");
            return result;
          }),
        requestDrain: (value) =>
          enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                (Object.keys(value ?? {}).length === 0 ||
                  (Object.keys(value).join() === "maintenanceId" &&
                    typeof value.maintenanceId === "string" &&
                    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.maintenanceId))) &&
                typeof options.requestDrain === "function",
            );
            const ready = await options.requestDrain(value.maintenanceId);
            check(phase === "open" && typeof ready === "boolean");
            return { ready };
          }),
        accountMaintenance: async (value) => {
          const result = await enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                Object.keys(value ?? {}).join() === "grant" &&
                typeof value.grant === "string" &&
                value.grant.length >= 100 &&
                value.grant.length <= 16384 &&
                typeof options.accountMaintenance === "function",
            );
            return boundedAuthority(() => options.accountMaintenance(value.grant), 25000);
          });
          check(phase === "open");
          // Do not retain the outer admission queue across a worker resume: the
          // existing prepare/checkout/metadata RPCs need that same queue.
          if (result?.action === "pause" || result?.action === "resume") {
            check(
              typeof result.maintenanceId === "string" &&
                /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.maintenanceId),
            );
            const started = await wire.request(
              result.action === "pause" ? "beginAccountMaintenance" : "resumeAccountMaintenance",
              result.action === "pause"
                ? { maintenanceId: result.maintenanceId }
                : { scope: result.scope },
              25000,
            );
            check(started?.accepted === true && phase === "open");
            return { accepted: true };
          }
          return result;
        },
        maintenanceResumeReady: (value) =>
          enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                Object.keys(value ?? {}).length === 0 &&
                typeof options.maintenanceResumeReady === "function",
            );
            const result = await boundedAuthority(() => options.maintenanceResumeReady());
            check(phase === "open" && result?.ready === true);
            return result;
          }),
        recoverEmptyClose: (value) =>
          enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                Object.keys(value ?? {}).join() === "grant" &&
                typeof value.grant === "string" &&
                typeof options.recoverEmptyClose === "function",
            );
            const accepted = await options.recoverEmptyClose(value.grant);
            check(phase === "open" && accepted === true);
            return { accepted: true };
          }),
        bootstrap: (value) =>
          enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                Object.keys(value ?? {}).join() === "grant" &&
                typeof value.grant === "string" &&
                value.grant.length >= 100 &&
                value.grant.length <= 16384 &&
                typeof options.controllerBootstrap === "function",
            );
            const result = await boundedAuthority(
              () => options.controllerBootstrap(value.grant),
              25000,
            );
            check(phase === "open");
            return result;
          }),
        currentMetadata: (value) =>
          enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                Object.keys(value ?? {}).join() === "projectId" &&
                guardian.state.projects.some((p) => p.projectId === value.projectId) &&
                typeof options.controllerMetadata === "function",
            );
            const result = await boundedAuthority(
              () => options.controllerMetadata(value.projectId),
              GUARDIAN_ADMISSION_BUDGET.outerMs,
            );
            check(phase === "open");
            return result;
          }),
        ...Object.fromEntries(
          ["applyReserve", "applyVerify", "applyCommit"].map((action) => [
            action,
            (value) =>
              enqueue(async () => {
                const request = guardianApplicationRequest(action, value),
                  callback = options[`controller${action[0].toUpperCase()}${action.slice(1)}`];
                check(
                  phase === "open" &&
                    hello &&
                    startupReady &&
                    guardian.state.projects.some((p) => p.projectId === request.projectId) &&
                    typeof callback === "function",
                );
                const result = await boundedAuthority(() => callback(request));
                check(phase === "open");
                return result;
              }),
          ]),
        ),
        metadataAuthority: (value) => {
          const metadataDeadline = Date.now() + GUARDIAN_ADMISSION_BUDGET.outerMs;
          return enqueue(async () => {
            check(
              phase === "open" &&
                hello &&
                startupReady &&
                (Object.keys(value ?? {})
                  .sort()
                  .join() === "projectIds" ||
                  (Object.keys(value ?? {})
                    .sort()
                    .join() === "authorityVersion,projectIds" &&
                    value.authorityVersion === 1)) &&
                Date.now() < metadataDeadline &&
                Array.isArray(value.projectIds) &&
                value.projectIds.length > 0 &&
                value.projectIds.length <= 32 &&
                new Set(value.projectIds).size === value.projectIds.length &&
                value.projectIds.length === guardian.state.projects.length &&
                value.projectIds.every((id) =>
                  guardian.state.projects.some((p) => p.projectId === id),
                ) &&
                typeof options.metadataAuthority === "function",
            );
            const result = await boundedAuthority(
              () =>
                options.metadataAuthority(
                  value.projectIds.map((projectId) => ({ projectId })),
                  { authorityVersion: value.authorityVersion },
                ),
              Math.max(1, metadataDeadline - Date.now()),
            );
            check(phase === "open" && Date.now() < metadataDeadline);
            return result;
          });
        },
      },
      unavailable,
    );
    const root = await guardian.launch("host-worker");
    workerPid = root.pid;
    markLaunch();
    if (!(startup ? startupReady : hello))
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("guardian_worker_start_timeout")), 5000);
        markReady = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    check(phase === "open");
    return {
      get state() {
        return structuredClone({ phase, guardian: guardian.state, workerPid, rolloverEligible });
      },
      startupAttestation,
      idleShutdown: () =>
        enqueue(async () => {
          check(
            phase === "open" &&
              guardian.state.projects.length === 0 &&
              typeof options.canIdleShutdown === "function" &&
              (await options.canIdleShutdown()),
          );
          idleDrain = true;
          const receipt = await guardian.drain();
          check(acceptedReceipt?.projects.length === 0 && receipt.projects.length === 0);
          acceptedReceipt = { ...acceptedReceipt, guardianExited: true };
          journal.record("idleTreeExited", acceptedReceipt);
          journal.record("idleClosed", {
            lifetimeId: receipt.lifetimeId,
            receiptId: receipt.receiptId,
          });
          phase = "closed";
          wire.close();
          journal.close();
          return structuredClone(acceptedReceipt);
        }),
      drain: () =>
        enqueue(async () => {
          check(phase === "open");
          const receipt = await guardian.drain();
          // drain() returns only after the native guardian acknowledges ECHILD
          // and exits successfully. A journaled pre-exit receipt is insufficient.
          acceptedReceipt = { ...acceptedReceipt, guardianExited: true };
          journal.record("treeExited", acceptedReceipt);
          try {
            if (options.acceptTreeReceipt)
              await options.acceptTreeReceipt(structuredClone(acceptedReceipt));
            if (options.postTreeClosed)
              rolloverEligible =
                (await options.postTreeClosed(structuredClone(acceptedReceipt)))?.archived === true;
          } catch (error) {
            phase = "indeterminate";
            wire.close();
            journal.close();
            throw error;
          }
          journal.record("closed", {
            lifetimeId: receipt.lifetimeId,
            receiptId: receipt.receiptId,
          });
          phase = "closed";
          wire.close();
          journal.close();
          return structuredClone(acceptedReceipt);
        }),
      async abort() {
        phase = "indeterminate";
        wire.close();
        const result = await guardian.abort();
        journal.close();
        return result;
      },
    };
  } catch (error) {
    markLaunch();
    wire?.close();
    if (guardian) await guardian.abort();
    journal.close();
    throw error;
  }
}
