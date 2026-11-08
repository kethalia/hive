import { randomUUID } from "node:crypto";
import type { Prisma } from "@hive/db";
import { z } from "zod";
import {
  type databaseCatalogSchema,
  databaseJobRequestSchema,
  databaseObservationSchema,
  databaseSignedResponseSchema,
} from "../../../services/migrate/src/delivery/wire.mjs";
import { githubSourceDigest } from "./github-evidence.server";
import { automaticDatabaseActionSchema } from "./release-database-actions";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

type Tx = Prisma.TransactionClient;
type Request = z.infer<typeof databaseJobRequestSchema>;
type Catalog = z.infer<typeof databaseCatalogSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const historySchema = z
  .object({
    request: databaseJobRequestSchema,
    catalogDigest: hash,
    policyDigest: hash,
    releasePolicyDigest: hash,
    bindingDigest: hash,
    responseDigest: hash,
    authorityDigest: hash,
    observedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

/** Original short SQL grants can prove history, never authorize another write. */
export async function recordDatabaseSqlAuthority(
  tx: Tx,
  store: RepositoryPolicyStore,
  request: Request,
  catalog: Catalog,
  response: unknown,
) {
  if (request.operation !== "authorize") throw Error("database_history_scope");
  const bound = await store.resolveTask(tx, request.ownerId, request.taskId);
  if (!bound || bound.task.pauseRequested || bound.task.schedulingPaused)
    throw Error("database_history_scope");
  const release = await tx.deliveryRelease.findUnique({
    where: { id: request.releaseId },
    select: { policyDigest: true },
  });
  if (!release) throw Error("database_history_scope");
  const signed = databaseSignedResponseSchema.parse(response);
  const payload = historySchema.parse({
    request,
    catalogDigest: githubSourceDigest(catalog),
    policyDigest: bound.binding.policyDigest,
    releasePolicyDigest: release.policyDigest,
    bindingDigest: bound.binding.bindingDigest,
    responseDigest: githubSourceDigest(signed),
    authorityDigest: signed.data.authorityDigest,
    observedAt: signed.observedAt,
    expiresAt: signed.expiresAt,
  });
  const key = `database-sql-authority/${request.requestId}`,
    digest = githubSourceDigest(payload);
  const prior = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId: request.ownerId,
        aggregateKey: key,
        aggregateVersion: 1,
      },
    },
  });
  if (
    prior &&
    (prior.taskId !== request.taskId ||
      prior.type !== "database_sql_authorized" ||
      prior.requestDigest !== digest)
  )
    throw Error("database_history_scope");
  if (!prior)
    await tx.deliveryEvent.create({
      data: {
        id: randomUUID(),
        ownerId: request.ownerId,
        taskId: request.taskId,
        aggregateKey: key,
        aggregateVersion: 1,
        schemaVersion: 1,
        policyVersion: `database/${catalog.id}`,
        type: "database_sql_authorized",
        // DeliveryEvent defaults to transaction-start now(); use this actual DB-clock sample.
        createdAt: new Date(signed.observedAt),
        requestDigest: digest,
        payload: payload as Prisma.InputJsonValue,
      },
    });
}

export async function hasDatabaseSqlHistory(
  tx: Tx,
  store: RepositoryPolicyStore,
  request: Request,
  catalog: Catalog,
) {
  if (request.operation !== "report" || !request.dispatchId || !request.observation) return false;
  const bound = await store.resolveTask(tx, request.ownerId, request.taskId);
  if (!bound || bound.task.sourceSha !== request.sourceSha) return false;
  const actions = await tx.$queryRaw<
    {
      id: string;
      request: unknown;
      request_digest: string;
      generation: number;
      policy_digest: string;
    }[]
  >`
    SELECT a.id,a.request,a.request_digest,t.generation,r.policy_digest FROM delivery_release_actions a
    JOIN delivery_releases r ON r.id=a.release_id JOIN delivery_release_targets t ON t.target_digest=r.target_digest
    WHERE r.id=${request.releaseId}::uuid AND r.owner_id=${request.ownerId}::uuid AND r.task_id=${request.taskId}::uuid
      AND r.purpose='automatic_production' AND r.phase='active' AND t.active_release_id=r.id
      AND a.kind='database_job' AND a.phase IN ('effect_started','held') AND a.request->>'dispatchId'=${request.dispatchId}`;
  if (actions.length !== 1) return false;
  const actionRow = actions[0],
    parsedAction = automaticDatabaseActionSchema.safeParse(actionRow.request);
  if (!parsedAction.success) return false;
  const actionRequest = parsedAction.data;
  if (
    githubSourceDigest(actionRequest) !== actionRow.request_digest ||
    actionRequest.ownerId !== request.ownerId ||
    actionRequest.taskId !== request.taskId ||
    actionRequest.releaseId !== request.releaseId ||
    actionRequest.generation !== request.generation ||
    actionRow.generation !== request.generation ||
    actionRequest.targetDigest !== request.targetDigest ||
    actionRequest.sourceSha !== request.sourceSha ||
    actionRequest.catalogDigest !== githubSourceDigest(catalog) ||
    actionRequest.stage !== request.dispatchStage ||
    actionRequest.planEventId !== request.planEventId
  )
    return false;
  const workload = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId: request.ownerId,
        aggregateKey: `database-workload/${request.dispatchId}`,
        aggregateVersion: 1,
      },
    },
  });
  const workloadPayload = {
    actionId: actionRow.id,
    releaseId: request.releaseId,
    catalogDigest: githubSourceDigest(catalog),
    runId: request.githubRunId,
    runAttempt: request.githubRunAttempt,
    stage: request.dispatchStage,
  };
  if (
    !workload ||
    workload.taskId !== request.taskId ||
    workload.type !== "database_workload_bound" ||
    workload.requestDigest !== githubSourceDigest(workloadPayload) ||
    githubSourceDigest(workload.payload) !== workload.requestDigest
  )
    return false;
  const observation = databaseObservationSchema.parse(request.observation);
  const action = observation.kind
    ? "certificate"
    : (
        {
          pending: "begin",
          expanded: "expand",
          compatible: "compatible",
          backfilled: "backfill",
          verified: "integrity",
          activated: "activate",
          contract_held: "contract",
        } as const
      )[observation.phase];
  const events = await tx.deliveryEvent.findMany({
    where: {
      ownerId: request.ownerId,
      taskId: request.taskId,
      type: "database_sql_authorized",
      payload: { path: ["request", "dispatchId"], equals: request.dispatchId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 64,
  });
  const now = (
    await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
  )[0].now.getTime();
  return events.some((event) => {
    const parsed = historySchema.safeParse(event.payload);
    if (!parsed.success) return false;
    const h = parsed.data,
      r = h.request;
    return (
      event.requestDigest === githubSourceDigest(h) &&
      h.catalogDigest === githubSourceDigest(catalog) &&
      h.policyDigest === bound.binding.policyDigest &&
      h.releasePolicyDigest === actionRow.policy_digest &&
      h.authorityDigest ===
        githubSourceDigest({
          request: r,
          catalog: githubSourceDigest(catalog),
          lease: { releaseId: r.releaseId, targetDigest: r.targetDigest, generation: r.generation },
          workflow: githubSourceDigest({ ref: catalog.workflowRef, sha: catalog.workflowSha }),
        }) &&
      h.bindingDigest === bound.binding.bindingDigest &&
      h.observedAt <= now &&
      event.createdAt.getTime() <= now &&
      h.expiresAt > h.observedAt &&
      h.expiresAt - h.observedAt <= 20000 &&
      h.observedAt <= event.createdAt.getTime() + 1000 &&
      r.operation === "authorize" &&
      r.action === action &&
      r.ownerId === request.ownerId &&
      r.taskId === request.taskId &&
      r.sourceSha === request.sourceSha &&
      r.catalogId === request.catalogId &&
      r.targetDigest === request.targetDigest &&
      r.releaseId === request.releaseId &&
      r.generation === request.generation &&
      r.planEventId === request.planEventId &&
      r.dispatchId === request.dispatchId &&
      r.dispatchStage === request.dispatchStage &&
      r.githubRunId === request.githubRunId &&
      r.githubRunAttempt === request.githubRunAttempt
    );
  });
}

/** Already committed SQL outcome, correlated to the exact started journal action. */
export async function databaseActionHasReportedHistory(
  tx: Tx,
  store: RepositoryPolicyStore,
  ownerId: string,
  taskId: string,
  dispatchId: string,
  catalog: Catalog,
) {
  const reports = await tx.deliveryEvent.findMany({
    where: {
      ownerId,
      taskId,
      type: "database_job_observed",
      payload: { path: ["request", "dispatchId"], equals: dispatchId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 64,
  });
  for (const event of reports) {
    const request = databaseJobRequestSchema.safeParse(
      (event.payload as { request?: unknown })?.request,
    );
    if (
      request.success &&
      request.data.operation === "report" &&
      githubSourceDigest(request.data) === event.requestDigest &&
      (await hasDatabaseSqlHistory(tx, store, request.data, catalog))
    )
      return true;
  }
  return false;
}
