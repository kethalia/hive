import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBuildReady } from "../app/build-integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const configPath = join(here, "wrangler.jsonc");
export const account = "225177f82b9234ede14e897fe15e0cb5";
const requiredSecrets = [
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "COOKIE_SECRET",
  "AUTH_SERVICE_SECRET",
  "PREVIEW_BEARER",
  "PREVIEW_COOKIE_SECRET",
];
const disabled = [
  "HIVE_PROJECT_DISCOVERY_ENABLED",
  "HIVE_PROJECT_TASKS_ENABLED",
  "HIVE_DELIVERY_ENABLED",
  "HIVE_CODEX_GATEWAY_ENABLED",
  "HIVE_DELIVERY_DISPATCH_ENABLED",
  "HIVE_TOKEN_ROTATION_ENABLED",
];

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
  assert.deepEqual(Object.keys(c.previews).sort(), ["secrets", "vars"]);
  assert.deepEqual(c.previews.secrets, { required: requiredSecrets });
  const v = c.previews.vars;
  assert.deepEqual(v, {
    HIVE_NATIVE_MODE: "preview",
    HIVE_NATIVE_PREVIEW_ENABLED: "true",
    HIVE_RUNTIME_TARGET: "cloudflare",
    HIVE_DISABLE_BACKGROUND_WORKERS: "true",
    HIVE_PROJECT_DISCOVERY_ENABLED: "false",
    HIVE_PROJECT_TASKS_ENABLED: "false",
    HIVE_DELIVERY_ENABLED: "false",
    HIVE_CODEX_GATEWAY_ENABLED: "false",
    HIVE_DELIVERY_DISPATCH_ENABLED: "false",
    HIVE_TOKEN_ROTATION_ENABLED: "false",
    CODER_URL: "https://coder.kethalia.com",
  });
  for (const name of disabled) assert.equal(v[name], "false");
}
export function plan({ branch, target, check = false, dryRun = false, config }) {
  validateConfig(config);
  assert.ok(["preview", "production"].includes(target));
  assert.ok(!(check && dryRun));
  if (target === "production") {
    assert.equal(branch, "main");
    assert.ok(check || dryRun, "Production deployment is disabled pending cutover approval");
    return { target, check, dryRun };
  }
  return { target, check, dryRun, ...previewTarget(branch) };
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
  const p = plan({
    branch,
    target,
    check: flags.includes("--check"),
    dryRun: flags.includes("--dry-run"),
    config,
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
          : config.vars;
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
      };
      writeFileSync(configFile, JSON.stringify(isolated));
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
  const resolved = await resolvePreviewOrigin(p.name, process.env.CLOUDFLARE_API_TOKEN);
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
    console.error("Native Preview deployment failed.");
    process.exitCode = 1;
  }
}
