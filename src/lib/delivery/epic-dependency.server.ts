import type { Prisma } from "@hive/db";
import { z } from "zod";
import { epicPreviewMergeReadiness } from "./epic-merge-observation.server";
import { githubSourceDigest } from "./github-evidence.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
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

const lineageCommon = {
  dependency: z.string().uuid(),
  repositoryId: z.string(),
  base: sha,
  head: sha,
  status: z.enum(["ahead", "identical"]),
  mergeBase: sha,
};
/** Existing production lineage remains valid. Preview lineage explicitly names
 * its independent readiness/source receipts instead of inventing a release. */
export const epicDependencyLineageSchema = z.union([
  z
    .object({
      ...lineageCommon,
      releaseId: z.string().uuid(),
      receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      ...lineageCommon,
      milestone: z.literal("implementation_preview"),
      readinessDigest: z.string().regex(/^[a-f0-9]{64}$/),
      completionEventId: z.string().uuid(),
      sourceReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
      mergeDigest: z.string().regex(/^[a-f0-9]{64}$/),
      observedAt: z.number().int().positive(),
      expiresAt: z.number().int().positive(),
    })
    .strict()
    .refine(
      (value) => value.expiresAt > value.observedAt && value.expiresAt - value.observedAt <= 30000,
    ),
]);
export type EpicDependencyLineage = z.infer<typeof epicDependencyLineageSchema>;

export async function epicIntegrationDependency(
  tx: Prisma.TransactionClient,
  store: RepositoryPolicyStore,
  scope: { ownerId: string; epicId: string; intentId: string },
) {
  const rows = await tx.$queryRaw<{ task_id: string; source_sha: string; phase: string }[]>`
    SELECT t.id AS task_id,t.source_sha,s.phase FROM delivery_epic_start_intents s
    JOIN delivery_manager_bindings b ON b.owner_id=s.owner_id AND b.preparation_intent_id=s.intent_id
    JOIN delivery_tasks t ON t.owner_id=b.owner_id AND t.manager_binding_id=b.id AND t.epic_id=s.epic_id
    WHERE s.owner_id=${scope.ownerId}::uuid AND s.epic_id=${scope.epicId}::uuid
    AND s.intent_id=${scope.intentId}::uuid LIMIT 2`;
  if (rows.length !== 1) throw new DeliveryConflict("epic_dependencies_pending");
  const row = rows[0];
  if (row.phase === "finished") {
    if (
      !(await verifyReleaseEvidence(tx, store, {
        ownerId: scope.ownerId,
        taskId: row.task_id,
        sourceSha: row.source_sha,
      }))
    )
      throw new DeliveryConflict("epic_dependencies_pending");
    const release = await epicDependencyRelease(tx, scope.ownerId, row.task_id);
    return {
      milestone: "production" as const,
      taskId: row.task_id,
      repositoryId: release.repositoryId,
      integrationSha: release.mergeSha,
      releaseId: release.releaseId,
      receiptDigest: release.receiptDigest,
    };
  }
  if (row.phase === "accepted") {
    const ready = await epicPreviewMergeReadiness(tx, store, scope);
    if (ready)
      return {
        milestone: "implementation_preview" as const,
        taskId: row.task_id,
        repositoryId: ready.readiness.repositoryId,
        integrationSha: ready.observation.mergeSha,
        branchHeadHint: ready.observation.branchHeadSha,
        readiness: ready.readiness,
        mergeDigest: ready.observation.mergeDigest,
      };
  }
  throw new DeliveryConflict("epic_dependencies_pending");
}
export type EpicIntegrationDependency = Awaited<ReturnType<typeof epicIntegrationDependency>>;
export function matchesEpicDependency(
  proof: EpicDependencyLineage,
  dependency: string,
  head: string,
  anchor: EpicIntegrationDependency,
) {
  if (
    proof.dependency !== dependency ||
    proof.repositoryId !== anchor.repositoryId ||
    proof.base !== anchor.integrationSha ||
    proof.mergeBase !== anchor.integrationSha ||
    proof.head !== head
  )
    return false;
  return anchor.milestone === "implementation_preview"
    ? "milestone" in proof &&
        proof.readinessDigest === anchor.readiness.digest &&
        proof.completionEventId === anchor.readiness.completionEventId &&
        proof.sourceReceiptDigest === anchor.readiness.sourceReceiptDigest &&
        proof.mergeDigest === anchor.mergeDigest
    : "releaseId" in proof &&
        proof.releaseId === anchor.releaseId &&
        proof.receiptDigest === anchor.receiptDigest;
}

/** Logical WIP can finish before production. Physical writer/domain/lease
 * reservations remain held and keep their independent overlap/resource fences. */
export async function epicIntegrationReadyIntents(
  tx: Prisma.TransactionClient,
  store: RepositoryPolicyStore,
  ownerId: string,
  epicId: string,
  intentIds: readonly string[],
) {
  const ready = new Set<string>();
  for (const intentId of intentIds) {
    try {
      await epicIntegrationDependency(tx, store, { ownerId, epicId, intentId });
      ready.add(intentId);
    } catch (error) {
      if (!(error instanceof DeliveryConflict)) throw error;
    }
  }
  return ready;
}
