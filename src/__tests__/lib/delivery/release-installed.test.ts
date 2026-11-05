import { PrismaClient } from "@hive/db";
import { afterAll, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";

const db = new PrismaClient({ datasourceUrl: "postgresql://unused@127.0.0.1:1/hive_release_test" });
afterAll(() => db.$disconnect());
it("keeps the installed controller off unless configuration and independent authority are complete", () => {
  expect(createInstalledReleaseController(db, {})).toBeNull();
  expect(() =>
    createInstalledReleaseController(db, {
      HIVE_DELIVERY_RELEASE_ENABLED: "true",
      HIVE_DELIVERY_RELEASE_CONFIG_JSON: "{}",
    }),
  ).toThrow();
});

it("requires an independently enrolled tested-tree producer for the preview controller", () => {
  const target = {
    accountId: "a".repeat(32),
    environment: "preview",
    scripts: { app: "preview-app", auth: "preview-auth" },
    hiveReleaseWriter: true,
  };
  const item = {
    deploymentId: "00000000-0000-4000-8000-000000000001",
    versionId: "00000000-0000-4000-8000-000000000002",
    sourceSha: "b".repeat(40),
    artifactDigest: "c".repeat(64),
    configDigest: "d".repeat(64),
  };
  const riskCatalog = { owner: "test", name: "repo", allowedPrefixes: ["src/"] };
  const config = {
    target,
    github: { repositoryId: "1", owner: "test", name: "repo", allowedBaseRef: "preview" },
    build: {
      publisherConfigDigest: "f".repeat(64),
      workflow: {
        audiencePrefix: "urn:hive:release-build:preview:",
        repositoryId: "1",
        repositoryOwnerId: "2",
        workflowRef: "test/repo/.github/workflows/upload.yml@refs/heads/preview",
        workflowSha: "1".repeat(40),
        branchRef: "refs/heads/preview",
      },
      run: { repositoryId: "1", owner: "test", name: "repo", workflowId: "3" },
    },
    authority: {
      targetDigest: githubSourceDigest(target),
      riskCatalogDigest: githubSourceDigest(riskCatalog),
      mergeMethod: "squash",
      baselines: {
        app: item,
        auth: {
          ...item,
          deploymentId: "00000000-0000-4000-8000-000000000003",
          versionId: "00000000-0000-4000-8000-000000000004",
        },
      },
    },
    riskCatalog,
    observation: {
      origin: "https://preview.example.invalid",
      minimumRequests: 1,
      maxErrorRate: 0,
      settleDelayMs: 60000,
    },
  };
  const env = {
    HIVE_DELIVERY_RELEASE_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify(config),
    HIVE_DELIVERY_RELEASE_GITHUB_TOKEN: "fixture",
    HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN: "fixture",
    HIVE_DELIVERY_RELEASE_ANALYTICS_TOKEN: "fixture",
    HIVE_RELEASE_PROBE_SECRET: "e".repeat(64),
    PREVIEW_BEARER: "f".repeat(64),
  };
  expect(() => createInstalledReleaseController(db, env)).toThrow("release_test_unavailable");
  const tested = {
    workflow: {
      audiencePrefix: "urn:hive:release-tested:preview:",
      repositoryId: "1",
      repositoryOwnerId: "2",
      workflowRef: "test/repo/.github/workflows/test.yml@refs/heads/preview",
      workflowSha: "1".repeat(40),
      controlDigest: "a".repeat(64),
    },
    run: {
      repositoryId: "1",
      owner: "test",
      name: "repo",
      workflowId: "4",
      testJobName: "fixed-tested-tree",
    },
  };
  const installedEnv = {
    ...env,
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify({
      ...config,
      authority: { ...config.authority, tested },
    }),
  };
  const controller = createInstalledReleaseController(db, installedEnv, async () => {
    throw Error("unexpected I/O");
  });
  expect(controller?.facts).toBeDefined();
  expect(controller?.scheduler).toBeDefined();
  expect(() =>
    createInstalledReleaseController(db, {
      ...installedEnv,
      HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "false",
    }),
  ).toThrow("release_test_attestation_unavailable");
  expect(() =>
    createInstalledReleaseController(db, {
      ...env,
      HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify({
        ...config,
        authority: { ...config.authority, riskCatalogDigest: "0".repeat(64) },
      }),
    }),
  ).toThrow();
});
