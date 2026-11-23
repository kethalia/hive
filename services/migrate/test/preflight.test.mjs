import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executePrisma, migrate, migrationSchema, preflightSql } from "../src/migrate.mjs";
import { cutoverMigrationNames, runtimeGrantsSql, runtimeTables } from "../src/runtime-grants.mjs";

const databaseUrl = "postgresql://fixture:secret@localhost/hive";
const success = { code: 0, output: "" };

test("OAuth preview grants select the isolated database, owner, role and current schema", () => {
  const sql = runtimeGrantsSql("oauth-preview", 12345);
  assert(sql.includes("current_database()<>'hive_coder_oauth_preview'"));
  assert(sql.includes("current_user<>'hive_epic_owner'"));
  assert(sql.includes("oid=12345"));
  assert(
    sql.includes(
      'GRANT CONNECT ON DATABASE "hive_coder_oauth_preview" TO "hive_coder_oauth_runtime"',
    ),
  );
  assert(sql.includes("ARRAY['hive_coder_oauth_runtime','hive_production_runtime']"));
  assert(sql.includes("'coder_oauth_accounts'"));
  assert(sql.includes("'better_auth_verifications'"));
  assert.equal(cutoverMigrationNames.length, 12);
  assert.equal(Object.values(runtimeTables).flat().length, 15);
  assert(!sql.includes("hive_foundation_runtime"));
});

test("managed Projects grants bind to the complete migration set and preserve append-only tables", async () => {
  const sql = runtimeGrantsSql("accounts-preview", 12345, "managed-projects");
  const expected = await readdir(
    new URL("../../../packages/db/prisma/migrations/", import.meta.url),
    {
      withFileTypes: true,
    },
  );
  const history = expected
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert(sql.includes(`ARRAY[${history.map((name) => `'${name}'`).join(",")}]`));
  const mutable = sql.match(
    /FOREACH name IN ARRAY (.*) LOOP\n {4}EXECUTE format\('GRANT SELECT,INSERT,UPDATE ON TABLE/,
  )[1];
  assert(mutable.includes("'project_task_intents'"));
  assert(!mutable.includes("'codex_registered_threads'"));
  assert(!mutable.includes("'codex_guardian_operation_receipts'"));
  assert(!runtimeGrantsSql("accounts-preview", 12345).includes("'project_task_intents'"));
});

test("the existing foundation preview grant target retains its database and role", () => {
  const sql = runtimeGrantsSql("preview", 12345);
  assert(sql.includes("current_database()<>'hive_foundation_preview'"));
  assert(
    sql.includes(
      'GRANT CONNECT ON DATABASE "hive_foundation_preview" TO "hive_foundation_runtime"',
    ),
  );
  assert(sql.includes("ARRAY['hive_foundation_runtime','hive_production_runtime']"));
  assert(!sql.includes("hive_coder_oauth_runtime"));
});

test("grant generation rejects unknown profiles and invalid OIDs before emitting SQL", () => {
  for (const target of ["unknown", "__proto__", "constructor"])
    assert.throws(() => runtimeGrantsSql(target, 12345), /oauth-preview/);
  for (const oid of [0, -1, 1.5, Number.NaN, 4294967296])
    assert.throws(() => runtimeGrantsSql("oauth-preview", oid), /database OID/);
});

test("defaults to public and honors a custom schema", () => {
  assert.equal(migrationSchema(databaseUrl), "public");
  assert.equal(migrationSchema(`${databaseUrl}?schema=tenant-blue`), "tenant-blue");
});

for (const invalid of [
  null,
  "invalid",
  "file:///db",
  `${databaseUrl}?schema=`,
  `${databaseUrl}?schema=a&schema=b`,
  `${databaseUrl}?schema=%00`,
  `${databaseUrl}?schema=tenant%22blue`,
  `${databaseUrl}?schema=tenant%22%3BDROP%20SCHEMA%20public%3B--`,
  `${databaseUrl}?schema=${"x".repeat(64)}`,
]) {
  test(`rejects malformed database configuration (${String(invalid).slice(-12)})`, async () => {
    let called = false;
    await assert.rejects(
      migrate({
        databaseUrl: invalid,
        execute: () => {
          called = true;
        },
        log: () => {},
      }),
    );
    assert.equal(called, false);
  });
}

test("keeps untrusted schema characters outside SQL syntax", () => {
  const schema = "tenant'; DROP TABLE users; -- $hive_preflight$";
  const sql = preflightSql(schema);
  assert.ok(sql.includes(Buffer.from(schema).toString("hex")));
  assert.ok(!sql.includes(schema));
});

test("a passing preflight runs deploy afterward without putting credentials in arguments", async () => {
  const calls = [];
  await migrate({
    databaseUrl,
    execute: async (call) => {
      calls.push(call);
      return success;
    },
    log: () => {},
  });
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2)),
    [
      ["db", "execute"],
      ["migrate", "deploy"],
    ],
  );
  assert.equal(calls[0].databaseUrl, databaseUrl);
  assert.ok(calls[0].stdin.includes("HIVE_MIGRATION_BASELINE_REQUIRED"));
  assert.ok(!JSON.stringify(calls.map((call) => call.args)).includes(databaseUrl));
});

test("check-only never deploys", async () => {
  let calls = 0;
  await migrate({
    databaseUrl,
    checkOnly: true,
    execute: async () => {
      calls++;
      return success;
    },
    log: () => {},
  });
  assert.equal(calls, 1);
});

for (const marker of [
  "HIVE_MIGRATION_BASELINE_REQUIRED",
  "HIVE_MIGRATION_FAILED_HISTORY",
  "connection refused",
]) {
  test(`preflight failure stops deployment and redacts child output (${marker})`, async () => {
    let calls = 0;
    await assert.rejects(
      migrate({
        databaseUrl,
        execute: async () => {
          calls++;
          return { code: 1, output: `${marker} ${databaseUrl}` };
        },
        log: () => {},
      }),
      (error) => {
        assert.ok(!error.message.includes("secret"));
        assert.ok(error.message.includes("docs/deployment.md#existing-database-baseline-adoption"));
        if (marker.startsWith("HIVE_")) assert.ok(error.message.includes(marker));
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}

test("a preflight subprocess failure cannot proceed to deployment", async () => {
  let calls = 0;
  await assert.rejects(
    migrate({
      databaseUrl,
      execute: async () => {
        calls++;
        throw new Error(databaseUrl);
      },
      log: () => {},
    }),
    /preflight could not run/,
  );
  assert.equal(calls, 1);
});

test("deployment failures report only a Prisma error code", async () => {
  let calls = 0;
  await assert.rejects(
    migrate({
      databaseUrl,
      execute: async () => (++calls === 1 ? success : { code: 1, output: `P3009 ${databaseUrl}` }),
      log: () => {},
    }),
    (error) => error.message.includes("P3009") && !error.message.includes("secret"),
  );
});

test("subprocess output retention is bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hive-migrate-output-"));
  try {
    const cli = join(directory, "fixture.mjs");
    await writeFile(
      cli,
      'process.stdin.resume(); process.stderr.write("x".repeat(100000), () => process.exit(1));',
    );
    const result = await executePrisma({ prismaCli: cli, databaseUrl, args: [] });
    assert.equal(result.code, 1);
    assert.ok(result.output.length <= 16384);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
