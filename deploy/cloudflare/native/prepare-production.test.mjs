import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { account } from "./deploy.mjs";
import { digest, prepareProduction, publicationRecipe } from "./prepare-production.mjs";

const config = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url)));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function fixture() {
  const revision = "a".repeat(40),
    readyBytes = json({ schemaVersion: 1 });
  const proofBytes = json({
    testedRevision: revision,
    testedSourceCommitted: true,
    sourceStable: true,
    nativeEntrypoint: true,
    inlineAuthAndRequestLifetimeVerified: true,
    result: { ok: true },
    httpStatus: 200,
    appBuildReadySHA256: digest(readyBytes),
  });
  const manifest = {
    schemaVersion: 1,
    sourceRevision: revision,
    origin: "https://hive.example.com",
    route: { pattern: "hive.example.com/*", zone_id: "b".repeat(32) },
    secretNames: ["AUTH_SERVICE_SECRET", "COOKIE_SECRET", "DATABASE_URL", "ENCRYPTION_KEY"],
    databaseIdentity: {
      projectId: "prod-project",
      branchId: "prod-branch",
      database: "hive",
      role: "hive_runtime",
    },
    r2Buckets: [],
    baseline: {
      accountId: account,
      workerName: "hive",
      workerTag: "tag-1",
      createdOn: "2026-11-05T00:00:00Z",
      deploymentId: "deployment-1",
      versionId: "version-1",
      settingsDigest: "c".repeat(64),
      inactive: true,
    },
    evidenceDigests: { buildReady: digest(readyBytes), nativeProof: digest(proofBytes) },
  };
  return {
    manifest,
    config,
    readyBytes,
    proofBytes,
    revision,
    branch: "main",
    clean: true,
    root: "/tmp/production-source",
  };
}
function approval(record) {
  return {
    schemaVersion: 1,
    action: "activate-first-production",
    preparationDigest: digest(json(record)),
    approvedBy: "operator-after-user-approval",
    approvedAt: "2026-11-05T00:00:00Z",
    expiresAt: "2026-11-05T00:10:00Z",
    resourceAndSecretIdentitiesVerified: true,
    schedulerHandoverVerified: true,
    rollbackRehearsalVerified: true,
  };
}
test("offline preparation pins one production Worker and leaves all scheduling/execution off", () => {
  const input = fixture(),
    result = prepareProduction(input),
    { record } = result;
  assert.equal(record.activationAuthorized, false);
  assert.equal(record.providerBaselineVerified, false);
  assert.equal(record.production.name, "hive");
  assert.equal(record.production.vars.HIVE_NATIVE_PRODUCTION_ACTIVE, "true");
  assert.equal(record.production.vars.HIVE_NATIVE_PREVIEW_ENABLED, "false");
  assert.equal(record.production.vars.HIVE_CODER_OAUTH_ENABLED, "false");
  assert.equal(record.production.vars.HIVE_CODER_OAUTH_CLIENT_ID, undefined);
  assert.equal(record.production.vars.HIVE_CODER_OAUTH_CLIENT_SECRET, undefined);
  assert.equal(record.production.vars.HIVE_DELIVERY_ENABLED, "false");
  assert.equal(record.production.vars.HIVE_PROJECT_TASKS_ENABLED, "false");
  assert.deepEqual(record.production.triggers.crons, []);
  assert.equal(record.production.services, undefined);
  assert.equal(record.production.previews, undefined);
  assert.equal(record.configDigest, digest(result.configBytes));
});
test("production bootstrap excludes independently enabled Preview execution and authority", () => {
  const input = fixture();
  input.config = structuredClone(input.config);
  for (const name of [
    "HIVE_PROJECT_DISCOVERY_ENABLED",
    "HIVE_PROJECT_TASKS_ENABLED",
    "HIVE_DELIVERY_ENABLED",
    "HIVE_CODEX_GATEWAY_ENABLED",
    "HIVE_GUARDIAN_ENABLED",
    "HIVE_DELIVERY_EXECUTION_ENABLED",
  ])
    input.config.previews.vars[name] = "true";
  const { record, configBytes } = prepareProduction(input);
  for (const [name, value] of Object.entries(record.production.vars))
    if (name.endsWith("_ENABLED")) assert.equal(value, "false", name);
  for (const name of [
    "HIVE_CODEX_ISSUER_KEY_ID",
    "HIVE_CODEX_ISSUER_PUBLIC_KEY",
    "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
    "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
    "HIVE_DELIVERY_ACCEPTANCE_PRODUCER",
    "HIVE_CODEX_HIVE_ORIGIN",
    "HIVE_PREVIEW_ORIGIN",
  ])
    assert.equal(Object.hasOwn(record.production.vars, name), false, name);
  assert.equal(configBytes.includes("b00ste.workers.dev"), false);
  assert.equal(record.production.r2_buckets, undefined);
  assert.equal(record.activationAuthorized, false);
});
test("candidate source, dirty tree, stale evidence and wrong native proof fail closed", () => {
  for (const mutate of [
    (x) => {
      x.branch = "codex/candidate";
    },
    (x) => {
      x.clean = false;
    },
    (x) => {
      x.revision = "d".repeat(40);
    },
    (x) => {
      x.readyBytes += " ";
    },
    (x) => {
      x.proofBytes += " ";
    },
    (x) => {
      const p = JSON.parse(x.proofBytes);
      p.nativeEntrypoint = false;
      x.proofBytes = json(p);
      x.manifest.evidenceDigests.nativeProof = digest(x.proofBytes);
    },
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => prepareProduction(x));
  }
});
test("production rejects resource ambiguity, preview data, route drift and secret values", () => {
  for (const mutate of [
    (m) => {
      m.origin = "https://a-hive.b00ste.workers.dev";
    },
    (m) => {
      m.route.pattern = "*.example.com/*";
    },
    (m) => {
      m.databaseIdentity.database = "hive_native_preview";
    },
    (m) => {
      m.secretNames.push("PREVIEW_BEARER");
    },
    (m) => {
      m.DATABASE_URL = "postgres://synthetic";
    },
    (m) => {
      m.baseline.workerName = "other";
    },
    (m) => {
      m.baseline.inactive = false;
    },
    (m) => {
      m.r2Buckets = [{ binding: "OTHER", bucket_name: "production-evidence" }];
    },
  ]) {
    const x = fixture();
    mutate(x.manifest);
    assert.throws(() => prepareProduction(x));
  }
});
test("operator approval is separately bound to the complete preparation and fresh unchanged baseline", () => {
  const result = prepareProduction(fixture());
  const args = {
    ...result,
    authorization: approval(result.record),
    freshBaseline: {
      observedAt: "2026-11-05T00:05:00Z",
      baseline: structuredClone(result.record.baseline),
    },
    configPath: "/private/cutover/wrangler.production.json",
    secretsPath: "/private/cutover/secrets.json",
    now: Date.parse("2026-11-05T00:05:00Z"),
  };
  const command = publicationRecipe(args);
  assert.deepEqual(command.slice(0, 4), ["pnpm", "exec", "wrangler", "deploy"]);
  assert.ok(command.includes("--strict"));
  for (const mutate of [
    (x) => {
      x.authorization = undefined;
    },
    (x) => {
      x.authorization.preparationDigest = "f".repeat(64);
    },
    (x) => {
      x.authorization.schedulerHandoverVerified = false;
    },
    (x) => {
      x.now = Date.parse("2026-11-05T00:10:00Z");
    },
    (x) => {
      x.now = Date.parse("2026-11-04T00:00:00Z");
    },
    (x) => {
      x.freshBaseline.baseline.deploymentId = "changed";
    },
    (x) => {
      x.freshBaseline.observedAt = "2026-11-04T00:00:00Z";
    },
    (x) => {
      x.configBytes += " ";
    },
  ]) {
    const x = structuredClone(args);
    mutate(x);
    assert.throws(() => publicationRecipe(x));
  }
});

function oauthFixture() {
  const input = fixture();
  input.manifest.origin = "https://hive.kethalia.com";
  input.manifest.route.pattern = "hive.kethalia.com/*";
  input.manifest.secretNames.push("HIVE_CODER_OAUTH_CLIENT_SECRET");
  input.manifest.oauthEnrollment = {
    coderOrigin: "https://coder.kethalia.com",
    clientId: "independent-production-client",
    callbackUri: "https://hive.kethalia.com/api/auth/coder/callback",
    secretName: "HIVE_CODER_OAUTH_CLIENT_SECRET",
  };
  return input;
}
test("explicit production OAuth enrollment emits only independently pinned public metadata", () => {
  const input = oauthFixture();
  const originalConfig = structuredClone(input.config);
  const { record, configBytes } = prepareProduction(input);
  assert.equal(record.production.vars.HIVE_CODER_OAUTH_ENABLED, "true");
  assert.equal(
    record.production.vars.HIVE_CODER_OAUTH_CLIENT_ID,
    input.manifest.oauthEnrollment.clientId,
  );
  assert.equal(record.production.vars.CODER_URL, "https://coder.kethalia.com");
  assert.equal(record.production.vars.HIVE_PUBLIC_ORIGIN, "https://hive.kethalia.com");
  assert.equal(record.production.vars.HIVE_CODER_OAUTH_CLIENT_SECRET, undefined);
  assert.deepEqual(record.oauthEnrollment, input.manifest.oauthEnrollment);
  assert.deepEqual(record.production.secrets.required, [...input.manifest.secretNames].sort());
  assert.equal(configBytes.includes(input.config.previews.vars.HIVE_CODER_OAUTH_CLIENT_ID), false);
  assert.equal(record.activationAuthorized, false);
  assert.equal(record.providerBaselineVerified, false);
  assert.deepEqual(input.config, originalConfig);
});
test("production OAuth rejects callback, issuer, production origin, preview client and secret ambiguity", () => {
  for (const mutate of [
    (m) => {
      m.oauthEnrollment.callbackUri += "?extra=true";
    },
    (m) => {
      m.oauthEnrollment.callbackUri = "https://hive.kethalia.com/other";
    },
    (m) => {
      m.oauthEnrollment.callbackUri = "https://other.example/api/auth/coder/callback";
    },
    (m) => {
      m.oauthEnrollment.coderOrigin = "https://other.example";
    },
    (m) => {
      m.origin = "https://other.example";
      m.route.pattern = "other.example/*";
    },
    (m) => {
      m.oauthEnrollment.clientId = config.previews.vars.HIVE_CODER_OAUTH_CLIENT_ID;
    },
    (m) => {
      m.oauthEnrollment.clientId = "";
    },
    (m) => {
      m.oauthEnrollment.clientId = "invalid\nclient";
    },
    (m) => {
      m.oauthEnrollment.secretName = "OTHER_CLIENT_SECRET";
    },
    (m) => {
      m.oauthEnrollment.clientSecret = "must-never-be-a-manifest-value";
    },
    (m) => {
      m.oauthEnrollment.HIVE_CODER_OAUTH_CLIENT_SECRET = "value";
    },
    (m) => {
      delete m.oauthEnrollment.callbackUri;
    },
    (m) => {
      m.secretNames.pop();
    },
    (m) => {
      delete m.oauthEnrollment;
    },
    (m) => {
      m.oauthEnrollment = null;
    },
  ]) {
    const input = oauthFixture();
    mutate(input.manifest);
    assert.throws(() => prepareProduction(input));
  }
});
test("production OAuth publication still needs exact package approval and unchanged inactive baseline", () => {
  const result = prepareProduction(oauthFixture());
  const args = {
    ...result,
    authorization: approval(result.record),
    freshBaseline: {
      observedAt: "2026-11-05T00:05:00Z",
      baseline: structuredClone(result.record.baseline),
    },
    configPath: "/private/cutover/wrangler.production.json",
    secretsPath: "/private/cutover/secrets.json",
    now: Date.parse("2026-11-05T00:05:00Z"),
  };
  assert.equal(publicationRecipe(args).includes("--strict"), true);
  const changed = structuredClone(args);
  changed.record.oauthEnrollment.clientId = "another-production-client";
  assert.throws(() => publicationRecipe(changed));
  const changedBaseline = structuredClone(args);
  changedBaseline.freshBaseline.baseline.versionId = "changed";
  assert.throws(() => publicationRecipe(changedBaseline));
  assert.throws(() => publicationRecipe({ ...args, authorization: undefined }));
});
