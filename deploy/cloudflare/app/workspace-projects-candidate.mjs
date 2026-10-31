import assert from "node:assert/strict";
import { PREVIEW_SOFTWARE_TEMPLATE_ID } from "./host-identity.mjs";

// This bounded candidate enables catalog/open and signed workspace reads only.
// Task execution, schedulers and the generic terminal remain separate candidates.
export function workspaceProjectsCandidate({
  enabled,
  updating,
  nativeCandidate,
  issuer,
  manifestSha256,
}) {
  if (!enabled) return undefined;
  assert.equal(updating, true, "Workspace projects require an existing owned preview");
  assert.equal(nativeCandidate, true, "Workspace projects require the native gateway");
  assert.equal(issuer?.scope.templateId, PREVIEW_SOFTWARE_TEMPLATE_ID);
  assert.match(issuer.keyId, /^[A-Za-z0-9._-]{1,64}$/);
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  return {
    templateId: PREVIEW_SOFTWARE_TEMPLATE_ID,
    profile: "software",
    manifestSha256,
  };
}

export function workspaceProjectsVars(candidate, issuer) {
  return {
    HIVE_PROJECT_DISCOVERY_ENABLED: candidate ? "true" : "false",
    HIVE_WORKSPACE_READ_ENABLED: candidate ? "true" : "false",
    ...(candidate
      ? {
          HIVE_WORKSPACE_READ_PROFILES_JSON: JSON.stringify([candidate]),
          HIVE_WORKSPACE_READ_HIVE_ORIGIN: issuer.scope.hiveOrigin,
          HIVE_WORKSPACE_READ_ISSUER_KEY_ID: issuer.keyId,
        }
      : {}),
  };
}

export function assertWorkspaceProjectsCandidate(record, app, secrets, currentManifestSha256) {
  const candidate = workspaceProjectsCandidate({
    enabled: Boolean(record.workspaceProjectsCandidate),
    updating: record.deploymentMode === "update-preview",
    nativeCandidate: record.nativeGatewayCandidate,
    issuer: record.nativeIssuer,
    manifestSha256: currentManifestSha256,
  });
  assert.deepEqual(record.workspaceProjectsCandidate, candidate);
  const expected = workspaceProjectsVars(candidate, record.nativeIssuer);
  for (const [name, value] of Object.entries(expected)) assert.equal(app.vars[name], value);
  if (candidate) {
    assert.equal(app.vars.HIVE_PROJECT_TASKS_ENABLED, "false");
    assert.equal(app.vars.HIVE_DISABLE_BACKGROUND_WORKERS, "true");
    assert.equal(app.vars.HIVE_CODEX_GATEWAY_ENABLED, "true");
    assert.equal(app.vars.HIVE_CODEX_ISSUER_KEY_ID, record.nativeIssuer.keyId);
    assert.equal(app.vars.HIVE_CODEX_HIVE_ORIGIN, record.nativeIssuer.scope.hiveOrigin);
    assert.ok(secrets.HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY);
    assert.equal(
      secrets.HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY,
      secrets.HIVE_CODEX_ISSUER_PRIVATE_KEY,
    );
  } else {
    for (const name of [
      "HIVE_WORKSPACE_READ_PROFILES_JSON",
      "HIVE_WORKSPACE_READ_HIVE_ORIGIN",
      "HIVE_WORKSPACE_READ_ISSUER_KEY_ID",
    ])
      assert.equal(app.vars[name], undefined);
    assert.equal(secrets.HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY, undefined);
  }
}
