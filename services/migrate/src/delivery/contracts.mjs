import { createHash } from "node:crypto";
export class MigrationHeld extends Error {
  constructor(reason) {
    super(reason);
    this.name = "MigrationHeld";
  }
}
export const requireValue = (v, reason = "migration_scope_changed") => {
  if (!v) throw new MigrationHeld(reason);
};
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v) =>
  typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact = (v, keys) =>
  requireValue(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join() === keys.sort().join(),
    "migration_contract_invalid",
  );
const sql = (v) =>
  requireValue(
    typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 32768,
    "migration_sql_artifact_invalid",
  );
export function validateScope(v) {
  exact(v, ["ownerId", "repositoryId", "environmentKey", "targetId", "databaseName"]);
  requireValue(
    uuid(v.ownerId) &&
      uuid(v.targetId) &&
      /^[1-9][0-9]{0,19}$/.test(v.repositoryId) &&
      /^[A-Za-z0-9_.:-]{1,100}$/.test(v.environmentKey) &&
      /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v.databaseName),
  );
  return structuredClone(v);
}
/** Deployment-verified artifact only. No model/HTTP caller can provide SQL or a
 * connection URL. SQL review and artifact authentication occur before this API. */
export function validatePlan(v) {
  exact(v, [
    "schemaVersion",
    "id",
    "sourceSha",
    "oldAppDigest",
    "newAppDigest",
    "compatibilityDigest",
    "beforeSchemaDigest",
    "afterSchemaDigest",
    "batchSize",
    "statementTimeoutMs",
    "lockTimeoutMs",
    "schemaSql",
    "expandSql",
    "highWaterSql",
    "batchSql",
    "integritySql",
    "integrityTables",
  ]);
  requireValue(v.schemaVersion === 1 && uuid(v.id) && /^[a-f0-9]{40}$/.test(v.sourceSha));
  for (const k of [
    "oldAppDigest",
    "newAppDigest",
    "compatibilityDigest",
    "beforeSchemaDigest",
    "afterSchemaDigest",
  ])
    requireValue(sha(v[k]));
  requireValue(
    Number.isInteger(v.batchSize) &&
      v.batchSize >= 1 &&
      v.batchSize <= 1000 &&
      Number.isInteger(v.statementTimeoutMs) &&
      v.statementTimeoutMs >= 100 &&
      v.statementTimeoutMs <= 5000 &&
      Number.isInteger(v.lockTimeoutMs) &&
      v.lockTimeoutMs >= 10 &&
      v.lockTimeoutMs <= 1000,
  );
  requireValue(
    Array.isArray(v.integrityTables) &&
      v.integrityTables.length > 0 &&
      v.integrityTables.length <= 16,
  );
  for (const table of v.integrityTables) {
    exact(table, ["schema", "name"]);
    requireValue(
      /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table.schema) &&
        /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table.name),
    );
  }
  requireValue(
    new Set(v.integrityTables.map((t) => `${t.schema}.${t.name}`)).size ===
      v.integrityTables.length,
  );
  requireValue(Array.isArray(v.expandSql) && v.expandSql.length > 0 && v.expandSql.length <= 16);
  for (const statement of [...v.expandSql, v.schemaSql, v.highWaterSql, v.batchSql, v.integritySql])
    sql(statement);
  requireValue(Buffer.byteLength(JSON.stringify(v)) <= 131072);
  return structuredClone(v);
}
export function decimal(v) {
  requireValue(
    typeof v === "string" && /^(0|[1-9][0-9]{0,18})$/.test(v),
    "migration_cursor_invalid",
  );
  const n = BigInt(v);
  requireValue(n <= 9223372036854775807n, "migration_cursor_invalid");
  return n;
}
export function authorizeReceipt(receipt, expected, now) {
  exact(receipt, ["scopeDigest", "planDigest", "runId", "action", "expiresAt", "authorityDigest"]);
  requireValue(
    receipt.scopeDigest === expected.scopeDigest &&
      receipt.planDigest === expected.planDigest &&
      receipt.runId === expected.runId &&
      uuid(receipt.runId) &&
      receipt.action === expected.action &&
      sha(receipt.authorityDigest) &&
      Number.isSafeInteger(receipt.expiresAt) &&
      receipt.expiresAt > now &&
      receipt.expiresAt <= now + 30000,
    "migration_authority_unavailable",
  );
  return receipt;
}
export function deploymentReceipt(receipt, expected, now) {
  exact(receipt, [
    "kind",
    "targetId",
    "runId",
    "sourceSha",
    "planDigest",
    "schemaDigest",
    "oldAppDigest",
    "newAppDigest",
    "compatibilityDigest",
    "observedAt",
    "expiresAt",
    "receiptDigest",
  ]);
  for (const k of Object.keys(expected))
    requireValue(receipt[k] === expected[k], "migration_deployment_scope_changed");
  requireValue(
    sha(receipt.receiptDigest) &&
      Number.isSafeInteger(receipt.observedAt) &&
      receipt.observedAt <= now &&
      now - receipt.observedAt <= 30000 &&
      Number.isSafeInteger(receipt.expiresAt) &&
      receipt.expiresAt > now &&
      receipt.expiresAt <= now + 30000,
    "migration_deployment_receipt_stale",
  );
  return receipt;
}
