#!/usr/bin/env node
// Fixed installer entry. No supplied worker path, execution grant or drain grant.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openGuardianController } from "./codex-guardian-controller.mjs";
import { readGuardianStart } from "./codex-guardian-startup.mjs";
import { openGuardedHost, verifyGuardianPackage } from "./codex-host-guardian.mjs";
import { readInstalledHostStartup, validateHostConfig } from "./codex-workspace-host.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const check = (value) => {
  if (!value) throw new Error("installed_guardian_startup_rejected");
};
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
    const authority = openGuardianController({
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
    host = await openGuardedHost({
      packageDirectory,
      packageManifestSha256: challenge.packageManifestSha256,
      workerName: "codex-workspace-host-worker.mjs",
      nodeExecutable,
      nodeSha256: challenge.nodeSha256,
      workerCwd: home,
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
      authorizeAdmission: authority.authorizeAdmission,
      authorizeDrain: authority.authorizeDrain,
      controllerIdentity: authority.identity,
      controllerBootstrap: authority.bootstrap,
      controllerMetadata: authority.currentMetadata,
      controllerApplyReserve: authority.applyReserve,
      controllerApplyVerify: authority.applyVerify,
      controllerApplyCommit: authority.applyCommit,
      metadataAuthority: authority.metadataAuthority,
    });
    await channel.ready(host.startupAttestation());
    return host;
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
        void host.abort().then(() => {
          process.exitCode = 1;
        });
      });
  } catch {
    process.stderr.write("Pinned guarded host startup rejected.\n");
    process.exitCode = 1;
  }
}
