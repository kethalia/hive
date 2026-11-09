import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dockerfile = readFileSync(new URL("../docker/hive-base/Dockerfile", import.meta.url), "utf8");
const instructions = dockerfile.match(/^RUN .*?(?:\\\n.*?)*$/gm) ?? [];
const evidence = JSON.parse(
  readFileSync(new URL("../docs/checks/security/workspace-image-artifacts.json", import.meta.url)),
);
const claudeRelease = JSON.parse(
  readFileSync(
    new URL(
      "../docs/checks/autonomous-delivery/codex-account-local/claude-2.1.319-release.json",
      import.meta.url,
    ),
  ),
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
    const record =
      artifact.name === "claude"
        ? claudeRelease.artifact
        : evidence.artifacts.find((record) => record.name === artifact.name);
    if (artifact.name === "claude") {
      assert.equal(claudeRelease.manifestSignature.gpgValidSig, true);
      assert.equal(
        claudeRelease.manifestSignature.fingerprint,
        "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE",
      );
    }
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

const retryArtifacts = [
  { name: "coder", download: "/tmp/coder.tar.gz" },
  { name: "act", download: "/tmp/act.tar.gz" },
  { name: "notesmd-cli", download: "/tmp/notesmd-cli.tar.gz" },
];
const infrastructureRetryArtifacts = [
  { name: "terraform", download: "/tmp/terraform.zip", checksum: "TERRAFORM_SHA256" },
  { name: "kubectl", download: "/tmp/kubectl", checksum: "KUBECTL_SHA256" },
  { name: "helm", download: "/tmp/helm.tar.gz", checksum: "HELM_SHA256" },
  { name: "argocd", download: "/tmp/argocd", checksum: "ARGOCD_SHA256" },
];
retryArtifacts.push(...infrastructureRetryArtifacts);
async function retryFixture(t, artifact, failure, permanent = false) {
  const root = mkdtempSync(join(tmpdir(), "hive-release-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = Buffer.from("synthetic checksum-verified release download\n");
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (permanent || requests === 1) {
      if (failure === "reset") req.socket.resetAndDestroy();
      else {
        res.writeHead(503);
        res.end("temporary vendor failure");
      }
    } else {
      res.writeHead(200);
      res.end(payload);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const instruction = installCommand(artifact).replaceAll(/\\\r?\n/g, " "),
    curl = instruction
      .match(/\bcurl\s+[\s\S]*?(?=\s*&&|$)/g)
      ?.find((command) => command.includes(artifact.download));
  assert.ok(curl, `${artifact.name} curl command must exist`);
  for (const option of [
    "--retry 3",
    "--retry-all-errors",
    "--retry-delay 2",
    "--retry-max-time 90",
    "--connect-timeout 15",
    "--max-time 120",
  ])
    assert.ok(curl.includes(option));
  let command = curl.replace(
    /https:\/\/[^"\s]+/,
    `http://127.0.0.1:${server.address().port}/release`,
  );
  const installationMarker = join(root, "installed");
  if (failure === "checksum") {
    // Execute the real checksum gate immediately after this artifact's curl.
    // A marker stands in for the following extraction/installation action.
    const following = instruction.slice(instruction.indexOf(curl) + curl.length);
    const checksum = following.match(/^\s*&&\s*([\s\S]*?)(?=\s*&&)/)?.[1];
    assert.ok(checksum?.includes(`$${artifact.checksum}`));
    assert.match(
      following.slice(following.indexOf(checksum) + checksum.length),
      /^\s*&&\s*(unzip|install|tar)\b/,
    );
    command += ` && ${checksum} && touch '${installationMarker}'`;
  }
  command = command.replaceAll(artifact.download, join(root, "download"));
  const started = performance.now();
  const child = spawn("sh", ["-ec", command], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH,
      CURL_HOME: root,
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
      ...(artifact.checksum ? { [artifact.checksum]: "0".repeat(64) } : {}),
    },
  });
  let error = "";
  child.stderr.on("data", (bytes) => {
    error += bytes.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  assert.equal(result.signal, null, "curl must stop itself within its retry bound");
  if (failure === "reset")
    assert.match(error, /curl: \(56\)/, "exercise the observed receive-error category");
  if (permanent) {
    assert.notEqual(result.code, 0);
    assert.equal(requests, 4, "one attempt plus at most three retries");
    assert.ok(performance.now() - started < 12000);
  } else if (failure === "checksum") {
    assert.notEqual(result.code, 0, "checksum mismatch must fail");
    assert.equal(requests, 2);
    assert.equal(existsSync(installationMarker), false, "checksum must gate installation");
  } else {
    assert.equal(result.code, 0, error);
    assert.equal(requests, 2);
    assert.deepEqual(readFileSync(join(root, "download")), payload);
  }
}
for (const failure of ["503", "reset"]) {
  test(`pinned release downloads recover a transient ${failure} within bounded retries`, async (t) => {
    for (const artifact of retryArtifacts)
      await t.test(artifact.name, (t) => retryFixture(t, artifact, failure));
  });
}
test("permanent release connection resets exhaust three retries without falling back", (t) =>
  retryFixture(t, retryArtifacts[0], "reset", true));

for (const artifact of infrastructureRetryArtifacts) {
  test(`${artifact.name} permanent 503 exhausts three retries without falling back`, (t) =>
    retryFixture(t, artifact, "503", true));
  test(`${artifact.name} checksum mismatch prevents extraction or installation`, (t) =>
    retryFixture(t, artifact, "checksum"));
}
