#!/usr/bin/env node
// Software profile opt-in only. Fixed installed configuration; no startup hook.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGuardianOwnerHandler } from "./codex-guardian-worker.mjs";
import { createHostRegistration } from "./codex-host-registration.mjs";
import { createProjectController } from "./codex-project-controller.mjs";
import { createProjectDiscovery, startDiscoveryGateway } from "./codex-project-discovery.mjs";
import { startProjectGateway } from "./codex-project-gateway.mjs";
import { openSupervisor } from "./codex-project-supervisor.mjs";
import { createDeliveryManagerAdapter } from "./delivery-manager-adapter.mjs";

const check = (v) => {
  if (!v) throw new Error("host_configuration_or_runtime_rejected");
};
const hash = (v) => createHash("sha256").update(v).digest("hex");
const pin = "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5";
export const runtimeRelative =
  ".local/share/hive/codex-runtime/0.165.0-linux-x64-c06a67fd8ac76508/vendor/x86_64-unknown-linux-musl";
function privatePath(path, directory = false) {
  check(realpathSync(path) === path);
  const s = lstatSync(path);
  check(
    s.uid === process.getuid() && !(s.mode & 0o077) && (directory ? s.isDirectory() : s.isFile()),
  );
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privatePath(path, true);
  return path;
}
export function validateHostConfig(value) {
  const keys = [
    "schemaVersion",
    "enabled",
    "profile",
    "binding",
    "hiveOrigin",
    "issuerPublicKeyPem",
    "issuerKeyId",
    "port",
    "model",
    "effort",
    "managerEnabled",
  ];
  check(
    value &&
      [keys.length, keys.length + 1, keys.length + 2].includes(Object.keys(value).length) &&
      Object.keys(value).every(
        (k) => keys.includes(k) || ["nativeIsolationEnabled", "guardianEnabled"].includes(k),
      ) &&
      value.schemaVersion === 1 &&
      value.enabled === true &&
      value.profile === "software" &&
      typeof value.managerEnabled === "boolean" &&
      (value.nativeIsolationEnabled === undefined ||
        typeof value.nativeIsolationEnabled === "boolean") &&
      (value.guardianEnabled === undefined || typeof value.guardianEnabled === "boolean") &&
      (!value.guardianEnabled || value.nativeIsolationEnabled === true) &&
      (!value.managerEnabled || value.nativeIsolationEnabled === true),
  );
  check(
    Number.isInteger(value.port) &&
      value.port >= 1024 &&
      value.port <= 65535 &&
      typeof value.model === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value.model) &&
      ["low", "medium", "high", "xhigh", "max", "ultra"].includes(value.effort),
  );
  // createProjectDiscovery independently validates all exact binding and key fields.
  return structuredClone(value);
}
function verifyRuntime(home) {
  const root = join(home, runtimeRelative);
  privatePath(join(home, ".local/share/hive/codex-runtime"), true);
  const pins = {
    "bin/codex": pin,
    "bin/codex-code-mode-host": "522935d4392ec9674fab60b239b5495992c6a93e4deb65113a216b6f5451ccd4",
    "codex-resources/bwrap": "755c8d6a9b893905a4aabab058bd6c02c453e5e8653adb84fc08e570607f3f36",
    "codex-path/rg": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
  };
  for (const [name, digest] of Object.entries(pins)) {
    const p = join(root, name);
    check(realpathSync(p) === p);
    const stat = lstatSync(p);
    check(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022) &&
        hash(readFileSync(p)) === digest,
    );
  }
  return join(root, "bin/codex");
}
function installedFiles(directory) {
  const manifestPath = join(directory, "package-manifest.json");
  check(realpathSync(manifestPath) === manifestPath);
  const s = lstatSync(manifestPath);
  check(s.isFile() && s.uid === process.getuid() && !(s.mode & 0o022) && s.size <= 32768);
  const manifest = JSON.parse(readFileSync(manifestPath));
  check(
    manifest.schemaVersion === 1 &&
      manifest.wsVersion === "8.21.3" &&
      manifest.nativeVersion === "0.165.0",
  );
  const required = [
    "managed-projects.py",
    "github-projects.py",
    "codex-project-terminal.py",
    "codex-project-lease.py",
    "vendor/ws.mjs",
  ];
  for (const name of required) {
    const file = join(directory, name);
    check(realpathSync(file) === file && hash(readFileSync(file)) === manifest.files[name]);
    const st = lstatSync(file);
    check(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o022));
  }
  return manifest.files;
}
function managedRunner(
  helperPath,
  helperHash,
  timeoutMs = 120000,
  agentAuth = true,
  assertExecution = () => {},
) {
  return (request) =>
    new Promise((resolve, reject) => {
      assertExecution();
      check(hash(readFileSync(helperPath)) === helperHash);
      const env = Object.fromEntries(
        [
          "PATH",
          "HOME",
          "USER",
          "LANG",
          ...(agentAuth ? ["CODER_AGENT_TOKEN", "CODER_AGENT_TOKEN_FILE", "CODER_AGENT_URL"] : []),
        ]
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]]),
      );
      const child = spawn("/usr/bin/python3", [helperPath], {
        env,
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      let size = 0,
        done = false;
      const chunks = [];
      const fail = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        reject(new Error("checkout_unavailable"));
      };
      const timer = setTimeout(fail, timeoutMs);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 65536) return fail();
        chunks.push(chunk);
      });
      child.on("close", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          assertExecution();
          const value = JSON.parse(Buffer.concat(chunks));
          if (value.ok === true) resolve(value.data);
          else if (
            request.operation === "inspect" &&
            ["managed_project_missing", "project_not_found"].includes(value.error)
          )
            resolve(null);
          else
            reject(
              new Error(
                value.error === "repository_account_changed"
                  ? "github_auth_required"
                  : value.error === "checkout_writer_busy"
                    ? "checkout_busy"
                    : "checkout_unavailable",
              ),
            );
        } catch {
          reject(new Error("checkout_unavailable"));
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
}
export async function startWorkspaceHost(raw, { guardian } = {}) {
  check(
    process.env.HIVE_WORKSPACE_PROFILE === "software" &&
      Number(process.versions.node.split(".")[0]) >= 24,
  );
  const config = validateHostConfig(raw),
    home = userInfo().homedir,
    directory = dirname(fileURLToPath(import.meta.url));
  check(Boolean(config.guardianEnabled) === Boolean(guardian));
  const pins = installedFiles(directory),
    executable = verifyRuntime(home);
  const controllerDirectory = privateDirectory(
    join(home, ".local/state/hive/codex-project-controller"),
  );
  const discoveryDirectory = privateDirectory(
    join(home, ".local/state/hive/codex-project-discovery"),
  );
  const bridgeDirectory = privateDirectory(join(home, ".local/state/hive/codex-session-bridge"));
  const executionAuthority = guardian
    ? {
        assert: () => controller.assertRuntimeExecution(),
        fence: () => controller.fenceRuntimeExecution(),
      }
    : undefined;
  const managed = managedRunner(
    join(directory, "managed-projects.py"),
    pins["managed-projects.py"],
    120000,
    true,
    () => executionAuthority?.assert(),
  );
  const renew = managedRunner(
    join(directory, "codex-project-lease.py"),
    pins["codex-project-lease.py"],
    5000,
    false,
    () => executionAuthority?.assert(),
  );
  let gateway,
    discovery,
    supervisor,
    registration,
    closed = false,
    admissionClosed = false;
  const controller = createProjectController(
    {
      stateDirectory: controllerDirectory,
      ownerId: config.binding.ownerId,
      workspaceId: config.binding.workspaceId,
      model: config.model,
      effort: config.effort,
    },
    {
      ...(guardian ? { guardian, guardianBuildId: config.binding.buildId } : {}),
      resolveRepository: (request) => discovery.resolveRepository(request),
      renewLease: (projectId) => renew({ schemaVersion: 1, projectId }),
      inspectCheckout: (repositoryId) =>
        managed({ schemaVersion: 1, operation: "inspect", provider: "github", repositoryId }),
      prepareCheckout: (r) =>
        managed({
          schemaVersion: 1,
          operation: "prepare",
          provider: "github",
          repositoryId: r.repositoryId,
          taskId: r.taskId,
          revision: r.revision,
          expectedAccountId: r.expectedAccountId,
          ttlSeconds: 3600,
          ...(r.leaseId ? { leaseId: r.leaseId, generation: r.generation } : {}),
        }),
      async openRuntime(projects) {
        check(!closed && !admissionClosed && !supervisor);
        await executionAuthority?.fence();
        executionAuthority?.assert();
        let swapped = false;
        try {
          supervisor = await openSupervisor(
            {
              schemaVersion: 1,
              profile: "software",
              ownerId: config.binding.ownerId,
              workspaceId: config.binding.workspaceId,
              buildId: config.binding.buildId,
              codexExecutable: executable,
              codexSha256: pin,
              projects,
              executionMode: config.nativeIsolationEnabled ? "isolated" : "direct",
              ...(guardian ? { metadataReadOnly: true } : {}),
            },
            {
              executionAuthority,
              ...(guardian
                ? { metadataAuthority: (request) => guardian.metadataAuthority(request) }
                : {}),
            },
          );
          executionAuthority?.assert();
          registration = createHostRegistration(supervisor, {
            hiveOrigin: config.hiveOrigin,
            coderOrigin: config.binding.coderOrigin,
            hiveUserId: config.binding.hiveUserId,
            agentId: config.binding.agentId,
            templateId: config.binding.templateId,
            appId: config.binding.appId,
            appOrigin: config.binding.appOrigin,
            issuerPublicKeyPem: config.issuerPublicKeyPem,
            issuerKeyId: config.issuerKeyId,
          });
          if (config.managerEnabled)
            supervisor.setManagerAdapter(
              createDeliveryManagerAdapter({
                enabled: true,
                hiveOrigin: config.hiveOrigin,
                stateDirectory: privateDirectory(join(home, ".local/state/hive/delivery-manager")),
                hostPrivateKeyPem: supervisor.state.controllerPrivateKeyPem,
                currentRegistration: () => registration.currentRegistration(),
                currentProjectContext: (threadId) => controller.currentProjectContext(threadId),
                // Producer isolation has not passed its activation gate.
                nativeEnabled: false,
                currentServerInstanceId: () => supervisor.state.serverInstanceId,
                registerChild: (managerThreadId, childThreadId, spawnCallId) =>
                  supervisor.registerChild(managerThreadId, childThreadId, spawnCallId),
                readNativeHistory: (request) => supervisor.readNativeHistory(request),
              }),
            );
          await gateway.close();
          executionAuthority?.assert();
          swapped = true;
          gateway = await startProjectGateway(
            {
              schemaVersion: 1,
              protocolVersion: "0.165.0",
              hiveOrigin: config.hiveOrigin,
              appOrigin: config.binding.appOrigin,
              publicKeyPem: config.issuerPublicKeyPem,
              keyId: config.issuerKeyId,
              stateDirectory: bridgeDirectory,
              port: config.port,
            },
            supervisor,
            registration,
            discovery,
          );
          executionAuthority?.assert();
          return { supervisor, registration };
        } catch (error) {
          registration?.close();
          await supervisor?.close();
          registration = null;
          supervisor = null;
          if (swapped && !closed && !admissionClosed)
            gateway = await startDiscoveryGateway(
              { port: config.port, appOrigin: config.binding.appOrigin },
              discovery,
            );
          throw error;
        }
      },
    },
  );
  try {
    discovery = createProjectDiscovery(
      {
        binding: config.binding,
        hiveOrigin: config.hiveOrigin,
        issuerPublicKeyPem: config.issuerPublicKeyPem,
        issuerKeyId: config.issuerKeyId,
        stateDirectory: discoveryDirectory,
        helperPath: join(directory, "github-projects.py"),
        helperSha256: pins["github-projects.py"],
      },
      controller,
    );
    if (guardian)
      discovery.handleGuardian = createGuardianOwnerHandler({
        appOrigin: config.binding.appOrigin,
        guardian,
      });
    gateway = await startDiscoveryGateway(
      { port: config.port, appOrigin: config.binding.appOrigin },
      discovery,
    );
  } catch (error) {
    await controller.close();
    discovery?.close();
    await supervisor?.close();
    throw error;
  }
  const tick = setInterval(() => controller.resumePending(), 5000);
  const renewal = setInterval(() => controller.renewLeases(), 60000);
  renewal.unref();
  tick.unref();
  controller.resumePending();
  return {
    async closeAdmission(barrier) {
      check(guardian && !admissionClosed);
      admissionClosed = true;
      clearInterval(tick);
      clearInterval(renewal);
      let receipt;
      try {
        receipt = controller.closeAdmission(barrier);
      } finally {
        registration?.close();
        discovery.close();
        // Revoke browser/PTY input synchronously, then close fixed owned CLI
        // sessions before acknowledging. Native descendants are still held;
        // only the outer guardian may certify their eventual tree exit.
        await supervisor?.closeAdmission(barrier);
        await gateway.close();
      }
      return receipt;
    },
    loseAdmission() {
      if (!guardian || admissionClosed) return;
      admissionClosed = true;
      clearInterval(tick);
      clearInterval(renewal);
      controller.loseAdmission();
      registration?.close();
      discovery.close();
      supervisor?.revoke();
      void gateway.close().catch(() => {});
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(tick);
      clearInterval(renewal);
      await controller.close();
      registration?.close();
      await gateway.close();
      await supervisor?.close();
      discovery.close();
    },
  };
}
export function readInstalledHostStartup() {
  const path = join(userInfo().homedir, ".config/hive/codex-host.json");
  privatePath(path);
  check(lstatSync(path).size <= 16384);
  const bytes = readFileSync(path);
  check(bytes.length <= 16384);
  return { config: JSON.parse(bytes), configSha256: hash(bytes) };
}
export const readInstalledHostConfig = () => readInstalledHostStartup().config;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 2);
    const host = await startWorkspaceHost(readInstalledHostConfig());
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => void host.close().then(() => process.exit(0)));
    process.stdout.write("Pinned project host ready on configured loopback app port.\n");
  } catch {
    process.stderr.write("Pinned project host startup rejected.\n");
    process.exitCode = 1;
  }
}
