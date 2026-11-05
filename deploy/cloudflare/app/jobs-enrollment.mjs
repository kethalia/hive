import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { validateRuntimeDatabase } from "./deployment-plan.mjs";

/** Read current policy under the scoped preview runtime role. The credential is
 * passed only in the child environment, never in argv or diagnostic output. */
export function readJobsEnrollment(runtimeUrl, record, now = new Date(), run = spawnSync) {
  validateRuntimeDatabase(runtimeUrl);
  const url = new URL(runtimeUrl);
  assert.ok(url.password, "Preview runtime password required");
  // Neon poolers reject statement_timeout at connection startup. The exact
  // validated pooler maps to its corresponding direct endpoint on the same
  // branch; no user-supplied host or search-path setting is accepted.
  const directHost = url.hostname.replace("-pooler.", ".");
  assert.equal(record.deliveryPilotCandidate.repositoryPolicies.length, 1);
  const [entry] = record.deliveryPilotCandidate.repositoryPolicies;
  assert.match(entry.ownerId, /^[a-f0-9-]{36}$/);
  for (const v of [entry.repositoryId, entry.providerAccountId])
    assert.match(v, /^[1-9][0-9]{0,19}$/);
  assert.match(entry.fullName, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/);
  for (const v of [record.repositoryPolicyDigest, record.repositoryCatalogDigest])
    assert.match(v, /^[a-f0-9]{64}$/);
  const sql = `SELECT json_build_object('databaseName',current_database(),'runtimeRole',current_user,'ownerId',p.owner_id,'repositoryId',p.repository_id,'providerAccountId',p.provider_account_id,'fullName',p.full_name,'policyVersionId',v.id,'policyDigest',v.policy_digest,'catalogDigest',v.catalog_digest,'active',(p.active_version_id=v.id),'revoked',(p.revoked_at IS NOT NULL OR v.revoked_at IS NOT NULL)) FROM delivery_repository_policies p JOIN delivery_repository_policy_versions v ON v.owner_id=p.owner_id AND v.project_id=p.project_id AND v.policy_id=p.id AND v.id=p.active_version_id WHERE p.owner_id='${entry.ownerId}'::uuid AND p.repository_id='${entry.repositoryId}' AND p.provider_account_id='${entry.providerAccountId}' AND p.full_name='${entry.fullName}'`;
  const result = run("/usr/bin/psql", ["-X", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      PGHOST: directHost,
      PGPORT: "5432",
      PGUSER: "hive_app_runtime",
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: "hive_app_preview",
      PGSSLMODE: "require",
      PGCHANNELBINDING: url.searchParams.has("channel_binding") ? "require" : "prefer",
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=5000",
      PGCONNECT_TIMEOUT: "5",
    },
  });
  assert.equal(result.status, 0, "Preview policy read unavailable");
  const output = result.stdout.trim();
  assert.ok(output, "Exactly one active enrollment required");
  const lines = output.split("\n");
  assert.equal(lines.length, 1, "Exactly one active enrollment required");
  const row = JSON.parse(lines[0]);
  assert.equal(row.databaseName, "hive_app_preview");
  assert.equal(row.runtimeRole, "hive_app_runtime");
  assert.equal(row.ownerId, entry.ownerId);
  assert.equal(row.repositoryId, entry.repositoryId);
  assert.equal(row.providerAccountId, entry.providerAccountId);
  assert.equal(row.fullName, entry.fullName);
  return { ...row, verifiedReadOnlyDatabase: true, observedAt: now.toISOString() };
}
