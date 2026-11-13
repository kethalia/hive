import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildReady } from "../app/build-integrity.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const configPath = resolve(root, "deploy/cloudflare/native/wrangler.jsonc");
export function deploymentPlan(target, branch, config, profiles) {
  assert.equal(target, "preview", "Production activation requires the P11 cutover package");
  assert.equal(config.name, "hive");
  assert.equal(config.account_id, "225177f82b9234ede14e897fe15e0cb5");
  assert.equal(config.main, "worker.ts");
  assert.equal(config.vars.HIVE_NATIVE_MODE, "bootstrap");
  assert.ok(
    branch !== "main" && Object.hasOwn(profiles, branch),
    "Preview branch requires a reviewed profile",
  );
  const profile = profiles[branch];
  const vars = config.previews.vars;
  assert.equal(vars.HIVE_NATIVE_MODE, "preview");
  assert.equal(vars.HIVE_PUBLIC_ORIGIN, profile.origin);
  assert.equal(vars.HIVE_DATABASE_NAME, profile.databaseName);
  assert.equal(vars.HIVE_DATABASE_ROLE, profile.databaseRole);
  assert.equal(vars.HIVE_RUNTIME_TARGET, "cloudflare");
  assert.equal(vars.HIVE_DISABLE_BACKGROUND_WORKERS, "true");
  assert.equal(vars.HIVE_GENERIC_TERMINAL_ENABLED, "true");
  assert.equal(vars.HIVE_TERMINAL_WS_URL, "/");
  assert.equal(vars.CODER_URL, "https://coder.kethalia.com");
  assert.deepEqual(config.triggers.crons, []);
  for (const section of ["services", "durable_objects", "workflows", "queues", "r2_buckets"]) {
    assert.equal(config[section], undefined, `Unexpected foundation binding ${section}`);
    assert.equal(config.previews[section], undefined, `Unexpected preview binding ${section}`);
  }
  return { branch, origin: profile.origin, databaseName: profile.databaseName };
}

async function main() {
  const [target, ...flags] = process.argv.slice(2);
  assert.ok(flags.every((flag) => flag === "--check"));
  const branch =
    process.env.WORKERS_CI_BRANCH ??
    execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  const plan = deploymentPlan(
    target,
    branch,
    JSON.parse(readFileSync(configPath, "utf8")),
    JSON.parse(
      readFileSync(resolve(root, "deploy/cloudflare/native/preview-profiles.json"), "utf8"),
    ),
  );
  await assertBuildReady(root);
  if (flags.includes("--check")) {
    console.log(JSON.stringify(plan));
    return;
  }
  // Existing repository-connected Workers Builds supplies its configured credential.
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "preview", "--config", configPath, "--name", plan.branch],
    { cwd: root, stdio: "inherit" },
  );
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await main();
