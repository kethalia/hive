// Read-only operator utility. No upload, deployment, secret mutation or activation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { account } from "./deploy.mjs";

export const productionReadbackTarget = Object.freeze({
  accountId: account,
  workerName: "hive",
  zoneId: "b5a1ed758b9cd1c62fcacf9037dc0dea",
  zoneName: "kethalia.com",
  hostname: "hive.kethalia.com",
});
export const READBACK_DEADLINE_MS = 30000;
export const READBACK_BODY_BYTES = 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const digest = (value) => hash(canonical(value));
const uuid = (value) => {
  assert.match(value, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return value;
};
const id = (value) => {
  assert.match(value, /^[a-f0-9]{32}$/);
  return value;
};
const name = (value) => {
  assert.match(value, /^[A-Za-z0-9_.-]{1,128}$/);
  return value;
};
const array = (value) => {
  assert.ok(Array.isArray(value) && value.length <= 1000);
  return value;
};
const sorted = (value) => value.sort((a, b) => canonical(a).localeCompare(canonical(b)));
const bool = (value) => {
  assert.equal(typeof value, "boolean");
  return value;
};

const only = (value, keys) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(Object.keys(value).every((key) => keys.includes(key)));
};
const publicBooleans = new Set([
  "HIVE_NATIVE_PREVIEW_ENABLED",
  "HIVE_NATIVE_PRODUCTION_ACTIVE",
  "HIVE_PREVIEW_ACCESS_REQUIRED",
  "HIVE_DISABLE_BACKGROUND_WORKERS",
  "HIVE_PROJECT_DISCOVERY_ENABLED",
  "HIVE_PROJECT_TASKS_ENABLED",
  "HIVE_DELIVERY_ENABLED",
  "HIVE_CODEX_GATEWAY_ENABLED",
  "HIVE_DELIVERY_DISPATCH_ENABLED",
  "HIVE_TOKEN_ROTATION_ENABLED",
  "HIVE_CODER_OAUTH_ENABLED",
]);
function publicBinding(binding) {
  const base = { name: name(binding.name), type: name(binding.type) };
  // Secret payloads (even unexpected fields) are deliberately never inspected,
  // hashed or exported. Private identity verification remains an operator gate.
  if (["secret_text", "secret_key"].includes(binding.type)) return base;
  if (binding.type === "plain_text") {
    only(binding, ["name", "type", "text"]);
    const value = binding.text;
    if (publicBooleans.has(binding.name)) assert.ok(["true", "false"].includes(value));
    else if (binding.name === "HIVE_NATIVE_MODE")
      assert.ok(["bootstrap", "production"].includes(value));
    else if (binding.name === "HIVE_RUNTIME_TARGET") assert.equal(value, "cloudflare");
    else if (binding.name === "CODER_URL") assert.equal(value, "https://coder.kethalia.com");
    else if (binding.name === "HIVE_PUBLIC_ORIGIN")
      assert.equal(value, "https://hive.kethalia.com");
    else if (binding.name === "HIVE_CODER_OAUTH_CLIENT_ID")
      assert.match(value, /^[A-Za-z0-9_-]{1,256}$/);
    else throw new Error();
    return { ...base, text: value };
  }
  if (binding.type === "assets") {
    only(binding, ["name", "type"]);
    assert.equal(binding.name, "ASSETS");
    return base;
  }
  assert.equal(binding.type, "r2_bucket");
  only(binding, ["name", "type", "bucket_name", "jurisdiction"]);
  assert.equal(binding.name, "HIVE_DELIVERY_EVIDENCE");
  assert.match(binding.bucket_name, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  assert.ok(
    binding.jurisdiction === undefined ||
      ["default", "eu", "fedramp"].includes(binding.jurisdiction),
  );
  return {
    ...base,
    bucketName: binding.bucket_name,
    ...(binding.jurisdiction ? { jurisdiction: binding.jurisdiction } : {}),
  };
}
function publicRuntime(runtime) {
  only(runtime, [
    "compatibility_date",
    "compatibility_flags",
    "limits",
    "usage_model",
    "exports",
    "migration_tag",
  ]);
  assert.match(runtime.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(runtime.compatibility_date)));
  const flags = array(runtime.compatibility_flags ?? [])
    .map(name)
    .sort();
  if (runtime.exports !== undefined) assert.deepEqual(runtime.exports, {});
  if (runtime.migration_tag !== undefined) assert.equal(runtime.migration_tag, "");
  const result = { compatibilityDate: runtime.compatibility_date, compatibilityFlags: flags };
  if (runtime.usage_model !== undefined) {
    assert.ok(["bundled", "unbound", "standard"].includes(runtime.usage_model));
    result.usageModel = runtime.usage_model;
  }
  if (runtime.limits !== undefined) {
    only(runtime.limits, ["cpu_ms"]);
    assert.ok(Number.isSafeInteger(runtime.limits.cpu_ms) && runtime.limits.cpu_ms > 0);
    result.cpuMs = runtime.limits.cpu_ms;
  }
  return result;
}
function publicSettings(settings) {
  only(settings, ["logpush", "observability", "tags", "tail_consumers"]);
  const result = {};
  if (settings.logpush !== undefined) result.logpush = bool(settings.logpush);
  // Destinations, tails and arbitrary tags require a separately reviewed schema.
  for (const key of ["tags", "tail_consumers"])
    if (settings[key] !== undefined) {
      // The real bootstrap API returns null for these optional collections.
      // Preserve that public value rather than treating an arbitrary value as empty.
      if (settings[key] !== null) assert.deepEqual(settings[key], []);
      result[key] = settings[key];
    }
  function observability(value, allowed) {
    only(value, allowed);
    const projected = {};
    for (const [key, item] of Object.entries(value)) {
      if (["logs", "traces", "issues"].includes(key))
        projected[key] = observability(
          item,
          key === "issues"
            ? ["enabled"]
            : [
                "enabled",
                "head_sampling_rate",
                "invocation_logs",
                "destinations",
                "persist",
                "redact_query_string",
                "propagation_policy",
              ],
        );
      else if (key === "destinations") {
        assert.deepEqual(item, []);
        projected[key] = [];
      } else if (key === "head_sampling_rate") {
        assert.ok(typeof item === "number" && item >= 0 && item <= 1);
        projected[key] = item;
      } else if (key === "propagation_policy") {
        assert.ok(["authenticated", "accept", null].includes(item));
        projected[key] = item;
      } else projected[key] = bool(item);
    }
    return projected;
  }
  if (settings.observability !== undefined)
    result.observability =
      settings.observability === null
        ? null
        : observability(settings.observability, [
            "enabled",
            "head_sampling_rate",
            "logs",
            "traces",
            "issues",
          ]);
  return result;
}

// Race both fetch and each body read: a transport ignoring AbortSignal must not
// retain the caller. Late response bodies are cancelled, never serialized/logged.
async function bounded(promise, signal, late) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(new Error("readback_unavailable"));
    signal.addEventListener("abort", listener, { once: true });
  });
  void promise.then(
    (value) => {
      if (signal.aborted) late?.(value);
    },
    () => {},
  );
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
function completeList(envelope) {
  const list = array(envelope.result);
  const info = envelope.result_info;
  if (Object.hasOwn(envelope, "result_info")) {
    // Script/route/secret endpoints document single-page arrays without this
    // envelope. Domains may provide page totals. Never infer completeness from
    // page/count/per_page alone or silently ignore an unsupported cursor.
    only(info, ["page", "per_page", "count", "total_count", "total_pages"]);
    for (const [key, value] of Object.entries(info)) {
      assert.ok(Number.isSafeInteger(value));
      assert.ok(value >= (["page", "per_page"].includes(key) ? 1 : 0));
    }
    assert.equal(info.page, 1);
    assert.ok(Object.hasOwn(info, "total_count") || Object.hasOwn(info, "total_pages"));
    if (info.count !== undefined) assert.equal(info.count, list.length);
    if (info.per_page !== undefined) assert.ok(info.per_page >= list.length);
    if (info.total_count !== undefined) assert.equal(info.total_count, list.length);
    if (info.total_pages !== undefined) {
      assert.ok(info.total_pages <= 1);
      if (info.total_pages === 0) assert.equal(list.length, 0);
      if (info.total_count !== undefined && info.per_page !== undefined)
        assert.equal(info.total_pages, Math.ceil(info.total_count / info.per_page));
    }
  }
  return list;
}

/** Two complete fixed-scope reads must agree. This detects observed drift, not
 * changes between samples or an atomic provider snapshot. Token stays private. */
export async function collectProductionReadback({ token, fetcher = fetch, signal }) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), READBACK_DEADLINE_MS);
  const deadline = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
  try {
    assert.ok(typeof token === "string" && /^[!-~]{1,4096}$/.test(token));
    const t = productionReadbackTarget;
    const root = `/accounts/${t.accountId}/workers`;
    const script = `${root}/scripts/hive`;
    async function get(path) {
      const response = await bounded(
        Promise.resolve().then(() =>
          fetcher(`https://api.cloudflare.com/client/v4${path}`, {
            method: "GET",
            redirect: "error",
            credentials: "omit",
            signal: deadline,
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          }),
        ),
        deadline,
        (late) => {
          void late.body?.cancel().catch(() => {});
        },
      );
      if (response.status !== 200 || response.redirected || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks = [];
      try {
        for (;;) {
          const part = await bounded(reader.read(), deadline, () => {
            void reader.cancel().catch(() => {});
          });
          if (part.done) break;
          bytes += part.value.byteLength;
          assert.ok(bytes <= READBACK_BODY_BYTES);
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(envelope.success, true);
      // The Domains API returns success:true with errors:null. A nonempty or
      // malformed errors payload still holds; success must remain exactly true.
      if (envelope.errors !== undefined && envelope.errors !== null)
        assert.deepEqual(envelope.errors, []);
      return envelope;
    }
    const zone = (await get(`/zones/${t.zoneId}`)).result;
    assert.equal(zone.id, t.zoneId);
    assert.equal(zone.name, t.zoneName);
    assert.equal(zone.account?.id, t.accountId);
    assert.equal(zone.status, "active");
    async function snapshot() {
      const scripts = completeList(await get(`${root}/scripts`)).filter((s) => s.id === "hive");
      assert.equal(scripts.length, 1);
      const worker = scripts[0];
      id(worker.tag);
      assert.ok(Number.isFinite(Date.parse(worker.created_on)));
      const deployment = (await get(`${script}/deployments?page=1&per_page=1`)).result;
      assert.equal(array(deployment.deployments).length, 1);
      const current = deployment.deployments[0];
      assert.equal(current.strategy, "percentage");
      assert.equal(array(current.versions).length, 1);
      assert.equal(current.versions[0].percentage, 100);
      const deploymentId = uuid(current.id),
        versionId = uuid(current.versions[0].version_id);
      const version = (await get(`${script}/versions/${versionId}`)).result;
      assert.equal(version.id, versionId);
      assert.ok(version.resources?.script?.etag && version.resources.script_runtime);
      assert.equal(typeof version.resources.script.etag, "string");
      assert.ok(version.resources.script.etag.length <= 256);
      assert.equal(typeof version.resources.script_runtime, "object");
      assert.ok(!Array.isArray(version.resources.script_runtime));
      only(version.resources, ["script", "script_runtime", "bindings"]);
      const bindings = array(version.resources.bindings);
      const publicVersion = {
        scriptEtag: version.resources.script.etag,
        runtime: publicRuntime(version.resources.script_runtime),
        bindings: sorted(bindings.map(publicBinding)),
      };
      for (const binding of bindings)
        assert.ok(
          ["plain_text", "secret_text", "secret_key", "assets", "r2_bucket"].includes(binding.type),
        );
      const bindingNames = sorted(
        bindings.map((b) => ({ name: name(b.name), type: name(b.type) })),
      );
      assert.equal(new Set(bindingNames.map((b) => b.name)).size, bindings.length);
      const secrets = sorted(
        completeList(await get(`${script}/secrets`)).map((s) => ({
          name: name(s.name),
          type: name(s.type),
        })),
      );
      assert.equal(new Set(secrets.map((s) => s.name)).size, secrets.length);
      assert.deepEqual(
        secrets,
        bindingNames.filter((b) => b.type === "secret_text" || b.type === "secret_key"),
      );
      const settings = (await get(`${script}/script-settings`)).result;
      assert.ok(settings && typeof settings === "object" && !Array.isArray(settings));
      const schedules = (await get(`${script}/schedules`)).result;
      const crons = sorted(
        array(schedules.schedules).map((s) => {
          assert.equal(typeof s.cron, "string");
          assert.ok(s.cron.length <= 256);
          return s.cron;
        }),
      );
      const subdomain = (await get(`${script}/subdomain`)).result;
      // Keep every route/domain in the fixed zone in the digest so a new wildcard
      // or another owner's more-specific route cannot silently escape comparison.
      const routes = sorted(
        completeList(await get(`/zones/${t.zoneId}/workers/routes`)).map((r) => {
          assert.equal(typeof r.pattern, "string");
          assert.ok(r.pattern.length <= 1024);
          return {
            id: id(r.id),
            pattern: r.pattern,
            script: r.script == null ? null : name(r.script),
          };
        }),
      );
      const domains = sorted(
        completeList(await get(`${root}/domains?zone_id=${t.zoneId}`)).map((d) => {
          assert.equal(d.zone_id, t.zoneId);
          assert.equal(d.zone_name, t.zoneName);
          assert.equal(typeof d.hostname, "string");
          assert.ok(d.hostname.length <= 253);
          return {
            // Workers custom-domain IDs in the live API are 40 hex characters;
            // zone and route IDs retain their separate 32-character contract.
            id: (() => {
              assert.match(d.id, /^(?:[a-f0-9]{32}|[a-f0-9]{40})$/);
              return d.id;
            })(),
            hostname: d.hostname,
            service: name(d.service),
            enabled: bool(d.enabled),
            previewsEnabled: bool(d.previews_enabled),
          };
        }),
      );
      const inert =
        bindings.length === 1 &&
        bindings[0].name === "HIVE_NATIVE_MODE" &&
        bindings[0].type === "plain_text" &&
        bindings[0].text === "bootstrap";
      return {
        ...t,
        workerTag: worker.tag,
        createdOn: worker.created_on,
        deploymentId,
        versionId,
        // Hash only the reviewed public projection. Secret payloads and unknown
        // provider credential fields must never influence public evidence hashes.
        coverage: "reviewed-public-config-v1",
        versionDigest: digest(publicVersion),
        scriptSettingsDigest: digest(publicSettings(settings)),
        bindingNames,
        secretNames: secrets.map((s) => s.name),
        crons,
        routes,
        domains,
        workersDev: bool(subdomain.enabled),
        versionPreviews: bool(subdomain.previews_enabled),
        inactive:
          inert &&
          secrets.length === 0 &&
          crons.length === 0 &&
          !subdomain.enabled &&
          routes.every((r) => r.script !== "hive") &&
          domains.every((d) => d.service !== "hive"),
      };
    }
    const first = await snapshot(),
      second = await snapshot();
    deadline.throwIfAborted();
    assert.equal(digest(first), digest(second));
    return {
      schemaVersion: 1,
      scope: "production-provider-readback",
      observedAt: new Date().toISOString(),
      snapshot: second,
      settingsDigest: digest(second),
      activationAuthorized: false,
      providerBaselineVerified: false,
    };
  } catch {
    // Never expose provider messages, paths containing returned values or errors
    // from injected transports. Unknown state is a hold, not an inactive baseline.
    throw new Error("production_readback_hold");
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
}
function fresh(readback) {
  assert.equal(readback.schemaVersion, 1);
  const observed = Date.parse(readback.observedAt),
    now = Date.now();
  assert.ok(Number.isFinite(observed) && observed <= now && now - observed <= 5 * 60 * 1000);
}
export function inactiveProductionBaseline(readback) {
  fresh(readback);
  assert.equal(readback.scope, "production-provider-readback");
  assert.equal(readback.settingsDigest, digest(readback.snapshot));
  const s = readback.snapshot;
  for (const [key, value] of Object.entries(productionReadbackTarget)) assert.equal(s[key], value);
  assert.equal(s.inactive, true);
  return {
    observedAt: readback.observedAt,
    baseline: {
      accountId: s.accountId,
      workerName: "hive",
      workerTag: s.workerTag,
      createdOn: s.createdOn,
      deploymentId: s.deploymentId,
      versionId: s.versionId,
      settingsDigest: readback.settingsDigest,
      inactive: true,
    },
  };
}
export function compareProductionReadback(actual, expected) {
  // Return only a fixed decision; never echo an untrusted expected artifact.
  try {
    fresh(actual);
    assert.equal(actual.scope, "production-provider-readback");
    assert.equal(actual.settingsDigest, digest(actual.snapshot));
    for (const [key, value] of Object.entries(productionReadbackTarget))
      assert.equal(actual.snapshot[key], value);
    assert.equal(actual.settingsDigest, expected.settingsDigest);
    assert.equal(digest(actual.snapshot), digest(expected.snapshot));
    return { state: "matched", activationAuthorized: false };
  } catch {
    return { state: "hold", activationAuthorized: false };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, output, expected, ...extra] = process.argv.slice(2);
  const run = async () => {
    assert.equal(extra.length, 0);
    assert.ok(output);
    if (action === "--compare") {
      assert.ok(expected);
      const decision = compareProductionReadback(
        JSON.parse(readFileSync(output)),
        JSON.parse(readFileSync(expected)),
      );
      console.log(JSON.stringify(decision));
      if (decision.state !== "matched") process.exitCode = 1;
    } else {
      assert.equal(action, "--capture");
      assert.equal(expected, undefined);
      const result = await collectProductionReadback({ token: process.env.CLOUDFLARE_API_TOKEN });
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      console.log("Production readback saved; activation remains unauthorized.");
    }
  };
  run().catch(() => {
    console.error("Production readback held.");
    process.exitCode = 1;
  });
}
