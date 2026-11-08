import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { epicMergePreparedSchema } from "./epic-merge-contracts";
import { epicPreviewReadiness } from "./epic-readiness.server";
import type { AutomaticReleaseConfig } from "./release-automatic-contracts";
import {
  automaticReleaseForTask,
  createAutomaticReleaseTestStore,
} from "./release-automatic-host.server";
import { AutomaticReleaseLifecycle } from "./release-automatic-lifecycle.server";
import { observeAutomaticBuild } from "./release-automatic-observer.server";
import { PostgresReleaseEffectJournal } from "./release-effect-journal.server";
import { ReleaseEffectRunner } from "./release-effect-runner.server";
import { ReleaseScheduler } from "./release-scheduler.server";
import { repositoryPolicyStore } from "./repository-policy.server";

/** Purpose selection inside the existing installed controller/scheduler. The
 * only provider write is an attributed merge; Builds remains repository-owned. */
export function createAutomaticReleaseController(
  db: PrismaClient,
  config: AutomaticReleaseConfig,
  fetcher: typeof fetch = fetch,
) {
  const store = repositoryPolicyStore(db),
    lifecycle = new AutomaticReleaseLifecycle(db, config, store),
    tested = createAutomaticReleaseTestStore(db, config, fetcher);
  const taskForAction = async (actionId: string) => {
    const rows = await db.$queryRaw<
      { task_id: string; owner_id: string; phase: string }[]
    >`SELECT r.task_id,r.owner_id,a.phase FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id WHERE a.id=${actionId}::uuid AND r.target_digest=${lifecycle.targetDigest} AND r.purpose='automatic_production'`;
    if (rows.length !== 1 || rows[0].owner_id !== config.policy.ownerId)
      throw Error("automatic_release_scope");
    return rows[0];
  };
  const controller = {
    builds: null,
    async step(ownerId: string, actionId: string, signal: AbortSignal) {
      const row = await taskForAction(actionId);
      if (row.owner_id !== ownerId) throw Error("automatic_release_scope");
      const scope = { ownerId, taskId: row.task_id };
      const runner = new ReleaseEffectRunner(
        new PostgresReleaseEffectJournal(db, ownerId, lifecycle.authorize),
        {
          async dispatch(identity, effectSignal) {
            await tested.verifyFresh(ownerId, row.task_id, identity.request, effectSignal);
            const authorityExpiresAt = await lifecycle.dispatchAuthority(identity);
            return automaticReleaseForTask(
              db,
              config,
              scope,
              { operation: "dispatch", identity, authorityExpiresAt },
              effectSignal,
            );
          },
          lookup: (identity, reference, effectSignal) =>
            automaticReleaseForTask(
              db,
              config,
              scope,
              {
                operation: "lookup",
                identity,
                reference: reference as { provider: "github"; requestId: string } | null,
              },
              effectSignal,
            ),
        },
      );
      return row.phase === "prepared"
        ? runner.dispatch(actionId, signal)
        : runner.reconcile(actionId, signal);
    },
    async observe(ownerId: string, releaseId: string, signal: AbortSignal) {
      const scope = await lifecycle.observationScope(ownerId, releaseId);
      if (!scope) return "held" as const;
      const began = (
        await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      try {
        const observed = await observeAutomaticBuild(
          config,
          scope.receipt.mergeSha,
          (mergeSha, effectSignal) =>
            automaticReleaseForTask(
              db,
              config,
              { ownerId, taskId: scope.taskId },
              { operation: "builds", mergeSha },
              effectSignal,
            ),
          signal,
          fetcher,
        );
        signal.throwIfAborted();
        return lifecycle.recordObservation(ownerId, releaseId, observed, began);
      } catch {
        signal.throwIfAborted();
        return lifecycle.observationFailed(ownerId, releaseId);
      }
    },
  };
  const opener = {
    async tick(signal: AbortSignal) {
      if (signal.aborted) return "aborted" as const;
      const rows = await db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO delivery_release_scheduler_cursors(target_digest) VALUES (${lifecycle.targetDigest}) ON CONFLICT DO NOTHING`;
        const cursor = (
          await tx.$queryRaw<
            { opener_cursor: string }[]
          >`SELECT opener_cursor FROM delivery_release_scheduler_cursors WHERE target_digest=${lifecycle.targetDigest} FOR UPDATE`
        )[0];
        const rows = await tx.$queryRaw<
          { id: string; owner_id: string }[]
        >`SELECT t.id,t.owner_id FROM delivery_tasks t JOIN delivery_source_revisions s ON s.owner_id=t.owner_id AND s.task_id=t.id AND s.id=t.source_revision_id WHERE t.owner_id=${config.policy.ownerId}::uuid AND t.id>${cursor.opener_cursor}::uuid AND s.repository_id=${config.policy.repositoryId} AND s.provider_account_id=${config.policy.providerAccountId} AND s.base_branch='main' AND NOT t.pause_requested AND NOT t.scheduling_paused AND NOT EXISTS (SELECT 1 FROM delivery_release_targets x WHERE x.target_digest=${lifecycle.targetDigest} AND x.active_release_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM delivery_releases r WHERE r.source_revision_id=s.id AND r.target_digest=${lifecycle.targetDigest}) ORDER BY t.id LIMIT 8`;
        const next = rows.length
          ? rows[rows.length - 1].id
          : "00000000-0000-0000-0000-000000000000";
        await tx.$executeRaw`UPDATE delivery_release_scheduler_cursors SET opener_cursor=${next}::uuid,updated_at=clock_timestamp() WHERE target_digest=${lifecycle.targetDigest}`;
        return rows;
      });
      for (const row of rows) {
        signal.throwIfAborted();
        try {
          const captured = await db.$transaction(async (tx) => ({
            ready: await epicPreviewReadiness(tx, store, row.owner_id, row.id),
            now: (
              await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
            )[0].now.getTime(),
          }));
          if (!captured.ready) continue;
          const prepared = epicMergePreparedSchema.parse(
            await automaticReleaseForTask(
              db,
              config,
              { ownerId: row.owner_id, taskId: row.id },
              { operation: "prepare" },
              signal,
            ),
          );
          const testedAttestationDigest = await tested.verifyFresh(
            row.owner_id,
            row.id,
            prepared.request,
            signal,
          );
          signal.throwIfAborted();
          await lifecycle.open({
            id: randomUUID(),
            ownerId: row.owner_id,
            taskId: row.id,
            prepared,
            testedAttestationDigest,
            observedAt: captured.now,
          });
          return "opened" as const;
        } catch {
          signal.throwIfAborted();
        }
      }
      return "idle" as const;
    },
  };
  return {
    ...controller,
    facts: null,
    lifecycle,
    planner: lifecycle,
    opener,
    scheduler: new ReleaseScheduler(db, lifecycle.targetDigest, controller, lifecycle, opener),
  };
}
