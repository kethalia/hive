import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPreviewHostIdentity, PREVIEW_SOFTWARE_TEMPLATE_ID } from "./host-identity.mjs";

const hiveOrigin = "https://preview.example",
  coderOrigin = "https://coder.example";
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "hive-host-identity-test-")),
    path = join(directory, "identity.json");
  const key = generateKeyPairSync("ed25519");
  const identity = {
    schemaVersion: 1,
    scope: { hiveOrigin, coderOrigin, templateId: PREVIEW_SOFTWARE_TEMPLATE_ID },
    keyId: "preview-key",
    privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  await writeFile(path, JSON.stringify(identity), { mode: 0o600 });
  try {
    await run(path, identity);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("loads only a private matching Ed25519 issuer and preserves the identity", () =>
  fixture(async (path, identity) => {
    const before = await readFile(path);
    const loaded = await loadPreviewHostIdentity(path, hiveOrigin, coderOrigin);
    assert.equal(loaded.privateKeyPem, identity.privateKeyPem);
    assert.match(loaded.publicKeySHA256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(path), before);
  }));
test("rejects foreign app/Coder/template scopes or a mismatched public key", () =>
  fixture(async (path, identity) => {
    await assert.rejects(loadPreviewHostIdentity(path, "https://foreign.example", coderOrigin));
    await assert.rejects(loadPreviewHostIdentity(path, hiveOrigin, "https://foreign.example"));
    for (const value of [
      { ...identity, scope: { ...identity.scope, templateId: "foreign" } },
      {
        ...identity,
        publicKeyPem: generateKeyPairSync("ed25519")
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
      },
    ]) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(loadPreviewHostIdentity(path, hiveOrigin, coderOrigin));
    }
  }));
