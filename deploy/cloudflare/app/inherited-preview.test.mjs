import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ACCOUNT_ID, APP_NAME, AUTH_NAME } from "./deployment-plan.mjs";
import { previousAfterAuthUpload, validateInheritedPreview } from "./inherited-preview.mjs";

const ids = ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"];
function fixture() {
  const key = generateKeyPairSync("ed25519").publicKey;
  const pem = key.export({ type: "spki", format: "pem" });
  const scope = {
    hiveOrigin: "https://example.workers.dev",
    coderOrigin: "https://coder.example",
    templateId: "template",
  };
  const nativeIssuer = {
    keyId: "preview-key",
    publicKeySHA256: createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex"),
    scope,
  };
  const secrets = {
    app: [
      "DATABASE_URL",
      "COOKIE_SECRET",
      "HIVE_CODEX_ISSUER_PRIVATE_KEY",
      "PREVIEW_BEARER",
      "PREVIEW_COOKIE_SECRET",
    ],
    auth: ["DATABASE_URL", "AUTH_SERVICE_SECRET"],
  };
  const previous = {
    accountId: ACCOUNT_ID,
    sourceRevision: "a".repeat(40),
    probe: { finalPassed: true },
    prepared: { previewIdentityId: "old" },
    nativeIssuer,
    nativeGatewayCandidate: true,
    workspaceProjectsCandidate: {},
    scriptIdentities: [],
    workers: {},
    finalPublicState: {},
  };
  const evidence = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    accountId: ACCOUNT_ID,
    targets: [],
  };
  for (const [i, [kind, name]] of Object.entries({ app: APP_NAME, auth: AUTH_NAME }).entries()) {
    const publicState = { enabled: false, previews_enabled: false };
    const bindings = [
      ...secrets[kind].map((n) => ({ name: n, type: "secret_text" })),
      { name: "SOURCE_REVISION", type: "plain_text", value: previous.sourceRevision },
    ];
    previous.scriptIdentities.push({
      name,
      tag: "a".repeat(32),
      createdOn: "2026-10-30T00:00:00Z",
    });
    previous.workers[kind] = { name, deploymentId: ids[i], versionId: ids[i], bindings };
    previous.finalPublicState[kind] = publicState;
    evidence.targets.push({
      ...previous.scriptIdentities[i],
      exists: true,
      deploymentId: ids[i],
      versionId: ids[i],
      publicState,
      bindings: structuredClone(bindings),
    });
  }
  evidence.targets[0].bindings.push(
    ...Object.entries({
      HIVE_CODEX_ISSUER_KEY_ID: nativeIssuer.keyId,
      HIVE_WORKSPACE_READ_ISSUER_KEY_ID: nativeIssuer.keyId,
      HIVE_CODEX_HIVE_ORIGIN: scope.hiveOrigin,
      HIVE_WORKSPACE_READ_HIVE_ORIGIN: scope.hiveOrigin,
      HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: scope.templateId,
      HIVE_CODEX_ISSUER_PUBLIC_KEY: pem,
    }).map(([name, value]) => ({ name, value, type: "plain_text" })),
  );
  return { previous, evidence };
}
test("inherited preview verifies fresh pinned provider identity, secret inventory and issuer", () => {
  const { previous, evidence } = fixture();
  assert.equal(validateInheritedPreview(evidence, previous).keyId, previous.nativeIssuer.keyId);
  for (const mutate of [
    (e) => {
      e.observedAt = "2020-01-01T00:00:00Z";
    },
    (e) => {
      e.targets[0].versionId = ids[1];
    },
    (e) => {
      e.targets[0].bindings.pop();
    },
    (e) => {
      e.targets[0].bindings[0].type = "plain_text";
    },
    (e) => {
      e.targets[1].bindings.push({ name: "UNEXPECTED", type: "secret_text" });
    },
    (e) => {
      e.targets[0].bindings.find((b) => b.name === "HIVE_CODEX_ISSUER_KEY_ID").value = "wrong";
    },
    (e) => {
      e.targets[0].bindings.push(e.targets[0].bindings[0]);
    },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.throws(() => validateInheritedPreview(changed, previous));
  }
});

test("second upload requires a receipt bound to this run and the prior auth version", () => {
  const { previous } = fixture();
  const record = { runId: "run", sourceRevision: "b".repeat(40) };
  const receipt = {
    ...record,
    kind: "auth",
    previousDeploymentId: previous.workers.auth.deploymentId,
    previousVersionId: previous.workers.auth.versionId,
    deploymentId: ids[0],
    versionId: ids[0],
  };
  assert.equal(previousAfterAuthUpload(previous, record, receipt).workers.auth.versionId, ids[0]);
  for (const patch of [
    { runId: "other" },
    { sourceRevision: "c".repeat(40) },
    { previousVersionId: ids[0] },
    { versionId: ids[1] },
    { kind: "app" },
  ])
    assert.throws(() => previousAfterAuthUpload(previous, record, { ...receipt, ...patch }));
});
