import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { githubSourceDigest as digest } from "@/lib/delivery/github-evidence.server";
import { GitHubDatabaseJobProvider } from "@/lib/delivery/release-database-github-provider.server";
import { deriveSourceBuildApproval } from "../../../../services/migrate/src/delivery/source-build-approval.mjs";
import { sourcePlanIntent } from "../../../../services/migrate/src/delivery/source-plan-intent.mjs";
import { databaseCatalogSchema } from "../../../../services/migrate/src/delivery/wire.mjs";

function fixture() {
  const hash = (s: string) => s.repeat(64),
    sha = (s: string) => s.repeat(40),
    now = Date.now();
  const plan = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: sha("a"),
    oldAppDigest: hash("b"),
    newAppDigest: hash("c"),
    compatibilityDigest: hash("d"),
    beforeSchemaDigest: hash("e"),
    afterSchemaDigest: hash("f"),
    batchSize: 10,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 100,
    schemaSql: "SELECT 1",
    expandSql: ["SELECT 1"],
    highWaterSql: "SELECT 1",
    batchSql: "SELECT 1",
    integritySql: "SELECT 1",
    integrityTables: [{ schema: "public", name: "fixture" }],
  };
  const id = randomUUID(),
    config = {
      schemaVersion: 2,
      kind: "automatic-source-build",
      catalogId: id,
      planIntentDigest: digest(sourcePlanIntent(plan)),
      recipeSha: sha("e"),
      toolchain: { node: "24.21.0", pnpm: "10.32.1" },
      sourceSha: plan.sourceSha,
      compatibilityDigest: plan.compatibilityDigest,
      postgresImage: `registry.example/db@sha256:${hash("a")}`,
      baseline: {
        sourceSha: sha("b"),
        treeSha: sha("c"),
        providerBuildUuid: randomUUID(),
        branch: "main",
      },
      candidate: {
        headSha: plan.sourceSha,
        baseSha: sha("b"),
        mergeSha: sha("d"),
        treeSha: sha("e"),
        policyDigest: hash("1"),
        checksDigest: hash("2"),
        controlDigest: hash("3"),
      },
      scenarioPath: "scripts/release/compatibility/fixed.mjs",
      scenarioDigest: hash("4"),
      compatibilityDate: "2026-10-29",
    };
  const catalog = databaseCatalogSchema.parse({
    schemaVersion: 1,
    id,
    ownerId: randomUUID(),
    repositoryId: "1",
    repositoryOwnerId: "2",
    environmentKey: "production",
    targetDigest: hash("9"),
    targetId: randomUUID(),
    databaseName: "fixture",
    databaseHost: "localhost",
    databasePort: 5432,
    workflowRef: `test/repo/.github/workflows/controlled-database-job.yml@${sha("f")}`,
    workflowSha: sha("f"),
    dispatcherSha: sha("e"),
    branchRef: "refs/heads/database-dispatch",
    authorityOrigin: "https://hive.example",
    authorityPublicKeyPem: "fixture-public-key".repeat(4),
    validFrom: now - 1000,
    expiresAt: now + 60000,
    automaticPlan: sourcePlanIntent(plan),
    automaticExecutionEnabled: true,
    compatibilityTest: {
      config,
      repositoryOwner: "test",
      repositoryName: "repo",
      workflowId: "12",
      jobName: `Automatic database / fixed-database-compatibility-${digest(config)}`,
    },
  });
  const releaseId = randomUUID(),
    request = {
      schemaVersion: 1,
      purpose: "automatic-database-job",
      dispatchId: randomUUID(),
      issuedAt: now,
      stage: "approve",
      ownerId: catalog.ownerId,
      taskId: randomUUID(),
      releaseId,
      targetDigest: catalog.targetDigest,
      generation: 1,
      sourceSha: plan.sourceSha,
      catalogDigest: digest(catalog),
      planDigest: digest(sourcePlanIntent(plan)),
      planEventId: null,
    };
  const identity = {
    id: randomUUID(),
    releaseId,
    targetDigest: catalog.targetDigest,
    kind: "database_job",
    request,
    requestDigest: digest(request),
    generation: 1,
  };
  const run = {
    id: 123,
    run_attempt: 1,
    workflow_id: 12,
    event: "workflow_dispatch",
    head_sha: catalog.dispatcherSha,
    head_branch: "database-dispatch",
    display_title: `hive-database/${request.dispatchId}/approve`,
    status: "completed",
    conclusion: "success",
    repository: { id: 1 },
    head_repository: { id: 1 },
  };
  const state = {
    writes: 0,
    loseAck: false,
    branchSha: catalog.dispatcherSha,
    duplicates: false,
    jobConclusion: "success",
    compatibilityOnly: false,
  };
  const fetcher: typeof fetch = async (input, options) => {
    const u = new URL(String(input));
    expect(u.origin).toBe("https://api.github.com");
    expect(options?.redirect).toBe("manual");
    if (u.pathname.endsWith("/dispatches")) {
      state.writes++;
      const body = JSON.parse(String(options?.body));
      expect(body.inputs.operation).toBe("database");
      expect(body.inputs["database-stage"]).toBe("approve");
      expect(JSON.parse(body.inputs["database-approval-json"]).dispatchId).toBe(request.dispatchId);
      expect(body.inputs).not.toHaveProperty("DATABASE_URL");
      if (state.loseAck) throw Error("Provider accepted but204 ACK lost");
      return new Response(null, { status: 204 });
    }
    if (u.pathname.includes("/git/ref/"))
      return Response.json({ object: { type: "commit", sha: state.branchSha } });
    if (u.pathname.endsWith("/actions/workflows/12"))
      return Response.json({ id: 12, path: ".github/workflows/ci.yml", state: "active" });
    if (u.pathname.endsWith("/actions/runs/123/attempts/1")) return Response.json(run);
    if (u.pathname.endsWith("/runs")) {
      expect(u.searchParams.get("created")).toMatch(/^>=20/);
      return Response.json({
        total_count: state.duplicates ? 2 : 1,
        workflow_runs: state.duplicates ? [run, { ...run, id: 124 }] : [run],
      });
    }
    if (u.pathname.endsWith("/jobs"))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            run_id: 123,
            run_attempt: 1,
            name: state.compatibilityOnly
              ? catalog.compatibilityTest?.jobName
              : "Automatic database / fixed-database-approval",
            status: "completed",
            conclusion: state.jobConclusion,
          },
        ],
      });
    throw Error("Unexpected provider path");
  };
  return {
    catalog,
    config,
    identity,
    run,
    state,
    provider: new GitHubDatabaseJobProvider(catalog, "fixture-connected-token", fetcher),
    signal: AbortSignal.timeout(5000),
  };
}
it("treats204 as pending and recovers a lost acknowledgement through attributed read-only lookup", async () => {
  const f = fixture();
  expect(await f.provider.dispatch(f.identity, f.signal, Date.now() + 5000)).toEqual({
    pending: true,
    reference: { provider: "github-actions", dispatchId: f.identity.request.dispatchId },
  });
  expect(f.state.writes).toBe(1);
  expect((await f.provider.lookup(f.identity, null, f.signal))?.evidence).toMatchObject({
    runId: "123",
    dispatchId: f.identity.request.dispatchId,
    stage: "approve",
  });
  expect(f.state.writes).toBe(1);
  const lost = fixture();
  lost.state.loseAck = true;
  await expect(
    lost.provider.dispatch(lost.identity, lost.signal, Date.now() + 5000),
  ).rejects.toThrow("ACK lost");
  expect(await lost.provider.lookup(lost.identity, null, lost.signal)).not.toBeNull();
  expect(lost.state.writes).toBe(1);
});
it("denies stale branch/deadline/opt-in before writes and rejects ambiguous/wrong-source/skipped receipts", async () => {
  const f = fixture();
  await expect(f.provider.dispatch(f.identity, f.signal, Date.now() - 1)).rejects.toThrow();
  f.state.branchSha = "0".repeat(40);
  await expect(f.provider.dispatch(f.identity, f.signal, Date.now() + 5000)).rejects.toThrow();
  expect(f.state.writes).toBe(0);
  const off = new GitHubDatabaseJobProvider(
    { ...f.catalog, automaticExecutionEnabled: false },
    "fixture",
    async () => {
      throw Error("Must not access provider");
    },
  );
  await expect(off.dispatch(f.identity, f.signal, Date.now() + 5000)).rejects.toThrow();
  const good = fixture();
  good.state.duplicates = true;
  expect(await good.provider.lookup(good.identity, null, good.signal)).toBeNull();
  good.state.duplicates = false;
  good.run.head_sha = "0".repeat(40);
  await expect(good.provider.lookup(good.identity, null, good.signal)).rejects.toThrow();
  good.run.head_sha = good.catalog.dispatcherSha;
  good.state.jobConclusion = "skipped";
  await expect(good.provider.lookup(good.identity, null, good.signal)).rejects.toThrow();
  expect(good.state.writes).toBe(0);
});

it("corroborates only completed compatibility while its protected approval job is still running", async () => {
  const f = fixture();
  f.state.compatibilityOnly = true;
  f.run.status = "in_progress";
  f.run.conclusion = null as unknown as string;
  const request = {
    schemaVersion: 1,
    purpose: "approve_database_plan",
    githubRunId: "123",
    githubRunAttempt: 1,
    ...deriveSourceBuildApproval(
      f.catalog,
      {
        catalogId: f.catalog.id,
        ownerId: f.catalog.ownerId,
        taskId: f.identity.request.taskId,
        sourceSha: f.identity.request.sourceSha,
        dispatchId: f.identity.request.dispatchId,
        planIntent: f.catalog.automaticPlan,
      },
      {
        schemaVersion: 1,
        kind: "source-build-output",
        intentDigest: digest(f.catalog.automaticPlan),
        configDigest: digest(f.config),
        recipeSha: f.config.recipeSha,
        oldAppDigest: "b".repeat(64),
        newAppDigest: "c".repeat(64),
        oldArchiveDigest: "a".repeat(64),
        newArchiveDigest: "d".repeat(64),
      },
    ),
  };
  expect(await f.provider.verifyCompatibility(request, f.signal)).toMatchObject({
    verified: true,
    runId: "123",
  });
  expect(await f.provider.lookup(f.identity, null, f.signal)).toBeNull();
  for (const changed of [
    { ...request, plan: { ...request.plan, newAppDigest: "0".repeat(64) } },
    { ...request, plan: { ...request.plan, expandSql: ["DROP TABLE unrelated"] } },
    {
      ...request,
      compatibility: {
        ...request.compatibility,
        actualSourceBuild: {
          ...request.compatibility.actualSourceBuild,
          intentDigest: "0".repeat(64),
        },
      },
    },
    { ...request, githubRunId: "124" },
  ])
    await expect(f.provider.verifyCompatibility(changed, f.signal)).rejects.toThrow();
  f.state.jobConclusion = "skipped";
  await expect(f.provider.verifyCompatibility(request, f.signal)).rejects.toThrow();
  expect(f.state.writes).toBe(0);
});
