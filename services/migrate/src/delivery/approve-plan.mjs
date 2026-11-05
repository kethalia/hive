import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireValue } from "./contracts.mjs";
import { databaseWorkloadToken, readDatabaseJson } from "./installed-job.mjs";
import {
  databaseCatalogSchema,
  databasePlanApprovalSchema,
  verifyDatabaseResponse,
} from "./wire.mjs";

/** Inputs are protected environment configuration, never candidate checkout data. */
export async function approveInstalledDatabasePlan({
  env = process.env,
  fetcher = fetch,
  signal,
} = {}) {
  requireValue(env.HIVE_DELIVERY_DATABASE_ENABLED === "true", "migration_disabled");
  const rawCatalog = env.HIVE_DELIVERY_DATABASE_CATALOG_JSON,
    rawPlan = env.HIVE_DELIVERY_DATABASE_APPROVAL_JSON;
  requireValue(
    typeof rawCatalog === "string" &&
      Buffer.byteLength(rawCatalog) <= 16384 &&
      typeof rawPlan === "string" &&
      Buffer.byteLength(rawPlan) <= 49152,
    "migration_job_config_unavailable",
  );
  const catalog = databaseCatalogSchema.parse(JSON.parse(rawCatalog));
  const request = databasePlanApprovalSchema.parse({
    ...JSON.parse(rawPlan),
    schemaVersion: 1,
    purpose: "approve_database_plan",
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  });
  requireValue(
    request.catalogId === catalog.id &&
      request.ownerId === catalog.ownerId &&
      catalog.validFrom <= Date.now() &&
      catalog.expiresAt > Date.now(),
    "migration_job_scope_changed",
  );
  const bounded = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  const token = await databaseWorkloadToken(request, env, fetcher, bounded);
  const response = await fetcher(`${catalog.authorityOrigin}/api/delivery/database-jobs/approve`, {
    method: "POST",
    redirect: "error",
    signal: bounded,
    headers: { "Content-Type": "application/json", "X-Hive-Database-OIDC": token },
    body: JSON.stringify(request),
  });
  return verifyDatabaseResponse(await readDatabaseJson(response, 65536, bounded), request, catalog)
    .data;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) process.exitCode = 1;
  else
    approveInstalledDatabasePlan()
      .then((data) => console.log(JSON.stringify(data)))
      .catch(() => {
        console.error("[database-job] Plan approval held.");
        process.exitCode = 1;
      });
}
