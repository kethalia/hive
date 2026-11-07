import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { epicDigest, epicPlanSchema } from "./epic-contracts";
import { readEpicGitHubForTask } from "./epic-github-read.server";
import { epicPreviewReadiness } from "./epic-readiness.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { DeliveryConflict } from "./state";

type Scope = { ownerId: string; epicId: string; intentId: string };
const sha = z.string().regex(/^[a-f0-9]{40}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const observationSchema = z
  .object({
    schemaVersion: z.literal(1),
    epicId: z.string().uuid(),
    intentId: z.string().uuid(),
    taskId: z.string().uuid(),
    sourceRevisionId: z.string().uuid(),
    sourceSha: sha,
    repositoryId: z.string(),
    pullRequestId: z.string(),
    pullNumber: z.number().int().positive(),
    sourceBranch: z.string(),
    baseBranch: z.string(),
    mergeSha: sha,
    branchHeadSha: sha,
    readinessDigest: digest,
    sourceReceiptDigest: digest,
    completionEventId: z.string().uuid(),
    planDigest: digest,
    nodeDigest: digest,
    mergeDigest: digest,
    observedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

async function inspect(tx: Prisma.TransactionClient, store: RepositoryPolicyStore, scope: Scope) {
  const rows = await tx.$queryRaw<{ task_id: string; plan: unknown; plan_digest: string }[]>`
    SELECT t.id AS task_id,p.plan,p.plan_digest FROM delivery_epic_start_intents s
    JOIN delivery_epic_plan_heads h ON h.owner_id=s.owner_id AND h.epic_id=s.epic_id
    JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
    JOIN delivery_manager_bindings b ON b.owner_id=s.owner_id AND b.preparation_intent_id=s.intent_id
    JOIN delivery_tasks t ON t.owner_id=b.owner_id AND t.manager_binding_id=b.id AND t.epic_id=s.epic_id
    JOIN delivery_epic_writer_reservations w ON w.owner_id=s.owner_id AND w.epic_id=s.epic_id AND w.intent_id=s.intent_id
      AND w.task_id=t.id AND w.workspace_id=b.workspace_id AND w.build_id=b.build_id AND w.lease_id=b.lease_id AND w.phase='held'
    WHERE s.owner_id=${scope.ownerId}::uuid AND s.epic_id=${scope.epicId}::uuid AND s.intent_id=${scope.intentId}::uuid
      AND s.phase='accepted' LIMIT 2 FOR SHARE OF h,s,w`;
  if (rows.length !== 1 || epicDigest(rows[0].plan) !== rows[0].plan_digest) return null;
  const plan = epicPlanSchema.parse(rows[0].plan),
    node = plan.tasks.find((entry) => entry.intentId === scope.intentId);
  if (!node || plan.epicId !== scope.epicId) return null;
  const ready = await epicPreviewReadiness(tx, store, scope.ownerId, rows[0].task_id);
  if (!ready || ready.intentId !== scope.intentId) return null;
  const bound = await store.resolveTask(tx, scope.ownerId, ready.taskId),
    source = bound?.task.currentSourceRevision;
  if (
    !bound ||
    !source ||
    bound.task.epicId !== scope.epicId ||
    bound.task.projectId !== plan.projectId ||
    bound.task.managerBinding?.sourceSha !== node.expectedRevision ||
    source.baseBranch !== bound.policy.source.baseBranch ||
    ["main", "master"].includes(source.baseBranch.toLowerCase())
  )
    return null;
  return {
    ready,
    planDigest: rows[0].plan_digest,
    nodeDigest: epicDigest(node),
    source: {
      repositoryId: source.repositoryId,
      pullRequestId: source.pullRequestId,
      pullNumber: source.pullNumber,
      headSha: source.headSha,
      branch: source.branch,
      baseBranch: source.baseBranch,
    },
  };
}

function semantics(value: z.infer<typeof observationSchema>) {
  return {
    epicId: value.epicId,
    intentId: value.intentId,
    taskId: value.taskId,
    sourceRevisionId: value.sourceRevisionId,
    sourceSha: value.sourceSha,
    repositoryId: value.repositoryId,
    pullRequestId: value.pullRequestId,
    pullNumber: value.pullNumber,
    sourceBranch: value.sourceBranch,
    baseBranch: value.baseBranch,
    mergeSha: value.mergeSha,
    readinessDigest: value.readinessDigest,
    sourceReceiptDigest: value.sourceReceiptDigest,
    completionEventId: value.completionEventId,
    nodeDigest: value.nodeDigest,
  };
}

/** Only the existing scheduler calls this GET-only observer. Provider work is
 * outside transactions. The immutable event is conditional on the same current
 * plan, native seal, source receipt and gates being valid again before commit. */
export async function observeEpicPreviewMerge(
  db: PrismaClient,
  store: RepositoryPolicyStore,
  scope: Scope,
  read: typeof readEpicGitHubForTask = readEpicGitHubForTask,
  signal?: AbortSignal,
) {
  const snapshot = await db.$transaction(
    async (tx) => ({
      state: await inspect(tx, store, scope),
      began: (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime(),
    }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  if (!snapshot.state) return null;
  signal?.throwIfAborted();
  const response = await read(
    db,
    { ownerId: scope.ownerId, taskId: snapshot.state.ready.taskId },
    { operation: "observe_merge" },
    signal,
  );
  if (response.operation !== "observe_merge" || !response.merged || !response.mergeSha) return null;
  const source = snapshot.state.source;
  if (
    response.repository.providerRepositoryId !== source.repositoryId ||
    response.pullRequestId !== source.pullRequestId ||
    response.pullNumber !== source.pullNumber ||
    response.sourceBranch !== source.branch ||
    response.headSha !== source.headSha ||
    response.baseBranch !== source.baseBranch ||
    ["main", "master", response.repository.defaultBranch].includes(response.baseBranch)
  )
    throw new DeliveryConflict("epic_lineage_unverified");
  return db.$transaction(
    async (tx) => {
      signal?.throwIfAborted();
      const current = await inspect(tx, store, scope);
      if (!current || epicDigest(current) !== epicDigest(snapshot.state))
        throw new DeliveryConflict("epic_dependencies_pending");
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      if (now < snapshot.began || now >= snapshot.began + 30000)
        throw new DeliveryConflict("epic_lineage_unavailable");
      const raw = {
        schemaVersion: 1,
        epicId: scope.epicId,
        intentId: scope.intentId,
        taskId: current.ready.taskId,
        sourceRevisionId: current.ready.sourceRevisionId,
        sourceSha: current.ready.sourceSha,
        repositoryId: source.repositoryId,
        pullRequestId: source.pullRequestId,
        pullNumber: source.pullNumber,
        sourceBranch: source.branch,
        baseBranch: source.baseBranch,
        mergeSha: response.mergeSha,
        branchHeadSha: response.branchHeadSha,
        readinessDigest: current.ready.digest,
        sourceReceiptDigest: current.ready.sourceReceiptDigest,
        completionEventId: current.ready.completionEventId,
        planDigest: current.planDigest,
        nodeDigest: current.nodeDigest,
        observedAt: now,
        expiresAt: snapshot.began + 30000,
      };
      const pending = observationSchema.parse({ ...raw, mergeDigest: "0".repeat(64) });
      const payload = { ...pending, mergeDigest: epicDigest(semantics(pending)) };
      const aggregateKey = `epic-preview-merge/${current.ready.taskId}/${current.ready.sourceRevisionId}`;
      const previous = await tx.deliveryEvent.findFirst({
        where: { ownerId: scope.ownerId, aggregateKey },
        orderBy: { aggregateVersion: "desc" },
      });
      const prior = observationSchema.safeParse(previous?.payload);
      if (
        previous?.type === "epic_preview_merge_observed" &&
        prior.success &&
        previous.requestDigest === epicDigest(prior.data) &&
        prior.data.mergeDigest === payload.mergeDigest &&
        prior.data.branchHeadSha === payload.branchHeadSha
      )
        return prior.data;
      await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId: scope.ownerId,
          taskId: current.ready.taskId,
          aggregateKey,
          aggregateVersion: (previous?.aggregateVersion ?? 0) + 1,
          type: "epic_preview_merge_observed",
          policyVersion: "epic-preview-merge-v1",
          requestDigest: epicDigest(payload),
          payload,
        },
      });
      const final = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      if (final >= payload.expiresAt) throw new DeliveryConflict("epic_lineage_unavailable");
      signal?.throwIfAborted();
      return payload;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function epicPreviewMergeReadiness(
  tx: Prisma.TransactionClient,
  store: RepositoryPolicyStore,
  scope: Scope,
) {
  const current = await inspect(tx, store, scope);
  if (!current) return null;
  const event = await tx.deliveryEvent.findFirst({
    where: {
      ownerId: scope.ownerId,
      aggregateKey: `epic-preview-merge/${current.ready.taskId}/${current.ready.sourceRevisionId}`,
    },
    orderBy: { aggregateVersion: "desc" },
  });
  const parsed = observationSchema.safeParse(event?.payload);
  if (
    !event ||
    event.type !== "epic_preview_merge_observed" ||
    !parsed.success ||
    event.requestDigest !== epicDigest(parsed.data)
  )
    return null;
  const value = parsed.data,
    now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime();
  if (
    value.expiresAt <= value.observedAt ||
    value.observedAt > now ||
    value.expiresAt - value.observedAt > 30000 ||
    value.epicId !== scope.epicId ||
    value.intentId !== scope.intentId ||
    value.taskId !== current.ready.taskId ||
    value.readinessDigest !== current.ready.digest ||
    value.sourceReceiptDigest !== current.ready.sourceReceiptDigest ||
    value.completionEventId !== current.ready.completionEventId ||
    value.nodeDigest !== current.nodeDigest ||
    value.sourceRevisionId !== current.ready.sourceRevisionId ||
    value.sourceSha !== current.source.headSha ||
    value.repositoryId !== current.source.repositoryId ||
    value.pullRequestId !== current.source.pullRequestId ||
    value.pullNumber !== current.source.pullNumber ||
    value.sourceBranch !== current.source.branch ||
    value.baseBranch !== current.source.baseBranch ||
    value.mergeDigest !== epicDigest(semantics(value))
  )
    return null;
  return { readiness: current.ready, observation: value };
}
