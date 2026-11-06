import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { PrismaClient } from "../../../../packages/db/src/generated/prisma/client.ts";
import { digest } from "../../src/delivery/contracts.mjs";
import { advanceDatabaseChange } from "../../src/delivery/job.mjs";
import { createDeliveryMigrationController } from "../../src/delivery/runner.mjs";

const url = process.env.HIVE_D10_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(u.hostname));
  assert.equal(u.pathname, "/hive_d10_test");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_d10_test",
});
const admin = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_d10_test",
});
const evidence = [];
before(async () => {
  if (!url) return;
  const found = await db.$queryRawUnsafe(
    "SELECT to_regnamespace('hive_delivery_db')::text AS name",
  );
  if (!found[0].name)
    execFileSync("/usr/bin/psql", [url, "-X", "-v", "ON_ERROR_STOP=1"], {
      input: readFileSync(new URL("../../src/delivery/ledger.sql", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    });
});
after(async () => {
  await db.$disconnect();
  await admin.$disconnect();
  if (process.env.HIVE_D10_EVIDENCE_PATH)
    writeFileSync(
      process.env.HIVE_D10_EVIDENCE_PATH,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fixture: "local PostgreSQL synthetic target only",
          observations: evidence,
          liveProviderWrites: false,
        },
        null,
        2,
      )}\n`,
    );
});
async function fixture({ rows = 11, authorizeHook, observerHook, slow = false } = {}) {
  const table = `d10_${randomUUID().replaceAll("-", "")}`;
  await db.$executeRawUnsafe(
    `CREATE TABLE public.${table}(id bigint PRIMARY KEY,legacy_value text NOT NULL)`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO public.${table} SELECT n,'value-'||n FROM generate_series(1,$1::integer) n`,
    rows,
  );
  const schemaSql = `SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_object('name',attname,'type',format_type(atttypid,atttypmod),'notnull',attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.${table}'::regclass AND attnum>0 AND NOT attisdropped),'triggers',(SELECT coalesce(jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname),'[]'::jsonb) FROM pg_trigger WHERE tgrelid='public.${table}'::regclass AND NOT tgisinternal),'functions',(SELECT coalesce(jsonb_agg(pg_get_functiondef(oid) ORDER BY proname),'[]'::jsonb) FROM pg_proc WHERE proname='${table}_dual')) AS schema`;
  const expandSql = [
    `ALTER TABLE public.${table} ADD COLUMN normalized_value text`,
    `CREATE FUNCTION public.${table}_dual() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.normalized_value=upper(NEW.legacy_value);RETURN NEW;END $$`,
    `CREATE TRIGGER dual_write BEFORE INSERT OR UPDATE OF legacy_value ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${table}_dual()`,
  ];
  const beforeSchemaDigest = digest(await db.$queryRawUnsafe(schemaSql));
  let afterSchemaDigest;
  await assert.rejects(
    db.$transaction(async (tx) => {
      for (const sql of expandSql) await tx.$executeRawUnsafe(sql);
      afterSchemaDigest = digest(await tx.$queryRawUnsafe(schemaSql));
      throw Error("fixture_schema_preview_rollback");
    }),
    /fixture_schema_preview_rollback/,
  );
  const scope = {
    ownerId: randomUUID(),
    repositoryId: "123",
    environmentKey: "local-fixture",
    targetId: randomUUID(),
    databaseName: "hive_d10_test",
  };
  const plan = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: "a".repeat(40),
    oldAppDigest: "b".repeat(64),
    newAppDigest: "c".repeat(64),
    compatibilityDigest: "d".repeat(64),
    beforeSchemaDigest,
    afterSchemaDigest,
    batchSize: 3,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 100,
    schemaSql,
    expandSql,
    highWaterSql: `SELECT coalesce(max(id),0)::text AS high_water FROM public.${table}`,
    batchSql: `WITH delay AS MATERIALIZED (SELECT pg_sleep(${slow ? 2 : 0})), chosen AS (SELECT id FROM public.${table}, delay WHERE id>$1::bigint AND id<=$2::bigint ORDER BY id LIMIT $3::integer FOR UPDATE), changed AS (UPDATE public.${table} d SET normalized_value=upper(d.legacy_value) FROM chosen c WHERE d.id=c.id RETURNING d.id) SELECT id::text AS key FROM changed ORDER BY id`,
    integrityTables: [{ schema: "public", name: table }],
    integritySql: `SELECT count(*) FILTER(WHERE normalized_value IS DISTINCT FROM upper(legacy_value))::text AS violations,count(*)::text AS total_rows FROM public.${table}`,
  };
  const options = {
    enabled: true,
    db,
    scope,
    plan,
    expectedPlanDigest: digest(plan),
    authorize: async ({ tx, action, runId }) => {
      await authorizeHook?.({ tx, action });
      return {
        scopeDigest: digest(scope),
        planDigest: digest(plan),
        runId,
        action,
        expiresAt: Date.now() + 20000,
        authorityDigest: "e".repeat(64),
      };
    },
    observeDeployment: async ({ expected }) => {
      await observerHook?.(expected);
      return {
        ...expected,
        observedAt: Date.now() - 1,
        expiresAt: Date.now() + 20000,
        receiptDigest: digest(expected),
      };
    },
  };
  const controller = createDeliveryMigrationController(options),
    runId = randomUUID();
  await controller.begin(runId);
  return { table, scope, plan, options, controller, runId };
}
async function compatible(f) {
  await f.controller.tick(f.runId, "expand");
  await f.controller.tick(f.runId, "compatible");
}
async function backfill(f) {
  let result;
  for (let n = 0; n < 20; n++) {
    result = await f.controller.tick(f.runId, "backfill");
    if (result.phase === "backfilled") return result;
  }
  throw Error("bounded_fixture_batches_exhausted");
}
const local = (name, fn) => test(name, { skip: !url }, fn);
local(
  "compatible expansion, bounded backfill, integrity and activation preserve old and new clients; contraction holds",
  async () => {
    const f = await fixture();
    await assert.rejects(f.controller.tick(f.runId, "backfill"), /dependency_pending/);
    await compatible(f);
    // Mixed old writer/new reader: reviewed trigger preserves new representation.
    await db.$executeRawUnsafe(
      `UPDATE public.${f.table} SET legacy_value='changed-by-old-client' WHERE id=1`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO public.${f.table}(id,legacy_value) VALUES(12,'new-write')`,
    );
    let report = await backfill(f);
    assert.equal(report.changedRows, "11");
    assert.equal(report.highWater, "11");
    assert.equal(
      (await db.$queryRawUnsafe(`SELECT normalized_value FROM public.${f.table} WHERE id=12`))[0]
        .normalized_value,
      "NEW-WRITE",
    );
    report = await f.controller.tick(f.runId, "integrity");
    assert.equal(report.integrity.violations, "0");
    assert.equal(report.integrity.totalRows, "12");
    report = await f.controller.tick(f.runId, "activate");
    assert.equal(report.phase, "activated");
    report = await f.controller.tick(f.runId, "contract");
    assert.equal(report.phase, "contract_held");
    assert.equal(report.contractAuthorized, false);
    assert.equal(
      (await db.$queryRawUnsafe(`SELECT legacy_value FROM public.${f.table} WHERE id=1`))[0]
        .legacy_value,
      "changed-by-old-client",
    );
    assert.equal(digest(await db.$queryRawUnsafe(f.plan.schemaSql)), f.plan.afterSchemaDigest);
    evidence.push({ case: "expand-backfill-integrity-activate-contract-hold", ...report });
  },
);
local(
  "terminating only the recorded in-flight backend rolls back data and checkpoint; restart resumes",
  async () => {
    let waiting, release;
    const blocked = new Promise((r) => (waiting = r)),
      resume = new Promise((r) => (release = r));
    let calls = 0,
      armed = false;
    const f = await fixture({
      authorizeHook: async ({ tx, action }) => {
        if (armed && action === "backfill" && ++calls === 2) {
          await tx.$executeRawUnsafe(
            "SELECT set_config('application_name','hive-d10-interruption-fixture',true)",
          );
          const identity = (
            await tx.$queryRawUnsafe(
              "SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()",
            )
          )[0];
          waiting(identity);
          await resume;
        }
      },
    });
    await compatible(f);
    armed = true;
    const operation = f.controller.tick(f.runId, "backfill");
    const rejected = assert.rejects(operation);
    const identity = await blocked;
    const killed = await admin.$queryRawUnsafe(
      "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datname='hive_d10_test' AND application_name='hive-d10-interruption-fixture'",
      identity.pid,
      identity.started,
    );
    assert.equal(killed[0]?.killed, true);
    release();
    await rejected;
    armed = false;
    const before = await f.controller.read(f.runId);
    assert.equal(before.cursor, "0");
    assert.equal(before.changedRows, "0");
    assert.equal(
      (
        await db.$queryRawUnsafe(
          `SELECT count(*)::text AS n FROM public.${f.table} WHERE normalized_value IS NOT NULL`,
        )
      )[0].n,
      "0",
    );
    f.controller = createDeliveryMigrationController(f.options);
    const completed = await backfill(f);
    assert.equal(completed.changedRows, "11");
    evidence.push({
      case: "backend-termination-rollback-resume",
      backendIdentity: identity,
      checkpointBefore: before.checkpointDigest,
      finalCursor: completed.cursor,
      changedRows: completed.changedRows,
    });
  },
);
local("lost batch acknowledgement and reconstructed controller do not repeat effects", async () => {
  const f = await fixture();
  await compatible(f);
  await f.controller.tick(f.runId, "backfill"); // discard ACK
  f.controller = createDeliveryMigrationController(f.options);
  const checkpoint = await f.controller.read(f.runId);
  assert.equal(checkpoint.cursor, "3");
  assert.equal(checkpoint.changedRows, "3");
  const completed = await backfill(f);
  assert.equal(completed.changedRows, "11");
  const again = await f.controller.tick(f.runId, "backfill");
  assert.deepEqual(again, completed);
  evidence.push({
    case: "lost-ack-restart",
    initialCursor: checkpoint.cursor,
    finalCursor: completed.cursor,
    changedRows: completed.changedRows,
  });
});
local(
  "database-scoped lock rejects concurrent runner without waiting for its effects",
  async () => {
    let entered, release;
    const waiting = new Promise((r) => (entered = r)),
      resume = new Promise((r) => (release = r));
    let armed = false;
    const f = await fixture({
      authorizeHook: async ({ action }) => {
        if (armed && action === "backfill") {
          armed = false;
          entered();
          await resume;
        }
      },
    });
    await compatible(f);
    armed = true;
    const first = f.controller.tick(f.runId, "backfill");
    await waiting;
    await assert.rejects(
      createDeliveryMigrationController(f.options).tick(f.runId, "backfill"),
      /migration_(database|prisma)_busy/,
    );
    release();
    await first;
    assert.equal((await f.controller.read(f.runId)).cursor, "3");
  },
);
local(
  "integrity is rechecked before activation and bad data cannot pass cached success",
  async () => {
    const f = await fixture();
    await compatible(f);
    await backfill(f);
    await f.controller.tick(f.runId, "integrity");
    await db.$executeRawUnsafe(
      `UPDATE public.${f.table} SET normalized_value='corrupted' WHERE id=1`,
    );
    await assert.rejects(f.controller.tick(f.runId, "activate"), /integrity_failed/);
    assert.equal((await f.controller.read(f.runId)).phase, "verified");
  },
);
local(
  "cancellation after SQL writes rolls the entire batch back and leaves the next safe boundary",
  async () => {
    let armed = false,
      calls = 0;
    const abort = new AbortController();
    const f = await fixture({
      authorizeHook: async ({ action }) => {
        if (armed && action === "backfill" && ++calls === 2) abort.abort();
      },
    });
    await compatible(f);
    armed = true;
    await assert.rejects(
      f.controller.tick(f.runId, "backfill", { signal: abort.signal }),
      /interrupted/,
    );
    armed = false;
    assert.equal((await f.controller.read(f.runId)).cursor, "0");
    assert.equal(
      (
        await db.$queryRawUnsafe(
          `SELECT count(*)::text AS n FROM public.${f.table} WHERE normalized_value IS NOT NULL`,
        )
      )[0].n,
      "0",
    );
  },
);
local(
  "schema drift and a substituted catalog fail closed without changing checkpoints",
  async () => {
    const f = await fixture();
    await compatible(f);
    const old = await f.controller.read(f.runId);
    assert.throws(
      () => createDeliveryMigrationController({ ...f.options, plan: { ...f.plan, batchSize: 4 } }),
      /catalog_unverified/,
    );
    await db.$executeRawUnsafe(`ALTER TABLE public.${f.table} ADD COLUMN unexpected text`);
    await assert.rejects(f.controller.tick(f.runId, "backfill"), /schema_changed/);
    assert.equal((await f.controller.read(f.runId)).checkpointDigest, old.checkpointDigest);
  },
);
local(
  "automatic bounded job yields checkpoints then fresh activation readiness, never contraction",
  async () => {
    const f = await fixture();
    const first = await advanceDatabaseChange({
      controller: f.controller,
      runId: f.runId,
      maxTicks: 3,
    });
    assert.equal(first.phase, "checkpointed");
    assert.equal(first.state.cursor, "3");
    const done = await advanceDatabaseChange({
      controller: createDeliveryMigrationController(f.options),
      runId: f.runId,
    });
    assert.equal(done.phase, "activation_ready");
    assert.equal(done.certificate.activationAuthorized, false);
    assert.equal(done.certificate.scope.targetId, f.scope.targetId);
    assert.equal(done.certificate.integrity.violations, "0");
    assert.ok(
      done.certificate.expiresAt > done.certificate.observedAt &&
        done.certificate.expiresAt - done.certificate.observedAt <= 20000,
    );
    await db.$executeRawUnsafe(
      `UPDATE public.${f.table} SET normalized_value='later-drift' WHERE id=1`,
    );
    await assert.rejects(f.controller.certificate(f.runId), /integrity_failed/);
    evidence.push({
      case: "bounded-automatic-job",
      firstCursor: first.state.cursor,
      ready: done.phase,
      certificate: done.certificate,
    });
  },
);
local("fresh empty target completes initialization without fabricated rows", async () => {
  const f = await fixture({ rows: 0 });
  const done = await advanceDatabaseChange({ controller: f.controller, runId: f.runId });
  assert.equal(done.phase, "activation_ready");
  assert.equal(done.state.changedRows, "0");
  assert.equal(done.certificate.integrity.totalRows, "0");
});
local("actual statement timeout rolls back oversized-duration batch", async () => {
  const f = await fixture({ slow: true });
  await compatible(f);
  const start = performance.now();
  await assert.rejects(f.controller.tick(f.runId, "backfill"), /statement timeout/);
  assert.ok(performance.now() - start < 2500);
  assert.equal((await f.controller.read(f.runId)).cursor, "0");
  evidence.push({
    case: "statement-deadline",
    elapsedMs: Math.round(performance.now() - start),
    cursor: "0",
  });
});
local("expired authority after mutations rolls back checkpoint and data", async () => {
  const f = await fixture();
  await compatible(f);
  let calls = 0;
  const controller = createDeliveryMigrationController({
    ...f.options,
    authorize: async (request) => {
      const receipt = await f.options.authorize(request);
      if (request.action === "backfill" && ++calls === 2) receipt.expiresAt = Date.now() - 1;
      return receipt;
    },
  });
  await assert.rejects(controller.tick(f.runId, "backfill"), /authority_unavailable/);
  assert.equal((await f.controller.read(f.runId)).cursor, "0");
  assert.equal(
    (
      await db.$queryRawUnsafe(
        `SELECT count(*)::text AS n FROM public.${f.table} WHERE normalized_value IS NOT NULL`,
      )
    )[0].n,
    "0",
  );
});
local(
  "stalled trusted authority is bounded and cannot retain the database lock indefinitely",
  async () => {
    const f = await fixture();
    await compatible(f);
    const controller = createDeliveryMigrationController({
      ...f.options,
      authorize: () => new Promise(() => {}),
    });
    const start = performance.now();
    await assert.rejects(controller.tick(f.runId, "backfill"), /authority_timeout/);
    assert.ok(performance.now() - start < 6500);
    assert.equal((await f.controller.read(f.runId)).cursor, "0");
  },
);
local("foreign owner and a second run cannot adopt a pending target", async () => {
  const f = await fixture();
  const foreign = createDeliveryMigrationController({
    ...f.options,
    scope: { ...f.scope, ownerId: randomUUID() },
  });
  await assert.rejects(foreign.read(f.runId), /authority_unavailable/);
  const foreignScope = { ...f.scope, ownerId: randomUUID() };
  const authorizedForeign = createDeliveryMigrationController({
    ...f.options,
    scope: foreignScope,
    authorize: async (request) => ({
      ...(await f.options.authorize(request)),
      scopeDigest: digest(foreignScope),
    }),
  });
  await assert.rejects(authorizedForeign.read(f.runId), /generation_changed/);
  await assert.rejects(f.controller.begin(randomUUID()), /previous_run_pending/);
  assert.equal((await f.controller.read(f.runId)).phase, "pending");
});
local(
  "wrong deployment app digest cannot authorize backfill and events stay immutable",
  async () => {
    const f = await fixture();
    await f.controller.tick(f.runId, "expand");
    const controller = createDeliveryMigrationController({
      ...f.options,
      observeDeployment: async (request) => ({
        ...(await f.options.observeDeployment(request)),
        newAppDigest: "0".repeat(64),
      }),
    });
    await assert.rejects(controller.tick(f.runId, "compatible"), /deployment_scope_changed/);
    assert.equal((await f.controller.read(f.runId)).phase, "expanded");
    await assert.rejects(
      db.$executeRawUnsafe(
        "UPDATE hive_delivery_db.events SET kind='changed' WHERE run_id=$1::uuid",
        f.runId,
      ),
      /history is immutable/,
    );
  },
);
local(
  "fresh certificate and activation hold complete-table writer fences across observer waits",
  async () => {
    const f = await fixture();
    await compatible(f);
    await backfill(f);
    await f.controller.tick(f.runId, "integrity");
    const blocked = [];
    const controller = createDeliveryMigrationController({
      ...f.options,
      observeDeployment: async (request) => {
        for (const [kind, sql] of [
          ["violating_update", `UPDATE public.${f.table} SET normalized_value='bad' WHERE id=1`],
          [
            "concurrent_insert",
            `INSERT INTO public.${f.table}(id,legacy_value) VALUES(999,'late')`,
          ],
        ]) {
          await assert.rejects(
            admin.$transaction(async (tx) => {
              await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
              await tx.$executeRawUnsafe(sql);
            }),
            /lock timeout/,
          );
          blocked.push(`${request.expected.kind}:${kind}`);
        }
        return f.options.observeDeployment(request);
      },
    });
    const certificate = await controller.certificate(f.runId);
    assert.equal(certificate.integrity.violations, "0");
    await controller.tick(f.runId, "activate");
    assert.equal(blocked.length, 4);
    // The certificate is point-in-time only: after commit a privileged writer can
    // violate this fixture's non-enforced invariant; a fresh certificate refuses.
    await db.$executeRawUnsafe(`UPDATE public.${f.table} SET normalized_value='bad' WHERE id=1`);
    await assert.rejects(controller.certificate(f.runId), /integrity_failed/);
    evidence.push({ case: "observer_write_fences", blocked, afterCommitDriftRejected: true });
  },
);
local(
  "deployment observation expiring during final authorization cannot advance durable phase",
  async () => {
    const f = await fixture();
    await f.controller.tick(f.runId, "expand");
    let calls = 0;
    const controller = createDeliveryMigrationController({
      ...f.options,
      authorize: async (request) => {
        if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 200));
        return f.options.authorize(request);
      },
      observeDeployment: async (request) => ({
        ...(await f.options.observeDeployment(request)),
        expiresAt: Date.now() + 100,
      }),
    });
    await assert.rejects(controller.tick(f.runId, "compatible"), /deployment_receipt_stale/);
    assert.equal((await f.controller.read(f.runId)).phase, "expanded");
  },
);
