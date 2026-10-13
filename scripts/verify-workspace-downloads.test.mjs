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
const instructions = dockerfile.match(/^RUN .*?(?:\\\n.*?)*$/gm) ?? [];
const evidence = JSON.parse(
  readFileSync(new URL("../docs/checks/security/workspace-image-artifacts.json", import.meta.url)),
);
const artifacts = [
  { name: "notesmd-cli", download: "/tmp/notesmd-cli.tar.gz", archive: true },
  { name: "act", download: "/tmp/act.tar.gz", archive: true },
  { name: "kasmvnc", download: "/tmp/kasmvnc.deb" },
  { name: "claude", download: "/tmp/claude" },
];

function installCommand(artifact) {
  const instruction = instructions.find((instruction) => instruction.includes(artifact.download));
  assert.ok(instruction, `${artifact.name} install command must exist`);
  return instruction.slice(4);
}

function fixture(artifact, { corrupt = false, failed = false, variant = "browser" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-workspace-download-"));
  try {
    const shims = join(root, "shims");
    const bin = join(root, "bin");
    const payload = join(root, "payload");
    for (const directory of [shims, bin, payload]) mkdirSync(directory);
    const source = join(root, "source");
    const executable = `#!/bin/sh\nprintf '%s\\n' 'verified ${artifact.name}'\n`;
    if (artifact.archive) {
      writeFileSync(join(payload, artifact.name), executable, { mode: 0o644 });
      const pack = spawnSync("tar", ["-czf", source, "-C", payload, artifact.name]);
      assert.equal(pack.status, 0, pack.stderr.toString());
    } else {
      writeFileSync(source, executable);
    }
    const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
    if (corrupt)
      writeFileSync(source, Buffer.concat([readFileSync(source), Buffer.from("tampered")]));
    const curlLog = join(root, "curl.log");
    const actionLog = join(root, "action.log");
    const shim = (name, script) =>
      writeFileSync(join(shims, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    shim(
      "curl",
      `printf '%s\\n' "$*" >> "$HIVE_DOWNLOAD_TEST_CURL_LOG"
if [ "$HIVE_DOWNLOAD_TEST_FAILED" = "1" ]; then exit 22; fi
while [ "$#" -gt 0 ]; do
  case "$1" in -o|-fsSLo) shift; output="$1" ;; esac
  shift
done
cp "$HIVE_DOWNLOAD_TEST_SOURCE" "$output"`,
    );
    for (const name of ["tar", "install"]) {
      const path = spawnSync("sh", ["-c", `command -v ${name}`], {
        encoding: "utf8",
      }).stdout.trim();
      shim(
        name,
        `printf '%s\\n' '${name}' >> "$HIVE_DOWNLOAD_TEST_ACTION_LOG"\nexec '${path}' "$@"`,
      );
    }
    shim("apt-get", 'printf "apt-get %s\\n" "$*" >> "$HIVE_DOWNLOAD_TEST_ACTION_LOG"');
    // Run the actual Docker RUN command, changing only the fixture hash and
    // filesystem destinations. Never touch the real user home or package DB.
    const destination = join(root, "download");
    const command = installCommand(artifact)
      .replaceAll(/[0-9a-f]{64}/g, hash)
      .replaceAll(artifact.download, destination)
      .replaceAll("/usr/local/bin", bin)
      .replaceAll("/usr/bin/docker-compose", join(bin, "docker-compose"))
      .replaceAll("/var/lib/apt/lists", join(root, "apt-lists"))
      .replaceAll("/home/coder", join(root, "home"));
    const result = spawnSync("sh", ["-ec", command], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${shims}:/usr/bin:/bin`,
        WORKSPACE_VARIANT: variant,
        ACT_VERSION: dockerfile.match(/^ENV ACT_VERSION=(.+)$/m)[1],
        CLAUDE_CODE_VERSION: dockerfile.match(/^ENV CLAUDE_CODE_VERSION=(.+)$/m)[1],
        HIVE_DOWNLOAD_TEST_SOURCE: source,
        HIVE_DOWNLOAD_TEST_CURL_LOG: curlLog,
        HIVE_DOWNLOAD_TEST_ACTION_LOG: actionLog,
        HIVE_DOWNLOAD_TEST_FAILED: failed ? "1" : "0",
      },
    });
    const installed =
      artifact.name === "claude" ? join(root, "home/.local/bin/claude") : join(bin, artifact.name);
    const readLog = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    return {
      ...result,
      curlLog: readLog(curlLog),
      actionLog: readLog(actionLog),
      downloaded: existsSync(destination),
      mode: existsSync(installed) ? statSync(installed).mode & 0o777 : undefined,
      version: existsSync(installed)
        ? spawnSync(installed, ["--version"], { encoding: "utf8" }).stdout.trim()
        : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("workspace builds never execute the mutable Claude installer or resolve a release channel", () => {
  assert.doesNotMatch(dockerfile, /claude\.ai\/install\.sh|claude-code-releases\/(latest|stable)/);
});

for (const artifact of artifacts) {
  test(`${artifact.name} pin matches the independently verified vendor artifact`, () => {
    const record = evidence.artifacts.find((record) => record.name === artifact.name);
    assert.equal(record.matches_vendor_checksum, true);
    const command = installCommand(artifact);
    assert.ok(command.includes(record.sha256));
    const resolved = command
      .replaceAll(/\$\{ACT_VERSION\}/g, dockerfile.match(/^ENV ACT_VERSION=(.+)$/m)[1])
      .replaceAll(
        /\$\{CLAUDE_CODE_VERSION\}/g,
        dockerfile.match(/^ENV CLAUDE_CODE_VERSION=(.+)$/m)[1],
      );
    assert.ok(resolved.includes(record.url));
  });

  test(`${artifact.name} verified download installs successfully and removes the download`, () => {
    const result = fixture(artifact);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.curlLog.trim().split("\n").length, 1);
    assert.equal(result.downloaded, false);
    if (artifact.name === "kasmvnc") {
      assert.match(result.actionLog, /apt-get install .*\/download/);
    } else {
      assert.equal(result.mode, 0o755);
      assert.equal(result.version, `verified ${artifact.name}`);
    }
  });

  for (const failure of ["corrupt", "failed"]) {
    test(`${artifact.name} ${failure} download fails before extraction or artifact installation`, () => {
      const result = fixture(artifact, { [failure]: true });
      assert.notEqual(result.status, 0);
      assert.equal(result.curlLog.trim().split("\n").length, 1);
      assert.doesNotMatch(result.actionLog, /^tar$|^install$|apt-get install .*\/download/m);
      assert.equal(result.mode, undefined);
      assert.equal(result.version, undefined);
    });
  }
}

const kasmvnc = artifacts.find((artifact) => artifact.name === "kasmvnc");
for (const variant of ["cli", "infrastructure"]) {
  test(`${variant} never downloads or installs KasmVNC`, () => {
    const result = fixture(kasmvnc, { variant });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.curlLog, "");
    assert.equal(result.actionLog, "");
  });
}
for (const variant of ["game", "electronics"]) {
  test(`${variant} rejects a tampered KasmVNC package before apt installs it`, () => {
    const result = fixture(kasmvnc, { corrupt: true, variant });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.actionLog, /apt-get install .*\/download/);
  });
}
