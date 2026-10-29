import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_ID,
  APP_NAME,
  AUTH_NAME,
  MAX_REQUESTS,
  validatePreflight,
  validatePreviewConfiguration,
  validateRuntimeDatabase,
} from "./deployment-plan.mjs";

const now = Date.parse("2026-10-29T18:00:00Z");
const preflight = () => ({
  accountId: ACCOUNT_ID,
  observedAt: new Date(now).toISOString(),
  plan: "paid-user-confirmed",
  additionalCostsAuthorized: false,
  newPaidProductsAllowed: false,
  targets: [
    { name: APP_NAME, exists: false },
    { name: AUTH_NAME, exists: false },
  ],
  approvedProbeRequestMaximum: MAX_REQUESTS,
  publishedIncludedAllowance: { requestsPerMonth: 10000000, cpuMillisecondsPerMonth: 30000000 },
  usage: { requests: 300000, conservativeCpuMilliseconds: 21000000 },
});
test("preparation requires fresh account/name/headroom evidence", () => {
  validatePreflight(preflight(), now);
  for (const edit of [
    (p) => {
      p.accountId = "other";
    },
    (p) => {
      p.observedAt = new Date(now - 31 * 60000).toISOString();
    },
    (p) => {
      p.targets[0].exists = true;
    },
    (p) => {
      p.usage.conservativeCpuMilliseconds = 30000000;
    },
    (p) => {
      p.additionalCostsAuthorized = true;
    },
  ]) {
    const p = preflight();
    edit(p);
    assert.throws(() => validatePreflight(p, now));
  }
});
function configs() {
  const common = {
    workers_dev: false,
    preview_urls: false,
    limits: { cpu_ms: 100 },
    observability: { enabled: false },
  };
  return [
    {
      ...common,
      name: APP_NAME,
      assets: { run_worker_first: true },
      services: [{ binding: "AUTH_SERVICE", service: AUTH_NAME }],
    },
    { ...common, name: AUTH_NAME },
  ];
}
test("preparation rejects asset bypass, public routing, cron and added products", () => {
  validatePreviewConfiguration(...configs());
  for (const edit of [
    (a) => {
      a.assets.run_worker_first = false;
    },
    (a) => {
      a.workers_dev = true;
    },
    (a) => {
      a.routes = ["example.com/*"];
    },
    (a) => {
      a.triggers = { crons: ["* * * * *"] };
    },
    (a) => {
      a.r2_buckets = [];
    },
    (a) => {
      a.limits.cpu_ms = 1000;
    },
  ]) {
    const pair = configs();
    edit(pair[0]);
    assert.throws(() => validatePreviewConfiguration(...pair));
  }
});
test("runtime credential cannot bind an owner, production database or other endpoint", () => {
  const runtime =
    "postgresql://hive_app_runtime:fixture@ep-jolly-sky-b7fhirib-pooler.c-13.us-east-1.aws.neon.tech/hive_app_preview?sslmode=require";
  validateRuntimeDatabase(runtime);
  for (const value of [
    runtime.replace("hive_app_runtime", "owner"),
    runtime.replace("hive_app_preview", "production"),
    runtime.replace("ep-jolly-sky-b7fhirib", "ep-other"),
    runtime.replace("require", "disable"),
    runtime.replace("c-13.us-east-1.aws.neon.tech", "example.neon.tech"),
    runtime.replace("/hive_app_preview", ":5433/hive_app_preview"),
    `${runtime}#fragment`,
  ])
    assert.throws(() => validateRuntimeDatabase(value));
});
