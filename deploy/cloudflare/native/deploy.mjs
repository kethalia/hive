import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBuildReady } from "../app/build-integrity.mjs";
import { PILOT_EVIDENCE_BUCKET } from "../app/delivery-pilot-bucket.mjs";

import { account } from "./production-configuration.mjs";
import {
  productionEnrollment,
  publishManagedProduction,
  verifyRemoteMain,
} from "./production-enrollment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const configPath = join(here, "wrangler.jsonc");

export { account } from "./production-configuration.mjs";
export const oauthPreviewBranch = "codex/delivery-system-design";
export const oauthPreviewOrigin = "https://codex-delivery-system-design-hive.b00ste.workers.dev";
const requiredSecrets = [
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "COOKIE_SECRET",
  "AUTH_SERVICE_SECRET",
  "HIVE_CODER_OAUTH_CLIENT_SECRET",
];
const previewFeatures = [
  "HIVE_PROJECT_DISCOVERY_ENABLED",
  "HIVE_PROJECT_TASKS_ENABLED",
  "HIVE_DELIVERY_ENABLED",
  "HIVE_CODEX_GATEWAY_ENABLED",
];
const disabled = [
  "HIVE_DELIVERY_DISPATCH_ENABLED",
  "HIVE_TOKEN_ROTATION_ENABLED",
  "HIVE_DELIVERY_EPICS_ENABLED",
  "HIVE_DELIVERY_RELEASE_ENABLED",
  "HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED",
  "HIVE_DELIVERY_DATABASE_ENABLED",
  "HIVE_NATIVE_PRODUCTION_ACTIVE",
];
// Public settings consumed by the existing host, project and guarded-manager
// runtimes. Those runtimes own policy/pin validation; deployment does not add a
// second policy schema or accept plaintext credential settings.
const previewRuntimeVars = new Set([
  "HIVE_CODEX_ACCOUNTS_ENABLED",
  "HIVE_CLAUDE_ACCOUNTS_ENABLED",
  "HIVE_CODEX_ISSUER_KEY_ID",
  "HIVE_CODEX_ISSUER_PUBLIC_KEY",
  "HIVE_CODEX_SOFTWARE_TEMPLATE_IDS",
  "HIVE_CODEX_APP_SLUG",
  "HIVE_CODEX_GATEWAY_PORT",
  "HIVE_CODEX_SESSION_TRANSPORT",
  "HIVE_CODEX_MANAGER_MODEL",
  "HIVE_CODEX_MANAGER_EFFORT",
  "HIVE_WORKSPACE_READ_ENABLED",
  "HIVE_WORKSPACE_READ_PROFILES_JSON",
  "HIVE_WORKSPACE_READ_ISSUER_KEY_ID",
  "HIVE_GENERIC_TERMINAL_ENABLED",
  "HIVE_TERMINAL_WS_URL",
  "HIVE_CODEX_TERMINAL_ENABLED",
  "HIVE_TERMINAL_PASTE_ENABLED",
  "HIVE_CODEX_VOICE_ENABLED",
  "HIVE_VOICE_TRANSPORT",
  "HIVE_VOICE_ISSUER_KEY_ID",
  "HIVE_VOICE_TEMPLATE_PINS_JSON",
  "HIVE_AGENT_TOOLS_ENABLED",
  "HIVE_WORKSPACE_ISSUER_MODE",
  "HIVE_AGENT_TOOLS_TRANSPORT",
  "HIVE_AGENT_TOOLS_ISSUER_KEY_ID",
  "HIVE_AGENT_TOOLS_PINS_JSON",
  "HIVE_GUARDIAN_ENABLED",
  "HIVE_GUARDIAN_PRODUCER_ENABLED",
  "HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED",
  "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
  "HIVE_DELIVERY_MANAGER_ENABLED",
  "HIVE_DELIVERY_EXECUTION_ENABLED",
  "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
  "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
  "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
  "HIVE_DELIVERY_ACCEPTANCE_PRODUCER",
  "HIVE_DELIVERY_NATIVE_ENABLED",
  "HIVE_DELIVERY_GITHUB_SOURCE_ENABLED",
  "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED",
]);
const previewOriginVars = new Set([
  "HIVE_PUBLIC_ORIGIN",
  "HIVE_PREVIEW_ORIGIN",
  "HIVE_CODEX_HIVE_ORIGIN",
  "HIVE_WORKSPACE_READ_HIVE_ORIGIN",
  "HIVE_AGENT_TOOLS_HIVE_ORIGIN",
]);

export function previewTarget(branch) {
  assert.equal(typeof branch, "string");
  assert.ok(
    branch.length > 0 && branch.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch),
  );
  assert.notEqual(branch.toLowerCase(), "main", "main may not publish a branch preview");
  return { name: branch };
}

// The managed Preview's provider identity, not a guessed normalization, binds
// both the publication target and the only permitted browser origin.
export async function resolvePreviewOrigin(branch, token, fetcher = fetch) {
  const { name } = previewTarget(branch);
  if (typeof token !== "string" || !token || /[\r\n]/.test(token))
    throw new Error("Preview metadata unavailable");
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, 5000);
    });
    const obtain = async () => {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/hive/previews/${encodeURIComponent(name)}`,
        {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error("bad response");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel().catch(() => {});
          throw new Error("oversized");
        }
        chunks.push(value);
      }
      const body = JSON.parse(
        Buffer.concat(chunks.map((value) => Buffer.from(value))).toString("utf8"),
      );
      const slug = body?.result?.slug;
      if (
        body?.success !== true ||
        body.result.name !== name ||
        typeof slug !== "string" ||
        !/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(slug)
      )
        throw new Error("bad identity");
      return { name, origin: `https://${slug}-hive.b00ste.workers.dev` };
    };
    return await Promise.race([obtain(), timeout]);
  } catch {
    throw new Error("Preview metadata unavailable");
  } finally {
    clearTimeout(timer);
  }
}
export function validateConfig(c) {
  assert.deepEqual(Object.keys(c).sort(), [
    "$schema",
    "account_id",
    "assets",
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "main",
    "name",
    "preview_urls",
    "previews",
    "triggers",
    "vars",
    "workers_dev",
  ]);
  assert.equal(c.name, "hive");
  assert.equal(c.account_id, account);
  assert.equal(c.main, "worker.ts");
  assert.equal(c.compatibility_date, "2026-10-29");
  assert.deepEqual(c.compatibility_flags, ["nodejs_compat", "global_fetch_strictly_public"]);
  assert.deepEqual(c.limits, { cpu_ms: 100 });
  assert.equal(c.workers_dev, false);
  assert.equal(c.preview_urls, true);
  assert.deepEqual(c.vars, { HIVE_NATIVE_MODE: "bootstrap" });
  assert.deepEqual(c.triggers, { crons: [] });
  for (const forbidden of [
    "services",
    "r2_buckets",
    "d1_databases",
    "hyperdrive",
    "routes",
    "route",
    "secrets",
  ])
    assert.ok(!Object.hasOwn(c, forbidden));
  assert.deepEqual(c.assets, {
    directory: "../../../.open-next/assets",
    binding: "ASSETS",
    run_worker_first: true,
  });
  assert.deepEqual(Object.keys(c.previews).sort(), [
    "placement",
    ...(Object.hasOwn(c.previews, "r2_buckets") ? ["r2_buckets"] : []),
    "secrets",
    "vars",
  ]);
  assert.deepEqual(c.previews.placement, { region: "aws:us-east-1" });
  assert.deepEqual(c.previews.secrets, { required: requiredSecrets });
  if (Object.hasOwn(c.previews, "r2_buckets"))
    assert.deepEqual(c.previews.r2_buckets, [
      { binding: "HIVE_DELIVERY_EVIDENCE", bucket_name: PILOT_EVIDENCE_BUCKET.name },
    ]);
  const v = c.previews.vars;
  const pinned = {
    HIVE_NATIVE_MODE: "preview",
    HIVE_NATIVE_PREVIEW_ENABLED: "true",
    HIVE_PREVIEW_ACCESS_REQUIRED: "false",
    HIVE_RUNTIME_TARGET: "cloudflare",
    HIVE_DISABLE_BACKGROUND_WORKERS: "true",
    HIVE_DELIVERY_DISPATCH_ENABLED: "false",
    HIVE_TOKEN_ROTATION_ENABLED: "false",
    HIVE_CODER_OAUTH_ENABLED: "true",
    HIVE_CODER_OAUTH_CLIENT_ID: "8a255ae5-7c91-4a6a-a27a-5107e82962d4",
    CODER_URL: "https://coder.kethalia.com",
  };
  assert.ok(v && typeof v === "object" && !Array.isArray(v));
  for (const [name, value] of Object.entries(pinned)) assert.equal(v[name], value);
  for (const name of previewFeatures) assert.ok(["true", "false"].includes(v[name]));
  for (const name of disabled) if (Object.hasOwn(v, name)) assert.equal(v[name], "false");
  for (const [name, value] of Object.entries(v)) {
    assert.ok(
      Object.hasOwn(pinned, name) ||
        previewFeatures.includes(name) ||
        disabled.includes(name) ||
        previewRuntimeVars.has(name) ||
        previewOriginVars.has(name),
      "Unsupported public Preview setting",
    );
    assert.equal(typeof value, "string");
    assert.ok(Buffer.byteLength(value) <= 262144);
    if (name.endsWith("_ENABLED")) assert.ok(["true", "false"].includes(value));
    if (previewOriginVars.has(name)) assert.equal(value, oauthPreviewOrigin);
  }
}
export function plan({ branch, target, check = false, dryRun = false, config, production }) {
  validateConfig(config);
  assert.ok(["preview", "production"].includes(target));
  assert.ok(!(check && dryRun));
  if (target === "production") {
    assert.equal(branch, "main");
    assert.ok(
      check || dryRun || production,
      "Production deployment is disabled pending cutover approval",
    );
    return { target, check, dryRun };
  }
  assert.equal(
    branch,
    oauthPreviewBranch,
    "Enroll an exact Coder OAuth callback before publishing another branch",
  );
  return { target, check, dryRun, ...previewTarget(branch) };
}
// Same production command used by connected Builds; injected I/O is only for
// focused protocol tests, never a configurable publication endpoint or command.
export async function deployManagedProduction({
  production,
  token,
  assertReady,
  observe,
  now,
  verifyMain = () => verifyRemoteMain(production.sourceRevision),
  execute = execFileSync,
}) {
  const temp = mkdtempSync(join(tmpdir(), "hive-managed-production-"));
  try {
    const configFile = join(temp, "wrangler.json");
    writeFileSync(configFile, JSON.stringify(production.config), { mode: 0o600 });
    await publishManagedProduction({
      enrollment: production.enrollment,
      assertReady,
      verifyMain,
      observe,
      token,
      now,
      execute: () =>
        execute("pnpm", ["exec", "wrangler", "deploy", "--config", configFile, "--strict"], {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account },
        }),
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function run() {
  const [target, ...flags] = process.argv.slice(2);
  assert.ok(
    flags.every((x) => ["--check", "--dry-run"].includes(x)) &&
      new Set(flags).size === flags.length,
  );
  const branch =
    process.env.WORKERS_CI_BRANCH ||
    execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  if (process.env.CLOUDFLARE_ACCOUNT_ID) assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, account);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const rawEnrollment = process.env.HIVE_NATIVE_PRODUCTION_ENROLLMENT_JSON;
  // Preview ignores production enrollment entirely, including its secrets and routes.
  const production =
    target === "production" && rawEnrollment
      ? productionEnrollment({
          raw: rawEnrollment,
          config,
          root,
          identity: {
            workersCI: process.env.WORKERS_CI,
            buildId: process.env.WORKERS_CI_BUILD_UUID,
            commit: process.env.WORKERS_CI_COMMIT_SHA,
            branch,
            head: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: root,
              encoding: "utf8",
            }).trim(),
            remote: execFileSync("git", ["remote", "get-url", "origin"], {
              cwd: root,
              encoding: "utf8",
            }).trim(),
            clean:
              execFileSync("git", ["status", "--porcelain"], {
                cwd: root,
                encoding: "utf8",
              }).trim() === "",
          },
        })
      : undefined;
  const p = plan({
    branch,
    target,
    check: flags.includes("--check"),
    dryRun: flags.includes("--dry-run"),
    config,
    production,
  });
  if (p.check) {
    console.log(JSON.stringify(p));
    return;
  }
  await assertBuildReady(root);
  if (p.dryRun) {
    const temp = mkdtempSync(join(tmpdir(), "hive-native-preview-dryrun-"));
    try {
      const configFile = join(temp, "wrangler.json");
      const v =
        p.target === "preview"
          ? {
              ...config.previews.vars,
              HIVE_PREVIEW_ORIGIN: "http://localhost",
              HIVE_PUBLIC_ORIGIN: "http://localhost",
            }
          : (production?.config.vars ?? config.vars);
      const isolated = {
        name: config.name,
        account_id: account,
        main: join(here, "worker.ts"),
        compatibility_date: config.compatibility_date,
        compatibility_flags: config.compatibility_flags,
        workers_dev: false,
        assets: { ...config.assets, directory: resolve(here, config.assets.directory) },
        vars: v,
        limits: config.limits,
        ...(p.target === "preview"
          ? {
              placement: config.previews.placement,
              ...(config.previews.r2_buckets ? { r2_buckets: config.previews.r2_buckets } : {}),
            }
          : {}),
      };
      writeFileSync(
        configFile,
        JSON.stringify(p.target === "production" && production ? production.config : isolated),
      );
      execFileSync(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--dry-run",
          "--config",
          configFile,
          "--outdir",
          join(temp, "out"),
        ],
        { cwd: root, stdio: "inherit" },
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    return;
  }
  if (p.target === "production") {
    await deployManagedProduction({
      production,
      token: process.env.CLOUDFLARE_API_TOKEN,
      assertReady: () => assertBuildReady(root),
    });
    return;
  }
  const resolved = await resolvePreviewOrigin(p.name, process.env.CLOUDFLARE_API_TOKEN);
  assert.equal(
    resolved.origin,
    oauthPreviewOrigin,
    "Preview origin differs from the enrolled Coder callback",
  );
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "preview",
      "--config",
      configPath,
      "--name",
      resolved.name,
      "--var",
      `HIVE_PREVIEW_ORIGIN:${resolved.origin}`,
      "--var",
      `HIVE_PUBLIC_ORIGIN:${resolved.origin}`,
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await run();
  } catch {
    console.error("Native deployment failed.");
    process.exitCode = 1;
  }
}
