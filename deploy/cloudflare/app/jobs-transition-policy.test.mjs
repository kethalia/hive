import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_ID, APP_NAME } from "./deployment-plan.mjs";
import {
  assertJobsTransition,
  PILOT_JOBS_CRON,
  PILOT_JOBS_NAME,
} from "./jobs-transition-policy.mjs";

const uuid = "11111111-1111-4111-8111-111111111111",
  now = Date.now(),
  digest = "a".repeat(64),
  rev = "b".repeat(40);
function fixture(action = "enable") {
  const entry = {
    ownerId: uuid,
    repositoryId: "123",
    providerAccountId: "456",
    fullName: "example/repo",
  };
  const record = {
    accountId: ACCOUNT_ID,
    sourceRevision: rev,
    runId: "run",
    deliveryPilotCandidate: { repositoryPolicies: [entry] },
    repositoryCatalogSHA256: digest,
    repositoryCatalogDigest: digest,
    repositoryPolicyDigest: digest,
  };
  const app = {
    name: APP_NAME,
    sourceRevision: rev,
    deploymentId: uuid,
    versionId: uuid,
    tag: "c".repeat(32),
    createdOn: new Date(now - 1000).toISOString(),
    publicState: { enabled: false, previews_enabled: false },
    repositoryPolicyEnabled: true,
    repositoryCatalogSHA256: digest,
  };
  const jobs = {
    name: PILOT_JOBS_NAME,
    exists: action !== "create",
    tag: "d".repeat(32),
    createdOn: new Date(now - 500).toISOString(),
    sourceRevision: rev,
    deploymentId: uuid,
    versionId: uuid,
    publicState: { enabled: false, previews_enabled: false },
    bindings: [
      "APP_SERVICE",
      "HIVE_DELIVERY_PILOT_MODE",
      "HIVE_PROJECT_TASK_RECONCILE_SECRET",
      "HIVE_PROJECT_TASKS_ENABLED",
      "HIVE_RUNTIME_TARGET",
      "SOURCE_REVISION",
    ],
    appService: APP_NAME,
    projectTasksEnabled: true,
    pilotMode: true,
    schedules: action === "disable" ? [PILOT_JOBS_CRON] : [],
  };
  const provider = {
    accountId: ACCOUNT_ID,
    observedAt: new Date(now).toISOString(),
    app,
    jobs,
    quota: {
      additionalCostsAuthorized: false,
      newPaidProductsAllowed: false,
      remainingRequests: 1000,
      remainingCpuMilliseconds: 100000,
    },
  };
  const creation =
    action === "create"
      ? undefined
      : {
          accountId: ACCOUNT_ID,
          name: PILOT_JOBS_NAME,
          runId: record.runId,
          tag: jobs.tag,
          createdOn: jobs.createdOn,
          deploymentId: uuid,
          versionId: uuid,
        };
  const appReceipt = {
    runId: record.runId,
    sourceRevision: rev,
    deploymentId: uuid,
    versionId: uuid,
    tag: app.tag,
    createdOn: app.createdOn,
  };
  const enrollment = {
    ...entry,
    verifiedReadOnlyDatabase: true,
    databaseName: "hive_app_preview",
    runtimeRole: "hive_app_runtime",
    policyVersionId: uuid,
    policyDigest: digest,
    catalogDigest: digest,
    active: true,
    revoked: false,
    observedAt: new Date(now).toISOString(),
  };
  const localProof = {
    passed: true,
    sourceRevision: rev,
    actualWorkerd: true,
    oneIntentPerWake: true,
  };
  return { action, record, provider, creation, appReceipt, enrollment, localProof, now };
}
test("creation requires absent identity and current scoped app and proof", () => {
  const f = fixture("create");
  assert.doesNotThrow(() => assertJobsTransition(f));
  f.provider.jobs.exists = true;
  assert.throws(() => assertJobsTransition(f));
});
test("activation requires exact owned deployment, active enrolled policy and local proof", () => {
  assert.doesNotThrow(() => assertJobsTransition(fixture()));
  for (const m of [
    (f) => (f.provider.jobs.tag = "e".repeat(32)),
    (f) => (f.provider.jobs.versionId = "22222222-2222-4222-8222-222222222222"),
    (f) => (f.provider.jobs.schedules = [PILOT_JOBS_CRON]),
    (f) => (f.enrollment.revoked = true),
    (f) => (f.enrollment.policyDigest = "f".repeat(64)),
    (f) => (f.localProof.oneIntentPerWake = false),
    (f) => (f.provider.app.publicState.enabled = true),
    (f) => (f.provider.app.repositoryCatalogSHA256 = "f".repeat(64)),
    (f) => (f.provider.observedAt = new Date(now - 61000).toISOString()),
  ]) {
    const f = fixture();
    m(f);
    assert.throws(() => assertJobsTransition(f));
  }
});
test("disable still checks owned job but does not require app or policy health", () => {
  const f = fixture("disable");
  f.provider.app = undefined;
  f.enrollment = undefined;
  f.localProof = undefined;
  assert.doesNotThrow(() => assertJobsTransition(f));
  f.provider.jobs.tag = "f".repeat(32);
  assert.throws(() => assertJobsTransition(f));
});
