#!/usr/bin/env node
// Local disposable PostgreSQL proof only. Never a production/Neon migration runner.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("guardian_application_upgrade_rejected");
};
const hash = (v) => createHash("sha256").update(v).digest("hex");
const source = new URL(process.env.HIVE_APPLICATION_SOURCE_DATABASE_URL ?? "");
check(
  source.protocol === "postgresql:" &&
    source.hostname === "127.0.0.1" &&
    source.username === "coder" &&
    !source.password &&
    source.pathname === "/hive_delivery_test" &&
    !source.search &&
    !source.hash &&
    source.port,
);
const targetPort = Number(process.env.HIVE_APPLICATION_UPGRADE_PORT);
check(Number.isSafeInteger(targetPort) && targetPort > 1024 && targetPort <= 65535);
const directory = mkdtempSync(join(tmpdir(), "hive-guardian-application-upgrade-"));
chmodSync(directory, 0o700);
const database = `hive_guardian_apply_upgrade_${randomUUID().replaceAll("-", "")}`;
const target = new URL(`postgresql://coder@127.0.0.1:${targetPort}/${database}`);
const bin = "/usr/lib/postgresql/17/bin";
const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: "utf8", maxBuffer: 33554432, ...options });
const psql = (url, sql) =>
  run(join(bin, "psql"), ["--no-psqlrc", url.href, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql]);
const dump = join(directory, "schema24.dump");
run(join(bin, "pg_dump"), ["--format=custom", "--file", dump, source.href]);
chmodSync(dump, 0o600);
run(join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(targetPort), "-U", "coder", database]);
run(join(bin, "pg_restore"), [
  "--no-owner",
  "--no-privileges",
  "--exit-on-error",
  "--dbname",
  target.href,
  dump,
]);
const tables = psql(
  target,
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename",
)
  .trim()
  .split("\n");
check(
  tables.length > 0 &&
    tables.every((t) => /^[a-z][a-z0-9_]*$/.test(t) && t !== "delivery_source_applications"),
);
const snapshot = () =>
  Object.fromEntries(
    tables.map((table) => {
      const data = psql(
        target,
        `SELECT to_jsonb(t)::text FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      );
      return [
        table,
        { rows: data.trim() ? data.trim().split("\n").length : 0, sha256: hash(data) },
      ];
    }),
  );
const history = () =>
  JSON.parse(
    psql(
      target,
      "SELECT coalesce(jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum,'rolledBack',rolled_back_at) ORDER BY migration_name),'[]'::jsonb)::text FROM _prisma_migrations",
    ),
  );
const oldHistory = history();
check(oldHistory.length === 24 && oldHistory.every((r) => r.rolledBack === null));
const before = snapshot();
const migrationPath =
  "packages/db/prisma/migrations/20261029140000_delivery_source_application/migration.sql";
const schemaPath = "packages/db/prisma/schema.prisma";
const sourceDigests = Object.fromEntries(
  [migrationPath, schemaPath, "scripts/probe-guardian-application-migration.mjs"].map((p) => [
    p,
    hash(readFileSync(p)),
  ]),
);
run(
  "pnpm",
  [
    "--filter",
    "@hive/db",
    "exec",
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    "prisma/schema.prisma",
  ],
  { env: { ...process.env, DATABASE_URL: target.href } },
);
const after = snapshot(),
  newHistory = history();
const oldRowsPreserved = JSON.stringify(before) === JSON.stringify(after);
const oldHistoryPreserved = JSON.stringify(oldHistory) === JSON.stringify(newHistory.slice(0, 24));
const sourceStable = Object.entries(sourceDigests).every(
  ([p, digest]) => hash(readFileSync(p)) === digest,
);
const added = psql(
  target,
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename = 'delivery_source_applications'",
).trim();
const evidence = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  baseRevision: run("git", ["rev-parse", "HEAD"]).trim(),
  sourceDigests,
  sourceStable,
  passed:
    oldRowsPreserved &&
    oldHistoryPreserved &&
    newHistory.length === 25 &&
    added === "1" &&
    sourceStable,
  database: {
    sourceSchema: 24,
    targetSchema: 25,
    targetPort,
    database,
    retained: true,
    scratchDirectory: directory,
  },
  oldRowsPreserved,
  oldHistoryPreserved,
  legacyTables: before,
  physicalAnchorsPreserved:
    before.delivery_manager_bindings.sha256 === after.delivery_manager_bindings.sha256 &&
    before.delivery_attempts.sha256 === after.delivery_attempts.sha256,
  migrations: newHistory,
  cloudMutations: false,
  accountInference: false,
};
const evidenceDirectory = resolve("docs/checks/autonomous-delivery/guardian-application-local");
const output = resolve(
  process.env.HIVE_APPLICATION_UPGRADE_EVIDENCE_PATH ??
    join(evidenceDirectory, "migration-upgrade.json"),
);
check(output.startsWith(`${evidenceDirectory}/`) && output.endsWith(".json"));
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
run("pnpm", ["exec", "biome", "format", "--write", output]);
check(evidence.passed);
process.stdout.write(
  `${JSON.stringify({
    passed: true,
    sourceSchema: 24,
    targetSchema: 25,
    legacyTableCount: tables.length,
    physicalAnchorsPreserved: true,
    evidence: output,
    retainedDatabase: database,
  })}\n`,
);
