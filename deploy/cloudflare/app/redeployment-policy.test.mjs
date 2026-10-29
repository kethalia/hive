import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_ID,
  APP_NAME,
  AUTH_NAME,
  MAX_REQUESTS,
  validatePreflight,
} from "./deployment-plan.mjs";
import { validatePreviewRedeployment } from "./redeployment-policy.mjs";

const account = "account",
  names = { app: "app", auth: "auth" };
function fixture(accountId = account, workerNames = names) {
  const disabled = { enabled: false, previews_enabled: false };
  const previous = {
    accountId,
    sourceRevision: "a".repeat(40),
    probe: { finalPassed: true },
    prepared: { previewIdentityId: "stable-identity" },
    finalPublicState: { app: disabled, auth: disabled },
    scriptIdentities: Object.values(workerNames).map((name) => ({
      name,
      tag: (name === workerNames.app ? "a" : "b").repeat(32),
      createdOn: "2026-10-29T19:00:00.123456Z",
    })),
    workers: Object.fromEntries(
      Object.entries(workerNames).map(([kind, name], index) => [
        kind,
        {
          name,
          deploymentId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          versionId: `00000000-0000-4000-8000-00000000000${index + 3}`,
        },
      ]),
    ),
  };
  const preflight = {
    targets: previous.scriptIdentities.map((identity) => ({
      ...identity,
      exists: true,
      deploymentId: Object.values(previous.workers).find((worker) => worker.name === identity.name)
        .deploymentId,
      versionId: Object.values(previous.workers).find((worker) => worker.name === identity.name)
        .versionId,
      publicState: { ...disabled },
    })),
  };
  return {
    previous,
    preflight,
    validate: () => validatePreviewRedeployment(preflight, previous, accountId, workerNames),
  };
}
test("accepts only the existing task-created identities and unchanged private deployments", () => {
  fixture().validate();
});
test("existing targets require explicit prior evidence and still require fresh included headroom", () => {
  const f = fixture(ACCOUNT_ID, { app: APP_NAME, auth: AUTH_NAME });
  Object.assign(f.preflight, {
    accountId: ACCOUNT_ID,
    observedAt: new Date().toISOString(),
    workersSubdomain: "b00ste",
    plan: "paid-user-confirmed",
    additionalCostsAuthorized: false,
    newPaidProductsAllowed: false,
    approvedProbeRequestMaximum: MAX_REQUESTS,
    publishedIncludedAllowance: { requestsPerMonth: 10000000, cpuMillisecondsPerMonth: 30000000 },
    usage: { requests: 0, conservativeCpuMilliseconds: 0 },
  });
  validatePreflight(f.preflight, Date.now(), f.previous);
  assert.throws(() => validatePreflight(f.preflight));
  f.preflight.observedAt = new Date(Date.now() - 3600000).toISOString();
  assert.throws(() => validatePreflight(f.preflight, Date.now(), f.previous));
});
test("rejects replaced workers, unexpected versions, partially existing resources and public URLs", () => {
  for (const mutation of [
    (target) => {
      target.tag = "c".repeat(32);
    },
    (target) => {
      target.createdOn = "2026-10-29T20:00:00Z";
    },
    (target) => {
      target.deploymentId = "foreign";
    },
    (target) => {
      target.versionId = "foreign";
    },
    (target) => {
      target.exists = false;
    },
    (target) => {
      target.publicState.enabled = true;
    },
    (target) => {
      target.publicState.previews_enabled = true;
    },
  ]) {
    const f = fixture();
    mutation(f.preflight.targets[0]);
    assert.throws(f.validate);
  }
});
test("rejects foreign account or incomplete/unproven prior deployment evidence", () => {
  for (const mutate of [
    (previous) => {
      previous.accountId = "foreign";
    },
    (previous) => {
      previous.probe.finalPassed = false;
    },
    (previous) => {
      previous.scriptIdentities = [];
    },
    (previous) => {
      previous.finalPublicState.auth.enabled = true;
    },
  ]) {
    const f = fixture();
    mutate(f.previous);
    assert.throws(f.validate);
  }
});
