import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assertDeliveryPilot,
  deliveryPilotCandidate,
  deliveryPilotVars,
  projectJobsPilotPlan,
} from "./delivery-pilot-candidate.mjs";
import { PREVIEW_SOFTWARE_TEMPLATE_ID } from "./host-identity.mjs";

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const issuer = {
    keyId: "pilot",
    publicKeySHA256: createHash("sha256")
      .update(keys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    scope: { templateId: PREVIEW_SOFTWARE_TEMPLATE_ID, hiveOrigin: "https://preview.example" },
  };
  const pins = {
    workspace: "1".repeat(64),
    voice: "2".repeat(64),
    agent: "3".repeat(64),
    helper: "4".repeat(64),
  };
  const guardian = {
    packageManifestSha256: "5".repeat(64),
    guardianElfSha256: "6".repeat(64),
    nodeSha256: "7".repeat(64),
    protocol: "guardian-v1",
    policyDigest: "8".repeat(64),
    metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
  };
  const input = {
    enabled: true,
    updating: true,
    nativeCandidate: true,
    issuer,
    pins,
    catalog: { schemaVersion: 1, model: "test-model", effort: "high", guardian },
  };
  const candidate = deliveryPilotCandidate(input);
  const record = {
    deliveryPilotCandidate: candidate,
    deploymentMode: "update-preview",
    nativeGatewayCandidate: true,
    nativeIssuer: issuer,
    workspaceProjectsCandidate: {
      templateId: PREVIEW_SOFTWARE_TEMPLATE_ID,
      profile: "software",
      manifestSha256: pins.workspace,
    },
  };
  const app = {
    vars: {
      HIVE_DISABLE_BACKGROUND_WORKERS: "true",
      HIVE_CODEX_GATEWAY_ENABLED: "true",
      HIVE_CODEX_ISSUER_KEY_ID: issuer.keyId,
      HIVE_CODEX_HIVE_ORIGIN: issuer.scope.hiveOrigin,
      HIVE_PREVIEW_ORIGIN: issuer.scope.hiveOrigin,
      HIVE_CODEX_SOFTWARE_TEMPLATE_IDS: PREVIEW_SOFTWARE_TEMPLATE_ID,
      HIVE_CODEX_ISSUER_PUBLIC_KEY: publicKey,
      ...deliveryPilotVars(candidate, issuer),
    },
  };
  const secrets = {
    PREVIEW_BEARER: "a".repeat(64),
    HIVE_PROJECT_TASK_RECONCILE_SECRET: "b".repeat(64),
  };
  return { input, pins, record, app, secrets };
}
test("pilot binds scoped policy, installed pins and issuer keys", () => {
  const f = fixture();
  assertDeliveryPilot(f.record, f.app, f.secrets, f.pins);
  for (const mutate of [
    (f) => (f.app.vars.HIVE_PROJECT_TASKS_ENABLED = "false"),
    (f) => (f.pins.agent = "a".repeat(64)),
    (f) => (f.secrets.HIVE_PROJECT_TASK_RECONCILE_SECRET = f.secrets.PREVIEW_BEARER),
    (f) =>
      (f.app.vars.HIVE_CODEX_ISSUER_PUBLIC_KEY = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString()),
    (f) => (f.record.nativeGatewayCandidate = false),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => assertDeliveryPilot(x.record, x.app, x.secrets, x.pins));
  }
});
test("job plan is private and schedule remains proposed only", () => {
  const p = projectJobsPilotPlan("b".repeat(64));
  assert.deepEqual(p.triggers.crons, []);
  assert.equal(p.plannedCron, "*/5 * * * *");
  assert.deepEqual(p.secretNames, ["HIVE_PROJECT_TASK_RECONCILE_SECRET"]);
});
