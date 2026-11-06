import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readPreviewPrivateJson } from "./deployment-identity.mjs";
import { ACCOUNT_ID, APP_NAME } from "./deployment-plan.mjs";
import { PILOT_JOBS_CRON, PILOT_JOBS_NAME } from "./jobs-transition-policy.mjs";

try {
  const [directory] = process.argv.slice(2);
  assert.ok(directory && resolve(directory) === directory && process.argv.length === 3);
  const attempt = await readPreviewPrivateJson(join(directory, "attempt.json"));
  const result = await readPreviewPrivateJson(join(directory, "result.json"));
  const provider = await readPreviewPrivateJson(
    process.env.HIVE_PREVIEW_JOBS_PROVIDER_EVIDENCE_FILE,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.runId, attempt.runId);
  assert.equal(result.action, attempt.action);
  assert.equal(result.sourceRevision, attempt.sourceRevision);
  const now = Date.now(),
    age = now - Date.parse(provider.observedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= 60000);
  assert.equal(provider.accountId, ACCOUNT_ID);
  if (attempt.action !== "disable") {
    assert.equal(provider.app.name, APP_NAME);
    for (const key of [
      "tag",
      "createdOn",
      "deploymentId",
      "versionId",
      "sourceRevision",
      "repositoryCatalogSHA256",
    ])
      assert.equal(provider.app[key], attempt.expectedApp[key]);
    assert.equal(provider.app.repositoryPolicyEnabled, true);
    assert.equal(provider.app.publicState.enabled, false);
    assert.equal(provider.app.publicState.previews_enabled, false);
  }
  const job = provider.jobs;
  assert.equal(job.exists, true);
  assert.equal(job.name, PILOT_JOBS_NAME);
  assert.equal(job.sourceRevision, attempt.sourceRevision);
  assert.match(job.tag, /^[a-f0-9]{32}$/);
  for (const id of [job.deploymentId, job.versionId])
    assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.ok(Number.isFinite(Date.parse(job.createdOn)));
  assert.equal(job.publicState.enabled, false);
  assert.equal(job.publicState.previews_enabled, false);
  assert.equal(job.appService, APP_NAME);
  assert.equal(job.projectTasksEnabled, true);
  assert.equal(job.pilotMode, true);
  assert.deepEqual(
    job.bindings,
    [
      "APP_SERVICE",
      "HIVE_DELIVERY_PILOT_MODE",
      "HIVE_PROJECT_TASK_RECONCILE_SECRET",
      "HIVE_PROJECT_TASKS_ENABLED",
      "HIVE_RUNTIME_TARGET",
      ...(attempt.action === "enable"
        ? [
            "HIVE_DELIVERY_PILOT_SCHEDULE_ENABLED",
            "HIVE_DELIVERY_PILOT_SCHEDULE_STARTED_AT",
            "HIVE_DELIVERY_PILOT_SCHEDULE_UNTIL",
          ]
        : []),
      "SOURCE_REVISION",
    ].sort(),
  );
  assert.deepEqual(job.schedules, attempt.action === "enable" ? [PILOT_JOBS_CRON] : []);
  if (attempt.action === "create") {
    assert.equal(attempt.expectedJobs.exists, false);
    assert.ok(Date.parse(job.createdOn) >= Date.parse(attempt.observedAt) - 5000);
    assert.ok(Date.parse(job.createdOn) <= now + 5000);
  } else {
    assert.ok(attempt.priorCreation);
    assert.equal(job.tag, attempt.priorCreation.tag);
    assert.equal(job.createdOn, attempt.priorCreation.createdOn);
  }
  if (attempt.action === "enable") {
    assert.equal(job.scheduleEnabled, true);
    assert.equal(job.scheduleStartedAt, attempt.scheduleStartedAt);
    assert.equal(job.scheduleUntil, attempt.scheduleStopBy);
    assert.ok(
      Number.isSafeInteger(job.scheduleStartedAt) &&
        job.scheduleUntil > job.scheduleStartedAt &&
        job.scheduleUntil - job.scheduleStartedAt <= 1800000,
    );
  }
  const receipt = {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    name: PILOT_JOBS_NAME,
    runId: attempt.runId,
    sourceRevision: attempt.sourceRevision,
    tag: job.tag,
    createdOn: job.createdOn,
    deploymentId: job.deploymentId,
    versionId: job.versionId,
    action: attempt.action,
    observedAt: provider.observedAt,
    schedules: job.schedules,
  };
  await writeFile(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      action: attempt.action,
      readbackVerified: true,
      receiptFile: join(directory, "receipt.json"),
      cloudWrites: 0,
    }),
  );
} catch {
  console.error("Pilot jobs readback rejected; preserve the attempt and inspect provider state.");
  process.exitCode = 1;
}
