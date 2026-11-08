import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect, vi } from "vitest";
import { createInstalledDatabaseJobStore } from "@/lib/delivery/database-job-installed.server";
import { databaseJobRoute } from "@/lib/delivery/database-job-route.server";
import { githubSourceDigest as digest } from "@/lib/delivery/github-evidence.server";
import {
  automaticPreparedSchema,
  automaticReleaseEnrollment,
  automaticReleaseTarget,
} from "@/lib/delivery/release-automatic-contracts";
import {
  automaticReleaseForTask,
  createAutomaticReleaseTestStore,
} from "@/lib/delivery/release-automatic-host.server";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";
import { automaticWorkerHealth } from "../../../../deploy/cloudflare/app/automatic-health";
import { hostProductionRelease } from "../../../../scripts/host-epic-merge";
import { artifactDigest, packReleaseArtifact } from "../../../../scripts/release/artifact.mjs";
import * as authDomain from "../../../../services/auth/src/auth/domain";
import { createFetchAuthHandler } from "../../../../services/auth/src/fetch-handler";
import { approveInstalledDatabasePlan } from "../../../../services/migrate/src/delivery/approve-plan.mjs";
import { runInstalledDatabaseJob } from "../../../../services/migrate/src/delivery/installed-job.mjs";
import { deriveSourceBuildApproval } from "../../../../services/migrate/src/delivery/source-build-approval.mjs";
import { sourcePlanIntent } from "../../../../services/migrate/src/delivery/source-plan-intent.mjs";
import { databaseCatalogSchema } from "../../../../services/migrate/src/delivery/wire.mjs";
import { acceptanceFixtureKey } from "./acceptance-fixture";
import { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";
import { automaticReleaseProviderFixture } from "./release-automatic-provider-fixture";

type Host = { mockImplementation(fn: (...args: any[]) => any): unknown };
type Job = {
  id: number;
  dispatchId: string;
  stage: string;
  inputs: Record<string, string>;
  status: string;
  conclusion: string | null;
  compatibility: string;
  protected: string;
};
/** All storage/SQL, signed workloads, semantic/native seals, source/rules,
 * connected helper and journal machinery are real. Only GitHub HTTP is doubled. */
export async function automaticDatabaseFixture(
  db: PrismaClient,
  url: string,
  host: Host,
  {
    testedLifetimeMs = 600000,
    grantMs = 600000,
    policyLifetimeMs = 600000,
  }: { testedLifetimeMs?: number; grantMs?: number; policyLifetimeMs?: number } = {},
) {
  const f = await verifiedEpicPreviewFixture(db, {
    baseBranch: "main",
    activationRequirement: true,
    productionValidationOnly: true,
  });
  vi.stubEnv("ENCRYPTION_KEY", acceptanceFixtureKey);
  const policy = await db.deliveryRepositoryPolicyVersion.findFirstOrThrow({
    where: { ownerId: f.user.id, projectId: f.project.id },
  });
  vi.stubEnv(
    "HIVE_DELIVERY_REPOSITORY_POLICIES_JSON",
    JSON.stringify([
      {
        ownerId: f.user.id,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: f.project.fullName,
        policy: {
          schemaVersion: 1,
          source: policy.sourcePolicy,
          evidenceGates: policy.evidenceGates,
          acceptanceContracts: policy.acceptanceContracts,
        },
      },
    ]),
  );
  const p = await automaticReleaseProviderFixture(db, f);
  p.config.policy.expiresAt = Date.now() + policyLifetimeMs;
  p.config.risk.databasePrefixes = ["packages/db/prisma/migrations/"];
  p.remote.filename = "packages/db/prisma/migrations/fixture/migration.sql";
  const key = generateKeyPairSync("ed25519"),
    issuer = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    baselineBuild = randomUUID(),
    candidateBuild = randomUUID(),
    catalogId = randomUUID(),
    table = `d10_${randomUUID().replaceAll("-", "")}`;
  await db.$executeRawUnsafe(
    `CREATE TABLE "${table}" (id bigint PRIMARY KEY, value text NOT NULL)`,
  );
  await db.$executeRawUnsafe(`INSERT INTO "${table}" VALUES (1,'one'),(2,'two'),(3,'three')`);
  const schemaSql = `SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position`;
  const before = await db.$queryRawUnsafe<Record<string, unknown>[]>(schemaSql);
  const plan = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: p.source.headSha,
    oldAppDigest: artifactDigest(
      new Map([
        ["app/worker.js", Buffer.from("export default {fetch(){return new Response('old')}}")],
      ]),
      "app",
    ),
    newAppDigest: artifactDigest(
      new Map([
        ["app/worker.js", Buffer.from("export default {fetch(){return new Response('new')}}")],
      ]),
      "app",
    ),
    compatibilityDigest: "a".repeat(64),
    beforeSchemaDigest: digest(before),
    afterSchemaDigest: digest([
      ...before,
      { column_name: "migrated", data_type: "text", is_nullable: "YES" },
    ]),
    batchSize: 2,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 100,
    schemaSql,
    expandSql: [`ALTER TABLE "${table}" ADD COLUMN migrated text`],
    highWaterSql: `SELECT COALESCE(max(id),0)::text AS high_water FROM "${table}"`,
    batchSql: `WITH selected AS (SELECT id FROM "${table}" WHERE id>$1::bigint AND id<=$2::bigint ORDER BY id LIMIT $3), changed AS (UPDATE "${table}" t SET migrated=value FROM selected s WHERE t.id=s.id RETURNING t.id) SELECT id::text AS key FROM changed ORDER BY id`,
    integritySql: `SELECT (count(*) FILTER (WHERE migrated IS DISTINCT FROM value))::text AS violations,count(*)::text AS total_rows FROM "${table}"`,
    integrityTables: [{ schema: "public", name: table }],
  };
  const compatibility = {
    schemaVersion: 2,
    kind: "automatic-source-build",
    catalogId,
    planIntentDigest: digest(sourcePlanIntent(plan)),
    recipeSha: "7".repeat(40),
    toolchain: { node: "24.21.0", pnpm: "10.32.1" },
    sourceSha: plan.sourceSha,
    compatibilityDigest: plan.compatibilityDigest,
    postgresImage: `registry.example/postgres@sha256:${"a".repeat(64)}`,
    baseline: {
      sourceSha: p.remote.baseSha,
      treeSha: "4".repeat(40),
      providerBuildUuid: baselineBuild,
      branch: "main",
    },
    candidate: {
      headSha: p.source.headSha,
      baseSha: p.remote.baseSha,
      mergeSha: p.remote.testMergeSha,
      treeSha: p.remote.treeSha,
      policyDigest: digest(automaticReleaseEnrollment(p.config)),
      checksDigest: digest(policy.evidenceGates),
      controlDigest: p.config.tested.workflow.controlDigest,
    },
    scenarioPath: "scripts/release/compatibility/fixed.mjs",
    scenarioDigest: "5".repeat(64),
    compatibilityDate: "2026-10-29",
  };
  const address = new URL(url),
    dispatcherSha = "9".repeat(40);
  const catalog = databaseCatalogSchema.parse({
    schemaVersion: 1,
    id: catalogId,
    ownerId: f.user.id,
    repositoryId: p.source.repositoryId,
    repositoryOwnerId: p.source.providerAccountId,
    environmentKey: "production",
    targetDigest: automaticReleaseTarget(p.config),
    targetId: randomUUID(),
    databaseName: address.pathname.slice(1),
    databaseHost: address.hostname,
    databasePort: Number(address.port),
    workflowRef: `${p.source.fullName}/.github/workflows/controlled-database-job.yml@${"6".repeat(40)}`,
    workflowSha: "6".repeat(40),
    dispatcherSha,
    branchRef: "refs/heads/database-dispatch",
    authorityOrigin: p.config.target.origin,
    authorityPublicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
    validFrom: Date.now() - 1000,
    expiresAt: Date.now() + 600000,
    automaticPlan: sourcePlanIntent(plan),
    automaticExecutionEnabled: true,
    automaticJobLimit: 8,
    continuationGrants: { enabled: true, maxCount: 4, maxLifetimeMs: 600000, grantMs },
    compatibilityTest: {
      config: compatibility,
      repositoryOwner: p.config.risk.owner,
      repositoryName: p.config.risk.name,
      workflowId: "99",
      jobName: `Automatic database / fixed-database-compatibility-${digest(compatibility)}`,
    },
  });
  const env = {
    NODE_ENV: "test" as const,
    HIVE_DELIVERY_RELEASE_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
    HIVE_NATIVE_MODE: "production",
    HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify(p.config),
    HIVE_DELIVERY_DATABASE_ENABLED: "true",
    HIVE_DELIVERY_DATABASE_CATALOGS_JSON: JSON.stringify([catalog]),
    HIVE_DELIVERY_DATABASE_SIGNING_KEY: key.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    DATABASE_URL: url,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const jobs: Job[] = [],
    followups: (() => Promise<void>)[] = [];
  const state = {
    activeJob: null as Job | null,
    wrongDb: false,
    droppedReport: false,
    reportCalls: 0,
    expireWorkloadRead: false,
    expireFinalMetadata: false,
    crossedPolicy: false,
    lastStoreFailure: "",
  };
  const run = (job: Job) => ({
    id: job.id,
    run_attempt: 1,
    workflow_id: 99,
    event: "workflow_dispatch",
    head_sha: dispatcherSha,
    head_branch: "database-dispatch",
    display_title: `hive-database/${job.dispatchId}/${job.stage}`,
    status: job.status,
    conclusion: job.conclusion,
    repository: { id: Number(p.source.repositoryId) },
    head_repository: { id: Number(p.source.repositoryId) },
  });
  const workloadToken = (audience: string) => {
    const job = state.activeJob;
    if (!job) throw Error("No active controlled job");
    const now = Math.floor(Date.now() / 1000),
      encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: audience,
      repository_id: catalog.repositoryId,
      repository_owner_id: catalog.repositoryOwnerId,
      sha: dispatcherSha,
      ref: catalog.branchRef,
      event_name: "workflow_dispatch",
      run_id: String(job.id),
      run_attempt: "1",
      job_workflow_ref: catalog.workflowRef,
      job_workflow_sha: catalog.workflowSha,
      jti: randomUUID(),
      iat: now - 1,
      nbf: now - 1,
      exp: now + 60,
    };
    const frame = `${encode({ alg: "RS256", kid: "database" })}.${encode(claims)}`;
    return `${frame}.${sign("RSA-SHA256", Buffer.from(frame), issuer.privateKey).toString("base64url")}`;
  };
  const authEnv = {
    ENCRYPTION_KEY: acceptanceFixtureKey,
    COOKIE_SECRET: "b".repeat(64),
    HIVE_CODER_OAUTH_ENABLED: "true",
    CODER_URL: "https://coder.example.invalid",
    HIVE_PUBLIC_ORIGIN: p.config.target.origin,
    HIVE_CODER_OAUTH_CLIENT_ID: "fixture-client",
    HIVE_CODER_OAUTH_CLIENT_SECRET: "fixture-client-secret",
  };
  const fetcher: typeof fetch = async (raw, init) => {
    const u = new URL(String(raw)),
      path = u.pathname;
    if (u.origin === p.config.target.origin && path.startsWith("/api/delivery/database-jobs/")) {
      const request = new Request(String(raw), init),
        body = JSON.parse(await request.clone().text());
      const store = createInstalledDatabaseJobStore(db, env, fetcher);
      if (store) {
        const job = store.job.bind(store);
        store.job = async (...args) => {
          try {
            return await job(...args);
          } catch (error) {
            state.lastStoreFailure = error instanceof Error ? error.message : "unknown";
            throw error;
          }
        };
      }
      const response = await databaseJobRoute(
        request,
        path.endsWith("/approve") ? "approve" : "job",
        store,
        (work) => followups.push(work),
      );
      if (body.operation === "report") {
        state.reportCalls++;
        if (state.droppedReport) throw Error("Lost report response after commit");
      }
      return response;
    }
    if (u.origin === p.config.target.origin)
      return automaticWorkerHealth(
        new Request(String(raw), init),
        {
          ...env,
          DATABASE_URL: state.wrongDb ? url.replace(address.pathname, "/other_database") : url,
          HIVE_NATIVE_HEALTH_ENABLED: "true",
          HIVE_PUBLIC_ORIGIN: p.config.target.origin,
          HIVE_NATIVE_BUILD_IDENTITY: {
            schemaVersion: 1,
            status: "available",
            provider: "cloudflare-builds",
            sourceSha: p.remote.merged ? p.remote.mergeSha : p.remote.baseSha,
            buildUuid: p.remote.merged ? candidateBuild : baselineBuild,
            branch: "main",
          },
        },
        async () => {
          await db.$queryRaw`SELECT 1`;
          return true;
        },
        async () =>
          (
            await createFetchAuthHandler("a".repeat(64), {
              ...authDomain,
              readAuthenticationReadiness: (options) =>
                authDomain.readAuthenticationReadiness({ ...options, env: authEnv, db }),
            })(
              new Request("https://auth.internal/readiness", {
                headers: { Authorization: `Bearer ${"a".repeat(64)}` },
              }),
            )
          ).ok,
      );
    if (u.origin === "https://token.actions.githubusercontent.com") {
      if (path.endsWith("/jwks")) {
        const original = await p.fetcher(raw, init);
        const j = await original.json();
        return Response.json({
          keys: [
            ...j.keys,
            {
              ...issuer.publicKey.export({ format: "jwk" }),
              kid: "database",
              use: "sig",
              alg: "RS256",
            },
          ],
        });
      }
      return Response.json({ value: workloadToken(u.searchParams.get("audience") ?? "") });
    }
    if (init?.method === "POST" && path.endsWith("/actions/workflows/99/dispatches")) {
      const body = JSON.parse(String(init.body));
      expect(body.inputs.operation).toBe("database");
      jobs.push({
        id: 500 + jobs.length,
        dispatchId: body.inputs["database-dispatch-id"],
        stage: body.inputs["database-stage"],
        inputs: body.inputs,
        status: "in_progress",
        conclusion: null,
        compatibility: "success",
        protected: "in_progress",
      });
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/git/ref/heads/database-dispatch"))
      return Response.json({ object: { type: "commit", sha: dispatcherSha } });
    if (path.endsWith("/git/ref/heads/main"))
      return Response.json({ object: { type: "commit", sha: p.remote.baseSha } });
    if (path.endsWith("/actions/workflows/99"))
      return Response.json({ id: 99, path: ".github/workflows/ci.yml", state: "active" });
    if (path.endsWith("/actions/workflows/99/runs"))
      return Response.json({ total_count: jobs.length, workflow_runs: jobs.map(run) });
    if (path === `/repositories/${p.source.repositoryId}` && state.expireFinalMetadata) {
      state.expireFinalMetadata = false;
      const delay = Math.max(0, p.config.policy.expiresAt - Date.now() + 50) / 1000;
      await db.$executeRaw`SELECT pg_sleep(${delay})`;
      state.crossedPolicy = true;
    }
    const matched = /\/actions\/runs\/(\d+)\/attempts\/1(\/jobs)?$/.exec(path);
    if (matched && Number(matched[1]) >= 500) {
      const job = jobs.find((j) => j.id === Number(matched[1]));
      if (!job) throw Error("Wrong job");
      if (!matched[2]) {
        if (state.expireWorkloadRead) {
          state.expireWorkloadRead = false;
          state.expireFinalMetadata = true;
        }
        return Response.json(run(job));
      }
      return Response.json({
        total_count: 2,
        jobs: [
          {
            run_id: job.id,
            run_attempt: 1,
            name: catalog.compatibilityTest?.jobName,
            status: "completed",
            conclusion: job.compatibility,
          },
          {
            run_id: job.id,
            run_attempt: 1,
            name: `Automatic database / fixed-database-${job.stage === "approve" ? "approval" : job.stage}`,
            status: job.protected === "in_progress" ? "in_progress" : "completed",
            conclusion: job.protected === "in_progress" ? null : job.protected,
          },
        ],
      });
    }
    if (path.endsWith(`/git/commits/${p.remote.baseSha}`))
      return Response.json({
        sha: p.remote.baseSha,
        tree: { sha: compatibility.baseline.treeSha },
      });
    if (path.endsWith(`/git/commits/${p.remote.mergeSha}`))
      return Response.json({ sha: p.remote.mergeSha, tree: { sha: p.remote.treeSha } });
    if (
      path.endsWith(`/commits/${p.remote.baseSha}/check-runs`) ||
      path.endsWith(`/commits/${p.remote.mergeSha}/check-runs`)
    ) {
      const candidate = path.includes(p.remote.mergeSha),
        sourceSha = candidate ? p.remote.mergeSha : p.remote.baseSha,
        buildUuid = candidate ? candidateBuild : baselineBuild;
      return Response.json({
        total_count: 1,
        check_runs: [
          {
            id: candidate ? 77 : 76,
            name: "Workers Builds: hive",
            head_sha: sourceSha,
            app: { id: 85455, slug: "cloudflare-workers-and-pages" },
            external_id: buildUuid,
            status: "completed",
            conclusion: "success",
            details_url: `https://dash.cloudflare.com/${p.config.target.accountId}/workers/services/view/hive/production/builds/${buildUuid}`,
          },
        ],
      });
    }
    return p.fetcher(raw, init);
  };
  vi.stubGlobal("fetch", fetcher);
  host.mockImplementation(async (user, workspace, path, request, options) => {
    expect(path).toBe("/projects/production-release");
    expect(user.id).toBe(f.user.id);
    expect(workspace).toBe(f.host.workspaceId);
    expect(options.expectedBuildId).toBe(f.host.buildId);
    return hostProductionRelease({ request, token: "fixture-connected-account" }, fetcher);
  });
  const signal = AbortSignal.timeout(120000),
    tested = createAutomaticReleaseTestStore(db, p.config, fetcher, testedLifetimeMs);
  const challenge = await tested.challenge(p.testRequest, p.token(p.testRequest), signal),
    { purpose: _purpose, ...rest } = p.testRequest;
  const attestation = { ...rest, purpose: "release_test_attestation", ...challenge };
  await tested.submit(attestation, p.token(attestation), signal);
  const controller = createInstalledReleaseController(db, env, fetcher);
  if (!controller) throw Error("Missing automatic controller");
  const prepared = automaticPreparedSchema.parse(
    await automaticReleaseForTask(
      db,
      p.config,
      { ownerId: f.user.id, taskId: f.taskId },
      { operation: "prepare" },
      signal,
    ),
  );
  const testedDigest = await tested.verifyFresh(f.user.id, f.taskId, prepared.request, signal);
  await controller.opener.tick(signal);
  const release = await db.deliveryRelease.findFirstOrThrow({
    where: { ownerId: f.user.id, taskId: f.taskId, purpose: "automatic_production" },
  });
  const runJob = async (job: Job) => {
    state.activeJob = job;
    const jobEnv = {
      ...env,
      HIVE_DATABASE_JOB_PURPOSE: "automatic-source-build",
      HIVE_DELIVERY_DATABASE_CATALOG_JSON: job.inputs["database-catalog-json"],
      HIVE_DELIVERY_DATABASE_APPROVAL_JSON:
        job.stage === "approve"
          ? JSON.stringify(
              deriveSourceBuildApproval(catalog, JSON.parse(job.inputs["database-approval-json"]), {
                schemaVersion: 1,
                kind: "source-build-output",
                intentDigest: digest(sourcePlanIntent(plan)),
                configDigest: digest(compatibility),
                recipeSha: compatibility.recipeSha,
                oldAppDigest: plan.oldAppDigest,
                newAppDigest: plan.newAppDigest,
                oldArchiveDigest: createHash("sha256")
                  .update(
                    await packReleaseArtifact(
                      new Map([
                        [
                          "app/worker.js",
                          Buffer.from("export default {fetch(){return new Response('old')}}"),
                        ],
                      ]),
                    ),
                  )
                  .digest("hex"),
                newArchiveDigest: createHash("sha256")
                  .update(
                    await packReleaseArtifact(
                      new Map([
                        [
                          "app/worker.js",
                          Buffer.from("export default {fetch(){return new Response('new')}}"),
                        ],
                      ]),
                    ),
                  )
                  .digest("hex"),
              }),
            )
          : job.inputs["database-approval-json"],
      HIVE_DELIVERY_DATABASE_JOB_JSON: job.inputs["database-job-json"],
      GITHUB_RUN_ID: String(job.id),
      GITHUB_RUN_ATTEMPT: "1",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-token",
      ...(job.stage === "activate" ? { HIVE_DELIVERY_DATABASE_JOB_MODE: "activate" } : {}),
    };
    const authorityEnrollment = {
      recipeSha: compatibility.recipeSha,
      manifest: [
        {
          ownerId: catalog.ownerId,
          repositoryId: catalog.repositoryId,
          origin: catalog.authorityOrigin,
          publicKeyPem: catalog.authorityPublicKeyPem,
          targetDigest: catalog.targetDigest,
          databaseHost: catalog.databaseHost,
          databasePort: catalog.databasePort,
          databaseName: catalog.databaseName,
        },
      ],
    };
    try {
      const result =
        job.stage === "approve"
          ? await approveInstalledDatabasePlan({
              env: jobEnv,
              fetcher,
              signal,
              authorityEnrollment,
            })
          : await runInstalledDatabaseJob({ env: jobEnv, fetcher, signal, authorityEnrollment });
      job.status = "completed";
      job.conclusion = "success";
      job.protected = "success";
      return result;
    } catch (error) {
      job.status = "completed";
      job.conclusion = "failure";
      job.protected = "failure";
      if (
        error instanceof Error &&
        error.message === "migration_transport_unavailable" &&
        state.lastStoreFailure
      )
        throw new Error(`${error.message}: ${state.lastStoreFailure}`, { cause: error });
      throw error;
    } finally {
      state.activeJob = null;
    }
  };
  return {
    ...f,
    ...p,
    base: f,
    controller,
    catalog,
    env,
    plan,
    release,
    testedDigest,
    prepared,
    signal,
    fetcher,
    jobs,
    followups,
    state,
    runJob,
    table,
  };
}
