import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildReady } from "../app/build-integrity.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const configPath = resolve(root, "deploy/cloudflare/native/wrangler.jsonc");
export function deploymentPlan(target, branch, config, profiles) {
  assert.ok(["preview", "production"].includes(target), "Unknown deployment target");
  assert.equal(config.name, "hive");
  assert.equal(config.account_id, "225177f82b9234ede14e897fe15e0cb5");
  assert.equal(config.main, "worker.ts");
  assert.deepEqual(config.routes, [
    { pattern: "hive.kethalia.com", custom_domain: true },
    {
      pattern: "hive-preview.kethalia.com",
      custom_domain: true,
      enabled: false,
      previews_enabled: true,
    },
  ]);
  assert.equal(config.previews.routes, undefined, "Preview cannot route the production domain");
  assert.deepEqual(config.secrets.required, [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "COOKIE_SECRET",
    "AUTH_SERVICE_SECRET",
    "CODER_OAUTH_CLIENT_SECRET",
    "HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY",
  ]);
  let profile;
  let vars;
  if (target === "production") {
    assert.equal(branch, "main", "Production deployment requires main");
    profile = {
      origin: "https://hive.kethalia.com",
      databaseName: "hive_production",
      databaseRole: "hive_production_runtime",
      coderOAuthEnabled: true,
      workspaceAccounts: true,
    };
    vars = config.vars;
    assert.equal(vars.HIVE_PREVIEW_ORIGIN_ALIAS, undefined);
  } else {
    assert.ok(
      branch !== "main" && Object.hasOwn(profiles, branch),
      "Preview branch requires a reviewed profile",
    );
    profile = profiles[branch];
    assert.notEqual(profile.origin, "https://hive.kethalia.com");
    assert.ok(Number.isInteger(profile.schemaMigrations) && profile.schemaMigrations >= 7);
    assert.notEqual(profile.databaseName, "hive_production");
    assert.notEqual(profile.databaseRole, "hive_production_runtime");
    vars = config.previews.vars;
    assert.equal(vars.HIVE_PREVIEW_ORIGIN_ALIAS, profile.alias);
  }
  for (const origin of [profile.origin, profile.alias].filter((value) => value !== undefined)) {
    const url = new URL(origin);
    assert.equal(url.protocol, "https:");
    assert.equal(url.origin, origin);
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
  if (profile.coderOAuthEnabled) assert.equal(vars.HIVE_CODER_OAUTH_ENABLED, "true");
  if (profile.workspaceAccounts) {
    assert.equal(vars.HIVE_CODEX_ACCOUNTS_ENABLED, "true");
    assert.equal(vars.HIVE_CLAUDE_ACCOUNTS_ENABLED, "true");
    assert.equal(vars.HIVE_AGENT_TOOLS_TRANSPORT, "workspace-app");
    assert.equal(vars.HIVE_WORKSPACE_ISSUER_MODE, "dedicated");
    assert.equal(vars.HIVE_AGENT_TOOLS_HIVE_ORIGIN, profile.origin);
    assert.match(vars.HIVE_AGENT_TOOLS_ISSUER_KEY_ID, /^[A-Za-z0-9._-]{1,64}$/);
    assert.equal(vars.HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY, undefined);
    const pins = JSON.parse(vars.HIVE_AGENT_TOOLS_PINS_JSON);
    assert.ok(Array.isArray(pins) && pins.length > 0 && pins.length <= 32);
    assert.equal(new Set(pins.map((pin) => pin.templateId)).size, pins.length);
    const asset = (name) =>
      readFileSync(
        resolve(root, `templates/ai-dev-k8s/assets/agent-bridge.${name}.sha256`),
        "utf8",
      ).trim();
    for (const pin of pins) {
      assert.match(pin.templateId, /^[0-9a-f-]{36}$/);
      assert.ok(
        ["software", "browser", "game", "electronics", "infrastructure"].includes(pin.profile),
      );
      assert.equal(pin.manifestSha256, asset("manifest"));
      assert.equal(pin.helperSha256, asset("helper"));
    }
  }
  assert.equal(vars.HIVE_NATIVE_MODE, target);
  assert.equal(vars.HIVE_PUBLIC_ORIGIN, profile.origin);
  assert.equal(vars.HIVE_DATABASE_NAME, profile.databaseName);
  assert.equal(vars.HIVE_DATABASE_ROLE, profile.databaseRole);
  assert.equal(vars.HIVE_RUNTIME_TARGET, "cloudflare");
  assert.equal(vars.HIVE_DISABLE_BACKGROUND_WORKERS, "true");
  assert.equal(vars.HIVE_GENERIC_TERMINAL_ENABLED, "true");
  assert.equal(vars.HIVE_TERMINAL_WS_URL, "/");
  assert.equal(vars.CODER_URL, "https://coder.kethalia.com");
  assert.equal(vars.ALLOWED_CODER_URLS, "https://coder.kethalia.com");
  assert.equal(vars.HIVE_TERMINAL_PASTE_ENABLED, "true");
  assert.equal(vars.HIVE_CODEX_VOICE_ENABLED, "true");
  assert.deepEqual(config.triggers.crons, ["17 * * * *"]);
  const background = { bindings: [{ name: "BACKGROUND", class_name: "HiveBackground" }] };
  assert.deepEqual(config.durable_objects, background);
  assert.deepEqual(config.previews.durable_objects, background);
  assert.deepEqual(config.migrations, [
    { tag: "hive-background-v1", new_sqlite_classes: ["HiveBackground"] },
  ]);
  for (const section of ["services", "workflows", "queues", "r2_buckets"]) {
    assert.equal(config[section], undefined, `Unexpected foundation binding ${section}`);
    assert.equal(config.previews[section], undefined, `Unexpected preview binding ${section}`);
  }
  return { branch, origin: profile.origin, databaseName: profile.databaseName };
}

export function deploymentArguments(target, plan, path = configPath) {
  assert.ok(["preview", "production"].includes(target));
  return target === "production"
    ? ["exec", "wrangler", "deploy", "--config", path]
    : ["exec", "wrangler", "preview", "--config", path, "--name", plan.branch];
}

async function main() {
  const [target, ...flags] = process.argv.slice(2);
  assert.ok(flags.every((flag) => flag === "--check"));
  const branch =
    process.env.WORKERS_CI_BRANCH ??
    execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  const profiles = JSON.parse(
    readFileSync(resolve(root, "deploy/cloudflare/native/preview-profiles.json"), "utf8"),
  );
  if (target === "preview" && process.env.WORKERS_CI === "1" && !Object.hasOwn(profiles, branch)) {
    console.log(JSON.stringify({ branch, status: "skipped", reason: "preview_profile_missing" }));
    return;
  }
  const plan = deploymentPlan(
    target,
    branch,
    JSON.parse(readFileSync(configPath, "utf8")),
    profiles,
  );
  await assertBuildReady(root);
  if (flags.includes("--check")) {
    console.log(JSON.stringify(plan));
    return;
  }
  // Existing repository-connected Workers Builds supplies its configured credential.
  execFileSync("pnpm", deploymentArguments(target, plan), { cwd: root, stdio: "inherit" });
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await main();
