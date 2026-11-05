import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import databaseStore from "../../../../src/lib/delivery/database-job-store.server.ts";

const { DatabaseJobStore } = databaseStore;

import { digest } from "../../src/delivery/contracts.mjs";

const h = (v) => v.repeat(64),
  image = (v) => `registry.example/app@sha256:${h(v)}`;
test("approval requires the exact completed GitHub compatibility job and artifact bindings", async () => {
  const id = randomUUID(),
    sha = "a".repeat(40);
  const plan = {
    sourceSha: sha,
    oldAppDigest: h("b"),
    newAppDigest: h("c"),
    compatibilityDigest: h("d"),
  };
  const config = {
    schemaVersion: 1,
    kind: "workerd",
    catalogId: id,
    planDigest: digest(plan),
    sourceSha: sha,
    postgresImage: image("e"),
    oldAuthDigest: h("1"),
    newAuthDigest: h("2"),
    oldArtifactUrl: "https://example.com/old",
    newArtifactUrl: "https://example.com/new",
    scenarioPath: "scripts/release/compatibility/reviewed.mjs",
    scenarioDigest: h("f"),
    compatibilityDate: "2026-10-29",
    oldAppDigest: plan.oldAppDigest,
    newAppDigest: plan.newAppDigest,
    compatibilityDigest: plan.compatibilityDigest,
  };
  const jobName = `call / fixed-database-compatibility-${digest(config)}`;
  const catalog = {
    id,
    dispatcherSha: sha,
    repositoryId: "42",
    compatibilityTest: {
      config,
      repositoryOwner: "owner",
      repositoryName: "repo",
      workflowId: "5",
      jobName,
    },
  };
  const request = {
    sourceSha: sha,
    plan,
    compatibility: { mixedVersionChecksDigest: digest(config) },
    githubRunId: "12",
    githubRunAttempt: 1,
  };
  let conclusion = "success";
  const fetcher = async (url) =>
    String(url).includes("/jobs?")
      ? Response.json({
          total_count: 1,
          jobs: [{ run_id: 12, run_attempt: 1, name: jobName, status: "completed", conclusion }],
        })
      : Response.json({
          id: 12,
          run_attempt: 1,
          workflow_id: 5,
          event: "workflow_dispatch",
          head_sha: sha,
          repository: { id: 42 },
          head_repository: { id: 42 },
        });
  const store = new DatabaseJobStore({}, {}, () => [], "", {}, fetcher, "read-only-fixture");
  await store.verifyCompatibilityTest(request, catalog, new AbortController().signal);
  conclusion = "failure";
  await assert.rejects(
    store.verifyCompatibilityTest(request, catalog, new AbortController().signal),
  );
  conclusion = "success";
  await assert.rejects(
    store.verifyCompatibilityTest(
      { ...request, plan: { ...plan, newAppDigest: h("9") } },
      catalog,
      new AbortController().signal,
    ),
  );
});
