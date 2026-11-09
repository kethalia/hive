import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  authorizeReceipt,
  decimal,
  deploymentReceipt,
  digest,
  validatePlan,
  validateScope,
} from "../../src/delivery/contracts.mjs";
import { createDeliveryMigrationController } from "../../src/delivery/runner.mjs";

const sha = "a".repeat(64);
function plan() {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: "b".repeat(40),
    oldAppDigest: sha,
    newAppDigest: sha,
    compatibilityDigest: sha,
    beforeSchemaDigest: sha,
    afterSchemaDigest: sha,
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
}
const scope = () => ({
  ownerId: randomUUID(),
  targetId: randomUUID(),
  repositoryId: "123",
  environmentKey: "test",
  databaseName: "hive_d10_test",
});
test("disabled controller cannot consult credentials or authority", () => {
  let accessed = false;
  assert.throws(
    () =>
      createDeliveryMigrationController({
        db: {},
        authorize: () => {
          accessed = true;
        },
      }),
    /migration_disabled/,
  );
  assert.equal(accessed, false);
});
test("exact pinned catalog rejects added commands, oversized SQL and invalid batch budgets", () => {
  const p = plan();
  assert.deepEqual(validatePlan(p), p);
  for (const patch of [
    { arbitraryCommand: "yes" },
    { batchSize: 1001 },
    { batchSize: 0 },
    { statementTimeoutMs: 5001 },
    { lockTimeoutMs: 0 },
    { schemaSql: "x".repeat(32769) },
    { expandSql: [] },
  ]) {
    assert.throws(() => validatePlan({ ...p, ...patch }));
  }
  assert.throws(
    () =>
      createDeliveryMigrationController({
        enabled: true,
        db: {},
        scope: scope(),
        plan: p,
        expectedPlanDigest: "0".repeat(64),
        authorize() {},
      }),
    /catalog_unverified/,
  );
  const copy = validatePlan(p);
  copy.expandSql[0] = "changed";
  assert.equal(p.expandSql[0], "SELECT 1");
});
test("scope is exact and contains no connection or authority selector", () => {
  assert.deepEqual(validateScope(scope()).databaseName, "hive_d10_test");
  for (const patch of [
    { databaseUrl: "postgresql://example" },
    { targetId: "-".repeat(36) },
    { databaseName: "other;SELECT" },
    { repositoryId: "0" },
  ])
    assert.throws(() => validateScope({ ...scope(), ...patch }));
});
test("authority cannot change scope/action or extend beyond thirty seconds", () => {
  const expected = { scopeDigest: sha, planDigest: sha, runId: randomUUID(), action: "backfill" },
    now = 100000;
  const r = { ...expected, expiresAt: now + 20000, authorityDigest: sha };
  assert.equal(authorizeReceipt(r, expected, now), r);
  for (const patch of [
    { scopeDigest: "b".repeat(64) },
    { action: "activate" },
    { runId: randomUUID() },
    { expiresAt: now },
    { expiresAt: now + 30001 },
    { executionAuthorized: true },
  ])
    assert.throws(() => authorizeReceipt({ ...r, ...patch }, expected, now));
});
test("deployment observation binds both application versions, target, source and compatibility", () => {
  const expected = {
      kind: "compatible",
      targetId: randomUUID(),
      runId: randomUUID(),
      sourceSha: "a".repeat(40),
      planDigest: sha,
      schemaDigest: sha,
      oldAppDigest: sha,
      newAppDigest: sha,
      compatibilityDigest: sha,
    },
    now = 100000;
  const r = { ...expected, observedAt: now - 1, expiresAt: now + 10000, receiptDigest: sha };
  assert.equal(deploymentReceipt(r, expected, now), r);
  for (const key of [
    "targetId",
    "runId",
    "sourceSha",
    "planDigest",
    "schemaDigest",
    "oldAppDigest",
    "newAppDigest",
    "compatibilityDigest",
  ])
    assert.throws(() => deploymentReceipt({ ...r, [key]: "changed" }, expected, now));
  for (const patch of [
    { observedAt: now + 1 },
    { observedAt: now - 30001 },
    { expiresAt: now },
    { expiresAt: now + 30001 },
  ])
    assert.throws(() => deploymentReceipt({ ...r, ...patch }, expected, now));
});
test("cursor is canonical nonnegative PostgreSQL bigint and digest ignores object key order", () => {
  assert.equal(decimal("9223372036854775807"), 9223372036854775807n);
  for (const value of ["-1", "01", "1.0", "9223372036854775808", 1])
    assert.throws(() => decimal(value));
  assert.equal(digest({ a: 1, b: [2] }), digest({ b: [2], a: 1 }));
});
