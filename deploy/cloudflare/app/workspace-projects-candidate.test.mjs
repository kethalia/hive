import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_SOFTWARE_TEMPLATE_ID } from "./host-identity.mjs";
import {
  assertWorkspaceProjectsCandidate,
  workspaceProjectsCandidate,
  workspaceProjectsVars,
} from "./workspace-projects-candidate.mjs";

function fixture() {
  const issuer = {
    keyId: "preview-key",
    scope: { templateId: PREVIEW_SOFTWARE_TEMPLATE_ID, hiveOrigin: "https://preview.example.com" },
  };
  const options = {
    enabled: true,
    updating: true,
    nativeCandidate: true,
    issuer,
    manifestSha256: "a".repeat(64),
  };
  const candidate = workspaceProjectsCandidate(options);
  const record = {
    deploymentMode: "update-preview",
    nativeGatewayCandidate: true,
    nativeIssuer: issuer,
    workspaceProjectsCandidate: candidate,
  };
  const app = {
    vars: {
      ...workspaceProjectsVars(candidate, issuer),
      HIVE_PROJECT_TASKS_ENABLED: "false",
      HIVE_DISABLE_BACKGROUND_WORKERS: "true",
      HIVE_CODEX_GATEWAY_ENABLED: "true",
      HIVE_CODEX_ISSUER_KEY_ID: issuer.keyId,
      HIVE_CODEX_HIVE_ORIGIN: issuer.scope.hiveOrigin,
    },
  };
  const secrets = {
    HIVE_CODEX_ISSUER_PRIVATE_KEY: "test-key",
    HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY: "test-key",
  };
  return {
    options,
    record,
    app,
    secrets,
    check: () => assertWorkspaceProjectsCandidate(record, app, secrets, options.manifestSha256),
  };
}
test("requires an existing preview and the scoped native issuer", () => {
  for (const mutate of [
    (f) => {
      f.options.updating = false;
    },
    (f) => {
      f.options.nativeCandidate = false;
    },
    (f) => {
      f.options.issuer.scope.templateId = "other";
    },
    (f) => {
      f.options.issuer.keyId = "unsupported:key";
    },
    (f) => {
      f.options.manifestSha256 = "invalid";
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => workspaceProjectsCandidate(f.options));
  }
});
test("deployment verifies the installed manifest pin and retained issuer", () => {
  fixture().check();
  for (const mutate of [
    (f) => {
      f.options.manifestSha256 = "b".repeat(64);
    },
    (f) => {
      f.app.vars.HIVE_WORKSPACE_READ_PROFILES_JSON = "[]";
    },
    (f) => {
      f.app.vars.HIVE_WORKSPACE_READ_HIVE_ORIGIN = "https://other.example.com";
    },
    (f) => {
      f.app.vars.HIVE_PROJECT_TASKS_ENABLED = "true";
    },
    (f) => {
      f.app.vars.HIVE_DISABLE_BACKGROUND_WORKERS = "false";
    },
    (f) => {
      f.secrets.HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY = "replacement-key";
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(f.check);
  }
});
test("default preparation disables discovery/reads and has no read issuer", () => {
  assert.equal(workspaceProjectsCandidate({ enabled: false }), undefined);
  const record = {};
  const app = { vars: workspaceProjectsVars(undefined, undefined) };
  assertWorkspaceProjectsCandidate(record, app, {}, "a".repeat(64));
  app.vars.HIVE_WORKSPACE_READ_ENABLED = "true";
  assert.throws(() => assertWorkspaceProjectsCandidate(record, app, {}, "a".repeat(64)));
});
