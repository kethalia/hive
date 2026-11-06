import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import tar from "tar-stream";
import { voicePackage } from "./build-package.mjs";
import { readVoiceStartup } from "./voice-host-start.mjs";

test("startup checks private config, fixed paths and the packaged source hashes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "voice-start-")),
    packageDirectory = join(home, "package"),
    buildId = randomUUID();
  t.after(() => rm(home, { recursive: true, force: true }));
  const lockDirectory = join(home, ".codex/hive-voice");
  for (const path of [
    packageDirectory,
    dirname(join(home, ".config/hive/voice.json")),
    lockDirectory,
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const artifact = await voicePackage(),
    extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      void writeFile(join(packageDirectory, header.name), Buffer.concat(chunks), {
        mode: 0o600,
      }).then(next);
    });
    stream.resume();
  });
  extract.end(artifact.archive);
  await new Promise((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
  });
  const issuer = generateKeyPairSync("ed25519");
  const config = {
    schemaVersion: 1,
    home,
    issuer: "https://hive.example",
    issuerKeyId: "test",
    issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }),
    audience: "https://voice.example",
    workspaceId: randomUUID(),
    buildId,
    agentId: randomUUID(),
    packageDirectory,
    manifestSha256: artifact.manifestSha256,
    lockDirectory,
    port: 13343,
  };
  const configPath = join(home, ".config/hive/voice.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(readVoiceStartup(home, packageDirectory, join(home, ".codex")), config);
  await chmod(configPath, 0o644);
  assert.throws(() => readVoiceStartup(home, packageDirectory, join(home, ".codex")));
  await chmod(configPath, 0o600);
  await writeFile(join(packageDirectory, "voice-host.mjs"), "tampered");
  assert.throws(() => readVoiceStartup(home, packageDirectory, join(home, ".codex")));
});
