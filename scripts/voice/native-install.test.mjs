import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { voicePackage } from "./build-package.mjs";

test("actual voice installer starts and reuses only its verified service", {
  timeout: 60000,
  skip: process.env.HIVE_VOICE_INSTALL_NATIVE !== "1",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "hive-voice-install-")),
    home = join(root, "home");
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
    version: execFileSync("/usr/bin/node", ["--version"], { encoding: "utf8" }).trim(),
  };
  const pinPath = join(root, "node-pin.json");
  writeFileSync(pinPath, JSON.stringify(nodePin), { mode: 0o600 });
  const entryPath = join(root, "entry.py");
  writeFileSync(
    entryPath,
    readFileSync("scripts/fixtures/workspace-read-install-entry.py", "utf8").replace(
      "/opt/hive-read-installer.py",
      "/opt/hive-voice-installer.py",
    ),
  );
  const artifact = await voicePackage(),
    issuer = generateKeyPairSync("ed25519");
  const request = {
    schemaVersion: 1,
    archive: artifact.compressed.toString("base64"),
    archiveSha256: artifact.archiveSha256,
    manifestSha256: artifact.manifestSha256,
    config: {
      schemaVersion: 1,
      home: "/home/coder",
      hiveOrigin: "https://hive.invalid",
      issuerKeyId: "fixture",
      issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
      binding: {
        coderOrigin: "https://coder.invalid",
        ownerId: randomUUID(),
        workspaceId: randomUUID(),
        buildId: randomUUID(),
        agentId: randomUUID(),
        templateId: randomUUID(),
        appOrigin: "https://hive-voice--main--fixture--owner.apps.invalid",
        appId: randomUUID(),
      },
      packageDirectory: `/home/coder/.local/share/hive/voice/${artifact.archiveSha256}`,
      manifestSha256: artifact.manifestSha256,
      port: 13343,
    },
  };
  try {
    const result = execFileSync(
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
        resolve("templates/ai-dev-k8s/scripts/install-voice.py"),
        "/opt/hive-voice-installer.py",
        "--ro-bind",
        resolve("scripts/voice/native-install-fixture.py"),
        "/opt/hive-voice-test.py",
        "--ro-bind",
        entryPath,
        "/opt/hive-voice-entry.py",
        "--ro-bind",
        resolve("scripts/fixtures/workspace-identity-install.py"),
        "/opt/hive-identity-fixture.py",
        "--ro-bind",
        pinPath,
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
        "/opt/hive-voice-test.py",
      ],
      {
        input: JSON.stringify(request),
        encoding: "utf8",
        timeout: 45000,
        env: { PATH: "/home/coder/.local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    assert.deepEqual(JSON.parse(result), { passed: true, reused: true, lifetimeMatched: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
