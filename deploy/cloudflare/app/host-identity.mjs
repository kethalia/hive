import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readPreviewPrivateJson } from "./deployment-identity.mjs";

export const PREVIEW_SOFTWARE_TEMPLATE_ID = "06ab5cf1-fc5a-4f98-ac96-94a6eaf5ef42";
export async function loadPreviewHostIdentity(path, hiveOrigin, coderOrigin) {
  const identity = await readPreviewPrivateJson(path);
  assert.equal(identity.schemaVersion, 1);
  assert.deepEqual(identity.scope, {
    hiveOrigin,
    coderOrigin,
    templateId: PREVIEW_SOFTWARE_TEMPLATE_ID,
  });
  assert.match(identity.keyId, /^[A-Za-z0-9._:-]{1,200}$/);
  for (const name of ["privateKeyPem", "publicKeyPem"])
    assert.ok(typeof identity[name] === "string" && identity[name].length <= 8192);
  const key = createPrivateKey(identity.privateKeyPem),
    publicKey = createPublicKey(identity.publicKeyPem);
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(publicKey.asymmetricKeyType, "ed25519");
  const derived = createPublicKey(key).export({ type: "spki", format: "der" });
  assert.deepEqual(
    derived,
    publicKey.export({ type: "spki", format: "der" }),
    "Preview issuer key pair mismatch",
  );
  return {
    ...identity,
    publicKeySHA256: createHash("sha256").update(derived).digest("hex"),
  };
}
