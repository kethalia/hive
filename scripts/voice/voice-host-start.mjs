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
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createVoiceHost } from "./voice-host.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
function check(value) {
  if (!value) throw new Error("voice_startup_rejected");
}
function privateDirectory(path) {
  check(realpathSync(path) === path);
  const info = lstatSync(path);
  check(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o022));
}
function privateFile(path, max) {
  check(realpathSync(path) === path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    check(
      info.isFile() &&
        info.uid === process.getuid() &&
        info.nlink === 1 &&
        !(info.mode & 0o077) &&
        info.size <= max,
    );
    const bytes = readFileSync(fd);
    check(bytes.length <= max);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function readVoiceStartup(
  home = userInfo().homedir,
  packageDirectory = dirname(fileURLToPath(import.meta.url)),
  codexHomeOverride,
) {
  const configPath = join(home, ".config/hive/voice.json");
  const codexHome = codexHomeOverride ?? (process.env.CODEX_HOME || join(home, ".codex"));
  check(isAbsolute(codexHome) && normalize(codexHome) === codexHome);
  for (const path of [join(home, ".config"), join(home, ".config/hive"), packageDirectory])
    privateDirectory(path);
  const config = JSON.parse(privateFile(configPath, 32768));
  check(
    exact(config, [
      "schemaVersion",
      "home",
      "issuer",
      "issuerKeyId",
      "issuerPublicKeyPem",
      "audience",
      "workspaceId",
      "buildId",
      "agentId",
      "packageDirectory",
      "manifestSha256",
      "lockDirectory",
      "port",
    ]) &&
      config.schemaVersion === 1 &&
      config.home === home &&
      config.packageDirectory === packageDirectory &&
      config.port === 13343 &&
      config.lockDirectory === join(codexHome, "hive-voice") &&
      /^[a-f0-9]{64}$/.test(config.manifestSha256),
  );
  for (const path of [codexHome, config.lockDirectory]) privateDirectory(path);
  const manifestBytes = privateFile(join(packageDirectory, "manifest.json"), 4096);
  check(sha(manifestBytes) === config.manifestSha256);
  const manifest = JSON.parse(manifestBytes);
  check(
    exact(manifest, ["schemaVersion", "files"]) &&
      manifest.schemaVersion === 1 &&
      exact(manifest.files, ["voice-host.mjs", "voice-host-start.mjs"]),
  );
  for (const name of Object.keys(manifest.files))
    check(
      /^[a-f0-9]{64}$/.test(manifest.files[name]) &&
        sha(privateFile(join(packageDirectory, name), 524288)) === manifest.files[name],
    );
  return config;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    check(process.argv.length === 2);
    const config = readVoiceStartup(),
      configFileSha256 = sha(privateFile(join(config.home, ".config/hive/voice.json"), 32768)),
      host = createVoiceHost(config, { configFileSha256 });
    host.server.listen(config.port, "127.0.0.1");
    host.server.on("error", () => {
      process.stderr.write("voice_startup_failed\n");
      process.exitCode = 1;
    });
    const stop = () => host.close();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch {
    process.stderr.write("voice_startup_failed\n");
    process.exitCode = 1;
  }
}
