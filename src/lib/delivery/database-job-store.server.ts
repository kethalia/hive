import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { sourcePlanIntent } from "../../../services/migrate/src/delivery/source-plan-intent.mjs";
import {
  databaseCatalogSchema,
  databaseJobRequestSchema,
  databaseObservationSchema,
  databasePlanApprovalSchema,
  databaseScope,
  signDatabaseResponse,
  verifyDatabaseResponse,
  verifySourceBuildApproval,
} from "../../../services/migrate/src/delivery/wire.mjs";
import { hasDatabaseSqlHistory, recordDatabaseSqlAuthority } from "./database-job-history.server";
import { verifyDatabaseJobIdentity } from "./database-job-identity.server";
import { githubSourceDigest } from "./github-evidence.server";
import { automaticDatabaseActionSchema } from "./release-database-actions";
import { verifyReleaseEvidence } from "./release-evidence.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const databasePin = z.object({ catalogDigest: hash, planEventId: uuid, planDigest: hash }).strict();
type Tx = Prisma.TransactionClient;
type Catalog = z.infer<typeof databaseCatalogSchema>;
type Request = z.infer<typeof databaseJobRequestSchema>;
const approvalDigest = (request: z.infer<typeof databasePlanApprovalSchema>) => {
  const { githubRunId: _runId, githubRunAttempt: _attempt, ...artifact } = request;
  return githubSourceDigest(artifact);
};
const fail = (): never => {
  throw Error("database_job_authority_unavailable");
};
const clock = async (tx: Tx) =>
  (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now.getTime();
export async function acceptedDatabasePlan(
  tx: Tx,
  scope: { ownerId: string; taskId: string; sourceSha: string },
  catalog: Catalog,
) {
  const event = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId: scope.ownerId,
        aggregateKey: `database-plan/${scope.taskId}/${scope.sourceSha}`,
        aggregateVersion: 1,
      },
    },
  });
  if (
    !event ||
    event.taskId !== scope.taskId ||
    event.type !== "database_plan_approved" ||
    !event.payload
  )
    return fail();
  const payload = z
    .object({
      manifest: databasePlanApprovalSchema,
      catalogDigest: hash,
      workflowDigest: hash,
      jtiDigest: hash,
    })
    .strict()
    .parse(event.payload);
  if (
    approvalDigest(payload.manifest) !== event.requestDigest ||
    payload.catalogDigest !== githubSourceDigest(catalog) ||
    payload.manifest.sourceSha !== scope.sourceSha ||
    payload.manifest.taskId !== scope.taskId ||
    payload.manifest.ownerId !== scope.ownerId ||
    payload.manifest.catalogId !== catalog.id
  )
    return fail();
  if (
    catalog.compatibilityTest?.config &&
    "kind" in catalog.compatibilityTest.config &&
    catalog.compatibilityTest.config.kind === "automatic-source-build"
  )
    verifySourceBuildApproval(payload.manifest, catalog);
  return { id: event.id, planDigest: githubSourceDigest(payload.manifest.plan), ...payload };
}
/** Fixed trusted controller. The HTTP caller never supplies catalog, SQL
 * replacement, signer, target URL, DB connection or an authority callback. */
export class DatabaseJobStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly repositoryPolicies: RepositoryPolicyStore,
    private readonly catalogs: () => unknown,
    private readonly privateKeyPem: string,
    private readonly deployment: {
      refresh?(request: Request, catalog: Catalog, signal: AbortSignal): Promise<void>;
      observe(
        tx: Tx,
        input: {
          request: Request;
          catalog: Catalog;
          plan: Record<string, unknown>;
          planDigest: string;
          signal: AbortSignal;
        },
      ): Promise<Record<string, unknown>>;
    },
    private readonly fetcher: typeof fetch = fetch,
    private readonly githubToken: string = "",
    private readonly connectedCompatibility?: (
      request: z.infer<typeof databasePlanApprovalSchema>,
      catalog: Catalog,
      signal: AbortSignal,
    ) => Promise<number>,
    private readonly connectedWorkload?: (
      request: Request,
      catalog: Catalog,
      signal: AbortSignal,
    ) => Promise<number>,
    private readonly wake?: (scope: {
      ownerId: string;
      taskId: string;
      sourceSha: string;
      dispatchId: string;
      reportEventId: string;
    }) => Promise<void>,
  ) {}
  postResponse(raw: unknown, result: unknown) {
    const wake = this.wake;
    if (!wake) return null;
    const request =
      (raw as { purpose?: unknown } | null)?.purpose === "approve_database_plan"
        ? databasePlanApprovalSchema.parse(raw)
        : databaseJobRequestSchema.parse(raw);
    if (
      !request.dispatchId ||
      (request.purpose === "database_job" && request.operation !== "report")
    )
      return null;
    const catalog = this.catalog(request.catalogId, Date.now()),
      mode = catalog.compatibilityTest?.config;
    if (!mode || !("kind" in mode) || mode.kind !== "automatic-source-build") return null;
    const response = verifyDatabaseResponse(result, request, catalog),
      reportEventId = z
        .string()
        .uuid()
        .parse(
          response.data[
            request.purpose === "approve_database_plan" ? "planEventId" : "observationId"
          ],
        );
    const scope = {
      ownerId: request.ownerId,
      taskId: request.taskId,
      sourceSha: request.sourceSha,
      dispatchId: request.dispatchId,
      reportEventId,
    };
    return () => wake(scope);
  }
  get requestBudgetMs() {
    return z
      .array(databaseCatalogSchema)
      .max(32)
      .parse(this.catalogs())
      .some((catalog) => {
        const mode = catalog.compatibilityTest?.config;
        return mode && "kind" in mode && mode.kind === "automatic-source-build";
      })
      ? 40000
      : 15000;
  }
  private catalog(id: string, now: number) {
    const catalogs = z.array(databaseCatalogSchema).max(32).parse(this.catalogs()),
      matching = catalogs.filter((c) => c.id === id);
    if (matching.length !== 1) return fail();
    const c = matching[0];
    if (
      c.validFrom > now ||
      c.expiresAt <= now ||
      createPublicKey(createPrivateKey(this.privateKeyPem)).export({
        type: "spki",
        format: "pem",
      }) !== createPublicKey(c.authorityPublicKeyPem).export({ type: "spki", format: "pem" })
    )
      return fail();
    return c;
  }
  private async source(
    tx: Tx,
    request: { ownerId: string; taskId: string; sourceSha: string },
    catalog: Catalog,
    receipt?: Request,
  ) {
    const rows = await tx.$queryRaw<
      { source_sha: string; repository_id: string; owner_id: string; paused: boolean }[]
    >`SELECT t.source_sha,p.provider_repository_id AS repository_id,t.owner_id,(t.pause_requested OR t.scheduling_paused) AS paused FROM delivery_tasks t JOIN delivery_projects p ON p.id=t.project_id AND p.owner_id=t.owner_id WHERE t.id=${request.taskId}::uuid AND t.owner_id=${request.ownerId}::uuid FOR UPDATE OF t`;
    const receiptHistory =
      rows[0]?.paused &&
      receipt?.operation === "report" &&
      (await hasDatabaseSqlHistory(tx, this.repositoryPolicies, receipt, catalog));
    if (
      rows.length !== 1 ||
      (rows[0].paused && !receiptHistory) ||
      request.ownerId !== catalog.ownerId ||
      rows[0].source_sha !== request.sourceSha ||
      rows[0].repository_id !== catalog.repositoryId ||
      // Approval and the migration job precede production verification. Current
      // release/target/plan authorization remains a separate job() requirement.
      !(await verifyReleaseEvidence(
        tx,
        this.repositoryPolicies,
        {
          ...request,
          milestone: "implementation_preview",
        },
        receiptHistory ? { pausedReceiptOnly: true } : undefined,
      ))
    )
      return fail();
  }
  private async verifyCompatibilityTest(
    request: z.infer<typeof databasePlanApprovalSchema>,
    catalog: Catalog,
    signal: AbortSignal,
  ) {
    const test = catalog.compatibilityTest,
      config = test?.config;
    if (config && "kind" in config && config.kind === "automatic-source-build") {
      if (
        !this.connectedCompatibility ||
        !request.dispatchId ||
        githubSourceDigest(sourcePlanIntent(request.plan)) !==
          githubSourceDigest(catalog.automaticPlan) ||
        githubSourceDigest(config) !== request.compatibility.mixedVersionChecksDigest ||
        !test?.jobName.endsWith(`fixed-database-compatibility-${githubSourceDigest(config)}`)
      )
        return fail();
      verifySourceBuildApproval(request, catalog);
      return this.connectedCompatibility(request, catalog, signal);
    }
    if (
      !test ||
      !config ||
      !("kind" in config && config.kind === "workerd") ||
      !this.githubToken ||
      this.githubToken.length > 4096 ||
      /[\r\n]/.test(this.githubToken) ||
      config.catalogId !== catalog.id ||
      config.sourceSha !== request.sourceSha ||
      config.planDigest !== githubSourceDigest(request.plan) ||
      config.oldAppDigest !== request.plan.oldAppDigest ||
      config.newAppDigest !== request.plan.newAppDigest ||
      config.compatibilityDigest !== request.plan.compatibilityDigest ||
      !test.jobName.endsWith(`fixed-database-compatibility-${githubSourceDigest(config)}`) ||
      githubSourceDigest(config) !== request.compatibility.mixedVersionChecksDigest
    )
      return fail();
    const root = `https://api.github.com/repos/${test.repositoryOwner}/${test.repositoryName}`;
    const get = async (path: string) => {
      const response = await this.fetcher(root + path, {
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok || /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? ""))
        return fail();
      return boundedReleaseJson(response, 1048576, signal);
    };
    const id = z.number().int().positive().safe();
    const run = z
      .object({
        id,
        run_attempt: id,
        workflow_id: id,
        event: z.literal("workflow_dispatch"),
        head_sha: z.string(),
        repository: z.object({ id }),
        head_repository: z.object({ id }),
      })
      .passthrough()
      .parse(
        await get(`/actions/runs/${request.githubRunId}/attempts/${request.githubRunAttempt}`),
      );
    if (
      String(run.id) !== request.githubRunId ||
      run.run_attempt !== request.githubRunAttempt ||
      String(run.workflow_id) !== test.workflowId ||
      run.head_sha !== catalog.dispatcherSha ||
      String(run.repository.id) !== catalog.repositoryId ||
      String(run.head_repository.id) !== catalog.repositoryId
    )
      return fail();
    const jobs = z
      .object({
        total_count: z.number().int().nonnegative().max(99),
        jobs: z
          .array(
            z
              .object({
                run_id: id,
                run_attempt: id,
                name: z.string(),
                status: z.string(),
                conclusion: z.string().nullable(),
              })
              .passthrough(),
          )
          .max(99),
      })
      .passthrough()
      .parse(
        await get(
          `/actions/runs/${request.githubRunId}/attempts/${request.githubRunAttempt}/jobs?per_page=100`,
        ),
      );
    const matches = jobs.jobs.filter((job) => job.name === test.jobName);
    if (
      jobs.total_count !== jobs.jobs.length ||
      matches.length !== 1 ||
      matches[0].run_id !== run.id ||
      matches[0].run_attempt !== run.run_attempt ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success" ||
      signal.aborted
    )
      return fail();
  }
  private async automaticAction(
    tx: Tx,
    request: {
      ownerId: string;
      taskId: string;
      sourceSha: string;
      dispatchId?: string;
      githubRunId: string;
      githubRunAttempt: number;
    },
    catalog: Catalog,
    stage: "approve" | "advance" | "activate",
  ) {
    const mode = catalog.compatibilityTest?.config;
    if (!mode || !("kind" in mode) || mode.kind !== "automatic-source-build") return;
    if (!request.dispatchId || request.githubRunAttempt !== 1) return fail();
    const rows = await tx.$queryRaw<
      {
        id: string;
        request: unknown;
        phase: string;
        snapshot: unknown;
        release_id: string;
        generation: number;
      }[]
    >`
      SELECT a.id,a.request,a.phase,r.snapshot,r.id AS release_id,t.generation FROM delivery_release_actions a
      JOIN delivery_releases r ON r.id=a.release_id JOIN delivery_release_targets t ON t.target_digest=r.target_digest
      WHERE r.owner_id=${request.ownerId}::uuid AND r.task_id=${request.taskId}::uuid AND r.purpose='automatic_production'
        AND r.phase='active' AND t.active_release_id=r.id AND a.kind='database_job'
        AND a.request->>'dispatchId'=${request.dispatchId} FOR UPDATE OF t,r,a`;
    if (rows.length !== 1 || !["effect_started", "held"].includes(rows[0].phase)) return fail();
    const row = rows[0],
      planned = automaticDatabaseActionSchema.parse(row.request),
      pin = z
        .object({
          database: z
            .object({ phase: z.literal("plan_intent"), catalogDigest: hash, planDigest: hash })
            .passthrough(),
        })
        .passthrough()
        .parse(row.snapshot).database;
    if (
      planned.stage !== stage ||
      planned.sourceSha !== request.sourceSha ||
      planned.ownerId !== request.ownerId ||
      planned.taskId !== request.taskId ||
      planned.releaseId !== row.release_id ||
      planned.generation !== row.generation ||
      planned.catalogDigest !== githubSourceDigest(catalog) ||
      planned.catalogDigest !== pin.catalogDigest ||
      planned.planDigest !== githubSourceDigest(catalog.automaticPlan) ||
      planned.planDigest !== pin.planDigest
    )
      return fail();
    const key = `database-workload/${request.dispatchId}`,
      payload = {
        actionId: row.id,
        releaseId: row.release_id,
        catalogDigest: githubSourceDigest(catalog),
        runId: request.githubRunId,
        runAttempt: request.githubRunAttempt,
        stage,
      };
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
        prior.type !== "database_workload_bound" ||
        prior.requestDigest !== githubSourceDigest(payload))
    )
      return fail();
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
          type: "database_workload_bound",
          requestDigest: githubSourceDigest(payload),
          payload,
        },
      });
  }
  async approve(raw: unknown, token: string, signal: AbortSignal) {
    const request = databasePlanApprovalSchema.parse(raw),
      catalog = this.catalog(request.catalogId, Date.now()),
      identity = await verifyDatabaseJobIdentity(
        request,
        token,
        catalog,
        Date.now(),
        signal,
        this.fetcher,
      );
    const connectedExpiry = await this.verifyCompatibilityTest(request, catalog, signal),
      authorityExpiry = Math.min(identity.expiresAt, connectedExpiry ?? identity.expiresAt);
    if (!Number.isSafeInteger(authorityExpiry)) return fail();
    return this.db.$transaction(
      async (tx) => {
        const now = await clock(tx);
        if (
          signal.aborted ||
          authorityExpiry <= now ||
          githubSourceDigest(this.catalog(catalog.id, now)) !== githubSourceDigest(catalog)
        )
          return fail();
        await this.source(tx, request, catalog);
        await this.automaticAction(tx, request, catalog, "approve");
        const key = `database-plan/${request.taskId}/${request.sourceSha}`,
          prior = await tx.deliveryEvent.findUnique({
            where: {
              ownerId_aggregateKey_aggregateVersion: {
                ownerId: request.ownerId,
                aggregateKey: key,
                aggregateVersion: 1,
              },
            },
          });
        if (prior && prior.requestDigest !== approvalDigest(request)) return fail();
        const event =
          prior ??
          (await tx.deliveryEvent.create({
            data: {
              id: randomUUID(),
              ownerId: request.ownerId,
              taskId: request.taskId,
              aggregateKey: key,
              aggregateVersion: 1,
              schemaVersion: 1,
              policyVersion: `database/${catalog.id}`,
              type: "database_plan_approved",
              requestDigest: approvalDigest(request),
              payload: {
                manifest: request,
                catalogDigest: githubSourceDigest(catalog),
                workflowDigest: identity.workflowDigest,
                jtiDigest: identity.jtiDigest,
              } as Prisma.InputJsonValue,
            },
          }));
        const end = await clock(tx);
        if (signal.aborted || authorityExpiry <= end || catalog.expiresAt <= end) return fail();
        return this.response(request, catalog, end, authorityExpiry, {
          planEventId: event.id,
          planDigest: githubSourceDigest(request.plan),
          catalogDigest: githubSourceDigest(catalog),
          executionAuthorized: false,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
    );
  }
  private response(
    request: unknown,
    catalog: Catalog,
    now: number,
    identityExpiry: number,
    data: Record<string, unknown>,
  ) {
    return signDatabaseResponse(
      {
        schemaVersion: 1,
        purpose: "database_job_response",
        catalogId: catalog.id,
        requestDigest: githubSourceDigest(request),
        observedAt: now,
        expiresAt: Math.min(now + 20000, identityExpiry, catalog.expiresAt),
        data,
      },
      this.privateKeyPem,
    );
  }
  async job(raw: unknown, token: string, signal: AbortSignal) {
    const request = databaseJobRequestSchema.parse(raw),
      catalog = this.catalog(request.catalogId, Date.now());
    const compatibility = catalog.compatibilityTest?.config;
    if (
      compatibility &&
      "kind" in compatibility &&
      compatibility.kind === "automatic-source-build" &&
      (catalog.automaticExecutionEnabled !== true || !request.dispatchId)
    )
      return fail();
    const identity = await verifyDatabaseJobIdentity(
      request,
      token,
      catalog,
      Date.now(),
      signal,
      this.fetcher,
    );
    let authorityExpiry = identity.expiresAt;
    if (
      compatibility &&
      "kind" in compatibility &&
      compatibility.kind === "automatic-source-build"
    ) {
      if (
        !this.connectedWorkload ||
        !request.dispatchStage ||
        (request.dispatchStage === "advance" && request.action === "activate") ||
        (request.dispatchStage === "activate" &&
          !["begin", "read", "activate", "certificate"].includes(request.action)) ||
        request.action === "contract"
      )
        return fail();
      authorityExpiry = Math.min(
        identity.expiresAt,
        await this.connectedWorkload(request, catalog, signal),
      );
      if (!Number.isSafeInteger(authorityExpiry)) return fail();
      if (request.operation === "observe")
        await this.deployment.refresh?.(request, catalog, signal);
    }
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          {
            owner_id: string;
            task_id: string;
            source_sha: string;
            phase: string;
            generation: number;
            active_release_id: string | null;
            snapshot: unknown;
            snapshot_digest: string;
          }[]
        >`SELECT r.owner_id,r.task_id,s.head_sha AS source_sha,r.phase,t.generation,t.active_release_id,r.snapshot,r.snapshot_digest FROM delivery_release_targets t JOIN delivery_releases r ON r.target_digest=t.target_digest JOIN delivery_source_revisions s ON s.id=r.source_revision_id AND s.owner_id=r.owner_id WHERE t.target_digest=${request.targetDigest} AND r.id=${request.releaseId}::uuid FOR UPDATE OF t,r`;
        const row = rows[0],
          now = await clock(tx);
        if (
          signal.aborted ||
          !row ||
          row.owner_id !== request.ownerId ||
          row.task_id !== request.taskId ||
          row.source_sha !== request.sourceSha ||
          (row.phase !== "active" &&
            !(
              row.phase === "held" &&
              (request.operation === "read_plan" ||
                request.operation === "report" ||
                (request.operation === "observe" &&
                  ["compatible", "certificate"].includes(request.action)) ||
                (request.operation === "authorize" &&
                  ["begin", "read", "certificate"].includes(request.action)))
            )) ||
          row.active_release_id !== request.releaseId ||
          row.generation !== request.generation ||
          request.targetDigest !== catalog.targetDigest ||
          authorityExpiry <= now ||
          githubSourceDigest(row.snapshot) !== row.snapshot_digest ||
          githubSourceDigest(this.catalog(catalog.id, now)) !== githubSourceDigest(catalog)
        )
          return fail();
        await this.source(tx, request, catalog, request);
        if (request.dispatchStage)
          await this.automaticAction(tx, request, catalog, request.dispatchStage);
        const accepted = await acceptedDatabasePlan(tx, request, catalog),
          pin =
            compatibility &&
            "kind" in compatibility &&
            compatibility.kind === "automatic-source-build"
              ? {
                  ...z
                    .object({
                      database: z
                        .object({
                          phase: z.literal("plan_intent"),
                          catalogDigest: hash,
                          planDigest: hash,
                        })
                        .passthrough(),
                    })
                    .passthrough()
                    .parse(row.snapshot).database,
                  planEventId: accepted.id,
                }
              : z.object({ database: databasePin }).passthrough().parse(row.snapshot).database;
        if (
          accepted.id !== request.planEventId ||
          pin.planEventId !== accepted.id ||
          pin.planDigest !==
            (compatibility &&
            "kind" in compatibility &&
            compatibility.kind === "automatic-source-build"
              ? githubSourceDigest(sourcePlanIntent(accepted.manifest.plan))
              : accepted.planDigest) ||
          pin.catalogDigest !== accepted.catalogDigest
        )
          return fail();
        const plan = accepted.manifest.plan,
          scope = databaseScope(catalog);
        let data: Record<string, unknown>;
        if (request.operation === "read_plan")
          data = {
            plan,
            scope,
            planDigest: accepted.planDigest,
            runId: accepted.id,
            compatibility: accepted.manifest.compatibility,
          };
        else if (request.operation === "authorize")
          data = {
            scopeDigest: githubSourceDigest(scope),
            planDigest: accepted.planDigest,
            runId: accepted.id,
            action: request.action,
            expiresAt: Math.min(now + 20000, authorityExpiry, catalog.expiresAt),
            authorityDigest: githubSourceDigest({
              request,
              catalog: accepted.catalogDigest,
              lease: {
                releaseId: request.releaseId,
                targetDigest: request.targetDigest,
                generation: row.generation,
              },
              workflow: identity.workflowDigest,
            }),
          };
        else if (request.operation === "observe")
          data = await this.deployment.observe(tx, {
            request,
            catalog,
            plan,
            planDigest: accepted.planDigest,
            signal,
          });
        else {
          const observation = databaseObservationSchema.parse(request.observation);
          if (
            observation.runId !== accepted.id ||
            observation.planDigest !== accepted.planDigest ||
            observation.scopeDigest !== githubSourceDigest(scope) ||
            observation.sourceSha !== request.sourceSha ||
            observation.beforeSchemaDigest !== plan.beforeSchemaDigest ||
            observation.afterSchemaDigest !== plan.afterSchemaDigest ||
            observation.oldAppDigest !== plan.oldAppDigest ||
            observation.newAppDigest !== plan.newAppDigest ||
            observation.compatibilityDigest !== plan.compatibilityDigest
          )
            return fail();
          if (
            observation.kind &&
            (observation.observedAt! > now + 1000 ||
              observation.expiresAt! <= now ||
              observation.expiresAt! > observation.observedAt! + 30000 ||
              githubSourceDigest(observation.scope) !== githubSourceDigest(scope) ||
              !observation.integrity ||
              observation.integrity.schemaDigest !== plan.afterSchemaDigest)
          )
            return fail();
          const aggregateKey = `database-observation/${request.requestId}`,
            prior = await tx.deliveryEvent.findUnique({
              where: {
                ownerId_aggregateKey_aggregateVersion: {
                  ownerId: request.ownerId,
                  aggregateKey,
                  aggregateVersion: 1,
                },
              },
            });
          if (prior && prior.requestDigest !== githubSourceDigest(request)) return fail();
          const event =
            prior ??
            (await tx.deliveryEvent.create({
              data: {
                id: randomUUID(),
                ownerId: request.ownerId,
                taskId: request.taskId,
                aggregateKey,
                aggregateVersion: 1,
                schemaVersion: 1,
                policyVersion: `database/${catalog.id}`,
                type: "database_job_observed",
                requestDigest: githubSourceDigest(request),
                payload: {
                  request,
                  catalogDigest: accepted.catalogDigest,
                  workflowDigest: identity.workflowDigest,
                  jtiDigest: identity.jtiDigest,
                  observedAt: now,
                  expiresAt: Math.min(
                    now + 20000,
                    authorityExpiry,
                    observation.expiresAt ?? now + 20000,
                    catalog.expiresAt,
                  ),
                } as Prisma.InputJsonValue,
              },
            }));
          data = {
            observationId: event.id,
            observationDigest: githubSourceDigest(observation),
            executionAuthorized: false,
            activationAuthorized: false,
          };
        }
        const end = await clock(tx);
        if (signal.aborted || authorityExpiry <= end || catalog.expiresAt <= end) return fail();
        const response = this.response(request, catalog, end, authorityExpiry, data);
        if (
          compatibility &&
          "kind" in compatibility &&
          compatibility.kind === "automatic-source-build" &&
          request.operation === "authorize"
        )
          await recordDatabaseSqlAuthority(tx, this.repositoryPolicies, request, catalog, response);
        const finalNow = await clock(tx);
        if (
          signal.aborted ||
          authorityExpiry <= finalNow ||
          catalog.expiresAt <= finalNow ||
          response.expiresAt <= finalNow
        )
          return fail();
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
    );
  }
}

/** Recheck a short-lived job observation at the D09 effect boundary. The caller
 * must supply an independent deployment verifier; a plan's asserted test digest
 * or a job report alone is never deployment authority. */
export async function verifyDatabaseCompatibility(
  tx: Tx,
  input: {
    ownerId: string;
    taskId: string;
    sourceSha: string;
    targetDigest: string;
    releaseId: string;
    generation: number;
    planEventId: string;
    observationId: string;
    action: "promote" | "recover";
    catalog: unknown;
    signal: AbortSignal;
  },
  verifyDeployment: (input: {
    observation: z.infer<typeof databaseObservationSchema>;
    plan: z.infer<typeof databasePlanApprovalSchema>["plan"];
    signal: AbortSignal;
  }) => Promise<boolean>,
) {
  const catalog = databaseCatalogSchema.parse(input.catalog);
  const rows = await tx.$queryRaw<
    {
      owner_id: string;
      task_id: string;
      source_sha: string;
      phase: string;
      generation: number;
      active_release_id: string | null;
      snapshot: unknown;
      snapshot_digest: string;
    }[]
  >`
    SELECT r.owner_id,r.task_id,s.head_sha AS source_sha,r.phase,t.generation,t.active_release_id,r.snapshot,r.snapshot_digest
    FROM delivery_release_targets t JOIN delivery_releases r ON r.target_digest=t.target_digest
    JOIN delivery_source_revisions s ON s.id=r.source_revision_id AND s.owner_id=r.owner_id
    WHERE t.target_digest=${input.targetDigest} AND r.id=${input.releaseId}::uuid FOR UPDATE OF t,r`;
  const row = rows[0],
    now = await clock(tx);
  if (
    input.signal.aborted ||
    !row ||
    row.owner_id !== input.ownerId ||
    row.task_id !== input.taskId ||
    row.source_sha !== input.sourceSha ||
    row.phase !== (input.action === "recover" ? "held" : "active") ||
    row.active_release_id !== input.releaseId ||
    row.generation !== input.generation ||
    catalog.ownerId !== input.ownerId ||
    catalog.targetDigest !== input.targetDigest ||
    catalog.validFrom > now ||
    catalog.expiresAt <= now ||
    githubSourceDigest(row.snapshot) !== row.snapshot_digest
  )
    return fail();
  const accepted = await acceptedDatabasePlan(tx, input, catalog);
  const pin = z.object({ database: databasePin }).passthrough().parse(row.snapshot).database;
  if (
    accepted.id !== input.planEventId ||
    pin.planEventId !== accepted.id ||
    pin.planDigest !== accepted.planDigest ||
    pin.catalogDigest !== accepted.catalogDigest
  )
    return fail();
  const event = await tx.deliveryEvent.findUnique({ where: { id: input.observationId } });
  if (
    !event ||
    event.ownerId !== input.ownerId ||
    event.taskId !== input.taskId ||
    event.type !== "database_job_observed" ||
    !event.payload
  )
    return fail();
  const evidence = z
    .object({
      request: databaseJobRequestSchema,
      catalogDigest: hash,
      workflowDigest: hash,
      jtiDigest: hash,
      observedAt: z.number().int().safe(),
      expiresAt: z.number().int().safe(),
    })
    .strict()
    .parse(event.payload);
  const request = evidence.request,
    observation = databaseObservationSchema.parse(request.observation);
  if (
    githubSourceDigest(request) !== event.requestDigest ||
    evidence.catalogDigest !== accepted.catalogDigest ||
    evidence.workflowDigest !==
      githubSourceDigest({ ref: catalog.workflowRef, sha: catalog.workflowSha }) ||
    evidence.observedAt > now + 1000 ||
    evidence.expiresAt <= now ||
    evidence.expiresAt > evidence.observedAt + 30000 ||
    request.operation !== "report" ||
    request.ownerId !== input.ownerId ||
    request.taskId !== input.taskId ||
    request.sourceSha !== input.sourceSha ||
    request.targetDigest !== input.targetDigest ||
    request.releaseId !== input.releaseId ||
    request.generation !== input.generation ||
    request.planEventId !== accepted.id ||
    observation.kind !== "database_compatibility_observation" ||
    observation.phase !== "verified" ||
    observation.runId !== accepted.id ||
    observation.planDigest !== accepted.planDigest ||
    observation.scopeDigest !== githubSourceDigest(databaseScope(catalog)) ||
    observation.sourceSha !== input.sourceSha ||
    observation.expiresAt! <= now ||
    !observation.integrity ||
    observation.integrity.schemaDigest !== accepted.manifest.plan.afterSchemaDigest
  )
    return fail();
  if (
    !(await verifyDeployment({ observation, plan: accepted.manifest.plan, signal: input.signal }))
  )
    return fail();
  const end = await clock(tx);
  if (
    input.signal.aborted ||
    evidence.expiresAt <= end ||
    observation.expiresAt! <= end ||
    catalog.expiresAt <= end
  )
    return fail();
  return {
    observationId: event.id,
    observationDigest: githubSourceDigest(observation),
    checkpointDigest: observation.checkpointDigest,
    expiresAt: Math.min(evidence.expiresAt, observation.expiresAt!),
  };
}

/** Resolve the newest report for this lease. Verification remains mandatory;
 * a newer non-ready report cannot be bypassed by selecting an older success. */
export async function latestDatabaseObservationId(
  tx: Tx,
  input: {
    ownerId: string;
    taskId: string;
    releaseId: string;
    generation: number;
    planEventId: string;
  },
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM delivery_events
    WHERE owner_id=${input.ownerId}::uuid AND task_id=${input.taskId}::uuid
      AND type='database_job_observed'
      AND payload->'request'->>'releaseId'=${input.releaseId}
      AND payload->'request'->>'generation'=${String(input.generation)}
      AND payload->'request'->>'planEventId'=${input.planEventId}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (rows.length !== 1) return fail();
  return rows[0].id;
}
