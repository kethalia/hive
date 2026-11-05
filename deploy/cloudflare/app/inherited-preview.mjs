import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { ACCOUNT_ID, APP_NAME, AUTH_NAME } from "./deployment-plan.mjs";
import { validatePreviewRedeployment } from "./redeployment-policy.mjs";

// Evidence is freshly obtained by the operator from the connected provider API.
// It contains binding names and public values only, never secret values.
export function validateInheritedPreview(
  evidence,
  previous,
  now = Date.now(),
  expectedSources = {},
) {
  assert.equal(evidence.schemaVersion, 1);
  const age = now - Date.parse(evidence.observedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= 60_000, "Refresh provider evidence");
  assert.equal(evidence.accountId, ACCOUNT_ID);
  validatePreviewRedeployment(evidence, previous, ACCOUNT_ID, { app: APP_NAME, auth: AUTH_NAME });
  for (const kind of ["app", "auth"]) {
    const expected = previous.workers[kind].bindings
      .filter((b) => b.type === "secret_text")
      .map((b) => b.name)
      .sort();
    const bindings = evidence.targets.find((t) => t.name === previous.workers[kind].name).bindings;
    assert.ok(Array.isArray(bindings));
    assert.equal(new Set(bindings.map((b) => b.name)).size, bindings.length);
    const source = bindings.find((b) => b.name === "SOURCE_REVISION");
    assert.equal(source?.type, "plain_text");
    assert.equal(source.value, expectedSources[kind] ?? previous.sourceRevision);
    assert.deepEqual(
      bindings
        .filter((b) => b.type === "secret_text")
        .map((b) => b.name)
        .sort(),
      expected,
    );
    for (const name of expected)
      assert.equal(bindings.find((b) => b.name === name)?.type, "secret_text");
  }
  const app = evidence.targets.find((t) => t.name === APP_NAME).bindings;
  const value = (name) => {
    const binding = app.find((b) => b.name === name);
    assert.equal(binding?.type, "plain_text");
    assert.equal(typeof binding.value, "string");
    return binding.value;
  };
  const prior = previous.nativeIssuer;
  assert.ok(prior && previous.nativeGatewayCandidate && previous.workspaceProjectsCandidate);
  assert.equal(value("HIVE_CODEX_ISSUER_KEY_ID"), prior.keyId);
  assert.equal(value("HIVE_WORKSPACE_READ_ISSUER_KEY_ID"), prior.keyId);
  assert.equal(value("HIVE_CODEX_HIVE_ORIGIN"), prior.scope.hiveOrigin);
  assert.equal(value("HIVE_WORKSPACE_READ_HIVE_ORIGIN"), prior.scope.hiveOrigin);
  assert.equal(value("HIVE_CODEX_SOFTWARE_TEMPLATE_IDS"), prior.scope.templateId);
  const pem = value("HIVE_CODEX_ISSUER_PUBLIC_KEY");
  const key = createPublicKey(pem);
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(
    createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex"),
    prior.publicKeySHA256,
  );
  return { ...prior, publicKeyPem: pem };
}

// Receipt is operator-recorded provider readback after the first (auth) upload.
export function previousAfterAuthUpload(previous, record, receipt) {
  assert.equal(receipt.runId, record.runId);
  assert.equal(receipt.sourceRevision, record.sourceRevision);
  assert.equal(receipt.kind, "auth");
  assert.equal(receipt.previousDeploymentId, previous.workers.auth.deploymentId);
  assert.equal(receipt.previousVersionId, previous.workers.auth.versionId);
  for (const id of [receipt.deploymentId, receipt.versionId])
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.notEqual(receipt.versionId, receipt.previousVersionId);
  const next = structuredClone(previous);
  next.workers.auth.deploymentId = receipt.deploymentId;
  next.workers.auth.versionId = receipt.versionId;
  return next;
}
