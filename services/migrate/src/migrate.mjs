import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runbook = "docs/deployment.md#existing-database-baseline-adoption";

export function migrationSchema(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  const schemas = url.searchParams.getAll("schema");
  const schema = schemas[0] ?? "public";
  if (schemas.length > 1 || !schema || schema.includes("\0") || Buffer.byteLength(schema) > 63) {
    throw new Error("DATABASE_URL must select one valid PostgreSQL schema.");
  }
  // Prisma 6 interpolates the schema into its connection's quoted search_path.
  // Reject quotes before starting the CLI, including in preflight-only mode.
  if (schema.includes('"')) {
    throw new Error(
      "DATABASE_URL schema names containing double quotes are unsupported by Prisma 6.",
    );
  }
  return schema;
}

export function preflightSql(schema) {
  // Hex encoding keeps schema text out of both SQL identifiers and the DO delimiter.
  const hex = Buffer.from(schema).toString("hex");
  return `SELECT pg_catalog.set_config('hive.migration_schema',
    pg_catalog.convert_from(pg_catalog.decode('${hex}', 'hex'), 'UTF8'), false);
DO $hive_preflight$
DECLARE
  target_schema text := pg_catalog.current_setting('hive.migration_schema');
  baseline_applied boolean;
  unfinished boolean;
BEGIN
  IF pg_catalog.to_regclass(pg_catalog.format('%I.%I', target_schema, '_prisma_migrations')) IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'SELECT EXISTS (SELECT 1 FROM %I._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)', target_schema)
      INTO unfinished;
    IF unfinished THEN
      RAISE EXCEPTION 'HIVE_MIGRATION_FAILED_HISTORY';
    END IF;
    EXECUTE pg_catalog.format(
      'SELECT EXISTS (SELECT 1 FROM %I._prisma_migrations WHERE migration_name = ''0_init'' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)', target_schema)
      INTO baseline_applied;
    IF baseline_applied THEN RETURN; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema AND c.relname <> '_prisma_migrations'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = target_schema AND t.typtype IN ('e', 'd')
  ) THEN
    RAISE EXCEPTION 'HIVE_MIGRATION_BASELINE_REQUIRED';
  END IF;
END
$hive_preflight$;
`;
}

export function executePrisma({ args, stdin = "", databaseUrl, prismaCli }) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [prismaCli, ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let failure;
    const streamFailure = (error) => {
      failure ??= error;
      child.kill();
    };
    child.on("error", (error) => {
      failure ??= error;
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-16384);
      });
      stream.on("error", streamFailure);
    }
    child.stdin.on("error", streamFailure);
    child.on("close", (code) => {
      if (failure) reject(failure);
      else done({ code, output });
    });
    child.stdin.end(stdin);
  });
}

export async function migrate({
  databaseUrl = process.env.DATABASE_URL,
  checkOnly = false,
  prismaCli = require.resolve("prisma/build/index.js"),
  schemaPath = resolve(dirname(require.resolve("@hive/db")), "../prisma/schema.prisma"),
  execute = executePrisma,
  log = console.log,
} = {}) {
  const schema = migrationSchema(databaseUrl);
  let preflight;
  try {
    preflight = await execute({
      prismaCli,
      databaseUrl,
      args: ["db", "execute", "--schema", schemaPath, "--stdin"],
      stdin: preflightSql(schema),
    });
  } catch {
    throw new Error(
      `Migration preflight could not run. Check database access and the migration image; see ${runbook}.`,
    );
  }
  if (preflight.code !== 0) {
    if (preflight.output.includes("HIVE_MIGRATION_BASELINE_REQUIRED")) {
      throw new Error(
        `HIVE_MIGRATION_BASELINE_REQUIRED: Existing schema has no completed 0_init baseline. Deployment stopped without changing schema or migration history. Verify a backup and the historical schema before explicitly adopting the baseline; see ${runbook}.`,
      );
    }
    if (preflight.output.includes("HIVE_MIGRATION_FAILED_HISTORY")) {
      throw new Error(
        `HIVE_MIGRATION_FAILED_HISTORY: An unresolved migration exists. Inspect prisma migrate status and repair the failed migration before retrying; see ${runbook}.`,
      );
    }
    throw new Error(
      `Migration preflight failed. Inspect database connectivity, permissions, and migration history; see ${runbook}.`,
    );
  }
  log("[migrate] Baseline preflight passed.");
  if (checkOnly) return;
  let deployment;
  try {
    deployment = await execute({
      prismaCli,
      databaseUrl,
      args: ["migrate", "deploy", "--schema", schemaPath],
    });
  } catch {
    throw new Error(
      "Migration deployment could not run. Inspect the migration image and database access.",
    );
  }
  if (deployment.code !== 0) {
    const code = deployment.output.match(/\bP\d{4}\b/)?.[0];
    throw new Error(
      `Migration deployment failed${code ? ` (${code})` : ""}. Inspect prisma migrate status and ${runbook}.`,
    );
  }
  log("[migrate] Deployment complete.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    console.error("Usage: node src/migrate.mjs [--check]");
    process.exitCode = 1;
  } else {
    migrate({ checkOnly: args.includes("--check") }).catch((error) => {
      console.error(`[migrate] ${error.message}`);
      process.exitCode = 1;
    });
  }
}
