#!/usr/bin/env node
// Source-bound local PostgreSQL acceptance. No remote resources or account inference.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("guardian_registry_local_probe_rejected");
};
const url = new URL(process.env.HIVE_DELIVERY_TEST_DATABASE_URL ?? "");
check(
  url.protocol === "postgresql:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "coder" &&
    !url.password &&
    url.pathname === "/hive_delivery_test" &&
    url.port &&
    !url.search &&
    !url.hash,
);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sources = [
  "packages/db/prisma/schema.prisma",
  "src/lib/codex-session/guardian-contracts.ts",
  "src/lib/codex-session/guardian-config.server.ts",
  "src/lib/codex-session/guardian-store.server.ts",
  "src/lib/codex-session/registration-store.server.ts",
  "src/lib/projects/task-intents.server.ts",
  "src/lib/delivery/manager-binding.server.ts",
  "src/lib/delivery/manager.server.ts",
  "src/lib/delivery/native.server.ts",
  "src/lib/delivery/repository.ts",
  "src/lib/delivery/progression.server.ts",
  "src/lib/delivery/source-resolver.server.ts",
  "src/__tests__/lib/codex-session/guardian-fixture.ts",
  "src/__tests__/lib/codex-session/guardian-policy.test.ts",
  "src/__tests__/lib/codex-session/guardian-store.integration.test.ts",
  "src/__tests__/lib/delivery/native-fixture.ts",
  "templates/ai-dev-k8s/scripts/codex-native-namespace.mjs",
  "scripts/probe-guardian-registry.mjs",
];
const migrationRoot = "packages/db/prisma/migrations";
const migrations = readdirSync(migrationRoot)
  .filter((p) => p === "0_init" || /^\d{14}_[a-z0-9_]+$/.test(p))
  .sort();
check(migrations.length === 24);
sources.push(...migrations.map((p) => join(migrationRoot, p, "migration.sql")));
const digests = Object.fromEntries(sources.map((p) => [p, hash(p)]));
const revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const baseRevision = revision();
const history = JSON.parse(
  execFileSync(
    "/usr/lib/postgresql/17/bin/psql",
    [
      "--no-psqlrc",
      url.href,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT coalesce(jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum,'rolledBack',rolled_back_at) ORDER BY migration_name),'[]'::jsonb)::text FROM _prisma_migrations",
    ],
    { encoding: "utf8", maxBuffer: 1048576 },
  ),
);
check(
  history.length === 24 &&
    history.every(
      (r, i) =>
        r.name === migrations[i] &&
        r.checksum === digests[join(migrationRoot, r.name, "migration.sql")] &&
        r.rolledBack === null,
    ),
);
const directory = mkdtempSync(join(tmpdir(), "hive-guardian-registry-proof-"));
const report = join(directory, "vitest.json");
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/__tests__/lib/codex-session/guardian-store.integration.test.ts",
    "src/__tests__/lib/codex-session/guardian-policy.test.ts",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1048576,
    env: { ...process.env, HIVE_DELIVERY_TEST_DATABASE_URL: url.href },
  },
);
let tests;
try {
  tests = JSON.parse(readFileSync(report, "utf8"));
} catch {
  tests = { numPassedTests: 0, numFailedTests: 1 };
}
const sourceStable = sources.every((p) => hash(p) === digests[p]);
const evidence = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  baseRevision,
  endingBaseRevision: revision(),
  testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...sources], {
    encoding: "utf8",
  }).trim(),
  sourceDigests: digests,
  sourceStable,
  passed:
    result.status === 0 &&
    tests.numPassedTests === 13 &&
    tests.numFailedTests === 0 &&
    sourceStable,
  database: {
    host: "127.0.0.1",
    port: Number(url.port),
    name: "hive_delivery_test",
    schemaMigrations: 24,
    allMigrationChecksumsMatch: true,
    rowsPreserved: true,
  },
  tests: {
    passed: tests.numPassedTests,
    failed: tests.numFailedTests,
    skipped: tests.numPendingTests ?? 0,
    groups:
      tests.testResults?.map((t) => ({
        name: t.name.split("/").at(-1),
        passed: t.status === "passed",
      })) ?? [],
  },
  limitations: [
    "Storage and real server manager/native mutation integration with synthetic owner/Coder policy and metadata evidence; signature/bootstrap routes and installed outer factory are next gate.",
    "No physical quiescence, tree receipt ingestion, source publication live or resource cleanup authorized.",
  ],
  accountInference: false,
  cloudMutations: false,
};
const evidenceDirectory = resolve("docs/checks/autonomous-delivery/guardian-registry-local");
const output = resolve(
  process.env.HIVE_GUARDIAN_STORE_EVIDENCE_PATH ?? join(evidenceDirectory, "store.json"),
);
check(output.startsWith(`${evidenceDirectory}/`) && output.endsWith(".json"));
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
check(evidence.passed);
process.stdout.write(
  `${JSON.stringify({ passed: true, tests: tests.numPassedTests, sourceStable, evidence: output })}\n`,
);
