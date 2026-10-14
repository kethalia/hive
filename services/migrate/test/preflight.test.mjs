import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executePrisma, migrate, migrationSchema, preflightSql } from "../src/migrate.mjs";

const databaseUrl = "postgresql://fixture:secret@localhost/hive";
const success = { code: 0, output: "" };

test("defaults to public and honors a custom schema", () => {
  assert.equal(migrationSchema(databaseUrl), "public");
  assert.equal(migrationSchema(`${databaseUrl}?schema=tenant%22blue`), 'tenant"blue');
});

for (const invalid of [
  null,
  "invalid",
  "file:///db",
  `${databaseUrl}?schema=`,
  `${databaseUrl}?schema=a&schema=b`,
  `${databaseUrl}?schema=%00`,
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
