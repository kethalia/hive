import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { createReleaseController } from "@/lib/delivery/release-controller.server";
import type { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";

const db = new PrismaClient({ datasourceUrl: "postgresql://unused@127.0.0.1:1/hive_release_test" });
afterAll(() => db.$disconnect());
const deps = {
  repositoryPolicies: {} as RepositoryPolicyStore,
  policies: () => [],
  verifyCurrent: async () => false,
  verifyOpening: async () => false,
  verifyBeforeMerge: async () => false,
  verifyMerged: async () => false,
};
const config = {
  target: {
    accountId: "a".repeat(32),
    environment: "preview",
    scripts: { app: "fixture-app", auth: "fixture-auth" },
    hiveReleaseWriter: true,
  },
  github: { repositoryId: "1", owner: "fixture", name: "repo", allowedBaseRef: "preview" },
  build: {
    publisherConfigDigest: "f".repeat(64),
    workflow: {
      audiencePrefix: "urn:hive:release-build:preview:",
      repositoryId: "1",
      repositoryOwnerId: "2",
      workflowRef: "trusted/build/.github/workflows/upload.yml@refs/tags/v1",
      workflowSha: "1".repeat(40),
      branchRef: "refs/heads/preview",
    },
    run: { repositoryId: "1", owner: "fixture", name: "repo", workflowId: "99" },
  },
  observation: {
    origin: "https://preview.example.invalid",
    minimumRequests: 1,
    maxErrorRate: 0,
    settleDelayMs: 60000,
  },
};
const environment = {
  enabled: "true",
  configJson: JSON.stringify(config),
  githubToken: "fixture",
  cloudflareToken: "fixture",
  analyticsToken: "fixture",
  probeSecret: "b".repeat(64),
  previewBearer: "c".repeat(64),
};
describe("configured release controller", () => {
  it("is disabled by default and rejects production configuration", () => {
    expect(createReleaseController(db, {}, deps)).toBeNull();
    expect(() =>
      createReleaseController(
        db,
        {
          ...environment,
          configJson: JSON.stringify({
            ...config,
            target: { ...config.target, environment: "production" },
          }),
        },
        deps,
      ),
    ).toThrow();
    expect(() =>
      createReleaseController(
        db,
        {
          ...environment,
          configJson: JSON.stringify({
            ...config,
            github: { ...config.github, allowedBaseRef: "main" },
          }),
        },
        deps,
      ),
    ).toThrow();
  });
  it("requires configured credentials and composes a preview controller without I/O", () => {
    expect(() =>
      createReleaseController(db, { ...environment, cloudflareToken: "" }, deps),
    ).toThrow();
    expect(createReleaseController(db, environment, deps)).not.toBeNull();
  });
  it("allows an explicitly enabled production config while preview still rejects main", () => {
    const production = {
      ...config,
      target: { ...config.target, environment: "production" },
      github: { ...config.github, allowedBaseRef: "main" },
      build: {
        ...config.build,
        workflow: {
          ...config.build.workflow,
          mode: "production",
          productionEnabled: true,
          branchRef: "refs/heads/main",
        },
      },
    };
    expect(() =>
      createReleaseController(db, { ...environment, configJson: JSON.stringify(production) }, deps),
    ).toThrow();
    expect(
      createReleaseController(
        db,
        { ...environment, productionEnabled: "true", configJson: JSON.stringify(production) },
        deps,
      ),
    ).not.toBeNull();
    expect(() =>
      createReleaseController(
        db,
        {
          ...environment,
          configJson: JSON.stringify({
            ...config,
            github: { ...config.github, allowedBaseRef: "main" },
          }),
        },
        deps,
      ),
    ).toThrow();
  });
});
