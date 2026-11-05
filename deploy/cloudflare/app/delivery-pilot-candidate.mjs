import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { PILOT_EVIDENCE_BUCKET } from "./delivery-pilot-bucket.mjs";
import { PREVIEW_SOFTWARE_TEMPLATE_ID } from "./host-identity.mjs";
import { workspaceProjectsCandidate } from "./workspace-projects-candidate.mjs";

const digest = (s) => assert.match(s, /^[a-f0-9]{64}$/);
const exact = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
const metadataPolicy = "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b";

/** An operator-owned catalog, never a task or model input. Pins are checked against
 * committed packages and the installed issuer before an artifact may be prepared. */
export function deliveryPilotCandidate({
  enabled,
  updating,
  nativeCandidate,
  issuer,
  catalog,
  pins,
}) {
  if (!enabled) return undefined;
  assert.equal(updating, true);
  assert.equal(nativeCandidate, true);
  assert.equal(issuer?.scope.templateId, PREVIEW_SOFTWARE_TEMPLATE_ID);
  assert.match(issuer.keyId, /^[A-Za-z0-9._-]{1,64}$/);
  exact(catalog, [
    "schemaVersion",
    "model",
    "effort",
    "guardian",
    "repositoryPolicies",
    ...(catalog.acceptanceProducer === undefined ? [] : ["acceptanceProducer"]),
    ...(catalog.evidenceBucket === undefined ? [] : ["evidenceBucket"]),
  ]);
  assert.equal(catalog.schemaVersion, 1);
  assert.match(catalog.model, /^[a-z0-9][a-z0-9._-]{0,99}$/);
  assert.ok(["low", "medium", "high", "xhigh", "max", "ultra"].includes(catalog.effort));
  const g = catalog.guardian;
  exact(g, [
    "packageManifestSha256",
    "guardianElfSha256",
    "nodeSha256",
    "protocol",
    "policyDigest",
    "metadataPolicyDigest",
  ]);
  for (const key of ["packageManifestSha256", "guardianElfSha256", "nodeSha256", "policyDigest"])
    digest(g[key]);
  assert.equal(g.protocol, "guardian-v1");
  assert.equal(g.metadataPolicyDigest, metadataPolicy);
  const check = spawnSync(
    "pnpm",
    ["exec", "tsx", "deploy/cloudflare/app/validate-delivery-pilot-policy.ts"],
    { input: JSON.stringify(catalog.repositoryPolicies), encoding: "utf8", timeout: 15000 },
  );
  assert.equal(check.status, 0, "Reviewed pilot repository catalog rejected");
  const policyDigests = JSON.parse(check.stdout);
  digest(policyDigests.catalogDigest);
  digest(policyDigests.policyDigest);
  if (catalog.acceptanceProducer !== undefined) {
    const acceptance = spawnSync(
      "pnpm",
      ["exec", "tsx", "deploy/cloudflare/app/validate-delivery-pilot-acceptance.ts"],
      { input: JSON.stringify(catalog.acceptanceProducer), encoding: "utf8", timeout: 15000 },
    );
    assert.equal(acceptance.status, 0, "Reviewed pilot acceptance producer rejected");
  }
  if (catalog.evidenceBucket !== undefined) {
    assert.ok(
      catalog.acceptanceProducer,
      "Source evidence requires independently reviewed acceptance",
    );
    assert.deepEqual(catalog.evidenceBucket, PILOT_EVIDENCE_BUCKET);
    const [entry] = catalog.repositoryPolicies;
    assert.equal(entry.ownerId, "3a8174c9-5c45-4b54-bdb8-2ed03b9b2f34");
    assert.equal(entry.repositoryId, "1183966024");
    assert.equal(entry.providerAccountId, "62855857");
    assert.equal(entry.policy.source.baseBranch, "codex/delivery-system-design");
    assert.deepEqual(entry.policy.source.allowedPrefixes, ["docs"]);
  }
  exact(pins, ["workspace", "voice", "agent", "helper"]);
  for (const value of Object.values(pins)) digest(value);
  return {
    schemaVersion: 1,
    templateId: PREVIEW_SOFTWARE_TEMPLATE_ID,
    model: catalog.model,
    effort: catalog.effort,
    guardian: g,
    repositoryPolicies: catalog.repositoryPolicies,
    repositoryCatalogDigest: policyDigests.catalogDigest,
    repositoryPolicyDigest: policyDigests.policyDigest,
    ...(catalog.acceptanceProducer === undefined
      ? {}
      : { acceptanceProducer: catalog.acceptanceProducer }),
    ...(catalog.evidenceBucket === undefined ? {} : { evidenceBucket: catalog.evidenceBucket }),
    pins,
  };
}

export function deliveryPilotVars(candidate, issuer) {
  const { templateId, pins } = candidate;
  return {
    HIVE_PUBLIC_ORIGIN: issuer.scope.hiveOrigin,
    HIVE_PROJECT_TASKS_ENABLED: "true",
    HIVE_PROJECT_DISCOVERY_ENABLED: "true",
    HIVE_WORKSPACE_READ_ENABLED: "true",
    HIVE_WORKSPACE_READ_PROFILES_JSON: JSON.stringify([
      { templateId, profile: "software", manifestSha256: pins.workspace },
    ]),
    HIVE_WORKSPACE_READ_HIVE_ORIGIN: issuer.scope.hiveOrigin,
    HIVE_WORKSPACE_READ_ISSUER_KEY_ID: issuer.keyId,
    HIVE_GENERIC_TERMINAL_ENABLED: "true",
    HIVE_TERMINAL_WS_URL: "/",
    HIVE_CODEX_TERMINAL_ENABLED: "true",
    HIVE_TERMINAL_PASTE_ENABLED: "true",
    HIVE_CODEX_VOICE_ENABLED: "true",
    HIVE_VOICE_TRANSPORT: "workspace-app",
    HIVE_VOICE_ISSUER_KEY_ID: issuer.keyId,
    HIVE_VOICE_TEMPLATE_PINS_JSON: JSON.stringify([{ templateId, manifestSha256: pins.voice }]),
    HIVE_AGENT_TOOLS_ENABLED: "true",
    HIVE_WORKSPACE_ISSUER_MODE: "shared-host",
    HIVE_AGENT_TOOLS_TRANSPORT: "workspace-app",
    HIVE_AGENT_TOOLS_HIVE_ORIGIN: issuer.scope.hiveOrigin,
    HIVE_AGENT_TOOLS_ISSUER_KEY_ID: issuer.keyId,
    HIVE_AGENT_TOOLS_PINS_JSON: JSON.stringify([
      { templateId, profile: "software", manifestSha256: pins.agent, helperSha256: pins.helper },
    ]),
    HIVE_CODEX_MANAGER_MODEL: candidate.model,
    HIVE_CODEX_MANAGER_EFFORT: candidate.effort,
    HIVE_GUARDIAN_ENABLED: "true",
    HIVE_GUARDIAN_PRODUCER_ENABLED: "true",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_DELIVERY_EXECUTION_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICIES_JSON: JSON.stringify(candidate.repositoryPolicies),
    ...(candidate.acceptanceProducer
      ? {
          HIVE_DELIVERY_ACCEPTANCE_ENABLED: "true",
          HIVE_DELIVERY_ACCEPTANCE_PRODUCER: JSON.stringify(candidate.acceptanceProducer),
          HIVE_DELIVERY_NATIVE_ENABLED: "true",
        }
      : {}),
    ...(candidate.evidenceBucket
      ? {
          HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED: "true",
          HIVE_DELIVERY_GITHUB_SOURCE_ENABLED: "true",
          HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED: "true",
        }
      : {}),
    HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: JSON.stringify([candidate.guardian]),
  };
}

export function assertDeliveryPilot(record, app, secrets, pins) {
  const candidate = record.deliveryPilotCandidate;
  assert.ok(candidate);
  const catalog = {
    schemaVersion: 1,
    model: candidate.model,
    effort: candidate.effort,
    guardian: candidate.guardian,
    repositoryPolicies: candidate.repositoryPolicies,
    ...(candidate.acceptanceProducer === undefined
      ? {}
      : { acceptanceProducer: candidate.acceptanceProducer }),
    ...(candidate.evidenceBucket === undefined ? {} : { evidenceBucket: candidate.evidenceBucket }),
  };
  assert.deepEqual(
    candidate,
    deliveryPilotCandidate({
      enabled: true,
      updating: record.deploymentMode === "update-preview",
      nativeCandidate: record.nativeGatewayCandidate,
      issuer: record.nativeIssuer,
      catalog,
      pins,
    }),
  );
  assert.deepEqual(
    record.workspaceProjectsCandidate,
    workspaceProjectsCandidate({
      enabled: true,
      updating: true,
      nativeCandidate: true,
      issuer: record.nativeIssuer,
      manifestSha256: pins.workspace,
    }),
  );
  assert.equal(app.vars.HIVE_DISABLE_BACKGROUND_WORKERS, "true");
  assert.equal(app.vars.HIVE_CODEX_GATEWAY_ENABLED, "true");
  assert.equal(app.vars.HIVE_CODEX_ISSUER_KEY_ID, record.nativeIssuer.keyId);
  assert.equal(app.vars.HIVE_CODEX_HIVE_ORIGIN, record.nativeIssuer.scope.hiveOrigin);
  assert.equal(app.vars.HIVE_PREVIEW_ORIGIN, record.nativeIssuer.scope.hiveOrigin);
  assert.equal(app.vars.HIVE_CODEX_SOFTWARE_TEMPLATE_IDS, candidate.templateId);
  if (candidate.evidenceBucket)
    assert.deepEqual(app.r2_buckets, [
      { binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: candidate.evidenceBucket.name },
    ]);
  else assert.equal(app.r2_buckets, undefined);
  assert.equal(
    record.repositoryCatalogSHA256,
    createHash("sha256").update(JSON.stringify(candidate.repositoryPolicies)).digest("hex"),
  );
  assert.equal(record.repositoryCatalogDigest, candidate.repositoryCatalogDigest);
  assert.equal(record.repositoryPolicyDigest, candidate.repositoryPolicyDigest);
  for (const flag of [
    "HIVE_DELIVERY_EPICS_ENABLED",
    "HIVE_DELIVERY_RELEASE_ENABLED",
    "HIVE_DELIVERY_DATABASE_ENABLED",
  ])
    assert.notEqual(app.vars[flag], "true");
  for (const [key, value] of Object.entries(deliveryPilotVars(candidate, record.nativeIssuer)))
    assert.equal(app.vars[key], value);
  assert.match(secrets.HIVE_PROJECT_TASK_RECONCILE_SECRET, /^[a-f0-9]{64}$/);
  assert.notEqual(secrets.HIVE_PROJECT_TASK_RECONCILE_SECRET, secrets.PREVIEW_BEARER);
  for (const name of [
    "HIVE_VOICE_ISSUER_PRIVATE_KEY",
    "HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY",
    "HIVE_CODEX_ISSUER_PRIVATE_KEY",
  ])
    assert.equal(secrets[name], undefined);
  const publicKey = createPublicKey(app.vars.HIVE_CODEX_ISSUER_PUBLIC_KEY);
  assert.equal(publicKey.asymmetricKeyType, "ed25519");
  assert.equal(
    createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    record.nativeIssuer.publicKeySHA256,
  );
}

export function projectJobsPilotPlan(reconcileSecret, sourceRevision) {
  assert.match(reconcileSecret, /^[a-f0-9]{64}$/);
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  return {
    name: "hive-jobs-compatibility-preview",
    workers_dev: false,
    preview_urls: false,
    services: [{ binding: "APP_SERVICE", service: "hive-app-compatibility-preview" }],
    vars: {
      HIVE_RUNTIME_TARGET: "cloudflare",
      HIVE_PROJECT_TASKS_ENABLED: "true",
      HIVE_DELIVERY_PILOT_MODE: "true",
      SOURCE_REVISION: sourceRevision,
    },
    limits: { cpu_ms: 100 },
    triggers: { crons: [] },
    plannedCron: "*/5 * * * *",
    secretNames: ["HIVE_PROJECT_TASK_RECONCILE_SECRET"],
  };
}
