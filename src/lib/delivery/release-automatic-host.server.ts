import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { signedHostProjectRequest } from "@/lib/projects/host.server";
import {
  databaseActionHasReportedHistory,
  hasDatabaseSqlHistory,
} from "./database-job-history.server";
import { epicMergeRpcResultSchema } from "./epic-merge-contracts";
import { githubSourceDigest } from "./github-evidence.server";
import {
  type AutomaticReleaseConfig,
  type AutomaticReleaseRpc,
  automaticPreparedSchema,
  automaticReleaseAuthority,
  automaticReleaseConfigSchema,
  automaticReleaseEnrollment,
  automaticReleaseRpcSchema,
  automaticReleaseTarget,
} from "./release-automatic-contracts";
import { configuredAutomaticDatabaseCatalog } from "./release-automatic-database.server";
import { type ConnectedReleaseTestProvider, ReleaseTestStore } from "./release-tested-store.server";
import { repositoryPolicyStore } from "./repository-policy.server";
export function configuredAutomaticRelease(env: Record<string, string | undefined> = process.env) {
  if (
    env.HIVE_DELIVERY_RELEASE_ENABLED !== "true" ||
    env.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED !== "true" ||
    env.HIVE_NATIVE_MODE !== "production" ||
    env.HIVE_NATIVE_PRODUCTION_ACTIVE !== "true"
  )
    return null;
  const raw = env.HIVE_DELIVERY_RELEASE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 16384) return null;
  const value = JSON.parse(raw);
  if (value?.mode !== "automatic-main-builds") return null;
  return automaticReleaseConfigSchema.parse(value);
}
export type AutomaticOperation =
  | Pick<Extract<AutomaticReleaseRpc, { operation: "prepare" }>, "operation" | "test" | "database">
  | Pick<
      Extract<AutomaticReleaseRpc, { operation: "database" }>,
      "operation" | "catalog" | "command"
    >
  | Pick<
      Extract<AutomaticReleaseRpc, { operation: "dispatch" }>,
      "operation" | "identity" | "authorityExpiresAt" | "database"
    >
  | Pick<
      Extract<AutomaticReleaseRpc, { operation: "lookup" }>,
      "operation" | "identity" | "reference"
    >
  | Pick<
      Extract<AutomaticReleaseRpc, { operation: "builds" }>,
      "operation" | "mergeSha" | "database"
    >;
export async function automaticReleaseForTask(
  db: PrismaClient,
  config: AutomaticReleaseConfig,
  scope: { ownerId: string; taskId: string },
  operation: AutomaticOperation,
  signal?: AbortSignal,
) {
  const bound = await repositoryPolicyStore(db).resolveTask(db, scope.ownerId, scope.taskId),
    source = bound?.task.currentSourceRevision,
    binding = bound?.task.managerBinding;
  const owner = await db.user.findUnique({ where: { id: scope.ownerId } });
  const databaseOperation = operation.operation === "database" ? operation : null;
  const paused = !!bound && (bound.task.pauseRequested || bound.task.schedulingPaused);
  const historyOnly =
    paused &&
    databaseOperation !== null &&
    (await db.$transaction(async (tx) => {
      if (
        databaseOperation.command.action === "workload" &&
        databaseOperation.command.request.operation === "report"
      )
        return hasDatabaseSqlHistory(
          tx,
          repositoryPolicyStore(db),
          databaseOperation.command.request,
          databaseOperation.catalog,
        );
      if (databaseOperation.command.action === "lookup")
        return databaseActionHasReportedHistory(
          tx,
          repositoryPolicyStore(db),
          scope.ownerId,
          scope.taskId,
          databaseOperation.command.identity.request.dispatchId as string,
          databaseOperation.catalog,
        );
      return false;
    }));
  if (
    !bound ||
    !source ||
    !binding ||
    !owner ||
    (paused && !historyOnly) ||
    binding.blockedReason ||
    config.policy.ownerId !== scope.ownerId ||
    source.repositoryId !== config.policy.repositoryId ||
    source.providerAccountId !== config.policy.providerAccountId ||
    source.baseBranch !== "main" ||
    source.fullName !== `${config.risk.owner}/${config.risk.name}`
  )
    throw Error("automatic_release_scope");
  if (
    (operation.operation === "prepare" ||
      operation.operation === "dispatch" ||
      operation.operation === "builds") &&
    !operation.database
  ) {
    const database = configuredAutomaticDatabaseCatalog(config, source.headSha);
    if (database) operation = { ...operation, database };
  }
  if (
    (operation.operation === "prepare" ||
      operation.operation === "dispatch" ||
      operation.operation === "builds") &&
    operation.database
  ) {
    const catalog = operation.database;
    operation =
      operation.operation === "prepare"
        ? {
            operation: "database",
            catalog,
            command: { action: "prepare", ...(operation.test ? { test: operation.test } : {}) },
          }
        : operation.operation === "dispatch"
          ? {
              operation: "database",
              catalog,
              command: {
                action: "merge",
                identity: operation.identity,
                authorityExpiresAt: operation.authorityExpiresAt,
              },
            }
          : {
              operation: "database",
              catalog,
              command: { action: "builds", mergeSha: operation.mergeSha },
            };
  }
  const request = automaticReleaseRpcSchema.parse({
    schemaVersion: 1,
    requestId: randomUUID(),
    config,
    source: {
      repositoryId: source.repositoryId,
      pullRequestId: source.pullRequestId,
      pullNumber: source.pullNumber,
      headSha: source.headSha,
      baseRef: "main",
      sourceBranch: source.branch,
    },
    gates: bound.policy.evidenceGates,
    ...operation,
  });
  const response = epicMergeRpcResultSchema.parse(
    await signedHostProjectRequest(
      { id: owner.id, coderUserId: owner.coderUserId },
      binding.workspaceId,
      "/projects/production-release",
      request,
      { signal, expectedBuildId: binding.buildId },
    ),
  );
  if (response.operation !== request.operation || response.requestId !== request.requestId)
    throw Error("automatic_release_scope");
  signal?.throwIfAborted();
  return response.result;
}
export function createAutomaticReleaseTestStore(
  db: PrismaClient,
  config: AutomaticReleaseConfig,
  fetcher: typeof fetch = fetch,
  attestationLifetimeMs = 600000,
) {
  const provider: ConnectedReleaseTestProvider = {
    authority: () => config.tested.run,
    async verifyConnected(input, scope, complete, signal) {
      const rows = await db.deliveryTask.findMany({
        where: {
          ownerId: config.policy.ownerId,
          currentSourceRevision: {
            is: {
              repositoryId: input.repositoryId,
              pullNumber: input.pullNumber,
              headSha: input.headSha,
            },
          },
        },
        take: 2,
      });
      if (rows.length !== 1) throw Error("release_test_scope");
      const observed = automaticPreparedSchema.parse(
        await automaticReleaseForTask(
          db,
          config,
          { ownerId: config.policy.ownerId, taskId: rows[0].id },
          { operation: "prepare", test: { request: input, complete } },
          signal,
        ),
      );
      const current = await repositoryPolicyStore(db).resolveTask(
        db,
        config.policy.ownerId,
        rows[0].id,
      );
      if (
        observed.request.pullRequestId !== scope.source.pullRequestId ||
        observed.request.baseRef !== "main" ||
        observed.request.baseSha !== input.baseSha ||
        observed.testedMergeSha !== input.mergeSha ||
        observed.testedTreeSha !== input.treeSha ||
        githubSourceDigest(current?.policy.evidenceGates) !== githubSourceDigest(scope.gates)
      )
        throw Error("release_test_scope");
    },
  };
  return new ReleaseTestStore(
    db,
    config.tested.workflow,
    provider,
    repositoryPolicyStore(db),
    () => [automaticReleaseEnrollment(config)],
    automaticReleaseTarget(config),
    automaticReleaseAuthority(config),
    undefined,
    undefined,
    fetcher,
    attestationLifetimeMs,
  );
}
