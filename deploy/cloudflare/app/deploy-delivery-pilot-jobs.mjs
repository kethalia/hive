import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertBuildReady } from "./build-integrity.mjs";
import { assertDeliveryPilot, projectJobsPilotPlan } from "./delivery-pilot-candidate.mjs";
import { readPreviewPrivateJson } from "./deployment-identity.mjs";
import { readJobsEnrollment } from "./jobs-enrollment.mjs";
import { readJobsLocalProof } from "./jobs-local-proof.mjs";
import { assertJobsTransition, PILOT_JOBS_CRON } from "./jobs-transition-policy.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
if (process.argv.includes("--deploy")) {
  console.error(
    "Retired compatibility Workers cannot be deployed; use the native Hive Preview workflow.",
  );
  process.exit(1);
}
try {
  const [manifestPath, action, ...flags] = process.argv.slice(2);
  assert.ok(["create", "enable", "disable"].includes(action));
  assert.ok(flags.length <= 1 && (flags.length === 0 || flags[0] === "--deploy"));
  const deploy = flags[0] === "--deploy";
  const record = await readPreviewPrivateJson(manifestPath);
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
  assert.equal(hash(await readFile(".open-next/hive-build-ready.json")), record.readinessSHA256);
  const app = await readPreviewPrivateJson(record.configs.app.configFile);
  const secret = await readPreviewPrivateJson(record.configs.app.secretFile);
  assert.equal(
    hash(await readFile(record.configs.app.configFile)),
    record.configs.app.configSHA256,
  );
  assert.equal(
    hash(await readFile(record.configs.app.secretFile)),
    record.configs.app.secretFileSHA256,
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
  const provider = await readPreviewPrivateJson(
    process.env.HIVE_PREVIEW_JOBS_PROVIDER_EVIDENCE_FILE,
  );
  const appReceipt =
    action === "disable"
      ? undefined
      : await readPreviewPrivateJson(process.env.HIVE_PREVIEW_PILOT_APP_RECEIPT_FILE);
  const creation =
    action === "create"
      ? undefined
      : await readPreviewPrivateJson(process.env.HIVE_PREVIEW_JOBS_CREATION_RECEIPT_FILE);
  const localProof =
    action === "disable"
      ? undefined
      : await readJobsLocalProof(
          process.env.HIVE_PREVIEW_JOBS_LOCAL_PROOF_FILE,
          record.sourceRevision,
        );
  const enrollment =
    action === "enable"
      ? readJobsEnrollment(
          (await readFile("/tmp/hive-epic-coder-auth/neon-app-preview-runtime-url", "utf8")).trim(),
          record,
        )
      : undefined;
  assertJobsTransition({ action, record, provider, creation, appReceipt, enrollment, localProof });
  const scheduleStart = Date.now();
  const stopByRaw = process.env.HIVE_PREVIEW_JOBS_STOP_BY_MS ?? "";
  if (action === "enable") {
    assert.match(stopByRaw, /^\d{13}$/);
    const stopBy = Number(stopByRaw);
    assert.ok(stopBy > scheduleStart + 30000 && stopBy <= scheduleStart + 30 * 60 * 1000);
  }
  if (!deploy) {
    console.log(
      JSON.stringify({
        action,
        sourceRevision: record.sourceRevision,
        validated: true,
        cloudWrites: 0,
      }),
    );
    process.exit(0);
  }
  const directory = join(dirname(manifestPath), `jobs-${action}`);
  await mkdir(directory, { mode: 0o700 });
  const parentDirectory = await open(dirname(directory), "r");
  try {
    await parentDirectory.sync();
  } finally {
    await parentDirectory.close();
  }
  const configFile = join(directory, "config.json"),
    secretFile = join(directory, "secrets.json");
  const { plannedCron, secretNames, ...config } = plan;
  await writeFile(
    configFile,
    JSON.stringify({
      ...config,
      vars: {
        ...config.vars,
        ...(action === "enable"
          ? {
              HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED: "true",
              HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT: String(scheduleStart),
              HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL: stopByRaw,
            }
          : {}),
      },
      account_id: record.accountId,
      main: resolve("deploy/cloudflare/jobs/worker.ts"),
      compatibility_date: "2026-10-29",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      observability: { enabled: false },
      triggers: { crons: action === "enable" ? [PILOT_JOBS_CRON] : [] },
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
  const attemptFile = await open(join(directory, "attempt.json"), "wx", 0o600);
  try {
    await attemptFile.writeFile(
      JSON.stringify({
        schemaVersion: 1,
        action,
        runId: record.runId,
        sourceRevision: record.sourceRevision,
        observedAt: new Date().toISOString(),
        providerObservedAt: provider.observedAt,
        expectedJobs: provider.jobs,
        expectedApp: provider.app ?? null,
        priorCreation: creation ?? null,
        scheduleStartedAt: action === "enable" ? scheduleStart : null,
        scheduleStopBy: action === "enable" ? Number(stopByRaw) : null,
      }),
    );
    await attemptFile.sync();
  } finally {
    await attemptFile.close();
  }
  const attemptDirectory = await open(directory, "r");
  try {
    await attemptDirectory.sync();
  } finally {
    await attemptDirectory.close();
  }
  const log = await open(join(directory, "deploy.log"), "wx", 0o600);
  let result;
  try {
    result = spawnSync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--config", configFile, "--secrets-file", secretFile],
      {
        stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
  } finally {
    await log.close();
  }
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify({
      schemaVersion: 1,
      action,
      runId: record.runId,
      sourceRevision: record.sourceRevision,
      exitCode: result.status,
      finishedAt: new Date().toISOString(),
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      action,
      sourceRevision: record.sourceRevision,
      cloudDeploymentAttempted: true,
      exitCode: result.status,
      readbackRequired: true,
      attemptDirectory: directory,
    }),
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Pilot jobs transition rejected or uncertain. Inspect retained private attempt and fresh provider state before retrying.",
  );
  process.exitCode = 1;
}
