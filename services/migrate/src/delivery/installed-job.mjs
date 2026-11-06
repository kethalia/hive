import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, requireValue, validatePlan } from "./contracts.mjs";
import { advanceDatabaseChange } from "./job.mjs";
import { createMigrationDatabase } from "./postgres.mjs";
import { createDeliveryMigrationController } from "./runner.mjs";
import {
  assertDatabaseEndpoint,
  databaseCatalogSchema,
  databaseJobRequestSchema,
  databaseOidcAudience,
  databaseScope,
  verifyDatabaseResponse,
} from "./wire.mjs";

export async function readDatabaseJson(response, max, signal) {
  requireValue(response.ok && response.body, "migration_transport_unavailable");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      requireValue(!signal.aborted, "migration_interrupted");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      requireValue(bytes <= max, "migration_response_limit");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
  }
}
export async function databaseWorkloadToken(request, env, fetcher, signal) {
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    u = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  requireValue(
    u.protocol === "https:" &&
      u.hostname.endsWith(".actions.githubusercontent.com") &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (!u.port || u.port === "443") &&
      typeof token === "string" &&
      token.length > 0 &&
      token.length <= 16384 &&
      !/[\r\n]/.test(token),
    "migration_workload_identity_unavailable",
  );
  u.searchParams.set("audience", databaseOidcAudience(request));
  const result = await readDatabaseJson(
    await fetcher(u.href, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${token}` },
    }),
    20000,
    signal,
  );
  requireValue(
    typeof result.value === "string" && /^[A-Za-z0-9_.-]{1,16384}$/.test(result.value),
    "migration_workload_identity_unavailable",
  );
  return result.value;
}
/** Fixed job entry. Config/credentials come only from the trusted job environment;
 * server-approved plan is read through the signed, purpose-bound OIDC channel. */
export async function runInstalledDatabaseJob({ env = process.env, fetcher = fetch, signal } = {}) {
  if (env.HIVE_DELIVERY_DATABASE_ENABLED !== "true") return { phase: "disabled" };
  requireValue(
    typeof env.HIVE_DELIVERY_DATABASE_CATALOG_JSON === "string" &&
      Buffer.byteLength(env.HIVE_DELIVERY_DATABASE_CATALOG_JSON) <= 16384 &&
      typeof env.HIVE_DELIVERY_DATABASE_JOB_JSON === "string" &&
      Buffer.byteLength(env.HIVE_DELIVERY_DATABASE_JOB_JSON) <= 8192,
    "migration_job_config_unavailable",
  );
  const catalog = databaseCatalogSchema.parse(JSON.parse(env.HIVE_DELIVERY_DATABASE_CATALOG_JSON));
  const base = databaseJobRequestSchema.parse({
    ...JSON.parse(env.HIVE_DELIVERY_DATABASE_JOB_JSON),
    schemaVersion: 1,
    purpose: "database_job",
    operation: "read_plan",
    action: "read",
    requestId: randomUUID(),
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  });
  requireValue(
    base.catalogId === catalog.id &&
      base.ownerId === catalog.ownerId &&
      base.targetDigest === catalog.targetDigest,
    "migration_job_scope_changed",
  );
  const lifetime = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  async function request(operation, action, observation) {
    requireValue(
      !lifetime.aborted && catalog.validFrom <= Date.now() && catalog.expiresAt > Date.now(),
      "migration_job_expired",
    );
    const body = databaseJobRequestSchema.parse({
      ...base,
      requestId: randomUUID(),
      operation,
      action,
      ...(observation ? { observation } : {}),
    });
    const bounded = AbortSignal.any([lifetime, AbortSignal.timeout(4000)]),
      token = await databaseWorkloadToken(body, env, fetcher, bounded);
    const response = await fetcher(
      `${catalog.authorityOrigin}/api/delivery/database-jobs/authorize`,
      {
        method: "POST",
        redirect: "error",
        signal: bounded,
        headers: { "Content-Type": "application/json", "X-Hive-Database-OIDC": token },
        body: JSON.stringify(body),
      },
    );
    const envelope = verifyDatabaseResponse(
      await readDatabaseJson(response, 65536, bounded),
      body,
      catalog,
    );
    requireValue(!bounded.aborted, "migration_interrupted");
    return envelope.data;
  }
  const approved = await request("read_plan", "read"),
    plan = validatePlan(approved.plan),
    scope = databaseScope(catalog);
  requireValue(
    approved.runId === base.planEventId &&
      approved.planDigest === digest(plan) &&
      digest(approved.scope) === digest(scope) &&
      plan.sourceSha === base.sourceSha,
    "migration_approved_plan_changed",
  );
  const db = createMigrationDatabase(assertDatabaseEndpoint(env.DATABASE_URL, catalog));
  const controller = createDeliveryMigrationController({
    enabled: true,
    db,
    scope,
    plan,
    expectedPlanDigest: approved.planDigest,
    authorize: async ({ runId, action }) => {
      requireValue(runId === approved.runId, "migration_run_changed");
      return request("authorize", action);
    },
    observeDeployment: async ({ expected, purpose }) =>
      request("observe", purpose === "certificate" ? "certificate" : expected.kind),
  });
  const mode = env.HIVE_DELIVERY_DATABASE_JOB_MODE ?? "advance";
  requireValue(mode === "advance" || mode === "activate", "migration_job_mode_invalid");
  let result;
  if (mode === "activate") {
    const state = await controller.begin(approved.runId, { signal: lifetime });
    requireValue(
      ["verified", "activated", "contract_held"].includes(state.phase),
      "migration_dependency_pending",
    );
    const current =
      state.phase === "verified"
        ? await controller.tick(approved.runId, "activate", { signal: lifetime })
        : state;
    result = { phase: current.phase, state: current, automaticContract: false };
  } else {
    result = await advanceDatabaseChange({
      controller,
      runId: approved.runId,
      signal: lifetime,
      maxTicks: 16,
      maxDurationMs: 50000,
    });
  }
  const report = await request("report", "read", result.certificate ?? result.state);
  return { ...result, report };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error("Usage: node src/delivery/installed-job.mjs");
    process.exitCode = 1;
  } else
    runInstalledDatabaseJob()
      .then((result) => console.log(JSON.stringify({ phase: result.phase, report: result.report })))
      .catch(() => {
        console.error(
          "[database-job] Operation held; reconcile the same run and inspect trusted job evidence.",
        );
        process.exitCode = 1;
      });
}
