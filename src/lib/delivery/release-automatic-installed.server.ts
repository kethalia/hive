import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { epicPreviewReadiness } from "./epic-readiness.server";
import type { AutomaticReleaseConfig } from "./release-automatic-contracts";
import { automaticBuildsReadSchema, automaticPreparedSchema } from "./release-automatic-contracts";
import { configuredAutomaticDatabaseCatalog } from "./release-automatic-database.server";
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
      { task_id: string; owner_id: string; phase: string; database: boolean }[]
    >`SELECT r.task_id,r.owner_id,a.phase,r.snapshot ? 'database' AS database FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id WHERE a.id=${actionId}::uuid AND r.target_digest=${lifecycle.targetDigest} AND r.purpose='automatic_production'`;
    if (rows.length !== 1 || rows[0].owner_id !== config.policy.ownerId)
      throw Error("automatic_release_scope");
    return rows[0];
  };
  const runnerForTask = (
    ownerId: string,
    taskId: string,
    database: boolean,
    prepareMissing = false,
  ) => {
    const scope = { ownerId, taskId };
    return new ReleaseEffectRunner(
      new PostgresReleaseEffectJournal(
        db,
        ownerId,
        lifecycle.authorize,
        prepareMissing ? lifecycle.prepareReservedMerge : undefined,
      ),
      {
        async dispatch(identity, effectSignal) {
          if (identity.kind === "database_job") {
            const authority = await lifecycle.databaseDispatchAuthority(identity);
            return automaticReleaseForTask(
              db,
              config,
              scope,
              {
                operation: "database",
                catalog: authority.catalog,
                command: {
                  action: "dispatch",
                  identity: { ...identity, kind: "database_job" },
                  authorityExpiresAt: authority.expiresAt,
                },
              },
              effectSignal,
            );
          }
          if (!database) await tested.verifyFresh(ownerId, taskId, identity.request, effectSignal);
          const authorityExpiresAt = await lifecycle.dispatchAuthority(identity);
          return automaticReleaseForTask(
            db,
            config,
            scope,
            { operation: "dispatch", identity, authorityExpiresAt },
            effectSignal,
          );
        },
        lookup: async (identity, reference, effectSignal) => {
          if (identity.kind === "database_job") {
            const authority = await lifecycle.databaseDispatchAuthority(identity, false);
            return automaticReleaseForTask(
              db,
              config,
              scope,
              {
                operation: "database",
                catalog: authority.catalog,
                command: {
                  action: "lookup",
                  identity: { ...identity, kind: "database_job" },
                  reference: reference as {
                    provider: "github-actions";
                    dispatchId: string;
                  } | null,
                },
              },
              effectSignal,
            );
          }
          return automaticReleaseForTask(
            db,
            config,
            scope,
            {
              operation: "lookup",
              identity,
              reference: reference as { provider: "github"; requestId: string } | null,
            },
            effectSignal,
          );
        },
      },
    );
  };
  const controller = {
    builds: null,
    async step(ownerId: string, actionId: string, signal: AbortSignal) {
      const row = await taskForAction(actionId);
      if (row.owner_id !== ownerId) throw Error("automatic_release_scope");
      const runner = runnerForTask(ownerId, row.task_id, row.database);
      return row.phase === "prepared"
        ? runner.dispatch(actionId, signal)
        : runner.reconcile(actionId, signal);
    },
    async dispatchReservedMerge(
      ownerId: string,
      releaseId: string,
      signal: AbortSignal,
    ): Promise<"held" | "observed" | "not_started" | "not_found"> {
      const scope = await lifecycle.reservedMergeScope(ownerId, releaseId);
      if (!scope) return "held";
      const existing = await db.deliveryReleaseAction.findUnique({ where: { id: scope.actionId } });
      if (existing && existing.releaseId !== releaseId) return "held";
      const runner = runnerForTask(ownerId, scope.taskId, true, true);
      if (existing?.phase === "observed") return "observed";
      return !existing || existing.phase === "prepared"
        ? runner.dispatch(scope.actionId, signal)
        : runner.reconcile(scope.actionId, signal);
    },
    async reconcileDatabaseReport(
      report: {
        ownerId: string;
        taskId: string;
        sourceSha: string;
        dispatchId: string;
        reportEventId: string;
      },
      signal: AbortSignal,
    ) {
      const rows = await db.$queryRaw<
        { id: string; release_id: string; phase: string; task_id: string }[]
      >`
        SELECT a.id,a.release_id,a.phase,r.task_id FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id
        JOIN delivery_release_targets t ON t.target_digest=r.target_digest
        WHERE r.owner_id=${report.ownerId}::uuid AND r.task_id=${report.taskId}::uuid AND r.target_digest=${lifecycle.targetDigest}
          AND r.purpose='automatic_production' AND r.phase='active' AND t.active_release_id=r.id
          AND a.kind='database_job' AND a.request->>'dispatchId'=${report.dispatchId} AND a.request->>'sourceSha'=${report.sourceSha}`;
      if (rows.length !== 1 || !["effect_started", "held", "observed"].includes(rows[0].phase))
        return "held" as const;
      signal.throwIfAborted();
      const event = await db.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId: report.ownerId, id: report.reportEventId } },
      });
      signal.throwIfAborted();
      if (
        !event ||
        event.taskId !== report.taskId ||
        !["database_plan_approved", "database_job_observed"].includes(event.type)
      )
        return "held" as const;
      const eventPayload = event.payload as { manifest?: unknown; request?: unknown } | null;
      const committed = z
        .object({
          ownerId: z.string(),
          taskId: z.string(),
          sourceSha: z.string(),
          dispatchId: z.string(),
        })
        .passthrough()
        .safeParse(
          event.type === "database_plan_approved" ? eventPayload?.manifest : eventPayload?.request,
        );
      if (
        !committed.success ||
        committed.data.ownerId !== report.ownerId ||
        committed.data.taskId !== report.taskId ||
        committed.data.sourceSha !== report.sourceSha ||
        committed.data.dispatchId !== report.dispatchId
      )
        return "held" as const;
      const row = rows[0];
      // Poll ONLY read-only reconciliation after the report response. A running
      // protected job never supplies its own completed-run receipt.
      const expires =
        event.type === "database_plan_approved"
          ? event.createdAt.getTime() + 30000
          : z.object({ expiresAt: z.number() }).passthrough().parse(event.payload).expiresAt;
      const pollUntil = Math.min(Date.now() + 20000, expires);
      for (let read = 0; read < 25 && row.phase !== "observed"; read++) {
        signal.throwIfAborted();
        await controller.step(report.ownerId, row.id, signal);
        signal.throwIfAborted();
        const action = await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: row.id } });
        row.phase = action.phase;
        signal.throwIfAborted();
        if (row.phase !== "observed") {
          if (Date.now() >= pollUntil) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(1000, pollUntil - Date.now()));
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      }
      if (row.phase !== "observed") return "waiting" as const;
      const task = await db.deliveryTask.findUnique({
        where: { ownerId_id: { ownerId: report.ownerId, id: report.taskId } },
        select: { pauseRequested: true, schedulingPaused: true },
      });
      if (!task || task.pauseRequested || task.schedulingPaused) return "checkpointed" as const;
      await controller.checkpointDatabase(report.ownerId, row.release_id, signal);
      return "checkpointed" as const;
    },
    async checkpointDatabase(
      ownerId: string,
      releaseId: string,
      signal: AbortSignal,
    ): Promise<string> {
      signal.throwIfAborted();
      const scope = await lifecycle.reservedMergeScope(ownerId, releaseId);
      signal.throwIfAborted();
      if (!scope) return "held" as const;
      const merge = await db.deliveryReleaseAction.findUnique({ where: { id: scope.actionId } });
      signal.throwIfAborted();
      if (merge?.phase === "observed") {
        await controller.observe(ownerId, releaseId, signal);
      } else if (!merge || merge.phase === "prepared") {
        const completed = await db.deliveryReleaseAction.findFirst({
          where: { releaseId, kind: "database_job", phase: "observed" },
        });
        signal.throwIfAborted();
        if (completed) {
          const began = (
            await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
          )[0].now.getTime();
          signal.throwIfAborted();
          const prepared = automaticPreparedSchema.parse(
            await automaticReleaseForTask(
              db,
              config,
              { ownerId, taskId: scope.taskId },
              { operation: "prepare" },
              signal,
            ),
          );
          signal.throwIfAborted();
          await lifecycle.renewDatabaseGrant(ownerId, releaseId, prepared, began);
        }
      }
      signal.throwIfAborted();
      const planned = await lifecycle.advance(ownerId, releaseId);
      signal.throwIfAborted();
      if (planned === "ready_to_merge")
        return controller.dispatchReservedMerge(ownerId, releaseId, signal);
      if (planned === "held") return planned;
      const pending = await db.deliveryReleaseAction.findMany({
        where: { releaseId, kind: "database_job", phase: "prepared" },
        take: 3,
      });
      signal.throwIfAborted();
      for (const action of pending) {
        signal.throwIfAborted();
        await controller.step(ownerId, action.id, signal);
      }
      return planned;
    },
    async observeDatabase(ownerId: string, releaseId: string, action: string, signal: AbortSignal) {
      const scope = await lifecycle.databaseObservationScope(ownerId, releaseId, action);
      if (!scope) return false;
      const began = (
        await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      const observation = await observeAutomaticBuild(
        config,
        scope.sourceSha,
        async (sha, proofSignal) => {
          if (!scope.baseline)
            return automaticReleaseForTask(
              db,
              config,
              { ownerId, taskId: scope.taskId },
              { operation: "builds", mergeSha: sha, database: scope.catalog },
              proofSignal,
            );
          const observed = z
            .object({ treeSha: z.string(), builds: automaticBuildsReadSchema })
            .strict()
            .parse(
              await automaticReleaseForTask(
                db,
                config,
                { ownerId, taskId: scope.taskId },
                { operation: "database", catalog: scope.catalog, command: { action: "baseline" } },
                proofSignal,
              ),
            );
          return observed.builds;
        },
        signal,
        fetcher,
      );
      if (
        observation.treeSha !== scope.treeSha ||
        (scope.buildUuid && observation.health.build.buildUuid !== scope.buildUuid)
      )
        return false;
      const boundedObservation = {
        ...observation,
        expiresAt: Math.min(observation.expiresAt, began + 30000),
      };
      return scope.baseline
        ? lifecycle.recordDatabaseBaseline(ownerId, releaseId, boundedObservation, began)
        : (await lifecycle.recordObservation(ownerId, releaseId, boundedObservation, began)) !==
            "held";
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
              {
                operation: "builds",
                mergeSha,
                ...(scope.catalog ? { database: scope.catalog } : {}),
              },
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
          const prepared = automaticPreparedSchema.parse(
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
          let databaseBaseline: unknown;
          if (prepared.riskClass === "database") {
            const catalog = configuredAutomaticDatabaseCatalog(config, prepared.request.headSha);
            if (!catalog) throw Error("automatic_database_unavailable");
            databaseBaseline = await observeAutomaticBuild(
              config,
              prepared.request.baseSha,
              async (_sha, proofSignal) => {
                const observed = z
                  .object({ treeSha: z.string(), builds: automaticBuildsReadSchema })
                  .strict()
                  .parse(
                    await automaticReleaseForTask(
                      db,
                      config,
                      { ownerId: row.owner_id, taskId: row.id },
                      { operation: "database", catalog, command: { action: "baseline" } },
                      proofSignal,
                    ),
                  );
                return observed.builds;
              },
              signal,
              fetcher,
            );
          }
          await lifecycle.open({
            id: randomUUID(),
            ownerId: row.owner_id,
            taskId: row.id,
            prepared,
            testedAttestationDigest,
            ...(databaseBaseline ? { databaseBaseline } : {}),
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
  const planner = {
    async advance(ownerId: string, releaseId: string, signal?: AbortSignal) {
      const bounded = signal ?? AbortSignal.timeout(40000);
      if (await lifecycle.reservedMergeScope(ownerId, releaseId))
        return controller.checkpointDatabase(ownerId, releaseId, bounded);
      const result = await lifecycle.advance(ownerId, releaseId);
      if (result === "ready_to_merge")
        return controller.dispatchReservedMerge(
          ownerId,
          releaseId,
          signal ?? AbortSignal.timeout(40000),
        );
      return result;
    },
  };
  return {
    ...controller,
    facts: null,
    lifecycle,
    planner,
    opener,
    scheduler: new ReleaseScheduler(db, lifecycle.targetDigest, controller, planner, opener),
  };
}
