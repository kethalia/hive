import assert from "node:assert/strict";
import { ACCOUNT_ID, APP_NAME } from "./deployment-plan.mjs";

export const PILOT_JOBS_NAME = "hive-jobs-compatibility-preview";
export const PILOT_JOBS_CRON = "*/5 * * * *";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;

/** Readback is obtained independently from the provider immediately before each
 * action. The creation receipt originates from this task's actual creation, never
 * from a workspace handoff or name match. */
export function assertJobsTransition({
  action,
  record,
  provider,
  creation,
  enrollment,
  localProof,
  appReceipt,
  now = Date.now(),
}) {
  assert.ok(["create", "enable", "disable"].includes(action));
  assert.equal(record.accountId, ACCOUNT_ID);
  assert.ok(record.deliveryPilotCandidate);
  assert.match(record.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(provider.accountId, ACCOUNT_ID);
  const age = now - Date.parse(provider.observedAt);
  assert.ok(Number.isFinite(age) && age >= -5000 && age <= 60000);
  if (action !== "disable") {
    assert.equal(provider.quota.additionalCostsAuthorized, false);
    assert.equal(provider.quota.newPaidProductsAllowed, false);
    assert.ok(
      Number.isFinite(provider.quota.remainingRequests) && provider.quota.remainingRequests >= 180,
    );
    assert.ok(
      Number.isFinite(provider.quota.remainingCpuMilliseconds) &&
        provider.quota.remainingCpuMilliseconds >= 18000,
    );
    assert.equal(localProof.passed, true);
    assert.equal(localProof.sourceRevision, record.sourceRevision);
    assert.equal(localProof.actualWorkerd, true);
    assert.equal(localProof.oneIntentPerWake, true);
    assert.equal(provider.app.name, APP_NAME);
    assert.equal(provider.app.sourceRevision, record.sourceRevision);
    for (const id of [provider.app.deploymentId, provider.app.versionId]) assert.match(id, uuid);
    assert.equal(appReceipt.runId, record.runId);
    assert.equal(appReceipt.sourceRevision, record.sourceRevision);
    assert.match(appReceipt.tag, /^[a-f0-9]{32}$/);
    assert.ok(Number.isFinite(Date.parse(appReceipt.createdOn)));
    assert.equal(provider.app.tag, appReceipt.tag);
    assert.equal(provider.app.createdOn, appReceipt.createdOn);
    assert.equal(provider.app.deploymentId, appReceipt.deploymentId);
    assert.equal(provider.app.versionId, appReceipt.versionId);
    assert.equal(provider.app.publicState.enabled, false);
    assert.equal(provider.app.publicState.previews_enabled, false);
    assert.equal(provider.app.repositoryPolicyEnabled, true);
    assert.equal(provider.app.repositoryCatalogSHA256, record.repositoryCatalogSHA256);
  }
  const jobs = provider.jobs;
  assert.equal(jobs.name, PILOT_JOBS_NAME);
  if (action === "create") {
    assert.equal(jobs.exists, false);
    assert.equal(creation, undefined);
    return;
  }
  assert.equal(jobs.exists, true);
  assert.equal(creation.accountId, ACCOUNT_ID);
  assert.equal(creation.name, PILOT_JOBS_NAME);
  assert.equal(creation.runId, record.runId);
  assert.match(creation.tag, /^[a-f0-9]{32}$/);
  assert.ok(Number.isFinite(Date.parse(creation.createdOn)));
  assert.equal(jobs.tag, creation.tag);
  assert.equal(jobs.createdOn, creation.createdOn);
  if (action !== "disable") assert.equal(jobs.sourceRevision, record.sourceRevision);
  for (const id of [jobs.deploymentId, jobs.versionId]) assert.match(id, uuid);
  assert.equal(jobs.deploymentId, creation.deploymentId);
  assert.equal(jobs.versionId, creation.versionId);
  assert.equal(jobs.publicState.enabled, false);
  assert.equal(jobs.publicState.previews_enabled, false);
  if (action !== "disable")
    assert.deepEqual(jobs.bindings, [
      "APP_SERVICE",
      "HIVE_DELIVERY_PILOT_MODE",
      "HIVE_PROJECT_TASK_RECONCILE_SECRET",
      "HIVE_PROJECT_TASKS_ENABLED",
      "HIVE_RUNTIME_TARGET",
      "SOURCE_REVISION",
    ]);
  if (action !== "disable") {
    assert.equal(jobs.appService, APP_NAME);
    assert.equal(jobs.projectTasksEnabled, true);
    assert.equal(jobs.pilotMode, true);
  }
  assert.deepEqual(jobs.schedules, action === "enable" ? [] : [PILOT_JOBS_CRON]);
  if (action === "enable") {
    assert.equal(enrollment.verifiedReadOnlyDatabase, true);
    assert.equal(enrollment.databaseName, "hive_app_preview");
    assert.equal(enrollment.runtimeRole, "hive_app_runtime");
    assert.equal(enrollment.ownerId, record.deliveryPilotCandidate.repositoryPolicies[0].ownerId);
    assert.equal(
      enrollment.repositoryId,
      record.deliveryPilotCandidate.repositoryPolicies[0].repositoryId,
    );
    assert.equal(
      enrollment.providerAccountId,
      record.deliveryPilotCandidate.repositoryPolicies[0].providerAccountId,
    );
    assert.equal(enrollment.fullName, record.deliveryPilotCandidate.repositoryPolicies[0].fullName);
    assert.equal(enrollment.policyDigest, record.repositoryPolicyDigest);
    assert.equal(enrollment.catalogDigest, record.repositoryCatalogDigest);
    assert.match(enrollment.policyVersionId, uuid);
    assert.match(enrollment.policyDigest, sha);
    assert.equal(enrollment.active, true);
    assert.equal(enrollment.revoked, false);
    const enrollmentAge = now - Date.parse(enrollment.observedAt);
    assert.ok(Number.isFinite(enrollmentAge) && enrollmentAge >= -5000 && enrollmentAge <= 60000);
  }
}
