import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { executePrisma, migrate } from "../src/migrate.mjs";

const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const schemaPath = resolve(dirname(require.resolve("@hive/db")), "../prisma/schema.prisma");
const baseUrl = new URL(process.env.MIGRATION_TEST_DATABASE_URL);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname));
assert.equal(baseUrl.pathname, "/hive_migrate_test", "Use only the disposable CI test database");
const quiet = () => {};
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

async function prisma(databaseUrl, args, stdin = "") {
  return executePrisma({ databaseUrl, prismaCli, args: [...args, "--schema", schemaPath], stdin });
}

async function sql(databaseUrl, script) {
  const schema = new URL(databaseUrl).searchParams.get("schema") ?? "public";
  const result = await prisma(
    databaseUrl,
    ["db", "execute", "--stdin"],
    `SET search_path TO ${quote(schema)};\n${script}`,
  );
  assert.equal(result.code, 0, result.output);
}

async function fixture(t, unusual = false) {
  const schema = `hive_test_${randomUUID().replaceAll("-", "").slice(0, 16)}${unusual ? '";$hive_preflight$' : ""}`;
  await sql(baseUrl.href, `CREATE SCHEMA ${quote(schema)};`);
  t.after(() => sql(baseUrl.href, `DROP SCHEMA ${quote(schema)} CASCADE;`));
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  return url.href;
}

async function legacy(databaseUrl) {
  await sql(
    databaseUrl,
    await readFile(resolve(dirname(schemaPath), "migrations/0_init/migration.sql"), "utf8"),
  );
  await sql(
    databaseUrl,
    `INSERT INTO users (id, coder_url, coder_user_id, username, email, updated_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'https://fixture.invalid',
    '22222222-2222-4222-8222-222222222222', 'preserved-user', 'fixture@example.invalid', now());`,
  );
}

const historyTable = `CREATE TABLE _prisma_migrations (
  id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
  migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0
);`;
const userRetained = `DO $$ BEGIN
  IF (SELECT count(*) FROM users WHERE username = 'preserved-user') <> 1 THEN
    RAISE EXCEPTION 'User data was not retained';
  END IF;
END $$;`;

test("fresh database migrates successfully", async (t) => {
  const url = await fixture(t);
  await migrate({ databaseUrl: url, log: quiet });
  await sql(
    url,
    `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '0_init' AND finished_at IS NOT NULL)
      OR to_regclass('users') IS NULL OR to_regclass('navigation_favorites') IS NULL THEN
      RAISE EXCEPTION 'Fresh migration did not finish';
    END IF;
  END $$;`,
  );
});

test("an already migrated database remains deployable", async (t) => {
  const url = await fixture(t);
  const initial = await prisma(url, ["migrate", "deploy"]);
  assert.equal(initial.code, 0, initial.output);
  await migrate({ databaseUrl: url, log: quiet });
  await sql(
    url,
    "DO $$ BEGIN IF (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '0_init') <> 1 THEN RAISE EXCEPTION 'Baseline repeated'; END IF; END $$;",
  );
});

test("legacy schema is retained until explicit baseline adoption, then upgrades with data intact", async (t) => {
  const url = await fixture(t);
  await legacy(url);
  await assert.rejects(
    migrate({ databaseUrl: url, log: quiet }),
    /HIVE_MIGRATION_BASELINE_REQUIRED/,
  );
  await sql(
    url,
    `${userRetained}
    DO $$ BEGIN IF to_regclass('_prisma_migrations') IS NOT NULL THEN RAISE EXCEPTION 'History changed'; END IF; END $$;`,
  );
  const adoption = await prisma(url, ["migrate", "resolve", "--applied", "0_init"]);
  assert.equal(adoption.code, 0, adoption.output);
  await migrate({ databaseUrl: url, log: quiet });
  await sql(url, userRetained);
});

test("legacy history without 0_init is not automatically rewritten", async (t) => {
  const url = await fixture(t);
  await legacy(url);
  await sql(
    url,
    `${historyTable} INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at)
    VALUES ('old-history', 'old-checksum', 'old_bootstrap', now());`,
  );
  await assert.rejects(
    migrate({ databaseUrl: url, log: quiet }),
    /HIVE_MIGRATION_BASELINE_REQUIRED/,
  );
  await sql(
    url,
    `${userRetained} DO $$ BEGIN
    IF (SELECT count(*) FROM _prisma_migrations) <> 1 THEN RAISE EXCEPTION 'Legacy history changed'; END IF;
  END $$;`,
  );
});

test("failed baseline history requires repair", async (t) => {
  const url = await fixture(t);
  await sql(
    url,
    `${historyTable} INSERT INTO _prisma_migrations (id, checksum, migration_name)
    VALUES ('failed-history', 'fixture-checksum', '0_init');`,
  );
  await assert.rejects(migrate({ databaseUrl: url, log: quiet }), /HIVE_MIGRATION_FAILED_HISTORY/);
  await sql(
    url,
    "DO $$ BEGIN IF to_regclass('users') IS NOT NULL THEN RAISE EXCEPTION 'Schema changed'; END IF; END $$;",
  );
});

test("custom schema quoting does not change preflight SQL or target selection", async (t) => {
  const url = await fixture(t, true);
  await migrate({ databaseUrl: url, checkOnly: true, log: quiet });
  await sql(
    url,
    "DO $$ BEGIN IF to_regclass('users') IS NOT NULL THEN RAISE EXCEPTION 'Check-only wrote schema'; END IF; END $$;",
  );
  await legacy(url);
  await assert.rejects(
    migrate({ databaseUrl: url, log: quiet }),
    /HIVE_MIGRATION_BASELINE_REQUIRED/,
  );
});

test("enum-only legacy schemas are detected", async (t) => {
  const url = await fixture(t);
  await sql(url, "CREATE TYPE fixture_enum AS ENUM ('existing');");
  await assert.rejects(
    migrate({ databaseUrl: url, log: quiet }),
    /HIVE_MIGRATION_BASELINE_REQUIRED/,
  );
});

test("empty history is allowed and check-only does not write migrations", async (t) => {
  const url = await fixture(t);
  await sql(url, historyTable);
  await migrate({ databaseUrl: url, checkOnly: true, log: quiet });
  await sql(
    url,
    "DO $$ BEGIN IF (SELECT count(*) FROM _prisma_migrations) <> 0 OR to_regclass('users') IS NOT NULL THEN RAISE EXCEPTION 'Preflight wrote data'; END IF; END $$;",
  );
  await migrate({ databaseUrl: url, log: quiet });
});
