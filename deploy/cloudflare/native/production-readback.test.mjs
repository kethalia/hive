import assert from "node:assert/strict";
import test from "node:test";
import {
  collectProductionReadback,
  compareProductionReadback,
  inactiveProductionBaseline,
  READBACK_BODY_BYTES,
  READBACK_DEADLINE_MS,
  productionReadbackTarget as target,
} from "./production-readback.mjs";

const deploymentId = "10000000-0000-4000-8000-000000000001";
const versionId = "20000000-0000-4000-8000-000000000001";
const marker = "unexpected-private-credential-value";
function fixture(mutate = () => {}) {
  const calls = [];
  const data = {
    zone: {
      id: target.zoneId,
      name: target.zoneName,
      account: { id: target.accountId },
      status: "active",
    },
    scripts: [
      { id: "hive", tag: "a".repeat(32), created_on: "2026-11-06T00:00:00Z", credential: marker },
    ],
    deployments: {
      deployments: [
        {
          id: deploymentId,
          strategy: "percentage",
          versions: [{ version_id: versionId, percentage: 100 }],
        },
      ],
    },
    version: {
      id: versionId,
      resources: {
        script: { etag: "artifact-hash", secret: marker },
        script_runtime: { compatibility_date: "2026-10-29" },
        bindings: [
          {
            name: "HIVE_NATIVE_MODE",
            type: "plain_text",
            text: "bootstrap",
          },
        ],
      },
    },
    secrets: [],
    settings: { logpush: false },
    schedules: { schedules: [] },
    subdomain: { enabled: false, previews_enabled: true },
    routes: [],
    domains: [],
  };
  const fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer private-fixture-token");
    let key;
    if (url.pathname === `/client/v4/zones/${target.zoneId}`) key = "zone";
    else if (url.pathname.endsWith("/scripts")) key = "scripts";
    else if (url.pathname.endsWith("/deployments")) key = "deployments";
    else if (url.pathname.includes("/versions/")) key = "version";
    else if (url.pathname.endsWith("/script-settings")) key = "settings";
    else if (url.pathname.endsWith("/routes")) key = "routes";
    else if (url.pathname.endsWith("/domains")) key = "domains";
    else key = url.pathname.split("/").at(-1);
    assert.ok(Object.hasOwn(data, key), "unexpected provider URL");
    const result = structuredClone(data[key]);
    const envelope = { success: true, result, errors: [], unexpectedCredential: marker };
    const replacement = await mutate({ key, result, envelope, calls, init });
    return replacement ?? Response.json(envelope);
  };
  return {
    data,
    calls,
    fetcher,
    collect: () => collectProductionReadback({ token: "private-fixture-token", fetcher }),
  };
}
test("observed bootstrap nullable settings are preserved and their drift still holds", async () => {
  const f = fixture();
  f.data.settings = { logpush: false, tags: null, tail_consumers: null, observability: null };
  const actual = await f.collect();
  assert.equal(actual.snapshot.inactive, true);
  assert.equal(actual.activationAuthorized, false);
  const changed = fixture(({ key, result, calls }) => {
    if (key === "settings" && calls.length > 10) result.tags = [];
  });
  changed.data.settings = structuredClone(f.data.settings);
  await assert.rejects(changed.collect(), /production_readback_hold/);
  for (const key of ["tags", "tail_consumers", "observability"]) {
    const invalid = fixture();
    invalid.data.settings = { ...f.data.settings, [key]: false };
    await assert.rejects(invalid.collect(), /production_readback_hold/);
  }
});
test("live custom-domain IDs have a separate bounded format from zone/route IDs", async () => {
  const f = fixture();
  f.data.domains = [
    {
      id: "b".repeat(40),
      hostname: "other.kethalia.com",
      service: "another-app",
      zone_id: target.zoneId,
      zone_name: target.zoneName,
      enabled: true,
      previews_enabled: false,
    },
  ];
  const actual = await f.collect();
  assert.equal(actual.snapshot.domains[0].id, "b".repeat(40));
  assert.equal(actual.snapshot.inactive, true);
  f.data.domains[0].id = "b".repeat(41);
  await assert.rejects(f.collect(), /production_readback_hold/);
});
test("successful Domains envelopes may use null errors; actual or malformed errors hold", async () => {
  const f = fixture(({ key, envelope }) => {
    if (key === "domains") envelope.errors = null;
  });
  assert.equal((await f.collect()).snapshot.inactive, true);
  for (const errors of [false, {}, [{ code: 1, message: marker }]]) {
    const invalid = fixture(({ key, envelope }) => {
      if (key === "domains") envelope.errors = errors;
    });
    await assert.rejects(invalid.collect(), /production_readback_hold/);
  }
});
test("two fixed GET-only samples produce sanitized metadata and an inactive recipe baseline", async () => {
  const f = fixture(),
    actual = await f.collect();
  assert.equal(f.calls.length, 19);
  assert.equal(actual.snapshot.versionPreviews, true);
  assert.equal(actual.snapshot.inactive, true);
  assert.equal(actual.providerBaselineVerified, false);
  assert.equal(actual.activationAuthorized, false);
  const serialized = JSON.stringify(actual);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("private-fixture-token"), false);
  assert.equal(serialized.includes("unexpectedEnv"), false);
  assert.deepEqual(compareProductionReadback(actual, structuredClone(actual)), {
    state: "matched",
    activationAuthorized: false,
  });
  const baseline = inactiveProductionBaseline(actual);
  assert.equal(baseline.baseline.settingsDigest, actual.settingsDigest);
  assert.equal(baseline.baseline.workerTag, "a".repeat(32));
});
test("unknown identity, partial lists, split deployment, missing state and provider errors hold", async () => {
  for (const change of [
    ({ key, result }) => {
      if (key === "zone") result.account.id = "b".repeat(32);
    },
    ({ key, result }) => {
      if (key === "zone") result.name = "other.example";
    },
    ({ key, result }) => {
      if (key === "zone") result.status = "pending";
    },
    ({ key, result }) => {
      if (key === "scripts") result.push(structuredClone(result[0]));
    },
    ({ key, envelope }) => {
      if (key === "scripts") envelope.result_info = { total_pages: 2 };
    },
    ({ key, result }) => {
      if (key === "deployments") result.deployments[0].versions[0].percentage = 50;
    },
    ({ key, result }) => {
      if (key === "version") result.id = deploymentId;
    },
    ({ key, result }) => {
      if (key === "version") delete result.resources.bindings;
    },
    ({ key, result }) => {
      if (key === "version") result.resources.bindings[0].type = "unknown_binding_type";
    },
    ({ key, result }) => {
      if (key === "subdomain") delete result.enabled;
    },
    ({ key, result }) => {
      if (key === "secrets")
        result.push({ type: "secret_text", name: "DATABASE_URL", text: marker });
    },
    ({ key, envelope }) => {
      if (key === "zone") envelope.success = false;
    },
  ])
    await assert.rejects(fixture(change).collect(), { message: "production_readback_hold" });
});
test("no token or provider error details enter public failure", async () => {
  await assert.rejects(
    collectProductionReadback({
      token: "bad\nheader",
      fetcher: () => assert.fail("must not fetch"),
    }),
    { message: "production_readback_hold" },
  );
  await assert.rejects(
    collectProductionReadback({
      token: "private",
      fetcher: () => {
        throw new Error(marker);
      },
    }),
    { message: "production_readback_hold" },
  );
});
test("metadata, binding-value and routing drift between samples holds", async () => {
  for (const changedKey of [
    "deployments",
    "settings",
    "version",
    "routes",
    "domains",
    "schedules",
    "subdomain",
    "scripts",
  ]) {
    const seen = {};
    const f = fixture(({ key, result }) => {
      seen[key] = (seen[key] ?? 0) + 1;
      if (key !== changedKey || seen[key] !== 2) return;
      if (key === "deployments") result.deployments[0].id = "30000000-0000-4000-8000-000000000001";
      if (key === "settings") result.logpush = true;
      if (key === "version") result.resources.bindings[0].text = "production";
      if (key === "routes")
        result.push({ id: "c".repeat(32), pattern: "*.kethalia.com/*", script: "other" });
      if (key === "domains")
        result.push({
          id: "d".repeat(32),
          hostname: target.hostname,
          service: "other",
          zone_id: target.zoneId,
          zone_name: target.zoneName,
          enabled: true,
          previews_enabled: false,
        });
      if (key === "schedules") result.schedules.push({ cron: "* * * * *" });
      if (key === "subdomain") result.enabled = true;
      if (key === "scripts") result[0].tag = "e".repeat(32);
    });
    await assert.rejects(f.collect(), { message: "production_readback_hold" });
  }
});
test("routed/scheduled/active state cannot be presented as an inactive first-cutover baseline", async () => {
  for (const change of [
    (d) => {
      d.subdomain.enabled = true;
    },
    (d) => {
      d.version.resources.bindings[0].text = "production";
    },
    (d) => {
      d.schedules.schedules.push({ cron: "* * * * *" });
    },
    (d) => {
      d.routes.push({ id: "b".repeat(32), pattern: "other.kethalia.com/*", script: "hive" });
    },
    (d) => {
      d.domains.push({
        id: "b".repeat(32),
        hostname: "other.kethalia.com",
        service: "hive",
        zone_id: target.zoneId,
        zone_name: target.zoneName,
        enabled: false,
        previews_enabled: true,
      });
    },
  ]) {
    const f = fixture();
    change(f.data);
    const actual = await f.collect();
    assert.equal(actual.snapshot.inactive, false);
    assert.throws(() => inactiveProductionBaseline(actual));
  }
});
test("comparison never accepts drift or echoes untrusted expected artifact fields", async () => {
  const actual = await fixture().collect();
  const changed = structuredClone(actual);
  changed.snapshot.versionId = deploymentId;
  assert.equal(compareProductionReadback(actual, changed).state, "hold");
  assert.equal(compareProductionReadback({}, { token: marker }).state, "hold");
  assert.equal(
    JSON.stringify(compareProductionReadback({}, { token: marker })).includes(marker),
    false,
  );
});
test("redirect, oversized and stalled response bodies are cancelled within the finite deadline", async (t) => {
  let cancelled = false;
  const redirect = fixture(
    () => new Response(null, { status: 302, headers: { Location: "https://untrusted.example" } }),
  );
  await assert.rejects(redirect.collect(), { message: "production_readback_hold" });
  const oversized = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(READBACK_BODY_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(oversized.collect(), { message: "production_readback_hold" });
  assert.equal(cancelled, true);
  cancelled = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled = fixture(
    () =>
      new Response(
        new ReadableStream({
          pull() {},
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const pending = stalled.collect();
  const rejected = assert.rejects(pending, { message: "production_readback_hold" });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(READBACK_DEADLINE_MS);
  await rejected;
  assert.equal(cancelled, true);
});
test("ignored fetch cancellation returns on deadline and cancels a late body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish,
    cancelled = false;
  const pending = collectProductionReadback({
    token: "private",
    fetcher: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const rejected = assert.rejects(pending, { message: "production_readback_hold" });
  await Promise.resolve();
  t.mock.timers.tick(READBACK_DEADLINE_MS);
  await rejected;
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(cancelled, true);
});

test("production secret lists export names only even if the provider unexpectedly returns values", async () => {
  const f = fixture();
  f.data.version.resources.bindings.push({
    name: "DATABASE_URL",
    type: "secret_text",
    text: marker,
  });
  f.data.secrets.push({
    name: "DATABASE_URL",
    type: "secret_text",
    text: marker,
    credentials: { value: marker },
  });
  const actual = await f.collect();
  assert.deepEqual(actual.snapshot.secretNames, ["DATABASE_URL"]);
  assert.equal(JSON.stringify(actual).includes(marker), false);
  assert.equal(JSON.stringify(actual).includes("credentials"), false);
  assert.equal(actual.snapshot.inactive, false);
});
test("stale/future readback cannot be reused as a fresh baseline or a matched observation", async () => {
  const actual = await fixture().collect();
  for (const timestamp of [
    "invalid",
    new Date(Date.now() - 301000).toISOString(),
    new Date(Date.now() + 60000).toISOString(),
  ]) {
    const changed = structuredClone(actual);
    changed.observedAt = timestamp;
    assert.throws(() => inactiveProductionBaseline(changed));
    assert.equal(compareProductionReadback(changed, actual).state, "hold");
  }
});

test("returned secret payload changes never influence public digests, even between samples", async () => {
  let secretSample = 0;
  const f = fixture(({ key, result }) => {
    if (key === "version") {
      secretSample++;
      result.resources.bindings.push({
        name: "DATABASE_URL",
        type: "secret_text",
        text: `${marker}-${secretSample}`,
        value: `${marker}-value`,
        unknown: { credential: `${marker}-${secretSample}` },
      });
      result.resources.script.secret = `${marker}-${secretSample}`;
    }
    if (key === "secrets")
      result.push({
        name: "DATABASE_URL",
        type: "secret_text",
        text: `${marker}-${secretSample}`,
        value: marker,
      });
  });
  const first = await f.collect();
  const second = await f.collect();
  assert.equal(first.settingsDigest, second.settingsDigest);
  assert.equal(first.snapshot.versionDigest, second.snapshot.versionDigest);
  assert.equal(first.snapshot.scriptSettingsDigest, second.snapshot.scriptSettingsDigest);
  assert.equal(first.snapshot.coverage, "reviewed-public-config-v1");
  assert.equal(JSON.stringify(first).includes(marker), false);
});
test("unknown public variables or unreviewed configuration settings hold before hashing", async () => {
  for (const change of [
    ({ key, result }) => {
      if (key === "version")
        result.resources.bindings.push({
          name: "UNREVIEWED_TOKEN",
          type: "plain_text",
          text: marker,
        });
    },
    ({ key, result }) => {
      if (key === "version") result.resources.bindings[0].credentials = marker;
    },
    ({ key, result }) => {
      if (key === "version") result.resources.script_runtime.unreviewed = { token: marker };
    },
    ({ key, result }) => {
      if (key === "settings") result.unexpectedEnv = { credential: marker };
    },
    ({ key, result }) => {
      if (key === "settings")
        result.observability = { enabled: true, logs: { enabled: true, destinations: [marker] } };
    },
  ])
    await assert.rejects(fixture(change).collect(), { message: "production_readback_hold" });
});

test("ambiguous, cursor-based or malformed list pagination always holds", async () => {
  for (const info of [
    null,
    false,
    [],
    {},
    { page: 1 },
    { page: 1, count: 0, per_page: 20 },
    { page: 1, cursors: { after: "next" } },
    { page: 1, total_count: 0, has_more: true },
    { page: 1, count: 20, per_page: 20 },
    { page: 2, total_count: 0 },
    { page: 1, total_count: 1 },
    { page: 1, total_count: "0" },
    { page: 1, total_count: -1 },
    { page: 1, total_count: 0.5 },
    { page: 1, total_pages: 2 },
    { page: 1, total_pages: -1 },
    { page: 1, total_pages: 1.5 },
    { page: 1, total_count: 0, count: 1 },
    { page: 1, total_count: 0, per_page: 0 },
    { page: 1, total_count: 0, total_pages: 1, per_page: 20 },
  ]) {
    for (const endpoint of ["routes", "domains"]) {
      const f = fixture(({ key, envelope }) => {
        if (key === endpoint) envelope.result_info = info;
      });
      await assert.rejects(f.collect(), { message: "production_readback_hold" });
    }
  }
});
test("recognized first-page totals prove completeness only when all supplied counts agree", async () => {
  for (const info of [
    { page: 1, total_count: 0 },
    { page: 1, total_pages: 0 },
    { page: 1, total_count: 0, total_pages: 0, per_page: 20, count: 0 },
  ]) {
    const f = fixture(({ key, envelope }) => {
      if (key === "domains" || key === "routes") envelope.result_info = info;
    });
    assert.equal((await f.collect()).snapshot.inactive, true);
  }
  const f = fixture(({ key, envelope }) => {
    if (key === "scripts")
      envelope.result_info = { page: 1, count: 1, per_page: 20, total_count: 1, total_pages: 1 };
  });
  assert.equal((await f.collect()).snapshot.inactive, true);
  const partial = fixture(({ key, envelope }) => {
    if (key === "scripts")
      envelope.result_info = { page: 1, count: 1, per_page: 20, total_count: 2, total_pages: 1 };
  });
  await assert.rejects(partial.collect(), { message: "production_readback_hold" });
});

test("ongoing public configuration identity survives code-only builds but changes with enrolled policy", async () => {
  const f = fixture();
  f.data.version.resources.bindings.push({
    name: "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
    type: "plain_text",
    text: "[]",
  });
  const first = await f.collect();
  f.data.version.resources.script.etag = "next-code-artifact";
  const next = await f.collect();
  assert.notEqual(first.settingsDigest, next.settingsDigest);
  assert.equal(first.snapshot.publicConfigurationDigest, next.snapshot.publicConfigurationDigest);
  f.data.version.resources.bindings.at(-1).text = '[{"version":"next-reviewed-policy"}]';
  const changed = await f.collect();
  assert.notEqual(
    next.snapshot.publicConfigurationDigest,
    changed.snapshot.publicConfigurationDigest,
  );
});
