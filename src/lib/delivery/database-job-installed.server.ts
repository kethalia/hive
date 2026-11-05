import type { PrismaClient } from "@hive/db";
import { DatabaseJobStore } from "./database-job-store.server";
import { githubSourceDigest } from "./github-evidence.server";
import { readReleaseDatabaseDeployment } from "./release-database-observer.server";
import { repositoryPolicyStore } from "./repository-policy.server";

/** Provider observations are collected separately and verified under the lease lock. */
export function createInstalledDatabaseJobStore(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.HIVE_DELIVERY_DATABASE_ENABLED !== "true") return null;
  const raw = env.HIVE_DELIVERY_DATABASE_CATALOGS_JSON;
  const key = env.HIVE_DELIVERY_DATABASE_SIGNING_KEY;
  if (!raw || Buffer.byteLength(raw) > 262144 || !key || key.length > 8192)
    throw Error("database_job_unavailable");
  const catalogs: unknown = JSON.parse(raw);
  return new DatabaseJobStore(
    db,
    repositoryPolicyStore(db),
    () => catalogs,
    key,
    {
      async observe(tx, { request, catalog, plan, planDigest, signal }) {
        const evidence = await readReleaseDatabaseDeployment(
          tx,
          request.ownerId,
          request.releaseId,
        );
        const now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0].now.getTime();
        const action = request.action;
        if (
          !evidence ||
          signal.aborted ||
          (action !== "compatible" && action !== "activate" && action !== "certificate") ||
          evidence.ownerId !== request.ownerId ||
          evidence.taskId !== request.taskId ||
          evidence.sourceSha !== request.sourceSha ||
          evidence.targetDigest !== request.targetDigest ||
          evidence.generation !== request.generation ||
          evidence.database.planEventId !== request.planEventId ||
          evidence.database.planDigest !== planDigest ||
          evidence.database.catalogDigest !== githubSourceDigest(catalog) ||
          (action === "certificate"
            ? ![plan.oldAppDigest, plan.newAppDigest].includes(evidence.expected.app.artifactDigest)
            : evidence.expected.app.artifactDigest !==
              (action === "compatible" ? plan.oldAppDigest : plan.newAppDigest)) ||
          evidence.expiresAt <= now
        )
          throw Error("database_deployment_observer_unavailable");
        return {
          kind: action === "certificate" ? "compatible" : action,
          targetId: catalog.targetId,
          runId: request.planEventId,
          sourceSha: request.sourceSha,
          planDigest,
          schemaDigest: plan.afterSchemaDigest,
          oldAppDigest: plan.oldAppDigest,
          newAppDigest: plan.newAppDigest,
          compatibilityDigest: plan.compatibilityDigest,
          observedAt: now,
          expiresAt: Math.min(evidence.expiresAt, now + 20000),
          receiptDigest: githubSourceDigest(evidence),
        };
      },
    },
    fetch,
    env.HIVE_DELIVERY_DATABASE_GITHUB_TOKEN ?? "",
  );
}
