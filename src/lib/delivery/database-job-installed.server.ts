import { captureRequestDatabaseFactory, getDb, type PrismaClient } from "@hive/db";
import { withReleaseDeadline } from "../../../deploy/cloudflare/app/release-health";
import { DatabaseJobStore } from "./database-job-store.server";
import { githubSourceDigest } from "./github-evidence.server";
import {
  automaticReleaseForTask,
  configuredAutomaticRelease,
} from "./release-automatic-host.server";
import { readReleaseDatabaseDeployment } from "./release-database-observer.server";
import { repositoryPolicyStore } from "./repository-policy.server";

/** Private post-response client: captured references cannot start SQL after expiry. */
export function databaseReportClient(
  client: PrismaClient,
  signal: AbortSignal,
  deadline: number,
): PrismaClient {
  const guard = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw Error("database_report_expired");
  };
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(actual, key) {
        const value = Reflect.get(actual, key, actual);
        if (typeof value === "function")
          return (...args: unknown[]) => {
            guard();
            if (key === "$transaction") {
              const [operation, options] = args;
              if (typeof operation !== "function")
                throw Error("database_report_transaction_unavailable");
              const remaining = deadline - Date.now(),
                maxWait = Math.max(1, Math.min(2500, Math.floor(remaining / 2))),
                timeout = Math.max(1, Math.min(5000, remaining - maxWait));
              return Reflect.apply(value, actual, [
                async (tx: object) => {
                  guard();
                  const result = await operation(wrap(tx));
                  guard();
                  return result;
                },
                { ...(options && typeof options === "object" ? options : {}), maxWait, timeout },
              ]);
            }
            return Reflect.apply(value, actual, args);
          };
        if (
          value &&
          typeof value === "object" &&
          typeof key === "string" &&
          !key.startsWith("$") &&
          !key.startsWith("_")
        )
          return wrap(value);
        return value;
      },
    });
  return wrap(client) as PrismaClient;
}

/** Provider observations are collected separately and verified under the lease lock. */
export function createInstalledDatabaseJobStore(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.HIVE_DELIVERY_DATABASE_ENABLED !== "true") return null;
  const raw = env.HIVE_DELIVERY_DATABASE_CATALOGS_JSON;
  const key = env.HIVE_DELIVERY_DATABASE_SIGNING_KEY;
  if (!raw || Buffer.byteLength(raw) > 262144 || !key || key.length > 8192)
    throw Error("database_job_unavailable");
  const catalogs: unknown = JSON.parse(raw);
  const createBackgroundRequest = captureRequestDatabaseFactory();
  return new DatabaseJobStore(
    db,
    repositoryPolicyStore(db),
    () => catalogs,
    key,
    {
      async refresh(request, catalog, signal) {
        const mode = catalog.compatibilityTest?.config;
        if (!mode || !("kind" in mode) || mode.kind !== "automatic-source-build") return;
        const config = configuredAutomaticRelease(env);
        if (!config) throw Error("database_deployment_observer_unavailable");
        const { createAutomaticReleaseController } = await import(
          "./release-automatic-installed.server"
        );
        const controller = createAutomaticReleaseController(db, config, fetcher);
        if (
          !(await controller.observeDatabase(
            request.ownerId,
            request.releaseId,
            request.action,
            signal,
          ))
        )
          throw Error("database_deployment_observer_unavailable");
      },
      async observe(tx, { request, catalog, plan, planDigest, signal }) {
        const mode = catalog.compatibilityTest?.config;
        if (mode && "kind" in mode && mode.kind === "automatic-source-build") {
          const config = configuredAutomaticRelease(env);
          if (!config || signal.aborted) throw Error("database_deployment_observer_unavailable");
          const { AutomaticReleaseLifecycle } = await import(
            "./release-automatic-lifecycle.server"
          );
          return new AutomaticReleaseLifecycle(
            db,
            config,
            repositoryPolicyStore(db),
          ).databaseDeployment(tx, request, catalog, plan, planDigest);
        }
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
    fetcher,
    env.HIVE_DELIVERY_DATABASE_GITHUB_TOKEN ?? "",
    async (request, catalog, signal) => {
      const config = configuredAutomaticRelease(env);
      if (!config) throw Error("database_job_unavailable");
      const observed = await automaticReleaseForTask(
        db,
        config,
        { ownerId: request.ownerId, taskId: request.taskId },
        { operation: "database", catalog, command: { action: "verify", approval: request } },
        signal,
      );
      if (
        !observed ||
        typeof observed !== "object" ||
        !("verified" in observed) ||
        observed.verified !== true ||
        !("catalogDigest" in observed) ||
        observed.catalogDigest !== githubSourceDigest(catalog) ||
        !("authorityExpiresAt" in observed) ||
        typeof observed.authorityExpiresAt !== "number" ||
        !Number.isSafeInteger(observed.authorityExpiresAt) ||
        observed.authorityExpiresAt !== config.policy.expiresAt ||
        observed.authorityExpiresAt <= Date.now()
      )
        throw Error("database_job_unavailable");
      return observed.authorityExpiresAt;
    },
    async (request, catalog, signal) => {
      const config = configuredAutomaticRelease(env);
      if (!config) throw Error("database_job_unavailable");
      const observed = await automaticReleaseForTask(
        db,
        config,
        { ownerId: request.ownerId, taskId: request.taskId },
        { operation: "database", catalog, command: { action: "workload", request } },
        signal,
      );
      if (
        !observed ||
        typeof observed !== "object" ||
        !("verified" in observed) ||
        observed.verified !== true ||
        !("dispatchId" in observed) ||
        observed.dispatchId !== request.dispatchId ||
        !("runId" in observed) ||
        observed.runId !== request.githubRunId ||
        !("runAttempt" in observed) ||
        observed.runAttempt !== request.githubRunAttempt ||
        !("catalogDigest" in observed) ||
        observed.catalogDigest !== githubSourceDigest(catalog) ||
        !("authorityExpiresAt" in observed) ||
        typeof observed.authorityExpiresAt !== "number" ||
        !Number.isSafeInteger(observed.authorityExpiresAt) ||
        observed.authorityExpiresAt !== config.policy.expiresAt ||
        observed.authorityExpiresAt <= Date.now()
      )
        throw Error("database_job_unavailable");
      return observed.authorityExpiresAt;
    },
    async (scope) => {
      // Report facts are already committed. Missing scoped capability holds advancement.
      if (!createBackgroundRequest) return;
      const hardDeadline = Date.now() + 25000,
        workDeadline = hardDeadline - 5000,
        controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, workDeadline - Date.now()));
      let database: ReturnType<typeof createBackgroundRequest> | undefined;
      try {
        controller.signal.throwIfAborted();
        database = createBackgroundRequest({
          queryTimeoutMillis: 2500,
          connectionTimeoutMillis: 2500,
          transactionTimeoutMillis: 5000,
        });
        await database.run(async () => {
          controller.signal.throwIfAborted();
          const config = configuredAutomaticRelease(env);
          if (!config) return;
          const { createAutomaticReleaseController } = await import(
            "./release-automatic-installed.server"
          );
          controller.signal.throwIfAborted();
          await createAutomaticReleaseController(
            databaseReportClient(getDb(), controller.signal, workDeadline),
            config,
            fetcher,
          ).reconcileDatabaseReport(scope, controller.signal);
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (database) {
          const allocated = database;
          await withReleaseDeadline(
            () => allocated.close(),
            new AbortController().signal,
            Math.max(1, hardDeadline - Date.now()),
          );
        }
      }
    },
  );
}
