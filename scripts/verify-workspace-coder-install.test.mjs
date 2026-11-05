import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../docker/hive-base/Dockerfile", import.meta.url), "utf8");
const version = dockerfile.match(/^ARG CODER_VERSION=(.+)$/m)?.[1];
const instructions = dockerfile.match(/^RUN .*?(?:\\\n.*?)*$/gm) ?? [];
const install = instructions.find((instruction) => instruction.includes("coder_sha="))?.slice(4);
assert.ok(install, "Dockerfile must contain the checksum-verified Coder install command");

function fixture(arch, { corrupt = false, downloadFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-coder-install-"));
  try {
    const payload = join(root, "payload");
    const shims = join(root, "shims");
    const destination = join(root, "bin");
    for (const directory of [payload, shims, destination]) mkdirSync(directory);
    writeFileSync(
      join(payload, "coder"),
      `#!/bin/sh\nprintf '%s\\n' 'Coder v${version} linux/${arch}'\n`,
      { mode: 0o644 },
    );
    const archive = join(root, "fixture.tar.gz");
    const pack = spawnSync("tar", ["-czf", archive, "-C", payload, "./coder"], {
      encoding: "utf8",
    });
    assert.equal(pack.status, 0, pack.stderr);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (corrupt)
      writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("tampered")]));
    const curlLog = join(root, "curl.log");
    const tarLog = join(root, "tar.log");
    writeFileSync(
      join(shims, "curl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$HIVE_CODER_TEST_CURL_LOG"
if [ "$HIVE_CODER_TEST_DOWNLOAD_FAILURE" = "1" ]; then exit 22; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift
done
cp "$HIVE_CODER_TEST_ARCHIVE" "$output"
`,
      { mode: 0o755 },
    );
    const tarPath = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(shims, "tar"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$HIVE_CODER_TEST_TAR_LOG"
exec '${tarPath}' "$@"
`,
      { mode: 0o755 },
    );
    // Execute the Dockerfile's actual shell command in isolated paths. Replace
    // only the immutable production digests with this offline fixture's digest.
    const command = install
      .replaceAll(/coder_sha="[0-9a-f]{64}"/g, `coder_sha="${digest}"`)
      .replaceAll("/tmp/coder.tar.gz", join(root, "download.tar.gz"))
      .replaceAll("/usr/bin", destination);
    const result = spawnSync("sh", ["-ec", command], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${shims}:${destination}:/usr/bin:/bin`,
        CODER_VERSION: version,
        TARGETARCH: arch,
        HIVE_CODER_TEST_ARCHIVE: archive,
        HIVE_CODER_TEST_CURL_LOG: curlLog,
        HIVE_CODER_TEST_TAR_LOG: tarLog,
        HIVE_CODER_TEST_DOWNLOAD_FAILURE: downloadFailure ? "1" : "0",
      },
    });
    const readLog = (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    let mode;
    try {
      mode = statSync(join(destination, "coder")).mode & 0o777;
    } catch {}
    return {
      ...result,
      curlLog: readLog(curlLog),
      tarLog: readLog(tarLog),
      mode,
      downloaded: existsSync(join(root, "download.tar.gz")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("workspace image never runs the unpinned Coder installer", () => {
  assert.doesNotMatch(dockerfile, /coder\.com\/install\.sh/);
});

test("workspace CLI pins match the Coder v2.38.4 vendor checksum manifest", () => {
  assert.equal(version, "2.38.4");
  for (const [arch, digest] of Object.entries({
    amd64: "d1d906964852c32413402078d8379a9a2693fa17182703fa8fd77aa463841b2b",
    arm64: "7d854fbd7fef8341b1b8c1ebfb9fa85c0e96a244a3f63105c45173994d371de8",
  })) {
    assert.ok(install.includes(`${arch}) coder_arch="${arch}"; coder_sha="${digest}"`));
  }
});

for (const arch of ["amd64", "arm64"]) {
  test(`installs the verified ${arch} archive and smoke-checks the executable`, () => {
    const result = fixture(arch);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.curlLog,
      new RegExp(
        `https://github\\.com/coder/coder/releases/download/v${version}/coder_${version}_linux_${arch}\\.tar\\.gz`,
      ),
    );
    assert.equal(
      result.curlLog.trim().split("\n").length,
      1,
      "one archive download, no installer script",
    );
    assert.match(result.stdout, new RegExp(`Coder v${version} linux/${arch}`));
    assert.equal(result.mode, 0o755);
    assert.match(result.tarLog, /--no-same-owner/, "archive ownership must not be retained");
    assert.equal(result.downloaded, false, "verified archive is removed after installation");
  });
}

test("a checksum mismatch fails before extraction, installation, or execution", () => {
  const result = fixture("amd64", { corrupt: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /FAILED|did not match/);
  assert.equal(result.tarLog, "");
  assert.equal(result.mode, undefined);
  assert.doesNotMatch(result.stdout, /Coder v/);
});

test("a failed download cannot fall back to an unverified installer or binary", () => {
  const result = fixture("amd64", { downloadFailure: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.curlLog.trim().split("\n").length, 1);
  assert.equal(result.tarLog, "");
  assert.equal(result.mode, undefined);
  assert.doesNotMatch(result.stdout, /Coder v/);
});

for (const arch of ["s390x", ""]) {
  test(`rejects unsupported/missing architecture (${arch || "empty"}) before download`, () => {
    const result = fixture(arch);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported Coder CLI architecture/);
    assert.equal(result.curlLog, "");
    assert.equal(result.tarLog, "");
    assert.equal(result.mode, undefined);
  });
}
