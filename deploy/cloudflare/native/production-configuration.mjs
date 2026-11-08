// Public configuration only. Runtime policy modules validate enrolled policy content.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const account = "225177f82b9234ede14e897fe15e0cb5";
export const productionTarget = Object.freeze({
  accountId: account,
  workerName: "hive",
  zoneId: "b5a1ed758b9cd1c62fcacf9037dc0dea",
  zoneName: "kethalia.com",
  hostname: "hive.kethalia.com",
});
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
export const publicDigest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
export const exact = (value, keys) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
export function createProductionConfiguration({ manifest, config, root, oauthEnrollment }) {
  const productionVars = {
    CODER_URL: config.previews.vars.CODER_URL,
    HIVE_RUNTIME_TARGET: "cloudflare",
    HIVE_DISABLE_BACKGROUND_WORKERS: "true",
    HIVE_PROJECT_DISCOVERY_ENABLED: "false",
    HIVE_PROJECT_TASKS_ENABLED: "false",
    HIVE_DELIVERY_ENABLED: "false",
    HIVE_CODEX_GATEWAY_ENABLED: "false",
    HIVE_DELIVERY_DISPATCH_ENABLED: "false",
    HIVE_TOKEN_ROTATION_ENABLED: "false",
  };
  return {
    name: "hive",
    account_id: account,
    main: join(root, "deploy/cloudflare/native/worker.ts"),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    assets: { ...config.assets, directory: join(root, ".open-next/assets") },
    limits: config.limits,
    routes: [manifest.route],
    triggers: { crons: [] },
    secrets: { required: [...manifest.secretNames].sort() },
    vars: {
      ...productionVars,
      HIVE_CODER_OAUTH_ENABLED: oauthEnrollment ? "true" : "false",
      ...(oauthEnrollment
        ? {
            CODER_URL: oauthEnrollment.coderOrigin,
            HIVE_CODER_OAUTH_CLIENT_ID: oauthEnrollment.clientId,
          }
        : {}),
      HIVE_NATIVE_MODE: "production",
      HIVE_NATIVE_PREVIEW_ENABLED: "false",
      HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
      HIVE_PUBLIC_ORIGIN: manifest.origin,
    },
    ...(manifest.r2Buckets.length ? { r2_buckets: manifest.r2Buckets } : {}),
  };
}

const featureNames = [
  "HIVE_PROJECT_DISCOVERY_ENABLED",
  "HIVE_PROJECT_TASKS_ENABLED",
  "HIVE_DELIVERY_ENABLED",
  "HIVE_CODEX_GATEWAY_ENABLED",
  "HIVE_GUARDIAN_ENABLED",
  "HIVE_GUARDIAN_PRODUCER_ENABLED",
  "HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED",
  "HIVE_DELIVERY_MANAGER_ENABLED",
  "HIVE_DELIVERY_EXECUTION_ENABLED",
  "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
  "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
  "HIVE_DELIVERY_NATIVE_ENABLED",
  "HIVE_DELIVERY_GITHUB_SOURCE_ENABLED",
  "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED",
  "HIVE_DELIVERY_EPICS_ENABLED",
  "HIVE_DELIVERY_EPIC_MERGE_ENABLED",
  "HIVE_DELIVERY_RELEASE_ENABLED",
  "HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED",
  "HIVE_DELIVERY_RELEASE_TESTED_ENABLED",
  "HIVE_DELIVERY_DATABASE_ENABLED",
  "HIVE_NATIVE_HEALTH_ENABLED",
  "HIVE_CODEX_ACCOUNTS_ENABLED",
  "HIVE_CLAUDE_ACCOUNTS_ENABLED",
  "HIVE_AGENT_TOOLS_ENABLED",
  "HIVE_WORKSPACE_READ_ENABLED",
  "HIVE_CODEX_VOICE_ENABLED",
  "HIVE_GENERIC_TERMINAL_ENABLED",
  "HIVE_CODEX_TERMINAL_ENABLED",
  "HIVE_TERMINAL_PASTE_ENABLED",
  "HIVE_DELIVERY_DISPATCH_ENABLED",
  "HIVE_TOKEN_ROTATION_ENABLED",
  "HIVE_TOKEN_WARNING_DISPATCH_ENABLED",
  "HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED",
  "HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED",
  "HIVE_AGENT_NOTIFICATION_DISPATCH_ENABLED",
  "HIVE_TEMPLATE_NOTIFICATION_DISPATCH_ENABLED",
  "HIVE_TEMPLATE_PUBLICATION_ENABLED",
  "HIVE_TEMPLATE_LOG_VIEW_ENABLED",
  "HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED",
];
const fixedPublic = {
  CODER_URL: "https://coder.kethalia.com",
  HIVE_RUNTIME_TARGET: "cloudflare",
  HIVE_DISABLE_BACKGROUND_WORKERS: "true",
  HIVE_NATIVE_PREVIEW_ENABLED: "false",
  HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
  HIVE_PUBLIC_ORIGIN: "https://hive.kethalia.com",
  HIVE_CODEX_HIVE_ORIGIN: "https://hive.kethalia.com",
  HIVE_AGENT_TOOLS_HIVE_ORIGIN: "https://hive.kethalia.com",
  HIVE_WORKSPACE_READ_HIVE_ORIGIN: "https://hive.kethalia.com",
  HIVE_VOICE_ALLOWED_ORIGINS: "https://hive.kethalia.com",
  HIVE_TERMINAL_WS_URL: "/",
  HIVE_CODER_OAUTH_ENABLED: "true",
};
const jsonPublic = new Set([
  "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
  "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
  "HIVE_DELIVERY_ACCEPTANCE_PRODUCER",
  "HIVE_DELIVERY_EPIC_MODEL_TIERS_JSON",
  "HIVE_DELIVERY_EPIC_ISOLATION_POLICY",
  "HIVE_DELIVERY_EPIC_MERGE_CONFIG_JSON",
  "HIVE_DELIVERY_RELEASE_CONFIG_JSON",
  "HIVE_DELIVERY_DATABASE_CATALOGS_JSON",
  "HIVE_DELIVERY_SOURCE_POLICIES_JSON",
  "HIVE_DELIVERY_GITHUB_TARGETS_JSON",
  "HIVE_AGENT_TOOLS_PINS_JSON",
  "HIVE_WORKSPACE_READ_PROFILES_JSON",
  "HIVE_VOICE_TEMPLATE_PINS_JSON",
]);
const stringPublic = new Set([
  "HIVE_CODEX_ISSUER_KEY_ID",
  "HIVE_CODEX_ISSUER_PUBLIC_KEY",
  "HIVE_CODEX_SOFTWARE_TEMPLATE_IDS",
  "HIVE_CODEX_APP_SLUG",
  "HIVE_CODEX_GATEWAY_PORT",
  "HIVE_CODEX_SESSION_TRANSPORT",
  "HIVE_CODEX_MANAGER_MODEL",
  "HIVE_CODEX_MANAGER_EFFORT",
  "HIVE_CODER_OAUTH_CLIENT_ID",
  "HIVE_AGENT_TOOLS_ISSUER_KEY_ID",
  "HIVE_AGENT_TOOLS_TRANSPORT",
  "HIVE_WORKSPACE_READ_ISSUER_KEY_ID",
  "HIVE_WORKSPACE_ISSUER_MODE",
  "HIVE_VOICE_ISSUER_KEY_ID",
  "HIVE_VOICE_TRANSPORT",
  "VAPID_SUBJECT",
]);
// Shared by enrollment and provider readback. Only explicitly public bindings
// enter the digest. Secret bindings are projected to name/type before this runs.
export function productionPublicVariable(name, value) {
  assert.equal(typeof value, "string");
  assert.ok(Buffer.byteLength(value) <= 262144);
  if (name === "HIVE_NATIVE_MODE") assert.ok(["bootstrap", "production"].includes(value));
  else if (Object.hasOwn(fixedPublic, name)) {
    // Historical bootstrap readback may have OAuth disabled.
    if (name === "HIVE_CODER_OAUTH_ENABLED") assert.ok(["true", "false"].includes(value));
    else assert.equal(value, fixedPublic[name]);
  } else if (featureNames.includes(name) || name === "HIVE_PREVIEW_ACCESS_REQUIRED")
    assert.ok(["true", "false"].includes(value));
  else if (jsonPublic.has(name)) {
    const parsed = JSON.parse(value);
    assert.ok(parsed && typeof parsed === "object");
  } else {
    assert.ok(stringPublic.has(name), "Unsupported public production setting");
    assert.ok(value.length > 0);
  }
  return value;
}

export function validateManagedProductionConfiguration(configuration, mode, config) {
  exact(configuration, [
    "origin",
    "route",
    "oauthEnrollment",
    "secretNames",
    "databaseIdentity",
    "r2Buckets",
    "vars",
    "crons",
  ]);
  assert.equal(configuration.origin, "https://hive.kethalia.com");
  assert.deepEqual(configuration.route, {
    pattern: "hive.kethalia.com/*",
    zone_id: productionTarget.zoneId,
  });
  const oauth = configuration.oauthEnrollment;
  exact(oauth, ["coderOrigin", "clientId", "callbackUri", "secretName"]);
  assert.equal(oauth.coderOrigin, "https://coder.kethalia.com");
  assert.equal(oauth.clientId, "0a4e5cd5-cf36-4c56-927c-effe349286c8");
  assert.notEqual(oauth.clientId, config.previews.vars.HIVE_CODER_OAUTH_CLIENT_ID);
  assert.equal(oauth.callbackUri, `${configuration.origin}/api/auth/coder/callback`);
  assert.equal(oauth.secretName, "HIVE_CODER_OAUTH_CLIENT_SECRET");
  exact(configuration.databaseIdentity, ["projectId", "branchId", "database", "role"]);
  for (const value of Object.values(configuration.databaseIdentity)) {
    assert.match(value, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.ok(!/preview|synthetic/i.test(value));
  }
  assert.ok(Array.isArray(configuration.r2Buckets) && configuration.r2Buckets.length <= 1);
  for (const bucket of configuration.r2Buckets) {
    exact(bucket, ["binding", "bucket_name"]);
    assert.equal(bucket.binding, "HIVE_DELIVERY_EVIDENCE");
    assert.match(bucket.bucket_name, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    assert.ok(!/preview|synthetic/i.test(bucket.bucket_name));
  }
  assert.ok(
    configuration.vars &&
      typeof configuration.vars === "object" &&
      !Array.isArray(configuration.vars),
  );
  for (const [name, value] of Object.entries(configuration.vars)) {
    productionPublicVariable(name, value);
    // The constructor owns these fixed values, not caller overrides.
    if (Object.hasOwn(fixedPublic, name)) assert.equal(value, fixedPublic[name]);
    assert.notEqual(name, "HIVE_NATIVE_MODE");
    assert.notEqual(name, "HIVE_CODER_OAUTH_CLIENT_ID");
    assert.notEqual(name, "HIVE_PREVIEW_ACCESS_REQUIRED");
  }
  assert.ok(Array.isArray(configuration.crons));
  assert.ok(new Set(configuration.crons).size === configuration.crons.length);
  for (const cron of configuration.crons) assert.ok(["* * * * *", "*/5 * * * *"].includes(cron));
  if (mode === "first-cutover") {
    assert.deepEqual(configuration.vars, {});
    assert.deepEqual(configuration.crons, []);
  }
  const secrets = [
    "AUTH_SERVICE_SECRET",
    "COOKIE_SECRET",
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "HIVE_CODER_OAUTH_CLIENT_SECRET",
  ];
  const optionalSecrets = [
    "HIVE_CODEX_ISSUER_PRIVATE_KEY",
    "HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY",
    "HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY",
    "HIVE_VOICE_ISSUER_PRIVATE_KEY",
    "HIVE_PROJECT_TASK_RECONCILE_SECRET",
  ];
  assert.ok(Array.isArray(configuration.secretNames));
  assert.equal(new Set(configuration.secretNames).size, configuration.secretNames.length);
  for (const name of configuration.secretNames)
    assert.ok(
      secrets.includes(name) || (mode === "ongoing-main" && optionalSecrets.includes(name)),
    );
  for (const name of secrets) assert.ok(configuration.secretNames.includes(name));
  if (configuration.vars.HIVE_PROJECT_TASKS_ENABLED === "true")
    assert.ok(configuration.secretNames.includes("HIVE_PROJECT_TASK_RECONCILE_SECRET"));
  if (configuration.vars.HIVE_CODEX_GATEWAY_ENABLED === "true")
    assert.ok(configuration.secretNames.includes("HIVE_CODEX_ISSUER_PRIVATE_KEY"));
  const shared = configuration.vars.HIVE_WORKSPACE_ISSUER_MODE === "shared-host";
  for (const [flag, key] of [
    ["HIVE_AGENT_TOOLS_ENABLED", "HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY"],
    ["HIVE_WORKSPACE_READ_ENABLED", "HIVE_WORKSPACE_READ_ISSUER_PRIVATE_KEY"],
    ["HIVE_CODEX_VOICE_ENABLED", "HIVE_VOICE_ISSUER_PRIVATE_KEY"],
  ]) {
    if (configuration.vars[flag] !== "true") continue;
    if (shared) assert.equal(configuration.vars.HIVE_CODEX_GATEWAY_ENABLED, "true");
    else assert.ok(configuration.secretNames.includes(key));
  }
}

export function managedProductionConfiguration(configuration, config, root) {
  const result = createProductionConfiguration({
    manifest: configuration,
    config,
    root,
    oauthEnrollment: configuration.oauthEnrollment,
  });
  // Absent capabilities stay disabled, including when Preview enrollment is on.
  for (const name of featureNames) result.vars[name] = "false";
  Object.assign(result.vars, configuration.vars);
  result.triggers.crons = [...configuration.crons];
  return result;
}
