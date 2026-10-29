import assert from "node:assert/strict";

export const ACCOUNT_ID = "225177f82b9234ede14e897fe15e0cb5";
export const APP_NAME = "hive-app-compatibility-preview";
export const AUTH_NAME = "hive-auth-compatibility-preview";
export const MAX_REQUESTS = 30;
export const CPU_LIMIT_MS = 100;

export function validatePreflight(preflight, now = Date.now()) {
  assert.equal(preflight.accountId, ACCOUNT_ID, "Preview account mismatch");
  const age = now - Date.parse(preflight.observedAt);
  assert.ok(
    Number.isFinite(age) && age >= -60_000 && age <= 30 * 60_000,
    "Refresh read-only account/quota evidence before preparation",
  );
  assert.equal(preflight.plan, "paid-user-confirmed");
  assert.ok(
    typeof preflight.workersSubdomain === "string" &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(preflight.workersSubdomain),
    "Verify account Workers subdomain",
  );
  assert.equal(preflight.additionalCostsAuthorized, false);
  assert.equal(preflight.newPaidProductsAllowed, false);
  for (const name of [APP_NAME, AUTH_NAME])
    assert.ok(
      preflight.targets.some((target) => target.name === name && target.exists === false),
      "Verify new Worker names are absent",
    );
  assert.equal(preflight.approvedProbeRequestMaximum, MAX_REQUESTS);
  const requests = preflight.publishedIncludedAllowance.requestsPerMonth - preflight.usage.requests;
  const cpu =
    preflight.publishedIncludedAllowance.cpuMillisecondsPerMonth -
    preflight.usage.conservativeCpuMilliseconds;
  // Adaptive metrics are not billing guarantees. Require ample observed room
  // for app + two auth calls per scripted request, with a tenfold reserve.
  assert.ok(
    requests >= MAX_REQUESTS * 10 && cpu >= MAX_REQUESTS * CPU_LIMIT_MS * 3 * 10,
    "Insufficient observed included allowance; review costs before deployment",
  );
}

export function validatePreviewConfiguration(app, auth) {
  assert.equal(app.name, APP_NAME);
  assert.equal(auth.name, AUTH_NAME);
  assert.equal(app.assets?.run_worker_first, true, "All assets must pass the preview gate");
  assert.deepEqual(app.services, [{ binding: "AUTH_SERVICE", service: AUTH_NAME }]);
  assert.equal(auth.services, undefined);
  for (const config of [app, auth]) {
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.ok(
      Number.isInteger(config.limits?.cpu_ms) &&
        config.limits.cpu_ms > 0 &&
        config.limits.cpu_ms <= CPU_LIMIT_MS,
    );
    assert.equal(config.observability?.enabled, false);
    assert.ok(
      !config.routes?.length && !config.triggers?.crons?.length,
      "No routes or cron may be prepared",
    );
    for (const binding of [
      "r2_buckets",
      "hyperdrive",
      "kv_namespaces",
      "durable_objects",
      "d1_databases",
      "queues",
      "ai",
      "images",
      "browser",
      "containers",
      "workflows",
      "vectorize",
      "ratelimits",
      "send_email",
    ])
      assert.equal(config[binding], undefined, "No additional resource binding may be prepared");
    for (const value of Object.values(config.vars ?? {}))
      assert.ok(
        typeof value !== "string" || !/postgres(?:ql)?:\/\/|Bearer /i.test(value),
        "Runtime credentials must not be text variables",
      );
  }
}

export function validateRuntimeDatabase(value) {
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.username, "hive_app_runtime", "Bind only the isolated runtime role");
  assert.equal(url.pathname, "/hive_app_preview");
  assert.ok(
    [
      "ep-jolly-sky-b7fhirib.c-13.us-east-1.aws.neon.tech",
      "ep-jolly-sky-b7fhirib-pooler.c-13.us-east-1.aws.neon.tech",
    ].includes(url.hostname),
  );
  assert.equal(url.port, "", "Use the default endpoint port");
  assert.equal(url.hash, "", "Connection fragments are not supported");
  assert.deepEqual(url.searchParams.getAll("sslmode"), ["require"]);
  for (const key of url.searchParams.keys())
    assert.ok(["sslmode", "channel_binding"].includes(key));
  if (url.searchParams.has("channel_binding"))
    assert.deepEqual(url.searchParams.getAll("channel_binding"), ["require"]);
}
