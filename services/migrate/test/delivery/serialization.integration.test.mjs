import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { createMigrationDatabase } from "../../src/delivery/postgres.mjs";
import {
  acquirePrismaInteroperabilityLock,
  assertPrismaLockContract,
} from "../../src/delivery/prisma-lock.mjs";
import { executePrisma } from "../../src/migrate.mjs";

const require = createRequire(import.meta.url),
  url = process.env.HIVE_D10_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(u.hostname));
  assert.equal(u.pathname, "/hive_d10_test");
}
async function fixture(sql) {
  const root = await mkdtemp(join(tmpdir(), "hive-d10-prisma-")),
    schema = `interop_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await mkdir(join(root, "migrations", "0_init"), { recursive: true });
  await writeFile(
    join(root, "schema.prisma"),
    `datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n`,
  );
  await writeFile(join(root, "migrations", "migration_lock.toml"), 'provider = "postgresql"\n');
  await writeFile(join(root, "migrations", "0_init", "migration.sql"), sql(schema));
  const scoped = new URL(url);
  scoped.searchParams.set("schema", schema);
  return {
    root,
    schema,
    admin,
    run: () =>
      executePrisma({
        prismaCli: require.resolve("prisma/build/index.js"),
        databaseUrl: scoped.href,
        args: ["migrate", "deploy", "--schema", join(root, "schema.prisma")],
      }),
    async close() {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function until(read, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("fixture_observation_timeout");
}
test("Prisma lock contract rejects engine/locking overrides", () => {
  assert.equal(assertPrismaLockContract({}).key, "72707369");
  for (const key of [
    "PRISMA_SCHEMA_ENGINE_BINARY",
    "PRISMA_MIGRATION_ENGINE_BINARY",
    "PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK",
    "PRISMA_SCHEMA_ENGINE_WS_BASE_URL",
  ])
    assert.throws(() => assertPrismaLockContract({ [key]: "" }), /contract_changed/);
});
test("actual Prisma engine waits for the D10 transaction lock before executing migration", {
  skip: !url,
}, async () => {
  const f = await fixture(() => "CREATE TABLE interop_result(id integer);"),
    database = createMigrationDatabase(url);
  let entered, release;
  const ready = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let running;
  try {
    const locked = database.$transaction(
      async (tx) => {
        await acquirePrismaInteroperabilityLock(tx);
        entered();
        await gate;
      },
      { timeout: 15000 },
    );
    await ready;
    running = f.run();
    await until(
      async () =>
        Number(
          (
            await f.admin.query(
              "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=72707369 AND NOT granted",
            )
          ).rows[0].count,
        ) > 0,
    );
    assert.equal(
      (await f.admin.query("SELECT to_regclass($1)::text AS name", [`${f.schema}.interop_result`]))
        .rows[0].name,
      null,
    );
    release();
    await locked;
    assert.equal((await running).code, 0);
  } finally {
    release?.();
    await running;
    await f.close();
  }
});
test("actual Prisma migration session excludes D10 and releases its lock on exact backend crash", {
  skip: !url,
}, async () => {
  const f = await fixture(
      (schema) => `CREATE TABLE interop_result(id integer); SELECT pg_sleep(5) /* ${schema} */;`,
    ),
    database = createMigrationDatabase(url);
  let running;
  try {
    running = f.run();
    const backend = await until(
      async () =>
        (
          await f.admin.query(
            "SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE datname='hive_d10_test' AND query LIKE $1 AND pid<>pg_backend_pid()",
            [`%pg_sleep(5) /* ${f.schema} */%`],
          )
        ).rows[0],
    );
    await assert.rejects(
      database.$transaction((tx) => acquirePrismaInteroperabilityLock(tx)),
      /prisma_busy/,
    );
    const killed = await f.admin.query(
      "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datname='hive_d10_test' AND query LIKE $3",
      [backend.pid, backend.started, `%pg_sleep(5) /* ${f.schema} */%`],
    );
    assert.equal(killed.rows[0]?.killed, true);
    assert.notEqual((await running).code, 0);
    await database.$transaction((tx) => acquirePrismaInteroperabilityLock(tx));
  } finally {
    await running;
    await f.close();
  }
});
test("actual Prisma lock deadline fails without running migration while D10 retains its transaction", {
  skip: !url,
}, async () => {
  const f = await fixture(() => "CREATE TABLE interop_result(id integer);"),
    database = createMigrationDatabase(url);
  try {
    await database.$transaction(
      async (tx) => {
        await acquirePrismaInteroperabilityLock(tx);
        const start = performance.now();
        const result = await f.run();
        assert.notEqual(result.code, 0);
        assert.match(result.output, /P1002|Timed out/i);
        assert.ok(performance.now() - start < 14000);
        assert.equal(
          (
            await f.admin.query("SELECT to_regclass($1)::text AS name", [
              `${f.schema}.interop_result`,
            ])
          ).rows[0].name,
          null,
        );
      },
      { timeout: 15000 },
    );
  } finally {
    await f.close();
  }
});
