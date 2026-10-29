#!/usr/bin/env node
// Fixed installed worker entry. Only a pinned guardian may provide inherited FD3.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectGuardianWorker } from "./codex-guardian-worker.mjs";
import { readInstalledHostStartup, startWorkspaceHost } from "./codex-workspace-host.mjs";

export async function startGuardedWorkspaceHost() {
  let host;
  const { config, configSha256 } = readInstalledHostStartup();
  const startup = { configSha256, port: config.port };
  const guardian = await connectGuardianWorker({
    fd: 3,
    startup,
    onCloseAdmission: (barrier) => {
      if (!host) throw new Error("guardian_worker_not_ready");
      return host.closeAdmission(barrier);
    },
    onLost: () => host?.loseAdmission(),
  });
  try {
    host = await startWorkspaceHost(config, { guardian });
    await guardian.ready(startup);
    return { host, guardian };
  } catch (error) {
    try {
      host?.loseAdmission();
      await host?.close();
    } finally {
      guardian.close();
    }
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("guardian_worker_arguments_rejected");
    const { host, guardian } = await startGuardedWorkspaceHost();
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        host.loseAdmission();
        void host.close().finally(() => {
          guardian.close();
          process.exit(0);
        });
      });
  } catch {
    process.stderr.write("Pinned guarded project worker startup rejected.\n");
    process.exitCode = 1;
  }
}
