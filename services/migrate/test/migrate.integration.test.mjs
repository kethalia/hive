import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { executePrisma, migrate } from "../src/migrate.mjs";
import { runtimeGrantsSql } from "../src/runtime-grants.mjs";

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
  const schema = `hive_test_${randomUUID().replaceAll("-", "").slice(0, 16)}${unusual ? "';$hive_preflight$" : ""}`;
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
  const schema = new URL(url).searchParams.get("schema");
  await sql(
    url,
    `BEGIN;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hive_app_runtime') THEN
      CREATE ROLE hive_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF; END $$;
    -- Exercise provisioning/regrant independently of any migration-time grants.
    REVOKE ALL ON agent_notification_events, agent_notification_rate_windows FROM hive_app_runtime;
    ${runtimeGrantsSql(schema)}
    ${runtimeGrantsSql(schema)}
    DO $$ DECLARE target text; privilege text; BEGIN
      FOREACH target IN ARRAY ARRAY['agent_notification_events','agent_notification_rate_windows'] LOOP
        FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
          IF NOT has_table_privilege('hive_app_runtime', target, privilege) THEN
            RAISE EXCEPTION 'Late runtime provisioning omitted % on %', privilege, target;
          END IF;
        END LOOP;
      END LOOP;
    END $$;
    DO $$ BEGIN
      IF NOT has_table_privilege('hive_app_runtime', 'codex_guardian_tree_receipts', 'SELECT')
        OR NOT has_table_privilege('hive_app_runtime', 'codex_guardian_tree_receipts', 'INSERT')
        OR has_table_privilege('hive_app_runtime', 'codex_guardian_tree_receipts', 'UPDATE')
        OR has_table_privilege('hive_app_runtime', 'codex_guardian_tree_receipts', 'DELETE')
        OR NOT has_table_privilege('hive_app_runtime', 'codex_guardian_runtimes', 'UPDATE')
        OR NOT has_table_privilege('hive_app_runtime', 'sessions', 'DELETE') THEN
        RAISE EXCEPTION 'Runtime grant scope incorrect';
      END IF;
    END $$;
    SET LOCAL ROLE hive_app_runtime;
    SELECT count(*) FROM codex_guardian_tree_receipts;
    RESET ROLE;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hive_native_runtime') THEN
      CREATE ROLE hive_native_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF; END $$;
    -- The selected native role must work when created after all DDL, even though
    -- migration 44 has no native grant. No migration or app grant is replayed.
    REVOKE ALL ON ALL TABLES IN SCHEMA ${quote(schema)} FROM hive_native_runtime;
    REVOKE CONNECT ON DATABASE hive_migrate_test FROM PUBLIC, hive_native_runtime;
    ${runtimeGrantsSql(schema, "hive_native_runtime")}
    ${runtimeGrantsSql(schema, "hive_native_runtime")}
    DO $$ DECLARE item record; privilege text; BEGIN
      FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='${schema}' AND tablename<>'_prisma_migrations' LOOP
        FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
          IF has_table_privilege('hive_native_runtime', format('%I.%I','${schema}',item.tablename), privilege)
            IS DISTINCT FROM has_table_privilege('hive_app_runtime', format('%I.%I','${schema}',item.tablename), privilege) THEN
            RAISE EXCEPTION 'Native/app fixed grant matrices differ for % on %', privilege, item.tablename;
          END IF;
        END LOOP;
      END LOOP;
      IF NOT has_table_privilege('hive_native_runtime', 'project_task_recoveries', 'SELECT')
        OR NOT has_table_privilege('hive_native_runtime', 'project_task_recoveries', 'INSERT')
        OR NOT has_table_privilege('hive_native_runtime', 'project_task_recoveries', 'UPDATE')
        OR has_table_privilege('hive_native_runtime', 'project_task_recoveries', 'DELETE')
        OR has_database_privilege('hive_native_runtime','hive_migrate_test','CONNECT') THEN
        RAISE EXCEPTION 'Native recovery permission or database-connect boundary incorrect';
      END IF;
    END $$;
    SET LOCAL ROLE hive_native_runtime;
    SELECT count(*) FROM project_task_recoveries;
    SELECT count(*) FROM codex_guardian_tree_receipts;
    RESET ROLE;
    ROLLBACK;`,
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

const retirement = "20261107010000_retire_native_preview_publication";
const retiredTables = [
  "delivery_native_release_artifacts",
  "delivery_native_publication_grants",
  "delivery_native_publication_receipts",
  "delivery_native_release_baselines",
];

// Keep this regression at its historical boundary; later migrations have their
// own compatibility checks and must not change this fixture's expected rows.
async function publisherRetirementSchema(t, includeRetirement = false) {
  const snapshot = await mkdtemp(resolve(tmpdir(), "hive-retirement-45-"));
  t.after(() => rm(snapshot, { recursive: true, force: true }));
  const historicalSchema = resolve(snapshot, "schema.prisma");
  await writeFile(historicalSchema, await readFile(schemaPath));
  const migrations = resolve(dirname(schemaPath), "migrations");
  await mkdir(resolve(snapshot, "migrations"));
  for (const entry of await readdir(migrations, { withFileTypes: true })) {
    if (
      entry.name === "migration_lock.toml" ||
      (entry.isDirectory() &&
        (entry.name < retirement || (includeRetirement && entry.name === retirement)))
    )
      await cp(resolve(migrations, entry.name), resolve(snapshot, "migrations", entry.name), {
        recursive: true,
      });
  }
  return historicalSchema;
}
async function beforePublisherRetirement(t) {
  const url = await fixture(t);
  const historicalSchema = await publisherRetirementSchema(t);
  const result = await executePrisma({
    databaseUrl: url,
    prismaCli,
    args: ["migrate", "deploy", "--schema", historicalSchema],
  });
  assert.equal(result.code, 0, result.output);
  await sql(
    url,
    `BEGIN;
    INSERT INTO users(id,coder_url,coder_user_id,username,email,updated_at) VALUES
      ('11111111-1111-4111-8111-111111111111','https://fixture.invalid','22222222-2222-4222-8222-222222222222','retained-owner','fixture@example.invalid',clock_timestamp());
    INSERT INTO delivery_projects(id,owner_id,provider,provider_repository_id,provider_account_id,full_name) VALUES
      ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','github','1','2','fixture/repo');
    INSERT INTO delivery_tasks(id,owner_id,project_id,outcome,source_sha,branch) VALUES
      ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','retained task',repeat('2',40),'preview');
    -- Explicit isolated-fixture seed: unrelated manager FKs are not the DDL
    -- under test. All retirement guards and transactions remain enabled.
    SET LOCAL session_replication_role=replica;
    INSERT INTO delivery_source_revisions(id,owner_id,task_id,manager_binding_id,step_id,producing_attempt_id,version,input_sha,head_sha,tree_sha,manifest_digest,operation_id,request_digest,producer,proof_digest,repository_id,provider_account_id,full_name,branch,base_branch,pull_request_id,pull_number) VALUES
      ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,repeat('1',40),repeat('2',40),repeat('3',40),repeat('4',64),gen_random_uuid(),repeat('5',64),'protected-source-broker-v1',repeat('6',64),'1','2','fixture/repo','preview','main','3',1);
    INSERT INTO delivery_release_targets(target_digest) VALUES(repeat('a',64));
    INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest) VALUES
      ('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',repeat('a',64),repeat('b',64),'{}',repeat('c',64));
    UPDATE delivery_release_targets SET active_release_id='66666666-6666-4666-8666-666666666666',generation=1 WHERE target_digest=repeat('a',64);
    INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation) VALUES
      ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666','merge',repeat('a',64),'{}',repeat('d',64),1);
    COMMIT;`,
  );
  return url;
}

async function saveRetirementRows(url, includePublisher = false) {
  const exclude = includePublisher
    ? ""
    : `AND tablename NOT IN (${retiredTables.map((name) => `'${name}'`).join(",")})`;
  await sql(
    url,
    `CREATE TABLE retirement_fixture_snapshot(table_name text PRIMARY KEY, contents jsonb);
    DO $$ DECLARE item record; contents jsonb; filter text; BEGIN
      FOR item IN SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
        AND tablename<>'retirement_fixture_snapshot' ${exclude} LOOP
        filter:=CASE WHEN item.tablename='_prisma_migrations' THEN ' WHERE migration_name<>''${retirement}''' ELSE '' END;
        EXECUTE format('SELECT coalesce(jsonb_agg(data ORDER BY data::text),''[]''::jsonb) FROM (SELECT to_jsonb(r) data FROM %I r%s) q',item.tablename,filter) INTO contents;
        INSERT INTO retirement_fixture_snapshot VALUES(item.tablename,contents);
      END LOOP;
    END $$;`,
  );
}

async function assertRetirementRows(url) {
  await sql(
    url,
    `DO $$ DECLARE item record; actual jsonb; filter text; BEGIN
    FOR item IN SELECT * FROM retirement_fixture_snapshot LOOP
      IF to_regclass(format('%I',item.table_name)) IS NULL THEN RAISE EXCEPTION 'Nonpublisher table disappeared'; END IF;
      filter:=CASE WHEN item.table_name='_prisma_migrations' THEN ' WHERE migration_name<>''${retirement}''' ELSE '' END;
      EXECUTE format('SELECT coalesce(jsonb_agg(data ORDER BY data::text),''[]''::jsonb) FROM (SELECT to_jsonb(r) data FROM %I r%s) q',item.table_name,filter) INTO actual;
      IF actual IS DISTINCT FROM item.contents THEN RAISE EXCEPTION 'Retained rows/history changed in %',item.table_name; END IF;
    END LOOP;
    IF (SELECT checksum FROM _prisma_migrations WHERE migration_name='20261106110000_native_preview_release_publication')
      IS DISTINCT FROM '3313ead5dfa0b922002ce90feef4e630f6081443ea34c0cca05f80e5bd4d03b5' THEN RAISE EXCEPTION 'Migration45 history changed'; END IF;
  END $$;`,
  );
}

test("native publisher retirement removes only empty tables/functions and preserves all other rows/history", async (t) => {
  const url = await beforePublisherRetirement(t);
  await saveRetirementRows(url);
  const deployed = await executePrisma({
    databaseUrl: url,
    prismaCli,
    args: ["migrate", "deploy", "--schema", await publisherRetirementSchema(t, true)],
  });
  assert.equal(deployed.code, 0, deployed.output);
  await assertRetirementRows(url);
  await sql(
    url,
    `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname=current_schema() AND tablename=ANY(ARRAY[${retiredTables.map((name) => `'${name}'`).join(",")}]))
      OR to_regprocedure('hive_native_release_immutable()') IS NOT NULL
      OR to_regprocedure('hive_native_publication_insert()') IS NOT NULL
      OR to_regprocedure('hive_native_baseline_insert()') IS NOT NULL THEN RAISE EXCEPTION 'Retired surface remains'; END IF;
    IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name='${retirement}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
      THEN RAISE EXCEPTION 'Retirement not recorded'; END IF;
  END $$;`,
  );
});

const retirementSeed = [
  `INSERT INTO delivery_native_release_artifacts(id,owner_id,release_id,target_digest,manifest,manifest_digest,builder_evidence,publisher_identity) VALUES(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','66666666-6666-4666-8666-666666666666',repeat('a',64),'{"marker":"retained"}',repeat('b',64),'{}','{}');`,
  `INSERT INTO delivery_native_publication_grants(id,action_id,artifact_id,grant_data,grant_digest,expires_at) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"marker":"retained"}',repeat('b',64),clock_timestamp()+interval '1 minute');`,
  `INSERT INTO delivery_native_publication_receipts(action_id,grant_id,receipt,receipt_digest,publisher_identity) VALUES(gen_random_uuid(),gen_random_uuid(),'{"marker":"retained"}',repeat('b',64),'{}');`,
  `INSERT INTO delivery_native_release_baselines(observation_digest,artifact_id,action_id,owner_id,target_digest,evidence) VALUES(repeat('b',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),repeat('a',64),'{"marker":"retained"}');`,
];
async function tryRetirementSql(url) {
  const schema = new URL(url).searchParams.get("schema") ?? "public";
  return prisma(
    url,
    ["db", "execute", "--stdin"],
    `SET search_path TO ${quote(schema)};\n${await readFile(resolve(dirname(schemaPath), "migrations", retirement, "migration.sql"), "utf8")}`,
  );
}
test("native publisher retirement rolls back earlier drops for an unexpected external dependency", async (t) => {
  const url = await beforePublisherRetirement(t);
  await sql(
    url,
    `CREATE TABLE retirement_external_dependency (
    artifact_id uuid REFERENCES delivery_native_release_artifacts(id), payload text NOT NULL);
    INSERT INTO retirement_external_dependency(payload) VALUES('unrelated retained row');`,
  );
  await saveRetirementRows(url, true);
  const raw = await tryRetirementSql(url);
  assert.notEqual(raw.code, 0);
  assert.match(raw.output, /depend/i);
  await assertRetirementRows(url);
  const deployed = await prisma(url, ["migrate", "deploy"]);
  assert.notEqual(deployed.code, 0);
  // This failure occurs after three DROP TABLE statements, exercising actual
  // DDL rollback rather than only the earlier nonempty guard.
  await assertRetirementRows(url);
  await sql(
    url,
    `DO $$ BEGIN
    IF (SELECT count(*) FROM retirement_external_dependency WHERE payload='unrelated retained row')<>1
      OR to_regprocedure('hive_native_release_immutable()') IS NULL
      THEN RAISE EXCEPTION 'Unrelated dependency changed'; END IF;
  END $$;`,
  );
});
for (const [index, table] of retiredTables.entries()) {
  test(`native publisher retirement aborts atomically for a row in ${table}`, async (t) => {
    const url = await beforePublisherRetirement(t);
    // Guard must preserve ANY row, even a legacy/orphan row: do not require
    // obsolete publisher authorization merely to exercise the empty check.
    await sql(
      url,
      `BEGIN; SET LOCAL session_replication_role=replica; ${retirementSeed[index]} COMMIT;`,
    );
    await saveRetirementRows(url, true);
    const raw = await tryRetirementSql(url);
    assert.notEqual(raw.code, 0);
    assert.match(raw.output, /native_publication_retirement_nonempty/);
    await assertRetirementRows(url);
    const deployed = await prisma(url, ["migrate", "deploy"]);
    assert.notEqual(deployed.code, 0);
    // Prisma6 may mask the original guard while persisting failure history
    // because the explicit transaction is aborted. Independently prove the
    // guard above and complete data/schema rollback through both entrypoints.
    await assertRetirementRows(url);
    await sql(
      url,
      `DO $$ BEGIN
      IF to_regprocedure('hive_native_release_immutable()') IS NULL
        OR to_regprocedure('hive_native_publication_insert()') IS NULL
        OR to_regprocedure('hive_native_baseline_insert()') IS NULL THEN RAISE EXCEPTION 'Failed retirement changed functions'; END IF;
      IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name='${retirement}' AND finished_at IS NULL)
        THEN RAISE EXCEPTION 'Failed retirement history missing'; END IF;
    END $$;`,
    );
  });
}
