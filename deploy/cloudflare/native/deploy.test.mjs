import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  account,
  oauthPreviewBranch,
  plan,
  previewTarget,
  resolvePreviewOrigin,
  validateConfig,
} from "./deploy.mjs";

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
    (c) => (c.previews.placement = { region: "aws:eu-central-1" }),
    (c) => delete c.previews.placement,
    (c) => (c.triggers.crons = ["* * * * *"]),
  ]) {
    const c = clone();
    change(c);
    assert.throws(() => validateConfig(c));
  }
  assert.equal(config.account_id, account);
  assert.deepEqual(config.previews.placement, { region: "aws:us-east-1" });
  assert.equal(config.placement, undefined);
  assert.equal(config.previews.vars.HIVE_PREVIEW_ACCESS_REQUIRED, "false");
  assert.deepEqual(config.previews.secrets.required, [
    "DATABASE_URL",
    "ENCRYPTION_KEY",
    "COOKIE_SECRET",
    "AUTH_SERVICE_SECRET",
    "HIVE_CODER_OAUTH_CLIENT_SECRET",
  ]);
});
test("branch name preserves the provider-managed Preview identity", () => {
  const a = previewTarget("codex/example-branch");
  assert.deepEqual(a, previewTarget("codex/example-branch"));
  assert.notEqual(a.name, previewTarget("codex/example_branch").name);
  assert.equal(a.name, "codex/example-branch");
  assert.equal(a.origin, undefined);
  for (const bad of ["", "main", "MAIN", "-flag", "a b", "a\nother", "a".repeat(201)])
    assert.throws(() => previewTarget(bad));
});
test("provider metadata pins the exact branch and valid slug without exposing token", async () => {
  const token = "synthetic-private-token";
  const branch = "codex/delivery-system-design";
  const fetcher = async (url, options) => {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/hive/previews/codex%2Fdelivery-system-design`,
    );
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return Response.json({
      success: true,
      result: { name: branch, slug: "codex-delivery-system-design" },
    });
  };
  assert.deepEqual(await resolvePreviewOrigin(branch, token, fetcher), {
    name: branch,
    origin: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
  });
  for (const response of [
    Response.json({ success: true, result: { name: "other", slug: "safe" } }),
    Response.json({ success: true, result: { name: branch, slug: "bad.example" } }),
    Response.json({ success: true, result: { name: branch, slug: "a".repeat(59) } }),
    Response.json({ success: false, result: { name: branch, slug: "safe" } }),
    new Response("x".repeat(65537)),
    new Response("unavailable", { status: 404 }),
  ])
    await assert.rejects(
      resolvePreviewOrigin(branch, token, async () => response),
      (error) => error.message === "Preview metadata unavailable" && !error.message.includes(token),
    );
  await assert.rejects(resolvePreviewOrigin(branch, "", fetcher));
  await assert.rejects(
    resolvePreviewOrigin(branch, token, async () => {
      throw Error(token);
    }),
    (error) => !error.message.includes(token),
  );
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
    plan({ branch: oauthPreviewBranch, target: "preview", check: true, config }).target,
    "preview",
  );
  assert.throws(
    () => plan({ branch: "feature", target: "preview", check: true, config }),
    /Enroll an exact Coder OAuth callback/,
  );
});

test("CLI checks do not deploy and reject a mismatched account or production action", () => {
  const script = new URL("./deploy.mjs", import.meta.url).pathname;
  const run = (branch, args, extra = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, WORKERS_CI_BRANCH: branch, CLOUDFLARE_ACCOUNT_ID: account, ...extra },
    });
  const preview = run(oauthPreviewBranch, ["preview", "--check"]);
  assert.equal(preview.status, 0);
  assert.equal(JSON.parse(preview.stdout).name, oauthPreviewBranch);
  assert.equal(JSON.parse(preview.stdout).origin, undefined);
  assert.notEqual(
    run("codex/example", ["preview", "--check"], { CLOUDFLARE_ACCOUNT_ID: "wrong" }).status,
    0,
  );
  assert.notEqual(run("main", ["production"]).status, 0);
  assert.notEqual(run("main", ["preview", "--check"]).status, 0);
  assert.notEqual(run("codex/unenrolled", ["preview", "--check"]).status, 0);
});
