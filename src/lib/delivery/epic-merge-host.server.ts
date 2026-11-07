import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { signedHostProjectRequest } from "@/lib/projects/host.server";
import {
  type EpicMergeConfig,
  type EpicMergeRpcRequest,
  epicMergeAuthority,
  epicMergeEnrollment,
  epicMergePreparedSchema,
  epicMergeRpcRequestSchema,
  epicMergeRpcResultSchema,
  epicMergeTarget,
} from "./epic-merge-contracts";
import { githubSourceDigest } from "./github-evidence.server";
import { ReleaseTestStore } from "./release-tested-store.server";
import { repositoryPolicyStore } from "./repository-policy.server";

export type EpicMergeOperation =
  | { operation: "prepare"; test?: Extract<EpicMergeRpcRequest, { operation: "prepare" }>["test"] }
  | Pick<Extract<EpicMergeRpcRequest, { operation: "dispatch" }>, "operation" | "identity">
  | Pick<
      Extract<EpicMergeRpcRequest, { operation: "lookup" }>,
      "operation" | "identity" | "reference"
    >;
export async function epicMergeForTask(
  db: PrismaClient,
  config: EpicMergeConfig,
  scope: { ownerId: string; taskId: string; readerWorkspaceId?: string; readerBuildId?: string },
  operation: EpicMergeOperation,
  signal?: AbortSignal,
) {
  const bound = await repositoryPolicyStore(db).resolveTask(db, scope.ownerId, scope.taskId),
    source = bound?.task.currentSourceRevision,
    binding = bound?.task.managerBinding;
  const owner = await db.user.findUnique({ where: { id: scope.ownerId } });
  if (
    !bound ||
    !source ||
    !binding ||
    !owner ||
    bound.task.pauseRequested ||
    bound.task.schedulingPaused ||
    binding.blockedReason ||
    config.policy.ownerId !== scope.ownerId ||
    source.repositoryId !== config.policy.repositoryId ||
    source.providerAccountId !== config.policy.providerAccountId ||
    source.baseBranch !== config.policy.baseBranch ||
    source.fullName !== `${config.risk.owner}/${config.risk.name}` ||
    !!scope.readerBuildId !== !!scope.readerWorkspaceId
  )
    throw Error("epic_merge_scope");
  const request = epicMergeRpcRequestSchema.parse({
    schemaVersion: 1,
    requestId: randomUUID(),
    config,
    source: {
      repositoryId: source.repositoryId,
      pullRequestId: source.pullRequestId,
      pullNumber: source.pullNumber,
      headSha: source.headSha,
      sourceBranch: source.branch,
      baseRef: source.baseBranch,
    },
    gates: bound.policy.evidenceGates,
    ...operation,
  });
  const response = epicMergeRpcResultSchema.parse(
    await signedHostProjectRequest(
      { id: owner.id, coderUserId: owner.coderUserId },
      scope.readerWorkspaceId ?? binding.workspaceId,
      "/projects/epic-merge",
      request,
      { signal, expectedBuildId: scope.readerBuildId ?? binding.buildId },
    ),
  );
  if (response.requestId !== request.requestId || response.operation !== request.operation)
    throw Error("epic_merge_scope");
  signal?.throwIfAborted();
  return response.result;
}
export function createEpicMergeTestStore(
  db: PrismaClient,
  config: EpicMergeConfig,
  fetcher: typeof fetch = fetch,
) {
  const provider = {
    authority: () => config.tested.run,
    async verifyConnected(
      input: Parameters<
        import("./release-tested-store.server").ConnectedReleaseTestProvider["verifyConnected"]
      >[0],
      scope: Parameters<
        import("./release-tested-store.server").ConnectedReleaseTestProvider["verifyConnected"]
      >[1],
      complete: boolean,
      signal: AbortSignal,
    ) {
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
      const result = epicMergePreparedSchema.parse(
        await epicMergeForTask(
          db,
          config,
          { ownerId: config.policy.ownerId, taskId: rows[0].id },
          { operation: "prepare", test: { request: input, complete } },
          signal,
        ),
      );
      if (
        result.request.pullRequestId !== scope.source.pullRequestId ||
        result.request.baseRef !== scope.source.baseBranch ||
        result.request.baseSha !== input.baseSha ||
        result.testedMergeSha !== input.mergeSha ||
        result.testedTreeSha !== input.treeSha ||
        githubSourceDigest(scope.gates) !==
          githubSourceDigest(
            (await repositoryPolicyStore(db).resolveTask(db, config.policy.ownerId, rows[0].id))
              ?.policy.evidenceGates,
          )
      )
        throw Error("release_test_scope");
    },
  };
  return new ReleaseTestStore(
    db,
    config.tested.workflow,
    provider,
    repositoryPolicyStore(db),
    () => [epicMergeEnrollment(config)],
    epicMergeTarget(config),
    epicMergeAuthority(config),
    undefined,
    undefined,
    fetcher,
  );
}
