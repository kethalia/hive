import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { workspaceReadPackage } from "./build-workspace-read-package.mjs";

test("actual standalone installer pins Node/config/package/listener inside private home and network namespace", {
  timeout: 60000,
  skip: process.env.HIVE_WORKSPACE_READ_INSTALL_NATIVE !== "1",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-read-install-actual-")),
    home = join(root, "home"),
    log = join(root, "result.log");
  mkdirSync(home, { mode: 0o700 });
  const node = statSync("/usr/bin/node");
  assert.equal(realpathSync("/usr/bin/node"), "/usr/bin/node");
  assert.equal(node.uid, 0);
  const nodePin = {
    uid: node.uid,
    device: String(node.dev),
    inode: String(node.ino),
    size: node.size,
    sha256: createHash("sha256").update(readFileSync("/usr/bin/node")).digest("hex"),
    version: execFileSync("/usr/bin/node", ["--version"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim(),
  };
  assert.match(nodePin.version, /^v24\./);
  const nodePinFile = join(root, "node-pin.json");
  writeFileSync(nodePinFile, JSON.stringify(nodePin), { mode: 0o600 });
  const artifact = await workspaceReadPackage(process.cwd()),
    issuer = generateKeyPairSync("ed25519"),
    buildId = randomUUID(),
    request = {
      schemaVersion: 1,
      archive: artifact.compressed.toString("base64"),
      archiveSha256: artifact.archiveSha256,
      manifestSha256: artifact.manifestSha256,
      config: {
        schemaVersion: 1,
        profile: "software",
        home: "/home/coder",
        projectsRoot: "/home/coder",
        hiveOrigin: "https://hive.invalid",
        issuerKeyId: "fixture",
        issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
        binding: {
          coderOrigin: "https://coder.invalid",
          ownerId: randomUUID(),
          workspaceId: randomUUID(),
          buildId,
          agentId: randomUUID(),
          templateId: randomUUID(),
          appOrigin: "https://hive-read--main--fixture--owner.apps.invalid",
          appId: randomUUID(),
        },
        packageDirectory: `/home/coder/.local/share/hive/workspace-read/${artifact.archiveSha256}`,
        manifestSha256: artifact.manifestSha256,
        stateDirectory: `/home/coder/.local/state/hive/workspace-read/${buildId}`,
        port: 13342,
      },
    };
  let passed = false;
  try {
    const output = execFileSync(
      "bwrap",
      [
        "--unshare-user",
        "--unshare-net",
        "--die-with-parent",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--ro-bind",
        "/etc/passwd",
        "/etc/passwd",
        "--ro-bind",
        "/etc/group",
        "/etc/group",
        "--dir",
        "/opt",
        "--ro-bind",
        resolve("templates/ai-dev-k8s/scripts/install-workspace-read.py"),
        "/opt/hive-read-installer.py",
        "--ro-bind",
        resolve("scripts/fixtures/workspace-read-install.py"),
        "/opt/hive-read-test.py",
        "--ro-bind",
        resolve("scripts/fixtures/workspace-read-install-entry.py"),
        "/opt/hive-read-install-entry.py",
        "--ro-bind",
        nodePinFile,
        "/opt/hive-read-node-pin.json",
        "--bind",
        home,
        "/home/coder",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--chdir",
        "/home/coder",
        "--",
        "/usr/bin/python3",
        "-I",
        "-B",
        "/opt/hive-read-test.py",
      ],
      {
        input: JSON.stringify(request),
        encoding: "utf8",
        timeout: 45000,
        maxBuffer: 1048576,
        env: { PATH: "/home/coder/.local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" },
      },
    );
    writeFileSync(log, output, { mode: 0o600 });
    const result = JSON.parse(output);
    assert.equal(result.passed, true);
    assert.notEqual(result.networkNamespace, readlinkSync("/proc/self/ns/net"));
    assert.equal(result.homeInode, String(statSync(home).ino));
    assert.equal(result.syntheticNodeRootOwnershipObservation, true);
    if (process.env.HIVE_WORKSPACE_READ_INSTALL_REPORT) {
      const directory = resolve("docs/checks/autonomous-delivery/workspace-read-install-local"),
        path = resolve(process.env.HIVE_WORKSPACE_READ_INSTALL_REPORT);
      assert(path.startsWith(`${directory}/`) && path.endsWith(".json"));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ observedAt: new Date().toISOString(), ...result, nodePin }, null, 2)}\n`,
      );
    }
    for (const value of Object.values(result.checks)) assert.equal(value, true);
    passed = true;
  } catch (error) {
    writeFileSync(log, `${error.stdout ?? ""}\n${error.stderr ?? ""}`, { mode: 0o600 });
    throw new Error(`Isolated read installer proof failed; retained ${root}`, { cause: error });
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true });
  }
});
