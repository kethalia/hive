#!/usr/bin/env node
// Fixed installer entry. No supplied worker path, execution grant or drain grant.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openGuardianController } from "./codex-guardian-controller.mjs";
import { readGuardianStart } from "./codex-guardian-startup.mjs";
import { openGuardedHost, verifyGuardianPackage } from "./codex-host-guardian.mjs";
import {
  archiveBootstrapProjectState,
  archiveIdleProjectState,
} from "./codex-project-controller.mjs";
import { readInstalledHostStartup, validateHostConfig } from "./codex-workspace-host.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const check = (value) => {
  if (!value) throw new Error("installed_guardian_startup_rejected");
};
// The shared home mount may be group writable or provisioner owned. The installer
// already creates this private, user-owned package root before starting the host.
export function installedWorkerCwd(home) {
  const path = join(home, ".local/share/hive/codex-host"),
    stat = lstatSync(path);
  check(
    realpathSync(path) === path &&
      stat.isDirectory() &&
      stat.uid === process.getuid() &&
      !(stat.mode & 0o077),
  );
  return path;
}
export function readBootstrapConfigHistory(home, digest, current) {
  check(/^[a-f0-9]{64}$/.test(digest));
  const history = join(home, ".local/state/hive/codex-host-install/config-history"),
    directory = lstatSync(history),
    path = join(history, `${digest}.json`);
  check(
    realpathSync(history) === history &&
      directory.isDirectory() &&
      directory.uid === process.getuid() &&
      !(directory.mode & 0o077),
  );
  check(realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const s = fstatSync(fd);
    check(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === process.getuid() &&
        !(s.mode & 0o077) &&
        s.size <= 16384,
    );
    raw = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  check(raw.length <= 16384 && sha(raw) === digest);
  const old = validateHostConfig(JSON.parse(raw));
  check(
    ["ownerId", "workspaceId", "templateId", "hiveUserId", "coderOrigin"].every(
      (key) => old.binding[key] === current.binding[key],
    ) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(old.binding.buildId) &&
      old.binding.buildId !== current.binding.buildId &&
      old.hiveOrigin === current.hiveOrigin &&
      old.issuerKeyId === current.issuerKeyId &&
      old.issuerPublicKeyPem === current.issuerPublicKeyPem &&
      old.guardianEnabled === true &&
      old.nativeIsolationEnabled === true,
  );
  return old;
}
/** Serializes lifetime replacement; uncertain drain or restart never opens a second worker. */
export function createGuardedRollover(launch) {
  let current,
    pending = false,
    held = false,
    stopped = false;
  return {
    async start() {
      check(!current && !held);
      current = await launch(true);
      return current.host;
    },
    async trigger(expected) {
      if (pending || held || stopped || current?.host !== expected) return;
      pending = true;
      try {
        const receipt = await expected.drain();
        if (stopped) return;
        if (!expected.state.rolloverEligible) {
          held = true;
          return;
        }
        await current.authority.archiveClosedController(receipt);
        if (stopped) return;
        current = await launch(false);
        if (stopped) await current.host.abort();
      } catch {
        held = true;
      } finally {
        pending = false;
      }
    },
    async abort() {
      stopped = true;
      if (current) return current.host.abort();
    },
    async shutdown() {
      stopped = true;
      if (!current) return;
      try {
        await current.host.idleShutdown();
        return true;
      } catch {
        await current.host.abort();
        return false;
      }
    },
    get state() {
      return { held, pending, host: current?.host.state };
    },
  };
}
export async function startInstalledGuardedHost() {
  const channel = await readGuardianStart();
  let host;
  try {
    check(process.env.HIVE_WORKSPACE_PROFILE === "software");
    const { config: raw, configSha256 } = readInstalledHostStartup();
    const config = validateHostConfig(raw),
      challenge = channel.challenge;
    check(
      config.guardianEnabled === true &&
        config.nativeIsolationEnabled === true &&
        configSha256 === challenge.configSha256 &&
        config.port === challenge.port,
    );
    const packageDirectory = dirname(fileURLToPath(import.meta.url)),
      nodeExecutable = realpathSync(process.execPath),
      home = userInfo().homedir;
    check(
      sha(readFileSync(nodeExecutable)) === challenge.nodeSha256 &&
        sha(readFileSync(join(packageDirectory, "package-manifest.json"))) ===
          challenge.packageManifestSha256,
    );
    const workerEnvironment = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HIVE_WORKSPACE_PROFILE: "software",
    };
    for (const key of ["CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE", "CODER_AGENT_URL"])
      if (process.env[key]) workerEnvironment[key] = process.env[key];
    const files = verifyGuardianPackage(
      packageDirectory,
      challenge.packageManifestSha256,
      "codex-workspace-host-worker.mjs",
    );
    let authority;
    const newAuthority = () =>
      openGuardianController({
        config,
        configSha256,
        home,
        stateDirectory: join(home, ".local/state/hive/codex-host-guardian"),
        packageManifestSha256: challenge.packageManifestSha256,
        guardianElfSha256: files.sha256,
        nodeSha256: challenge.nodeSha256,
        startupAttestation: () => {
          check(host);
          return host.startupAttestation();
        },
      });
    const launch = async (recoverPrevious) => {
      authority = newAuthority();
      host = await openGuardedHost({
        packageDirectory,
        packageManifestSha256: challenge.packageManifestSha256,
        workerName: "codex-workspace-host-worker.mjs",
        nodeExecutable,
        nodeSha256: challenge.nodeSha256,
        workerCwd: installedWorkerCwd(home),
        workerEnvironment,
        stateDirectory: join(home, ".local/state/hive/codex-host-guardian"),
        bindingDigest: sha(
          JSON.stringify({
            schemaVersion: 1,
            configSha256,
            packageManifestSha256: challenge.packageManifestSha256,
          }),
        ),
        startup: challenge,
        authorizeAdmission: (...args) => authority.authorizeAdmission(...args),
        authorizeDrain: (...args) => authority.authorizeDrain(...args),
        canIdleShutdown: () => authority.canIdleShutdown(),
        beginDrain: (...args) => authority.beginDrain(...args),
        acceptTreeReceipt: (...args) => authority.acceptTreeReceipt(...args),
        recoverTreeReceipt: (...args) => authority.recoverTreeReceipt(...args),
        postTreeClosed: (...args) => authority.postTreeClosed(...args),
        prepareIdleLifetime: (receipt) =>
          archiveIdleProjectState(
            {
              stateDirectory: join(home, ".local/state/hive/codex-project-controller"),
              ownerId: config.binding.ownerId,
              workspaceId: config.binding.workspaceId,
            },
            receipt,
          ),
        prepareBootstrapRetirement: (proof) => {
          readBootstrapConfigHistory(home, proof.configSha256, config);
          return archiveBootstrapProjectState(
            {
              stateDirectory: join(home, ".local/state/hive/codex-project-controller"),
              guardianStateDirectory: join(home, ".local/state/hive/codex-host-guardian"),
              ownerId: config.binding.ownerId,
              workspaceId: config.binding.workspaceId,
              templateId: config.binding.templateId,
              buildId: config.binding.buildId,
            },
            proof,
          );
        },
        prepareNextLifetime: recoverPrevious
          ? async (receipt) => {
              await authority.archiveClosedController(receipt);
              authority = newAuthority();
            }
          : undefined,
        requestDrain: async (maintenanceId) => {
          let ready = false;
          try {
            ready = await authority.drainReady(maintenanceId);
          } catch {
            return false;
          }
          if (ready)
            setTimeout(() => {
              void rollover.trigger(host);
            }, 50);
          return ready;
        },
        accountMaintenance: (grant) => authority.requestAccountMaintenance(grant),
        maintenanceResumeReady: () => authority.maintenanceResumeReady(),
        recoverEmptyClose: async (grant) => {
          await authority.requestExpiredEmptyDrain(grant);
          setTimeout(() => {
            void rollover.trigger(host);
          }, 50);
          return true;
        },
        controllerIdentity: (...args) => authority.identity(...args),
        controllerBootstrap: (...args) => authority.bootstrap(...args),
        controllerMetadata: (...args) => authority.currentMetadata(...args),
        controllerApplyReserve: (...args) => authority.applyReserve(...args),
        controllerApplyVerify: (...args) => authority.applyVerify(...args),
        controllerApplyCommit: (...args) => authority.applyCommit(...args),
        metadataAuthority: (...args) => authority.metadataAuthority(...args),
      });
      return { host, authority };
    };
    const rollover = createGuardedRollover(launch);
    await rollover.start();
    await channel.ready(host.startupAttestation());
    return {
      abort: () => rollover.abort(),
      shutdown: () => rollover.shutdown(),
      get state() {
        return rollover.state;
      },
    };
  } catch (error) {
    if (host) await host.abort();
    channel.close();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 2);
    const host = await startInstalledGuardedHost();
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void host.shutdown().then((idleClosed) => {
          process.exitCode = idleClosed ? 0 : 1;
        });
      });
  } catch {
    process.stderr.write("Pinned guarded host startup rejected.\n");
    process.exitCode = 1;
  }
}
