import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PILOT_EVIDENCE_BUCKET } from "../app/delivery-pilot-bucket.mjs";
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
test("reviewed public host and guarded-manager settings can opt in through the managed Preview", () => {
  const c = clone();
  Object.assign(c.previews.vars, {
    HIVE_PROJECT_DISCOVERY_ENABLED: "true",
    HIVE_PROJECT_TASKS_ENABLED: "true",
    HIVE_DELIVERY_ENABLED: "true",
    HIVE_CODEX_GATEWAY_ENABLED: "true",
    HIVE_PUBLIC_ORIGIN: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
    HIVE_CODEX_HIVE_ORIGIN: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
    HIVE_CODEX_ISSUER_KEY_ID: "reviewed-existing-host",
    HIVE_CODEX_ISSUER_PUBLIC_KEY: "public host key; validated by the existing runtime",
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "high",
    HIVE_GUARDIAN_ENABLED: "true",
    HIVE_GUARDIAN_APPROVED_PACKAGES_JSON: "[]",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_DELIVERY_EXECUTION_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICIES_JSON: "[]",
    HIVE_DELIVERY_ACCEPTANCE_ENABLED: "true",
    HIVE_DELIVERY_ACCEPTANCE_PRODUCER: "{}",
    HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED: "true",
    HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED: "true",
  });
  c.previews.r2_buckets = [
    { binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: PILOT_EVIDENCE_BUCKET.name },
  ];
  assert.doesNotThrow(() => validateConfig(c));
  assert.equal(
    plan({ branch: oauthPreviewBranch, target: "preview", config: c }).target,
    "preview",
  );
  assert.throws(() => plan({ branch: "main", target: "production", config: c }));
  assert.deepEqual(c.vars, { HIVE_NATIVE_MODE: "bootstrap" });
  assert.deepEqual(c.triggers, { crons: [] });
  assert.equal(c.previews.vars.HIVE_DELIVERY_DISPATCH_ENABLED, "false");
  assert.equal(c.previews.vars.HIVE_TOKEN_ROTATION_ENABLED, "false");
});
test("Preview enrollment rejects credentials, unknown settings, production authority and resource drift", () => {
  for (const change of [
    (c) => (c.previews.vars.HIVE_CODEX_ISSUER_PRIVATE_KEY = "private"),
    (c) => (c.previews.vars.HIVE_DELIVERY_RELEASE_GITHUB_TOKEN = "credential"),
    (c) => (c.previews.vars.HIVE_UNKNOWN_SETTING = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_MANAGER_ENABLED = "yes"),
    (c) => (c.previews.vars.HIVE_DELIVERY_MANAGER_ENABLED = true),
    (c) => (c.previews.vars.HIVE_PUBLIC_ORIGIN = "https://other.invalid"),
    (c) => (c.previews.vars.HIVE_CODEX_HIVE_ORIGIN = "https://other.invalid"),
    (c) => (c.previews.vars.HIVE_NATIVE_MODE = "production"),
    (c) => (c.previews.vars.HIVE_DISABLE_BACKGROUND_WORKERS = "false"),
    (c) => (c.previews.vars.HIVE_DELIVERY_DISPATCH_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_TOKEN_ROTATION_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_EPICS_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_RELEASE_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_DELIVERY_DATABASE_ENABLED = "true"),
    (c) => (c.previews.vars.HIVE_NATIVE_PRODUCTION_ACTIVE = "true"),
    (c) => (c.previews.vars.HIVE_GUARDIAN_APPROVED_PACKAGES_JSON = "x".repeat(262145)),
    (c) => delete c.previews.vars.HIVE_PROJECT_TASKS_ENABLED,
    (c) =>
      (c.previews.r2_buckets = [{ binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: "production" }]),
    (c) =>
      (c.previews.r2_buckets = [{ binding: "OTHER", bucket_name: PILOT_EVIDENCE_BUCKET.name }]),
    (c) =>
      (c.previews.r2_buckets = [
        {
          binding: "HIVE_DELIVERY_EVIDENCE",
          bucket_name: PILOT_EVIDENCE_BUCKET.name,
          remote: true,
        },
      ]),
    (c) => (c.previews.triggers = { crons: ["* * * * *"] }),
    (c) => (c.previews.routes = ["production.example/*"]),
  ]) {
    const c = clone();
    change(c);
    assert.throws(() => validateConfig(c));
  }
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

test("managed Codex accounts stay absent/off by default and require explicit public enrollment", () => {
  assert.equal(config.vars.HIVE_CODEX_ACCOUNTS_ENABLED, undefined);
  const c = clone();
  delete c.previews.vars.HIVE_CODEX_ACCOUNTS_ENABLED;
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CODEX_ACCOUNTS_ENABLED = "true";
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CODEX_ACCOUNTS_ENABLED = "arbitrary";
  assert.throws(() => validateConfig(c));
});

test("workspace Claude accounts require explicit public enrollment without new secrets", () => {
  assert.equal(config.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED, undefined);
  const c = clone();
  delete c.previews.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED;
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED = "true";
  assert.doesNotThrow(() => validateConfig(c));
  c.previews.vars.HIVE_CLAUDE_ACCOUNTS_ENABLED = "arbitrary";
  assert.throws(() => validateConfig(c));
});
