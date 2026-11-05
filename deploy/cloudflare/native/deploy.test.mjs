import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { account, plan, previewTarget, validateConfig } from "./deploy.mjs";

const config = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url)));
const clone = () => structuredClone(config);
test("isolated bootstrap and preview config have no production data or service bindings", () => {
  validateConfig(config);
  for (const change of [
    (c) => (c.account_id = "other"),
    (c) => (c.vars.HIVE_NATIVE_MODE = "production"),
    (c) => (c.services = [{ binding: "AUTH_SERVICE", service: "production" }]),
    (c) => (c.previews.services = [{ binding: "AUTH_SERVICE", service: "production" }]),
    (c) => (c.previews.r2_buckets = [{ binding: "DATA", bucket_name: "production" }]),
    (c) => (c.previews.vars.HIVE_DELIVERY_ENABLED = "true"),
    (c) => (c.previews.vars.DATABASE_URL = "postgres://bad"),
    (c) => (c.triggers.crons = ["* * * * *"]),
  ]) {
    const c = clone();
    change(c);
    assert.throws(() => validateConfig(c));
  }
  assert.equal(config.account_id, account);
});
test("branch name and origin are deterministic, bounded, distinct and target the same name", () => {
  const a = previewTarget("codex/example-branch");
  assert.deepEqual(a, previewTarget("codex/example-branch"));
  assert.notEqual(a.name, previewTarget("codex/example_branch").name);
  assert.match(a.name, /^[a-z0-9-]{1,48}$/);
  assert.equal(a.origin, `https://${a.name}-hive.b00ste.workers.dev`);
  for (const bad of ["", "main", "MAIN", "-flag", "a b", "a\nother", "a".repeat(201)])
    assert.throws(() => previewTarget(bad));
});
test("production is check/dry-run only, while branch preview cannot target main", () => {
  assert.throws(() => plan({ branch: "main", target: "production", config }));
  assert.equal(
    plan({ branch: "main", target: "production", check: true, config }).target,
    "production",
  );
  assert.throws(() => plan({ branch: "feature", target: "production", check: true, config }));
  assert.throws(() => plan({ branch: "main", target: "preview", check: true, config }));
  assert.throws(() =>
    plan({ branch: "feature", target: "preview", check: true, dryRun: true, config }),
  );
  assert.equal(
    plan({ branch: "feature", target: "preview", check: true, config }).target,
    "preview",
  );
});

test("CLI checks do not deploy and reject a mismatched account or production action", () => {
  const script = new URL("./deploy.mjs", import.meta.url).pathname;
  const run = (branch, args, extra = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, WORKERS_CI_BRANCH: branch, CLOUDFLARE_ACCOUNT_ID: account, ...extra },
    });
  const preview = run("codex/example", ["preview", "--check"]);
  assert.equal(preview.status, 0);
  assert.equal(JSON.parse(preview.stdout).origin, previewTarget("codex/example").origin);
  assert.notEqual(
    run("codex/example", ["preview", "--check"], { CLOUDFLARE_ACCOUNT_ID: "wrong" }).status,
    0,
  );
  assert.notEqual(run("main", ["production"]).status, 0);
  assert.notEqual(run("main", ["preview", "--check"]).status, 0);
});
