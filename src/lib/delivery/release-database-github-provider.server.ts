import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { databaseCatalogSchema } from "../../../services/migrate/src/delivery/wire.mjs";
import { githubSourceDigest } from "./github-evidence.server";
import { releaseActionIdentitySchema } from "./release-action-journal";
import {
  automaticDatabaseActionSchema,
  automaticDatabaseReceipt,
  automaticDatabaseRunSchema,
} from "./release-database-actions";

const providerId = z.number().int().positive().safe();
const runSchema = z
  .object({
    id: providerId,
    run_attempt: providerId,
    workflow_id: providerId,
    event: z.literal("workflow_dispatch"),
    head_sha: z.string(),
    head_branch: z.string(),
    display_title: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    repository: z.object({ id: providerId }),
    head_repository: z.object({ id: providerId }),
  })
  .passthrough();
// This purpose has its own strict identity until the forward journal migration is installed.
const identitySchema = releaseActionIdentitySchema
  .innerType()
  .extend({ kind: z.literal("database_job") })
  .strict();
const fail = (): never => {
  throw Error("database_dispatch_unavailable");
};

/** One journaled dispatch to the EXISTING pinned CI dispatcher. A 204 is only
 * pending; recovery observes its unique run title and never dispatches again. */
export class GitHubDatabaseJobProvider {
  private readonly catalog: z.infer<typeof databaseCatalogSchema>;
  constructor(
    rawCatalog: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.catalog = databaseCatalogSchema.parse(rawCatalog);
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) fail();
  }
  private scope(raw: unknown) {
    const identity = identitySchema.parse(raw),
      request = automaticDatabaseActionSchema.parse(identity.request),
      c = this.catalog,
      test = c.compatibilityTest;
    if (!test || !("kind" in test.config) || test.config.kind !== "automatic-source-build")
      return fail();
    if (
      githubSourceDigest(identity.request) !== identity.requestDigest ||
      request.releaseId !== identity.releaseId ||
      request.targetDigest !== identity.targetDigest ||
      request.generation !== identity.generation ||
      c.automaticExecutionEnabled !== true ||
      request.catalogDigest !== githubSourceDigest(c) ||
      request.ownerId !== c.ownerId ||
      request.targetDigest !== c.targetDigest ||
      request.sourceSha !== c.automaticPlan?.sourceSha ||
      request.planDigest !== githubSourceDigest(c.automaticPlan)
    )
      fail();
    return { identity, request, catalog: c, test };
  }
  private async request(path: string, signal: AbortSignal, body?: unknown) {
    const c = this.catalog,
      test = c.compatibilityTest;
    if (!test) return fail();
    signal.throwIfAborted();
    const response = await this.fetcher(
      `https://api.github.com/repos/${test.repositoryOwner}/${test.repositoryName}${path}`,
      {
        method: body ? "POST" : "GET",
        redirect: "manual",
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    signal.throwIfAborted();
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      !response.ok ||
      /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? "")
    )
      return fail();
    return response;
  }
  private title(dispatchId: string, stage: string) {
    return `hive-database/${dispatchId}/${stage}`;
  }
  async dispatch(raw: unknown, signal: AbortSignal, authorityExpiresAt: number) {
    const { request: r, catalog: c, test } = this.scope(raw);
    const deadline = () => {
      signal.throwIfAborted();
      const now = Date.now();
      if (
        r.issuedAt > now ||
        now < c.validFrom ||
        now >= c.expiresAt ||
        now >= authorityExpiresAt ||
        !Number.isSafeInteger(authorityExpiresAt)
      )
        fail();
    };
    deadline();
    const branch = c.branchRef.slice("refs/heads/".length);
    const ref = z
      .object({ object: z.object({ type: z.literal("commit"), sha: z.literal(c.dispatcherSha) }) })
      .passthrough()
      .parse(
        await boundedReleaseJson(
          await this.request(
            `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
            signal,
          ),
          65536,
          signal,
        ),
      );
    if (!ref) return fail();
    const workflow = z
      .object({
        id: providerId,
        path: z.literal(".github/workflows/ci.yml"),
        state: z.literal("active"),
      })
      .passthrough()
      .parse(
        await boundedReleaseJson(
          await this.request(`/actions/workflows/${test.workflowId}`, signal),
          65536,
          signal,
        ),
      );
    if (String(workflow.id) !== test.workflowId) return fail();
    deadline();
    const plan = c.automaticPlan;
    if (!plan) return fail();
    const approval = {
      catalogId: c.id,
      ownerId: r.ownerId,
      taskId: r.taskId,
      sourceSha: r.sourceSha,
      dispatchId: r.dispatchId,
      plan,
      compatibility: {
        contractDigest: plan.compatibilityDigest,
        mixedVersionChecksDigest: githubSourceDigest(test.config),
        databaseEnforcedInvariantDigest: githubSourceDigest({
          schemaDigest: plan.afterSchemaDigest,
          sql: plan.integritySql,
          tables: plan.integrityTables,
        }),
      },
    };
    const job = {
      catalogId: c.id,
      ownerId: r.ownerId,
      taskId: r.taskId,
      sourceSha: r.sourceSha,
      dispatchId: r.dispatchId,
      releaseId: r.releaseId,
      targetDigest: r.targetDigest,
      generation: r.generation,
      planEventId: r.planEventId,
    };
    const response = await this.request(
      `/actions/workflows/${test.workflowId}/dispatches`,
      signal,
      {
        ref: branch,
        inputs: {
          operation: "database",
          "database-stage": r.stage,
          "database-dispatch-id": r.dispatchId,
          "database-trusted-revision": c.workflowSha,
          "database-catalog-json": JSON.stringify(c),
          "database-approval-json": JSON.stringify(approval),
          "database-job-json": JSON.stringify(job),
          "database-compatibility-digest": githubSourceDigest(test.config),
        },
      },
    );
    if (response.status !== 204) return fail();
    return {
      pending: true as const,
      reference: { provider: "github-actions", dispatchId: r.dispatchId },
    };
  }
  async lookup(raw: unknown, reference: unknown, signal: AbortSignal) {
    const { identity, request: r, catalog: c, test } = this.scope(raw);
    if (reference !== null) {
      const ref = z
        .object({ provider: z.literal("github-actions"), dispatchId: z.literal(r.dispatchId) })
        .strict()
        .safeParse(reference);
      if (!ref.success) return fail();
    }
    const listed = z
      .object({
        total_count: z.number().int().min(0).max(99),
        workflow_runs: z.array(runSchema).max(99),
      })
      .passthrough()
      .parse(
        await boundedReleaseJson(
          await this.request(
            `/actions/workflows/${test.workflowId}/runs?event=workflow_dispatch&branch=${encodeURIComponent(c.branchRef.slice(11))}&created=${encodeURIComponent(`>=${new Date(r.issuedAt - 1000).toISOString()}`)}&per_page=100&page=1`,
            signal,
          ),
          1048576,
          signal,
        ),
      );
    if (listed.total_count !== listed.workflow_runs.length) return fail();
    const matches = listed.workflow_runs.filter(
      (run) => run.display_title === this.title(r.dispatchId, r.stage),
    );
    if (matches.length !== 1) return null;
    const run = matches[0];
    if (
      String(run.workflow_id) !== test.workflowId ||
      run.head_sha !== c.dispatcherSha ||
      run.head_branch !== c.branchRef.slice(11) ||
      String(run.repository.id) !== c.repositoryId ||
      String(run.head_repository.id) !== c.repositoryId ||
      run.run_attempt !== 1
    )
      return fail();
    if (run.status !== "completed") return null;
    if (run.conclusion !== "success") return fail();
    const jobs = z
      .object({
        total_count: z.number().int().min(1).max(99),
        jobs: z
          .array(
            z
              .object({
                run_id: providerId,
                run_attempt: providerId,
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
        await boundedReleaseJson(
          await this.request(
            `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=1`,
            signal,
          ),
          1048576,
          signal,
        ),
      );
    const expectedName = `fixed-database-${r.stage === "approve" ? "approval" : r.stage}`;
    const exact = jobs.jobs.filter(
      (job) => job.name === expectedName || job.name.endsWith(` / ${expectedName}`),
    );
    if (
      jobs.total_count !== jobs.jobs.length ||
      exact.length !== 1 ||
      exact[0].run_id !== run.id ||
      exact[0].run_attempt !== run.run_attempt ||
      exact[0].status !== "completed" ||
      exact[0].conclusion !== "success"
    )
      return fail();
    const evidence = automaticDatabaseRunSchema.parse({
      provider: "github-actions",
      dispatchId: r.dispatchId,
      stage: r.stage,
      runId: String(run.id),
      runAttempt: run.run_attempt,
      workflowId: test.workflowId,
      dispatcherSha: c.dispatcherSha,
      catalogDigest: r.catalogDigest,
      planDigest: r.planDigest,
      sourceSha: r.sourceSha,
    });
    return automaticDatabaseReceipt(identity.requestDigest, evidence);
  }
}
