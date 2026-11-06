import type { Prisma } from "@hive/db";
import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import { DeliveryConflict } from "./state";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const receiptSchema = z
  .object({
    provider: z.literal("github"),
    repositoryId: z.string(),
    pullRequestId: z.string(),
    pullNumber: z.number().int().positive(),
    headSha: sha,
    baseSha: sha,
    mergeSha: sha,
    requestId: z.string().uuid(),
    rulesDigest: z.string(),
  })
  .strict();
/** Squash/rebase merges are not descendants of a PR head. A healthy release's
 * observed attributed merge receipt is the integration base, bound to the
 * dependency's current immutable source revision and provider repository. */
export async function epicDependencyRelease(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  ownerId: string,
  taskId: string,
) {
  const rows = await tx.$queryRaw<
    {
      release_id: string;
      source_sha: string;
      repository_id: string;
      request: unknown;
      request_digest: string;
      receipt: unknown;
      receipt_digest: string;
    }[]
  >`
    SELECT r.id AS release_id,t.source_sha,p.provider_repository_id AS repository_id,a.request,a.request_digest,a.receipt,a.receipt_digest
    FROM delivery_tasks t JOIN delivery_projects p ON p.owner_id=t.owner_id AND p.id=t.project_id
    JOIN delivery_releases r ON r.owner_id=t.owner_id AND r.task_id=t.id AND r.source_revision_id=t.source_revision_id AND r.phase='healthy'
    JOIN delivery_release_actions a ON a.release_id=r.id AND a.kind='merge' AND a.phase='observed'
    WHERE t.owner_id=${ownerId}::uuid AND t.id=${taskId}::uuid LIMIT 2`;
  if (rows.length !== 1) throw new DeliveryConflict("epic_dependency_release_pending");
  const row = rows[0],
    request = githubReleaseRequestSchema.parse(row.request),
    receipt = receiptSchema.parse(row.receipt);
  if (
    githubSourceDigest(request) !== row.request_digest ||
    githubSourceDigest(receipt) !== row.receipt_digest ||
    request.repositoryId !== row.repository_id ||
    request.headSha !== row.source_sha ||
    receipt.repositoryId !== request.repositoryId ||
    receipt.pullRequestId !== request.pullRequestId ||
    receipt.pullNumber !== request.pullNumber ||
    receipt.headSha !== request.headSha ||
    receipt.baseSha !== request.baseSha ||
    receipt.rulesDigest !== request.rulesDigest
  )
    throw new DeliveryConflict("epic_dependency_release_invalid");
  return {
    releaseId: row.release_id,
    sourceSha: row.source_sha,
    repositoryId: row.repository_id,
    mergeSha: receipt.mergeSha,
    receiptDigest: row.receipt_digest,
  };
}
