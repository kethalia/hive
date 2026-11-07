import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { signedHostProjectRequest } from "@/lib/projects/host.server";
import { epicGitHubReadRequestSchema, epicGitHubReadResultSchema } from "./epic-github-contracts";
import { DeliveryConflict } from "./state";

/** Read-only use of the workspace's existing Coder-linked GitHub account.
 * Credentials remain inside its pinned installed helper; none are enrolled in
 * Hive or returned to the scheduler/model. No browser route accepts these args. */
export async function readEpicGitHubForTask(
  db: PrismaClient,
  scope: { ownerId: string; taskId: string; readerWorkspaceId?: string; readerBuildId?: string },
  operation:
    | { operation: "observe_merge" }
    | { operation: "lineage"; baseSha: string; headSha: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const task = await db.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId: scope.ownerId, id: scope.taskId } },
    include: { managerBinding: true, currentSourceRevision: true },
  });
  const source = task?.currentSourceRevision,
    binding = task?.managerBinding;
  const owner = await db.user.findUnique({ where: { id: scope.ownerId } });
  if (
    !task ||
    !source ||
    !binding ||
    !owner ||
    binding.blockedReason ||
    task.pauseRequested ||
    task.schedulingPaused
  )
    throw new DeliveryConflict("epic_lineage_unavailable");
  if (!!scope.readerWorkspaceId !== !!scope.readerBuildId)
    throw new DeliveryConflict("epic_lineage_unavailable");
  const request = epicGitHubReadRequestSchema.parse({
    schemaVersion: 1,
    requestId: randomUUID(),
    repositoryId: source.repositoryId,
    expectedAccountId: source.providerAccountId,
    baseBranch: source.baseBranch,
    ...(operation.operation === "observe_merge"
      ? {
          operation: operation.operation,
          pullRequestId: source.pullRequestId,
          pullNumber: source.pullNumber,
          headSha: source.headSha,
          sourceBranch: source.branch,
        }
      : operation),
  });
  const result = epicGitHubReadResultSchema.parse(
    await signedHostProjectRequest(
      { id: owner.id, coderUserId: owner.coderUserId },
      scope.readerWorkspaceId ?? binding.workspaceId,
      "/projects/epic-read",
      request,
      { signal, expectedBuildId: scope.readerBuildId ?? binding.buildId },
    ),
  );
  if (
    result.operation !== request.operation ||
    result.requestId !== request.requestId ||
    result.providerAccountId !== request.expectedAccountId ||
    result.repository.providerRepositoryId !== request.repositoryId ||
    result.repository.fullName !== source.fullName ||
    result.repository.archived ||
    !result.repository.permissions.pull ||
    !result.repository.permissions.push ||
    result.baseBranch !== source.baseBranch ||
    result.headSha !== request.headSha
  )
    throw new DeliveryConflict("epic_lineage_unverified");
  if (request.operation === "observe_merge") {
    if (
      result.operation !== "observe_merge" ||
      result.pullRequestId !== request.pullRequestId ||
      result.pullNumber !== request.pullNumber ||
      result.sourceBranch !== request.sourceBranch ||
      ["main", "master", result.repository.defaultBranch].includes(result.baseBranch) ||
      result.merged !== (result.mergeSha !== null)
    )
      throw new DeliveryConflict("epic_lineage_unverified");
  } else if (
    result.operation !== "lineage" ||
    result.baseSha !== request.baseSha ||
    result.mergeBaseSha !== request.baseSha ||
    result.branchHeadSha !== request.headSha ||
    (result.status === "identical" && result.baseSha !== result.headSha)
  )
    throw new DeliveryConflict("epic_lineage_unverified");
  signal?.throwIfAborted();
  return result;
}
