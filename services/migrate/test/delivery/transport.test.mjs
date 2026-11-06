import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { approveInstalledDatabasePlan } from "../../src/delivery/approve-plan.mjs";
import { digest } from "../../src/delivery/contracts.mjs";
import { databaseOidcAudience, signDatabaseResponse } from "../../src/delivery/wire.mjs";

test("protected approval binds the OIDC audience and signed response to the exact plan", async () => {
  const keys = generateKeyPairSync("ed25519"),
    now = Date.now(),
    hash = "a".repeat(64),
    sourceSha = "b".repeat(40);
  const catalog = {
    schemaVersion: 1,
    id: randomUUID(),
    ownerId: randomUUID(),
    repositoryId: "123",
    repositoryOwnerId: "456",
    environmentKey: "test",
    targetDigest: hash,
    targetId: randomUUID(),
    databaseName: "hive_d10_test",
    databaseHost: "localhost",
    databasePort: 5432,
    workflowRef: "owner/repo/.github/workflows/job.yml@refs/heads/main",
    workflowSha: sourceSha,
    dispatcherSha: sourceSha,
    branchRef: "refs/heads/main",
    authorityOrigin: "https://authority.example",
    authorityPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    validFrom: now - 1000,
    expiresAt: now + 60000,
  };
  const plan = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha,
    oldAppDigest: hash,
    newAppDigest: hash,
    compatibilityDigest: hash,
    beforeSchemaDigest: hash,
    afterSchemaDigest: hash,
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
  const approval = {
    catalogId: catalog.id,
    ownerId: catalog.ownerId,
    taskId: randomUUID(),
    sourceSha,
    plan,
    compatibility: {
      contractDigest: hash,
      mixedVersionChecksDigest: hash,
      databaseEnforcedInvariantDigest: hash,
    },
  };
  const env = {
    HIVE_DELIVERY_DATABASE_ENABLED: "true",
    HIVE_DELIVERY_DATABASE_CATALOG_JSON: JSON.stringify(catalog),
    HIVE_DELIVERY_DATABASE_APPROVAL_JSON: JSON.stringify(approval),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
  };
  let audience;
  const fetcher = async (url, options) => {
    if (url.startsWith("https://token.actions.githubusercontent.com/")) {
      audience = new URL(url).searchParams.get("audience");
      return Response.json({ value: "fixture.jwt.token" });
    }
    const request = JSON.parse(options.body);
    assert.equal(audience, databaseOidcAudience(request));
    assert.equal(request.plan.sourceSha, sourceSha);
    return Response.json(
      signDatabaseResponse(
        {
          schemaVersion: 1,
          purpose: "database_job_response",
          catalogId: catalog.id,
          requestDigest: digest(request),
          observedAt: now,
          expiresAt: now + 20000,
          data: { planEventId: randomUUID() },
        },
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      ),
    );
  };
  assert.match(
    (await approveInstalledDatabasePlan({ env, fetcher })).planEventId,
    /^[a-f0-9-]{36}$/,
  );
  await assert.rejects(
    approveInstalledDatabasePlan({
      env: {
        ...env,
        HIVE_DELIVERY_DATABASE_CATALOG_JSON: JSON.stringify({ ...catalog, ownerId: randomUUID() }),
      },
      fetcher,
    }),
    /scope_changed/,
  );
});
