// Build-time tool only. Installed workspaces never compile the guardian.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const guardianFlags = Object.freeze([
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-fPIE",
  "-pie",
  "-fstack-protector-strong",
  "-D_FORTIFY_SOURCE=3",
  "-Wl,-z,relro,-z,now",
  "-Wl,--build-id=none",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const guardianRecipeSha256 = sha(
  JSON.stringify({ schemaVersion: 1, flags: guardianFlags, sourceDateEpoch: "0" }),
);
export const guardianSourcePath = "templates/ai-dev-k8s/scripts/codex-native-guardian.c";
const builderPath = fileURLToPath(import.meta.url);
function regular(path, max) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && stat.nlink === 1 && stat.size <= max,
    "Invalid guardian artifact file",
  );
  return readFileSync(path);
}
export function validateGuardianArtifact(root, directory) {
  const manifest = JSON.parse(regular(join(directory, "guardian-build.json"), 32768));
  const binary = regular(join(directory, "codex-native-guardian"), 1024 * 1024);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, "linux");
  assert.equal(manifest.architecture, "x64");
  assert.equal(manifest.sourceSha256, sha(readFileSync(join(root, guardianSourcePath))));
  assert.equal(manifest.recipeSha256, guardianRecipeSha256);
  assert.equal(manifest.builderSha256, sha(readFileSync(builderPath)));
  assert.deepEqual(manifest.flags, guardianFlags);
  assert.equal(manifest.elfSha256, sha(binary));
  assert.match(manifest.compiler?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(
    typeof manifest.compiler?.version === "string" && manifest.compiler.version.length <= 4096,
  );
  assert.ok(
    typeof manifest.compiler?.target === "string" &&
      /^x86_64-[a-z0-9_-]+$/.test(manifest.compiler.target),
  );
  assert.ok(binary.length >= 64 && binary.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])));
  assert.equal(binary[4], 2);
  assert.equal(binary[5], 1);
  assert.equal(binary.readUInt16LE(18), 62);
  assert.equal(binary.readUInt16LE(16), 3); // Position-independent ELF executable.
  return { manifest, binary };
}
export function buildNativeGuardian(root, output) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const compiler = realpathSync("/usr/bin/cc");
  const source = join(root, guardianSourcePath),
    sourceSha256 = sha(readFileSync(source));
  const compilerBytes = readFileSync(compiler),
    env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SOURCE_DATE_EPOCH: "0" };
  const version = execFileSync(compiler, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4096,
  }).trim();
  const target = execFileSync(compiler, ["-dumpmachine"], {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 256,
  }).trim();
  mkdirSync(output, { mode: 0o700 });
  const executable = join(output, "codex-native-guardian");
  execFileSync(compiler, [...guardianFlags, source, "-o", executable], {
    env,
    stdio: "pipe",
    timeout: 30000,
    maxBuffer: 65536,
  });
  assert.equal(
    sha(readFileSync(source)),
    sourceSha256,
    "Guardian source changed during compilation",
  );
  assert.equal(
    sha(readFileSync(compiler)),
    sha(compilerBytes),
    "Compiler changed during compilation",
  );
  chmodSync(executable, 0o500);
  const probe = spawnSync(executable, [], { env, timeout: 2000, stdio: "pipe" });
  assert.equal(probe.status, 100, "Guardian must reject launch without its private protocol");
  const manifest = {
    schemaVersion: 1,
    platform: "linux",
    architecture: "x64",
    sourceSha256,
    recipeSha256: guardianRecipeSha256,
    builderSha256: sha(readFileSync(builderPath)),
    flags: guardianFlags,
    elfSha256: sha(readFileSync(executable)),
    compiler: { sha256: sha(compilerBytes), version, target },
    ci:
      process.env.GITHUB_ACTIONS === "true"
        ? {
            repository: process.env.GITHUB_REPOSITORY,
            commit: process.env.GITHUB_SHA,
            runId: process.env.GITHUB_RUN_ID,
            runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          }
        : null,
  };
  writeFileSync(join(output, "guardian-build.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o400,
    flag: "wx",
  });
  validateGuardianArtifact(root, output);
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Expected a new absolute output directory");
  const output = process.argv[2];
  assert.equal(resolve(output), output);
  const manifest = buildNativeGuardian(
    resolve(fileURLToPath(new URL("..", import.meta.url))),
    output,
  );
  console.log(
    JSON.stringify({
      directory: output,
      sourceSha256: manifest.sourceSha256,
      elfSha256: manifest.elfSha256,
    }),
  );
}
