import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { configuredEpicMerge } from "./epic-merge-config.server";
import { epicMergePreparedSchema } from "./epic-merge-contracts";
import { createEpicMergeTestStore, epicMergeForTask } from "./epic-merge-host.server";
import { EpicPreviewMergeLifecycle } from "./epic-merge-lifecycle.server";
import { epicPreviewMergeCandidate } from "./epic-merge-observation.server";
import { PostgresReleaseEffectJournal } from "./release-effect-journal.server";
import { ReleaseEffectRunner } from "./release-effect-runner.server";
import { repositoryPolicyStore } from "./repository-policy.server";

/** One bounded pass inside the existing epic scheduler. Deployment enrollment
 * authorizes only child PRs into this exact non-default epic branch. Unknown
 * acknowledgements stay held in the existing journal and are never dispatched again. */
export async function reconcileEpicPreviewMerge(
  db: PrismaClient,
  scope: {
    ownerId: string;
    epicId: string;
    intentId: string;
    readerWorkspaceId: string;
    readerBuildId: string;
  },
  signal: AbortSignal,
  env: Record<string, string | undefined> = process.env,
) {
  const config = configuredEpicMerge(env);
  if (!config || config.policy.ownerId !== scope.ownerId) return "disabled" as const;
  const store = repositoryPolicyStore(db),
    lifecycle = new EpicPreviewMergeLifecycle(db, config, store);
  const snapshot = await db.$transaction(async (tx) => ({
    candidate: await epicPreviewMergeCandidate(tx, store, scope),
    began: (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime(),
  }));
  const candidate = snapshot.candidate;
  if (
    !candidate ||
    candidate.source.repositoryId !== config.policy.repositoryId ||
    candidate.source.baseBranch !== config.policy.baseBranch
  )
    return "held" as const;
  const hostScope = { ...scope, taskId: candidate.ready.taskId };
  let rows = await db.$queryRaw<{ id: string; phase: string; purpose: string }[]>`
    SELECT id,phase,purpose FROM delivery_releases WHERE owner_id=${scope.ownerId}::uuid AND source_revision_id=${candidate.ready.sourceRevisionId}::uuid AND target_digest=${lifecycle.targetDigest} LIMIT 2`;
  if (rows.length > 1 || rows.some((row) => row.purpose !== "epic_preview_integration"))
    return "held" as const;
  if (rows[0]?.phase === "integrated") return "integrated" as const;
  if (!rows.length) {
    const prepared = epicMergePreparedSchema.parse(
      await epicMergeForTask(db, config, hostScope, { operation: "prepare" }, signal),
    );
    const testedAttestationDigest = await createEpicMergeTestStore(db, config).verifyFresh(
      scope.ownerId,
      candidate.ready.taskId,
      prepared.request,
      signal,
    );
    signal.throwIfAborted();
    const opened = await lifecycle.open({
      id: randomUUID(),
      ownerId: scope.ownerId,
      taskId: candidate.ready.taskId,
      prepared,
      testedAttestationDigest,
      observedAt: snapshot.began,
    });
    rows = [{ id: opened.releaseId, phase: "active", purpose: "epic_preview_integration" }];
  }
  const releaseId = rows[0].id;
  await lifecycle.advance(scope.ownerId, releaseId);
  const actions = await db.$queryRaw<
    { id: string; phase: string }[]
  >`SELECT id,phase FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND kind='merge' AND phase IN ('prepared','effect_started','held') LIMIT 2`;
  if (actions.length > 1) return "held" as const;
  if (actions.length) {
    const provider = {
      async dispatch(
        identity: Parameters<
          import("./release-effect-runner.server").ReleaseEffectProvider["dispatch"]
        >[0],
        effectSignal: AbortSignal,
      ) {
        // Refresh the OIDC-bound tested tree immediately before the only dispatch.
        await createEpicMergeTestStore(db, config).verifyFresh(
          scope.ownerId,
          candidate.ready.taskId,
          identity.request,
          effectSignal,
        );
        return epicMergeForTask(
          db,
          config,
          hostScope,
          { operation: "dispatch", identity },
          effectSignal,
        );
      },
      lookup: (
        identity: Parameters<
          import("./release-effect-runner.server").ReleaseEffectProvider["lookup"]
        >[0],
        reference: Record<string, unknown> | null,
        effectSignal: AbortSignal,
      ) =>
        epicMergeForTask(
          db,
          config,
          hostScope,
          {
            operation: "lookup",
            identity,
            reference: reference as { provider: "github"; requestId: string } | null,
          },
          effectSignal,
        ),
    };
    const runner = new ReleaseEffectRunner(
      new PostgresReleaseEffectJournal(db, scope.ownerId, lifecycle.authorize),
      provider,
    );
    if (actions[0].phase === "prepared") await runner.dispatch(actions[0].id, signal);
    else await runner.reconcile(actions[0].id, signal);
  }
  return lifecycle.advance(scope.ownerId, releaseId);
}
