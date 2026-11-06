#!/usr/bin/env node
// Isolated loopback PostgreSQL upgrade proof. Never a hosted migration runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd(),
  source = new URL(process.env.HIVE_REPOSITORY_POLICY_TEST_DATABASE_URL ?? "");
assert(
  source.protocol === "postgresql:" &&
    source.hostname === "127.0.0.1" &&
    source.username === "coder" &&
    !source.password &&
    source.pathname === "/hive_delivery_test" &&
    source.port &&
    !source.search &&
    !source.hash,
);
const directory = mkdtempSync(join(tmpdir(), "hive-repository-policy-upgrade-"));
chmodSync(directory, 0o700);
const database = `hive_repository_policy_upgrade_${randomUUID().replaceAll("-", "")}`;
const target = new URL(source);
target.pathname = `/${database}`;
const bin = "/usr/lib/postgresql/17/bin",
  run = (file, args, options = {}) =>
    execFileSync(file, args, { encoding: "utf8", maxBuffer: 33554432, timeout: 60000, ...options });
const psql = (sql) =>
  run(join(bin, "psql"), ["--no-psqlrc", target.href, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const migration = "20261029190000_delivery_repository_policy",
  schema = join(directory, "prisma"),
  original = join(root, "packages/db/prisma");
mkdirSync(join(schema, "migrations"), { recursive: true });
cpSync(join(original, "schema.prisma"), join(schema, "schema.prisma"));
for (const name of readdirSync(join(original, "migrations"))) {
  if (
    name === "migration_lock.toml" ||
    name === "0_init" ||
    (name < migration && /^\d{14}_/.test(name))
  )
    cpSync(join(original, "migrations", name), join(schema, "migrations", name), {
      recursive: true,
    });
}
const paths = [
  "packages/db/prisma/schema.prisma",
  `packages/db/prisma/migrations/${migration}/migration.sql`,
  "scripts/probe-repository-policy-migration.mjs",
];
const digests = Object.fromEntries(paths.map((p) => [p, hash(readFileSync(p))]));
run(join(bin, "createdb"), ["-h", "127.0.0.1", "-p", source.port, "-U", "coder", database]);
const deploy = () =>
  run("pnpm", ["exec", "prisma", "migrate", "deploy", "--schema", join(schema, "schema.prisma")], {
    cwd: join(root, "packages/db"),
    env: { ...process.env, DATABASE_URL: target.href },
  });
writeFileSync(join(directory, "before-deploy.log"), deploy());
const owner = randomUUID(),
  project = randomUUID(),
  intent = randomUUID();
psql(`INSERT INTO users(id,coder_url,coder_user_id,username,email,updated_at) VALUES('${owner}','https://fixture.invalid','${randomUUID()}','policy-upgrade','fixture@example.invalid',clock_timestamp());
INSERT INTO delivery_projects(id,owner_id,provider,provider_repository_id,provider_account_id,full_name,updated_at) VALUES('${project}','${owner}','github','123','456','fixture/upgrade',clock_timestamp());
INSERT INTO project_task_intents(id,owner_id,project_id,workspace_id,request_id,request_digest,repository_id,provider_account_id,source_sha,updated_at) VALUES('${intent}','${owner}','${project}','${randomUUID()}','${randomUUID()}','${"a".repeat(64)}','123','456','${"a".repeat(40)}',clock_timestamp());`);
const tables = psql(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename",
)
  .trim()
  .split("\n");
assert(
  tables.length > 0 &&
    tables.every(
      (t) =>
        /^[a-z][a-z0-9_]*$/.test(t) &&
        !t.startsWith("delivery_repository_") &&
        t !== "delivery_task_policy_bindings",
    ),
);
const snapshot = () =>
  Object.fromEntries(
    tables.map((table) => {
      const projection =
        table === "project_task_intents"
          ? "to_jsonb(t)-ARRAY['repository_policy_version_id','repository_policy_digest','intent_text_digest']"
          : "to_jsonb(t)";
      const value = psql(
        `SELECT (${projection})::text FROM "${table}" t ORDER BY (${projection})::text`,
      );
      return [
        table,
        { rows: value.trim() ? value.trim().split("\n").length : 0, sha256: hash(value) },
      ];
    }),
  );
const history = () =>
  JSON.parse(
    psql(
      "SELECT jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name)::text FROM _prisma_migrations WHERE rolled_back_at IS NULL",
    ),
  );
psql(
  "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN CREATE ROLE hive_app_runtime NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE; END IF; END $$",
);
const before = snapshot(),
  oldHistory = history();
assert.equal(oldHistory.length, 29);
cpSync(join(original, "migrations", migration), join(schema, "migrations", migration), {
  recursive: true,
});
writeFileSync(join(directory, "after-deploy.log"), deploy());
const after = snapshot(),
  newHistory = history();
assert.deepEqual(after, before);
assert.deepEqual(newHistory.slice(0, 29), oldHistory);
assert.equal(newHistory.length, 30);
assert.equal(
  psql(
    `SELECT count(*) FROM project_task_intents WHERE id='${intent}' AND repository_policy_version_id IS NULL AND repository_policy_digest IS NULL AND intent_text_digest IS NULL`,
  ).trim(),
  "1",
);
const roleTables = [
  "delivery_repository_policies",
  "delivery_repository_policy_versions",
  "delivery_task_policy_bindings",
];
for (const table of roleTables) {
  assert.equal(
    psql(
      `SELECT has_table_privilege('hive_app_runtime','${table}','SELECT') AND has_table_privilege('hive_app_runtime','${table}','INSERT') AND has_table_privilege('hive_app_runtime','${table}','UPDATE') AND NOT has_table_privilege('hive_app_runtime','${table}','DELETE') AND NOT has_table_privilege('hive_app_runtime','${table}','TRUNCATE') AND NOT has_table_privilege('hive_app_runtime','${table}','REFERENCES') AND NOT has_table_privilege('hive_app_runtime','${table}','TRIGGER')`,
    ).trim(),
    "t",
  );
  assert(psql(`SET ROLE hive_app_runtime; SELECT count(*) FROM ${table}`).trim().endsWith("0"));
  assert.throws(() => psql(`SET ROLE hive_app_runtime; DELETE FROM ${table}`), /permission denied/);
}
assert(Object.entries(digests).every(([p, value]) => hash(readFileSync(p)) === value));
const result = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  sourceStable: true,
  sourceHashes: digests,
  testedSourcesCommitted: false,
  beforeMigrations: 29,
  afterMigrations: 30,
  oldTablesPreserved: tables.length,
  legacyIntentRemainsUnbound: true,
  runtimeRoleGrantsVerified: true,
  runtimeRoleDeleteDenied: true,
  before,
  after,
  cloudMutation: false,
  fixtureDirectory: directory,
  fixtureDatabase: database,
};
const output = resolve(
  process.env.HIVE_REPOSITORY_POLICY_UPGRADE_EVIDENCE_PATH ?? join(directory, "result.json"),
);
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, evidence: output, oldTablesPreserved: tables.length }));
