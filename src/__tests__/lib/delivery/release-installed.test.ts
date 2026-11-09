import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, expect, it } from "vitest";
import { createInstalledReleaseController } from "@/lib/delivery/release-installed.server";
import { createInstalledReleaseTestStore } from "@/lib/delivery/release-tested-installed.server";

const db = new PrismaClient({ datasourceUrl: "postgresql://unused@127.0.0.1:1/hive_release_test" });
afterAll(() => db.$disconnect());
const flags = {
  HIVE_DELIVERY_RELEASE_ENABLED: "true",
  HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED: "true",
  HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "true",
  HIVE_NATIVE_MODE: "production",
  HIVE_NATIVE_PRODUCTION_ACTIVE: "true",
};
it("keeps publication disabled before owner/native production configuration", () => {
  expect(createInstalledReleaseController(db, {})).toBeNull();
  expect(createInstalledReleaseTestStore(db, {})).toBeNull();
  expect(() =>
    createInstalledReleaseController(db, {
      HIVE_DELIVERY_RELEASE_ENABLED: "true",
      HIVE_DELIVERY_RELEASE_CONFIG_JSON: "{}",
    }),
  ).toThrow("release_controller_unavailable");
});
it("rejects legacy publisher/token configuration without reading credentials or performing provider IO", () => {
  const env: Record<string, string | undefined> = {
    ...flags,
    HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify({
      target: { hiveReleaseWriter: true },
      build: { publisherConfigDigest: "f".repeat(64) },
    }),
  };
  for (const key of [
    "HIVE_DELIVERY_RELEASE_GITHUB_TOKEN",
    "HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN",
    "HIVE_DELIVERY_RELEASE_ANALYTICS_TOKEN",
  ])
    Object.defineProperty(env, key, {
      get() {
        throw Error("Legacy credentials must never be read");
      },
    });
  const fetcher: typeof fetch = async () => {
    throw Error("No provider IO during selection");
  };
  expect(() => createInstalledReleaseController(db, env, fetcher)).toThrow(
    "release_controller_unavailable",
  );
  expect(() => createInstalledReleaseTestStore(db, env, fetcher)).toThrow(
    "release_test_unavailable",
  );
});
it("installs only connected automatic Builds and its credential-free tested-tree producer", () => {
  const config = {
    mode: "automatic-main-builds",
    policy: {
      schemaVersion: 1,
      purpose: "automatic_production",
      versionId: randomUUID(),
      ownerId: randomUUID(),
      repositoryId: "1",
      providerAccountId: "2",
      baseBranch: "main",
      method: "squash",
      validFrom: Date.now() - 1000,
      expiresAt: Date.now() + 600000,
      cutoverApproval: {
        id: randomUUID(),
        approvedBy: "explicit owner fixture",
        approvedAt: Date.now() - 2000,
      },
      pipelineUsage: "existing-connected-builds",
    },
    target: { accountId: "a".repeat(32), worker: "hive", origin: "https://hive.example.invalid" },
    risk: { owner: "test", name: "repo", allowedPrefixes: ["src/"] },
    observation: { windowMs: 1000 },
    tested: {
      workflow: {
        audiencePrefix: "urn:hive:release-tested:installed:",
        repositoryId: "1",
        repositoryOwnerId: "2",
        workflowRef: `test/repo/.github/workflows/test.yml@${"1".repeat(40)}`,
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
    },
  };
  const env = { ...flags, HIVE_DELIVERY_RELEASE_CONFIG_JSON: JSON.stringify(config) },
    fetcher: typeof fetch = async () => {
      throw Error("No provider IO during construction");
    };
  const controller = createInstalledReleaseController(db, env, fetcher);
  expect(controller?.scheduler).toBeDefined();
  expect(controller?.builds).toBeNull();
  expect(createInstalledReleaseTestStore(db, env, fetcher)).not.toBeNull();
  expect(
    createInstalledReleaseController(
      db,
      { ...env, HIVE_NATIVE_PRODUCTION_ACTIVE: "false" },
      fetcher,
    ),
  ).toBeNull();
  expect(
    createInstalledReleaseTestStore(
      db,
      { ...env, HIVE_DELIVERY_RELEASE_TESTED_ENABLED: "false" },
      fetcher,
    ),
  ).toBeNull();
});
