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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentBridge } from "./agent-host.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
function check(value) {
  if (!value) throw new Error("agent_start_rejected");
}
function directory(path) {
  check(realpathSync(path) === path);
  const s = lstatSync(path);
  check(s.isDirectory() && s.uid === process.getuid() && !(s.mode & 0o022));
}
function file(path, limit) {
  check(realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    check(
      s.isFile() &&
        s.uid === process.getuid() &&
        s.nlink === 1 &&
        !(s.mode & 0o077) &&
        s.size <= limit,
    );
    const raw = readFileSync(fd);
    check(raw.length === s.size);
    return raw;
  } finally {
    closeSync(fd);
  }
}
export function readAgentStartup(
  home = userInfo().homedir,
  packageDirectory = dirname(fileURLToPath(import.meta.url)),
) {
  const configPath = join(home, ".config/hive/agent-bridge.json");
  for (const path of [join(home, ".config"), join(home, ".config/hive"), packageDirectory])
    directory(path);
  const configBytes = file(configPath, 32768),
    config = JSON.parse(configBytes);
  check(
    exact(config, [
      "schemaVersion",
      "issuer",
      "issuerKeyId",
      "issuerPublicKeyPem",
      "binding",
      "profile",
      "home",
      "packageDirectory",
      "manifestSha256",
      "helperSha256",
      "environment",
      "port",
    ]) &&
      config.schemaVersion === 1 &&
      config.home === home &&
      config.packageDirectory === packageDirectory &&
      config.port === 13344 &&
      /^[a-f0-9]{64}$/.test(config.manifestSha256) &&
      /^[a-f0-9]{64}$/.test(config.helperSha256),
  );
  const manifestBytes = file(join(packageDirectory, "manifest.json"), 4096);
  check(sha(manifestBytes) === config.manifestSha256);
  const manifest = JSON.parse(manifestBytes);
  check(
    exact(manifest, ["schemaVersion", "files"]) &&
      manifest.schemaVersion === 1 &&
      exact(manifest.files, ["agent-host.mjs", "agent-start.mjs", "agent-tools.py"]),
  );
  for (const name of Object.keys(manifest.files))
    check(
      /^[a-f0-9]{64}$/.test(manifest.files[name]) &&
        sha(file(join(packageDirectory, name), 131072)) === manifest.files[name],
    );
  check(manifest.files["agent-tools.py"] === config.helperSha256);
  return { config, configFileSha256: sha(configBytes) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    check(process.argv.length === 2);
    const { config, configFileSha256 } = readAgentStartup();
    const bridge = createAgentBridge(config, {
      helperPath: join(config.packageDirectory, "agent-tools.py"),
      configFileSha256,
      environment: config.environment,
    });
    bridge.server.listen(config.port, "127.0.0.1");
    bridge.server.on("error", () => {
      process.stderr.write("agent_start_failed\n");
      process.exitCode = 1;
    });
    process.once("SIGTERM", () => bridge.close());
    process.once("SIGINT", () => bridge.close());
  } catch {
    process.stderr.write("agent_start_failed\n");
    process.exitCode = 1;
  }
}
