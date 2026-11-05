import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertBuildReady } from "./build-integrity.mjs";
import { assertDeliveryPilot, projectJobsPilotPlan } from "./delivery-pilot-candidate.mjs";
import { readPreviewPrivateJson } from "./deployment-identity.mjs";

// Dry-run packaging only. This command never uploads or installs a schedule.
try {
  assert.equal(process.argv.length, 3);
  const record = await readPreviewPrivateJson(process.argv[2]);
  assert.equal(
    record.sourceRevision,
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--", "deploy/cloudflare/jobs"], {
      encoding: "utf8",
    }).trim(),
    "",
  );
  await assertBuildReady();
  const ready = await readFile(".open-next/hive-build-ready.json");
  assert.equal(createHash("sha256").update(ready).digest("hex"), record.readinessSHA256);
  const app = await readPreviewPrivateJson(record.configs.app.configFile);
  const secret = await readPreviewPrivateJson(record.configs.app.secretFile);
  for (const [path, expected] of [
    [record.configs.app.configFile, record.configs.app.configSHA256],
    [record.configs.app.secretFile, record.configs.app.secretFileSHA256],
  ])
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      expected,
    );
  const pins = Object.fromEntries(
    await Promise.all(
      Object.entries({
        workspace: "workspace-read.manifest.sha256",
        voice: "voice.manifest.sha256",
        agent: "agent-bridge.manifest.sha256",
        helper: "agent-bridge.helper.sha256",
      }).map(async ([k, p]) => [
        k,
        (await readFile(`templates/ai-dev-k8s/assets/${p}`, "utf8")).trim(),
      ]),
    ),
  );
  assertDeliveryPilot(record, app, secret, pins);
  const plan = projectJobsPilotPlan(
    secret.HIVE_PROJECT_TASK_RECONCILE_SECRET,
    record.sourceRevision,
  );
  assert.deepEqual(record.projectJobsPlan, plan);
  const { plannedCron, secretNames, ...config } = plan;
  const directory = join(dirname(process.argv[2]), "jobs-dry-run");
  await mkdir(directory, { mode: 0o700 });
  const configFile = join(directory, "jobs.json"),
    secretFile = join(directory, "jobs-secrets.json");
  await writeFile(
    configFile,
    JSON.stringify({
      ...config,
      account_id: record.accountId,
      main: resolve("deploy/cloudflare/jobs/worker.ts"),
      compatibility_date: "2026-10-29",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      observability: { enabled: false },
    }),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    secretFile,
    JSON.stringify({
      HIVE_PROJECT_TASK_RECONCILE_SECRET: secret.HIVE_PROJECT_TASK_RECONCILE_SECRET,
    }),
    { mode: 0o600, flag: "wx" },
  );
  const log = await open(join(directory, "dry-run.log"), "wx", 0o600);
  let result;
  try {
    result = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--config",
        configFile,
        "--secrets-file",
        secretFile,
        "--outdir",
        join(directory, "bundle"),
      ],
      {
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
  } finally {
    await log.close();
  }
  assert.equal(result.status, 0, "Jobs dry run failed");
  console.log(
    JSON.stringify({
      sourceRevision: record.sourceRevision,
      plannedCron,
      secretNames,
      cloudWrites: 0,
      bundleDirectory: join(directory, "bundle"),
    }),
  );
} catch {
  console.error("Delivery pilot jobs packaging rejected; no cloud deployment attempted.");
  process.exitCode = 1;
}
