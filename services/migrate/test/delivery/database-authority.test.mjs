import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { approveInstalledDatabasePlan } from "../../src/delivery/approve-plan.mjs";
import { digest } from "../../src/delivery/contracts.mjs";
import { assertDatabaseAuthority } from "../../src/delivery/database-authority.mjs";
import { runInstalledDatabaseJob } from "../../src/delivery/installed-job.mjs";
import { sourcePlanIntent } from "../../src/delivery/source-plan-intent.mjs";
import { databaseCatalogSchema } from "../../src/delivery/wire.mjs";

function fixture() {
  const hash = "a".repeat(64),
    sha = "b".repeat(40),
    recipe = "c".repeat(40),
    id = randomUUID(),
    owner = randomUUID(),
    key = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
  const plan = sourcePlanIntent({
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: sha,
    oldAppDigest: hash,
    newAppDigest: hash,
    compatibilityDigest: hash,
    beforeSchemaDigest: hash,
    afterSchemaDigest: hash,
    batchSize: 1,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 100,
    schemaSql: "SELECT 1",
    expandSql: ["SELECT 1"],
    highWaterSql: "SELECT 1",
    batchSql: "SELECT 1",
    integritySql: "SELECT 1",
    integrityTables: [{ schema: "public", name: "fixture" }],
  });
  const config = {
    schemaVersion: 2,
    kind: "automatic-source-build",
    catalogId: id,
    planIntentDigest: digest(plan),
    recipeSha: recipe,
    toolchain: { node: "24.21.0", pnpm: "10.32.1" },
    sourceSha: sha,
    compatibilityDigest: hash,
    postgresImage: `example/db@sha256:${hash}`,
    baseline: { sourceSha: sha, treeSha: sha, providerBuildUuid: randomUUID(), branch: "main" },
    candidate: {
      headSha: sha,
      baseSha: sha,
      mergeSha: sha,
      treeSha: sha,
      policyDigest: hash,
      checksDigest: hash,
      controlDigest: hash,
    },
    scenarioPath: "scripts/release/compatibility/fixed.mjs",
    scenarioDigest: hash,
    compatibilityDate: "2026-10-29",
  };
  const catalog = databaseCatalogSchema.parse({
    schemaVersion: 1,
    id,
    ownerId: owner,
    repositoryId: "1",
    repositoryOwnerId: "2",
    environmentKey: "production",
    targetDigest: hash,
    targetId: randomUUID(),
    databaseName: "production",
    databaseHost: "db.example.invalid",
    databasePort: 5432,
    workflowRef: `test/repo/.github/workflows/controlled-database-job.yml@${sha}`,
    workflowSha: sha,
    dispatcherSha: sha,
    branchRef: "refs/heads/dispatch",
    authorityOrigin: "https://hive.example.invalid",
    authorityPublicKeyPem: key,
    validFrom: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    automaticPlan: plan,
    automaticExecutionEnabled: true,
    compatibilityTest: {
      config,
      repositoryOwner: "test",
      repositoryName: "repo",
      workflowId: "1",
      jobName: "fixed-database-compatibility",
    },
  });
  const enrolled = {
    ownerId: owner,
    repositoryId: "1",
    origin: catalog.authorityOrigin,
    publicKeyPem: key,
    targetDigest: hash,
    databaseHost: catalog.databaseHost,
    databasePort: 5432,
    databaseName: catalog.databaseName,
  };
  return { catalog, enrolled, recipe };
}
test("source-owned authority enrollment rejects caller origin/key/target/owner/recipe substitutions before OIDC or SQL credentials", async () => {
  const { catalog, enrolled, recipe } = fixture();
  assert.doesNotThrow(() => assertDatabaseAuthority(catalog, recipe, [enrolled]));
  const key = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const { automaticPlan: _intent, automaticExecutionEnabled: _enabled, ...legacy } = catalog;
  const image = `example/local@sha256:${"a".repeat(64)}`;
  legacy.compatibilityTest = {
    ...catalog.compatibilityTest,
    config: {
      schemaVersion: 1,
      catalogId: catalog.id,
      planDigest: "a".repeat(64),
      sourceSha: "b".repeat(40),
      postgresImage: image,
      oldImage: image,
      newImage: image,
      scenarioImage: image,
      oldAppDigest: "a".repeat(64),
      newAppDigest: "a".repeat(64),
      compatibilityDigest: "a".repeat(64),
    },
  };
  databaseCatalogSchema.parse(legacy);
  let fetches = 0,
    credentials = 0;
  for (const [changed, manifest, revision] of [
    [catalog, [], recipe],
    [legacy, [enrolled], recipe],
    [catalog, [enrolled], "f".repeat(40)],
    [{ ...catalog, authorityOrigin: "https://attacker.example.invalid" }, [enrolled], recipe],
    [{ ...catalog, authorityPublicKeyPem: key }, [enrolled], recipe],
    [{ ...catalog, ownerId: randomUUID() }, [enrolled], recipe],
    [{ ...catalog, repositoryId: "3" }, [enrolled], recipe],
    [{ ...catalog, databaseHost: "other.example.invalid" }, [enrolled], recipe],
    [{ ...catalog, databaseName: "other" }, [enrolled], recipe],
    [{ ...catalog, targetDigest: "f".repeat(64) }, [enrolled], recipe],
  ]) {
    const env = {
      HIVE_DELIVERY_DATABASE_ENABLED: "true",
      HIVE_DATABASE_JOB_PURPOSE: "automatic-source-build",
      HIVE_DELIVERY_DATABASE_CATALOG_JSON: JSON.stringify(changed),
      HIVE_DELIVERY_DATABASE_JOB_JSON: "{}",
      HIVE_DELIVERY_DATABASE_APPROVAL_JSON: "{}",
    };
    Object.defineProperty(env, "DATABASE_URL", {
      get() {
        credentials++;
        throw Error("Must not read SQL credentials");
      },
    });
    const fetcher = async () => {
        fetches++;
        throw Error("Must not request OIDC");
      },
      authorityEnrollment = { recipeSha: revision, manifest };
    await assert.rejects(
      runInstalledDatabaseJob({ env, fetcher, authorityEnrollment }),
      /not_enrolled/,
    );
    await assert.rejects(
      approveInstalledDatabasePlan({ env, fetcher, authorityEnrollment }),
      /not_enrolled/,
    );
  }
  assert.equal(fetches, 0);
  assert.equal(credentials, 0);
  // Installed CLI/default behavior uses only the source-owned empty manifest.
  const env = {
    HIVE_DELIVERY_DATABASE_ENABLED: "true",
    HIVE_DATABASE_TRUSTED_RECIPE_SHA: recipe,
    HIVE_DELIVERY_DATABASE_CATALOG_JSON: JSON.stringify(catalog),
    HIVE_DELIVERY_DATABASE_JOB_JSON: "{}",
  };
  await assert.rejects(
    runInstalledDatabaseJob({
      env,
      fetcher: async () => {
        fetches++;
        throw Error("Never");
      },
    }),
    /authority_not_enrolled/,
  );
  assert.equal(fetches, 0);
});
