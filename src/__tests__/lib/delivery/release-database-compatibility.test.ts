import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { releaseDatabaseCompatibility } from "@/lib/delivery/release-database-compatibility.server";

const mocks = vi.hoisted(() => ({ latest: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/delivery/database-job-store.server", () => ({
  latestDatabaseObservationId: mocks.latest,
  verifyDatabaseCompatibility: mocks.verify,
}));

it("binds independent compatibility verification to enrolled catalog and both release artifacts", async () => {
  const ownerId = randomUUID(),
    taskId = randomUUID(),
    releaseId = randomUUID(),
    planEventId = randomUUID();
  const targetDigest = "a".repeat(64),
    oldDigest = "b".repeat(64),
    newDigest = "c".repeat(64);
  const catalog = {
    schemaVersion: 1,
    id: randomUUID(),
    ownerId,
    repositoryId: "1",
    repositoryOwnerId: "2",
    environmentKey: "preview",
    targetDigest,
    targetId: randomUUID(),
    databaseName: "test",
    databaseHost: "test.invalid",
    databasePort: 5432,
    workflowRef: "test",
    workflowSha: "a".repeat(40),
    dispatcherSha: "b".repeat(40),
    branchRef: "refs/heads/preview",
    authorityOrigin: "https://test.invalid",
    authorityPublicKeyPem: "x".repeat(64),
    validFrom: 1,
    expiresAt: Date.now() + 60000,
  };
  const baseline = {
    deploymentId: randomUUID(),
    versionId: randomUUID(),
    sourceSha: "a".repeat(40),
    artifactDigest: oldDigest,
    configDigest: "d".repeat(64),
  };
  const component = {
    script: "app",
    versionId: randomUUID(),
    artifactDigest: newDigest,
    configDigest: "d".repeat(64),
    providerScriptHash: "test",
  };
  const manifest = {
    schemaVersion: 1,
    releaseId,
    ownerId,
    repositoryId: "1",
    repositoryOwnerId: "2",
    mergeSha: "b".repeat(40),
    targetDigest,
    runId: "1",
    runAttempt: 1,
    app: component,
    auth: { ...component, script: "auth" },
  };
  const evidence = {
    status: "completed",
    conclusion: "success",
    manifestDigest: githubSourceDigest(manifest),
  };
  Object.assign(catalog, {
    compatibilityTest: {
      repositoryOwner: "test",
      repositoryName: "repo",
      workflowId: "1",
      jobName: "test",
      config: {
        schemaVersion: 1,
        kind: "workerd",
        catalogId: catalog.id,
        planDigest: "e".repeat(64),
        sourceSha: "c".repeat(40),
        oldAppDigest: oldDigest,
        newAppDigest: newDigest,
        oldAuthDigest: oldDigest,
        newAuthDigest: newDigest,
        compatibilityDigest: "d".repeat(64),
        postgresImage: `postgres@sha256:${"f".repeat(64)}`,
        oldArtifactUrl: "https://test.invalid/old",
        newArtifactUrl: "https://test.invalid/new",
        scenarioPath: "scripts/release/compatibility/test.mjs",
        scenarioDigest: "f".repeat(64),
        compatibilityDate: "2026-10-29",
      },
    },
  });
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ now: new Date() }])
      .mockResolvedValueOnce([
        {
          snapshot: { baselines: { app: baseline, auth: baseline } },
          manifest,
          manifest_digest: githubSourceDigest(manifest),
          evidence,
          evidence_digest: githubSourceDigest(evidence),
        },
      ]),
  };
  const context = {
    ownerId,
    taskId,
    sourceSha: "c".repeat(40),
    identity: { kind: "promote", releaseId, targetDigest, generation: 1 },
    database: {
      catalogDigest: githubSourceDigest(catalog),
      planEventId,
      planDigest: "e".repeat(64),
    },
  };
  mocks.latest.mockResolvedValue(randomUUID());
  let observedOld = oldDigest;
  mocks.verify.mockImplementation(async (_tx, _scope, verify) => {
    if (
      !(await verify({
        observation: { oldAppDigest: observedOld, newAppDigest: newDigest },
        plan: {},
        signal: new AbortController().signal,
      }))
    )
      throw Error("unverified");
  });
  const independent = vi.fn().mockResolvedValue(true);
  expect(
    await releaseDatabaseCompatibility(() => [catalog], independent)(tx as never, context as never),
  ).toBe(true);
  expect(independent).toHaveBeenCalledOnce();
  tx.$queryRaw.mockResolvedValueOnce([{ now: new Date() }]).mockResolvedValueOnce([
    {
      snapshot: { baselines: { app: baseline, auth: baseline } },
      manifest,
      manifest_digest: githubSourceDigest(manifest),
      evidence,
      evidence_digest: githubSourceDigest(evidence),
    },
  ]);
  observedOld = "f".repeat(64);
  expect(
    await releaseDatabaseCompatibility(() => [catalog], independent)(tx as never, context as never),
  ).toBe(false);
  expect(independent).toHaveBeenCalledOnce();
});
