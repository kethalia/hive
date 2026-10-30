import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import { agentPackage } from "./build-package.mjs";

const script = `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer','templates/ai-dev-k8s/scripts/install-agent-bridge.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=json.load(sys.stdin)
m.validate(r,Path('/home/coder'),'software')
`;
test("agent installer accepts only its pinned archive and bound configuration", async () => {
  const artifact = await agentPackage(),
    pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const request = {
    schemaVersion: 1,
    archive: artifact.compressed.toString("base64"),
    archiveSha256: artifact.archiveSha256,
    manifestSha256: artifact.manifestSha256,
    config: {
      schemaVersion: 1,
      home: "/home/coder",
      profile: "software",
      hiveOrigin: "https://hive.example",
      issuerKeyId: "test",
      issuerPublicKeyPem: pub,
      packageDirectory: `/home/coder/.local/share/hive/agent-bridge/${artifact.archiveSha256}`,
      manifestSha256: artifact.manifestSha256,
      helperSha256: artifact.helperSha256,
      port: 13344,
      binding: {
        coderOrigin: "https://coder.example",
        ownerId: ids[0],
        workspaceId: ids[1],
        buildId: ids[2],
        agentId: ids[3],
        templateId: ids[4],
        appOrigin: "https://agent.example",
        appId: ids[5],
      },
    },
  };
  const validate = (value) =>
    spawnSync("python3", ["-I", "-B", "-c", script], {
      input: JSON.stringify(value),
      encoding: "utf8",
    });
  const good = validate(request);
  assert.equal(good.status, 0, good.stderr);
  assert.notEqual(validate({ ...request, archiveSha256: "0".repeat(64) }).status, 0);
  assert.notEqual(
    validate({ ...request, config: { ...request.config, helperSha256: "0".repeat(64) } }).status,
    0,
  );
  assert.notEqual(validate({ ...request, config: { ...request.config, port: 13342 } }).status, 0);
  assert.notEqual(
    validate({
      ...request,
      config: {
        ...request.config,
        binding: { ...request.config.binding, appOrigin: "http://attacker.example" },
      },
    }).status,
    0,
  );
});
