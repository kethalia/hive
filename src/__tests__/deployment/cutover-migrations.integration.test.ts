import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@hive/db";
import { describe, expect, it } from "vitest";
import { migrate } from "../../../services/migrate/src/migrate.mjs";
import { runtimeGrantsSql, runtimeTables } from "../../../services/migrate/src/runtime-grants.mjs";

const connection = process.env.HIVE_CUTOVER_MIGRATIONS_TEST_DATABASE_URL;
if (connection) {
  const u = new URL(connection);
  if (
    u.hostname !== "127.0.0.1" ||
    u.port !== "55439" ||
    u.pathname !== "/hive_cutover_migrations_20261113" ||
    u.username !== "coder"
  )
    throw Error("Only the dedicated local cutover fixture is allowed");
}
const suite = connection ? describe : describe.skip;
const run = promisify(execFile);
const root = process.cwd(),
  schemaPath = resolve(root, "packages/db/prisma/schema.prisma");
const runtime = "hive_cutover_fixture_runtime_20261113",
  other = "hive_cutover_fixture_other_20261113";
const user = "10000000-0000-4000-8000-000000000001",
  coder = "20000000-0000-4000-8000-000000000002",
  source = "30000000-0000-4000-8000-000000000003";
const oldTables = [
  "users",
  "coder_tokens",
  "sessions",
  "push_subscriptions",
  "navigation_favorites",
  "vapid_keys",
  "notification_sources",
];
async function sql(text: string, url = connection as string) {
  const u = new URL(url);
  const { stdout } = await run("psql", ["-XAtq", "-v", "ON_ERROR_STOP=1", "-c", text], {
    env: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port,
      PGDATABASE: u.pathname.slice(1),
      PGUSER: u.username,
      PGPASSWORD: "",
      PGOPTIONS: "-c statement_timeout=10000",
    },
    maxBuffer: 1048576,
  });
  return stdout.trim();
}
const seed = `
 INSERT INTO users(id,coder_url,coder_user_id,username,email,updated_at) VALUES('${user}','https://coder.fixture.invalid','${coder}','old-user','fixture@example.invalid',now());
 INSERT INTO coder_tokens(id,user_id,ciphertext,iv,auth_tag,expires_at,updated_at) VALUES('${coder}','${user}',decode('00ffdeadbeef','hex'),decode('010203040506','hex'),decode('aabbccdd','hex'),now()+interval '1 day',now());
 INSERT INTO sessions(id,session_id,user_id,expires_at) VALUES('${user}','${coder}','${user}',now()+interval '1 day');
 INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,preferences) VALUES('${user}','${user}','https://push.fixture.invalid/retained','old-public-key','old-auth-bytes','{"agent":true}');
 INSERT INTO navigation_favorites(id,user_id,kind,workspace_id,target_key,label,relative_path,position) VALUES('${user}','${user}','terminal','workspace','session','old-label','/workspace',3);
 INSERT INTO vapid_keys(id,public_key,private_key) VALUES(1,'old-vapid-public','old-vapid-private');
 INSERT INTO notification_sources(id,user_id,workspace_id,workspace_name,token_hash,pending_token_hash,credential_generation) VALUES('${source}','${user}','${coder}','old-workspace',repeat('a',64),repeat('b',64),2);
`;
async function snapshot(schema: string, upgraded = false) {
  const result: Record<string, unknown> = {};
  for (const table of oldTables) {
    const value =
      table === "coder_tokens" && upgraded
        ? "to_jsonb(t)-ARRAY['rotation_next_at','rotation_lease_id','rotation_lease_until','rotation_state','warning_next_at']"
        : "to_jsonb(t)";
    result[table] = JSON.parse(
      await sql(
        `SELECT coalesce(jsonb_agg(${value} ORDER BY id),'[]'::jsonb) FROM ${schema}.${table} t`,
      ),
    );
  }
  return result;
}
suite("eleven-migration cutover and runtime permissions", () => {
  it("fresh + seeded seven-migration upgrade preserve bytes and enforce runtime/constraint boundaries", async () => {
    const identity = JSON.parse(
      await sql(
        "SELECT json_build_object('database',current_database(),'role',current_user,'oid',(SELECT oid FROM pg_database WHERE datname=current_database()))",
      ),
    );
    identity.oid = Number(identity.oid);
    expect(Number.isSafeInteger(identity.oid)).toBe(true);
    expect(identity.database).toBe("hive_cutover_migrations_20261113");
    expect(identity.role).toBe("coder");
    expect(
      await sql(
        `SELECT count(*) FROM pg_roles WHERE rolname IN ('${runtime}','${other}') AND rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)`,
      ),
    ).toBe("2");
    await sql(
      "DROP SCHEMA IF EXISTS upgrade_fixture CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE SCHEMA upgrade_fixture;",
    );
    const temp = await mkdtemp(join(tmpdir(), "hive-seven-migrations-"));
    try {
      const names = (await readdir(resolve(root, "packages/db/prisma/migrations")))
        .filter((name) => name !== "migration_lock.toml")
        .sort();
      expect(names).toHaveLength(11);
      await mkdir(join(temp, "migrations"));
      await cp(schemaPath, join(temp, "schema.prisma"));
      await cp(
        resolve(root, "packages/db/prisma/migrations/migration_lock.toml"),
        join(temp, "migrations/migration_lock.toml"),
      );
      for (const name of names.slice(0, 7))
        await cp(
          resolve(root, "packages/db/prisma/migrations", name),
          join(temp, "migrations", name),
          { recursive: true },
        );
      const upgrade = new URL(connection as string);
      upgrade.searchParams.set("schema", "upgrade_fixture");
      await migrate({ databaseUrl: connection, schemaPath, log: () => {} });
      await migrate({
        databaseUrl: upgrade.href,
        schemaPath: join(temp, "schema.prisma"),
        log: () => {},
      });
      await sql(`SET search_path=upgrade_fixture;${seed}`);
      const before = await snapshot("upgrade_fixture");
      const historyBefore = JSON.parse(
        await sql(
          "SELECT json_agg(t ORDER BY migration_name) FROM upgrade_fixture._prisma_migrations t",
        ),
      );
      await migrate({ databaseUrl: upgrade.href, schemaPath, log: () => {} });
      expect(await snapshot("upgrade_fixture", true)).toEqual(before);
      const historyAfter = JSON.parse(
        await sql(
          "SELECT json_agg(t ORDER BY migration_name) FROM upgrade_fixture._prisma_migrations t",
        ),
      );
      expect(historyAfter.slice(0, 7)).toEqual(historyBefore);
      for (const schema of ["public", "upgrade_fixture"]) {
        const history = JSON.parse(
          await sql(
            `SELECT json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY migration_name) FROM ${schema}._prisma_migrations`,
          ),
        );
        expect(history.map((row: { name: string }) => row.name)).toEqual(names);
        for (let i = 0; i < names.length; i++)
          expect(history[i]).toEqual({
            name: names[i],
            checksum: createHash("sha256")
              .update(
                await readFile(
                  resolve(root, "packages/db/prisma/migrations", names[i], "migration.sql"),
                ),
              )
              .digest("hex"),
            finished: true,
            rolledBack: false,
          });
      }
      // Current generated Node client selects the newly added columns from old rows.
      const client = new PrismaClient({ datasourceUrl: upgrade.href });
      try {
        const token = await client.coderToken.findUniqueOrThrow({ where: { userId: user } });
        expect(Buffer.from(token.ciphertext).toString("hex")).toBe("00ffdeadbeef");
        expect(token.rotationNextAt).toBeInstanceOf(Date);
        expect(token.rotationState).toBeNull();
        expect(token.rotationLeaseId).toBeNull();
        expect(
          (await client.session.findUniqueOrThrow({ where: { sessionId: coder } })).userId,
        ).toBe(user);
        expect((await client.vapidKeys.findUniqueOrThrow({ where: { id: 1 } })).privateKey).toBe(
          "old-vapid-private",
        );
      } finally {
        await client.$disconnect();
      }
      await sql(seed);
      const freshBefore = await snapshot("public", true);
      // Reproduce current production blanket defaults and opposite-environment grants.
      await sql(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${runtime}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${runtime}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${runtime},${other}; GRANT USAGE ON SCHEMA public TO ${other};`,
      );
      await expect(sql(runtimeGrantsSql("local-test", identity.oid + 1))).rejects.toThrow();
      await sql(runtimeGrantsSql("local-test", identity.oid));
      await sql(runtimeGrantsSql("local-test", identity.oid)); // exact reapplication is harmless
      expect(await snapshot("public", true)).toEqual(freshBefore);
      const runUrl = new URL(connection as string);
      runUrl.username = runtime;
      const q = (text: string) => sql(text, runUrl.href);
      const tables = Object.values(runtimeTables).flat();
      expect(tables).toHaveLength(13);
      for (const table of tables) {
        expect(
          await q(
            `SELECT has_table_privilege(current_user,'public.${table}','SELECT') AND has_table_privilege(current_user,'public.${table}','INSERT')`,
          ),
        ).toBe("t");
        await q(`SELECT count(*) FROM public.${table}`);
        const privileges = JSON.parse(
          await q(
            `SELECT json_build_object('update',has_table_privilege(current_user,'public.${table}','UPDATE'),'delete',has_table_privilege(current_user,'public.${table}','DELETE'),'admin',has_table_privilege(current_user,'public.${table}','TRUNCATE,REFERENCES,TRIGGER'))`,
          ),
        );
        expect(privileges).toEqual({
          update: table !== "terminal_events",
          delete: [...runtimeTables.deletable, ...runtimeTables.appendAndDelete].includes(table),
          admin: false,
        });
      }
      const runtimeClient = new PrismaClient({ datasourceUrl: runUrl.href });
      try {
        const token = await runtimeClient.coderToken.findUniqueOrThrow({ where: { userId: user } });
        expect(Buffer.from(token.ciphertext).toString("hex")).toBe("00ffdeadbeef");
        expect(token.rotationNextAt).toBeInstanceOf(Date);
        expect(
          (await runtimeClient.vapidKeys.findUniqueOrThrow({ where: { id: 1 } })).privateKey,
        ).toBe("old-vapid-private");
      } finally {
        await runtimeClient.$disconnect();
      }
      expect(
        await sql(
          `SELECT count(*) FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='${runtime}') AND d.datname<>current_database()`,
        ),
      ).toBe("0");
      // Real inserts/updates/deletes, sequence use, immutable identities and bounds.
      await q(
        `UPDATE users SET username='updated-fixture' WHERE id='${user}'; UPDATE coder_tokens SET rotation_next_at=now(),rotation_lease_id='${source}',rotation_lease_until=now()+interval '1 minute',rotation_state='{}' WHERE user_id='${user}';`,
      );
      await expect(
        q(`UPDATE coder_tokens SET rotation_lease_id=NULL WHERE user_id='${user}'`),
      ).rejects.toThrow();
      await q(
        `INSERT INTO agent_notification_events(id,owner_id,source_id,event_id,event_key,payload,payload_digest,coder_user_id,coder_origin) VALUES('${user}','${user}','${source}','${coder}','event-1','{}',repeat('c',64),'${coder}','https://coder.fixture.invalid');`,
      );
      await expect(
        q(`UPDATE agent_notification_events SET payload='{"changed":true}' WHERE id='${user}'`),
      ).rejects.toThrow();
      await q(
        `UPDATE agent_notification_events SET status='processing',attempts=1,next_attempt_at=now()+interval '1 minute' WHERE id='${user}'; UPDATE agent_notification_events SET status='delivered' WHERE id='${user}';`,
      );
      await expect(
        q(`UPDATE agent_notification_events SET status='pending' WHERE id='${user}'`),
      ).rejects.toThrow();
      await q(
        `INSERT INTO agent_notification_rate_windows VALUES('${source}','${user}',now(),1); UPDATE agent_notification_rate_windows SET accepted=2 WHERE source_id='${source}'; DELETE FROM agent_notification_rate_windows WHERE source_id='${source}';`,
      );
      await q(
        `INSERT INTO template_jobs(id,owner_id,request_id,coder_user_id,session_id,origin,organization_id,name,artifact,state,deadline) VALUES('${user}','${user}','${coder}','${coder}','${source}','https://coder.fixture.invalid','${coder}','ai-dev-k8s','{}','{}',now()+interval '10 minutes'); UPDATE template_jobs SET phase='succeeded' WHERE id='${user}'; INSERT INTO template_notices(id,owner_id,job_id) VALUES('${user}','${user}','${user}'); UPDATE template_notices SET status='delivered' WHERE id='${user}';`,
      );
      await expect(
        q(`UPDATE template_jobs SET phase='queued' WHERE id='${user}'`),
      ).rejects.toThrow();
      await expect(
        q(`UPDATE template_jobs SET owner_id='${coder}' WHERE id='${user}'`),
      ).rejects.toThrow();
      await q(
        `INSERT INTO terminal_connections(id,user_id,coder_user_id,coder_origin,workspace_id,build_id,agent_id,session_name,session_kind,authority_expires_at,lease_until,health) VALUES('${user}','${user}','${coder}','https://coder.fixture.invalid','${source}','${source}','${source}','main','terminal',now()+interval '5 minutes',now()+interval '1 minute','{}'); UPDATE terminal_connections SET health='{"ok":true}' WHERE id='${user}'; INSERT INTO terminal_events(user_id,coder_user_id,coder_origin,workspace_id,connection_id,session_name,session_kind,level,type,details) VALUES('${user}','${coder}','https://coder.fixture.invalid','${source}','${user}','main','terminal','info','opened','{}'); DELETE FROM terminal_events; DELETE FROM terminal_connections;`,
      );
      await expect(
        q(
          `INSERT INTO terminal_events(user_id,coder_user_id,coder_origin,workspace_id,connection_id,session_name,session_kind,level,type,details) VALUES('${user}','${coder}','https://coder.fixture.invalid','${source}','${user}','main','terminal','debug','opened','{}')`,
        ),
      ).rejects.toThrow();
      await q(
        `DELETE FROM agent_notification_events; DELETE FROM sessions; DELETE FROM push_subscriptions; DELETE FROM navigation_favorites; DELETE FROM notification_sources;`,
      );
      for (const forbidden of [
        "SELECT * FROM public._prisma_migrations",
        "TRUNCATE users",
        "CREATE TABLE public.unauthorized(id int)",
        "CREATE SCHEMA unauthorized",
        "CREATE TEMP TABLE unauthorized(id int)",
        "ALTER TABLE users ADD COLUMN unauthorized int",
        "ALTER ROLE hive_cutover_fixture_runtime_20261113 CREATEDB",
        "DELETE FROM template_jobs",
        "UPDATE terminal_events SET type='changed'",
        "SELECT setval('terminal_events_id_seq',100)",
      ])
        await expect(q(forbidden)).rejects.toThrow();
      expect(
        await q(
          "SELECT has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY') OR has_schema_privilege(current_user,'public','CREATE')",
        ),
      ).toBe("f");
      await sql("CREATE TABLE public.future_fixture(id int)");
      await expect(q("SELECT * FROM public.future_fixture")).rejects.toThrow();
      await sql("DROP TABLE public.future_fixture");
      const otherUrl = new URL(connection as string);
      otherUrl.username = other;
      await expect(sql("SELECT * FROM public.users", otherUrl.href)).rejects.toThrow();
      // The selected role received no grant on the separate upgrade schema.
      await expect(q("SELECT * FROM upgrade_fixture.users")).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 180000);
});
