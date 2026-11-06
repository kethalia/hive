// F08 local rehearsal only. This module is inert when imported; caller must
// explicitly invoke setup after review. Never import into deployed Workers.
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve("services/migrate/package.json"));
const pg = require("pg");
const tables = [
  { name: "users", ownerColumn: "id", grants: "SELECT, INSERT" },
  { name: "sessions", ownerColumn: "user_id", grants: "SELECT, INSERT, DELETE" },
  { name: "coder_tokens", ownerColumn: "user_id", grants: "SELECT, INSERT, DELETE" },
  { name: "delivery_projects", ownerColumn: "owner_id", grants: "SELECT, INSERT, DELETE" },
  { name: "delivery_tasks", ownerColumn: "owner_id", grants: "SELECT, INSERT, DELETE" },
  { name: "delivery_steps", ownerColumn: "owner_id", grants: "SELECT" },
];
export async function setupF08Role({ ownerFile, runtimeFile, checkpointFile, fixtureId }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fixtureId))
    throw Error("f08_fixture_id_invalid");
  const pooled = new URL((await readFile(ownerFile, "utf8")).trim());
  if (
    pooled.pathname !== "/hive_production_rehearsal_20261105" ||
    createHash("sha256").update(pooled.hostname.replace("-pooler.", ".")).digest("hex") !==
      "0c2e055f1031ffce660a74f2483fadcbf7a15033a61f4158dc5f3c3c8e8cd933"
  )
    throw Error("f08_database_scope");
  const direct = new URL(pooled);
  direct.hostname = direct.hostname.replace("-pooler.", ".");
  const suffix = randomBytes(8).toString("hex"),
    role = `hive_f08_${suffix}`,
    password = randomBytes(32).toString("hex");
  const runtime = new URL(pooled);
  runtime.username = role;
  runtime.password = password;
  const checkpoint = {
    schemaVersion: 1,
    role,
    fixtureId,
    database: "hive_production_rehearsal_20261105",
    directHostname: direct.hostname,
    tables: tables.map(({ name }) => name),
  };
  await writeFile(runtimeFile, runtime.toString(), { mode: 0o600, flag: "wx" });
  await writeFile(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600, flag: "wx" });
  const c = new pg.Client({ connectionString: direct.toString(), connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    const identity = (await c.query("SELECT current_database() AS database, current_user AS role"))
      .rows[0];
    if (
      identity.database !== "hive_production_rehearsal_20261105" ||
      identity.role !== "hive_epic_owner"
    )
      throw Error("f08_owner_identity_changed");
    await c.query("BEGIN");
    for (const t of tables) {
      const found = await c.query(
        `SELECT EXISTS (SELECT 1 FROM public."${t.name}" WHERE "${t.ownerColumn}"=$1::uuid) AS present`,
        [fixtureId],
      );
      if (found.rows[0].present) throw Error("f08_fixture_identity_collision");
    }
    const state = await c.query(
      "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,(SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",
      [tables.map(({ name }) => name)],
    );
    if (
      state.rows.length !== tables.length ||
      state.rows.some((r) => r.relrowsecurity || r.relforcerowsecurity || r.policies !== 0)
    )
      throw Error("f08_existing_rls_not_supported");
    const roleSql = (
      await c.query(
        "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',$1::text,$2::text) AS sql",
        [role, password],
      )
    ).rows[0].sql;
    await c.query(roleSql);
    await c.query(`GRANT CONNECT ON DATABASE hive_production_rehearsal_20261105 TO "${role}"`);
    await c.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const t of tables) {
      await c.query(`ALTER TABLE public."${t.name}" ENABLE ROW LEVEL SECURITY`);
      await c.query(
        `CREATE POLICY "f08_allow_${suffix}" ON public."${t.name}" AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`,
      );
      await c.query(
        `CREATE POLICY "f08_scope_${suffix}" ON public."${t.name}" AS RESTRICTIVE FOR ALL TO "${role}" USING ("${t.ownerColumn}"='${fixtureId}'::uuid) WITH CHECK ("${t.ownerColumn}"='${fixtureId}'::uuid)`,
      );
      await c.query(`GRANT ${t.grants} ON public."${t.name}" TO "${role}"`);
    }
    await c.query("COMMIT");
    return { role, fixtureId, tableCount: tables.length };
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}

/** Verify effective privileges and isolation as the newly created login, before
 * any fixture rows are inserted. No original row values leave the database. */
export async function verifyF08Role({ runtimeFile, fixtureId }) {
  const u = new URL((await readFile(runtimeFile, "utf8")).trim());
  const hostHash = createHash("sha256").update(u.hostname.replace("-pooler.", ".")).digest("hex");
  if (
    u.pathname !== "/hive_production_rehearsal_20261105" ||
    hostHash !== "0c2e055f1031ffce660a74f2483fadcbf7a15033a61f4158dc5f3c3c8e8cd933" ||
    !/^hive_f08_[a-f0-9]{16}$/.test(u.username) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fixtureId)
  )
    throw Error("f08_runtime_scope");
  const c = new pg.Client({ connectionString: u.toString(), connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const [identity] = (
      await c.query(
        "SELECT current_database() AS database,current_user AS role,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolinherit,r.rolreplication,(SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) AS memberships FROM pg_roles r WHERE r.rolname=current_user",
      )
    ).rows;
    if (
      !identity ||
      identity.database !== "hive_production_rehearsal_20261105" ||
      identity.role !== u.username ||
      identity.rolsuper ||
      identity.rolcreatedb ||
      identity.rolcreaterole ||
      identity.rolbypassrls ||
      identity.rolinherit ||
      identity.rolreplication ||
      identity.memberships !== 0
    )
      throw Error("f08_runtime_identity_changed");
    const policies = await c.query(
      `SELECT p.tablename,p.policyname,p.permissive,p.roles::text[] AS roles,p.cmd,p.qual,p.with_check,c.relrowsecurity,c.relforcerowsecurity FROM pg_policies p JOIN pg_class c ON c.relname=p.tablename JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=p.schemaname WHERE p.schemaname='public' AND p.tablename=ANY($1::text[])`,
      [tables.map(({ name }) => name)],
    );
    const suffix = u.username.slice("hive_f08_".length);
    if (policies.rows.length !== tables.length * 2) throw Error("f08_policy_scope_changed");
    for (const table of tables) {
      const pair = policies.rows.filter((p) => p.tablename === table.name);
      const allow = pair.find((p) => p.policyname === `f08_allow_${suffix}`);
      const restrict = pair.find((p) => p.policyname === `f08_scope_${suffix}`);
      const expression = `(${table.ownerColumn} = '${fixtureId}'::uuid)`;
      if (
        !allow ||
        !restrict ||
        pair.length !== 2 ||
        !allow.relrowsecurity ||
        allow.relforcerowsecurity ||
        allow.permissive !== "PERMISSIVE" ||
        allow.roles?.join() !== "public" ||
        allow.cmd !== "ALL" ||
        allow.qual !== "true" ||
        allow.with_check !== "true" ||
        restrict.permissive !== "RESTRICTIVE" ||
        restrict.roles?.join() !== u.username ||
        restrict.cmd !== "ALL" ||
        restrict.qual !== expression ||
        restrict.with_check !== expression
      )
        throw Error("f08_policy_scope_changed");
    }
    const excluded = [
      "_prisma_migrations",
      "navigation_favorites",
      "notification_sources",
      "push_subscriptions",
      "vapid_keys",
    ];
    const privileges = await c.query(
      "SELECT name,has_table_privilege(current_user,format('public.%I',name),'SELECT') AS can_select,has_table_privilege(current_user,format('public.%I',name),'INSERT') AS can_insert,has_table_privilege(current_user,format('public.%I',name),'UPDATE') AS can_update,has_table_privilege(current_user,format('public.%I',name),'DELETE') AS can_delete FROM unnest($1::text[]) AS name",
      [excluded],
    );
    if (privileges.rows.some((r) => r.can_select || r.can_insert || r.can_update || r.can_delete))
      throw Error("f08_unscoped_privilege");
    const dangerous = await c.query(
      "SELECT name,has_table_privilege(current_user,format('public.%I',name),'TRUNCATE') AS can_truncate,has_table_privilege(current_user,format('public.%I',name),'REFERENCES') AS can_reference,has_table_privilege(current_user,format('public.%I',name),'TRIGGER') AS can_trigger FROM unnest($1::text[]) AS name",
      [[...excluded, ...tables.map(({ name }) => name)]],
    );
    if (dangerous.rows.some((r) => r.can_truncate || r.can_reference || r.can_trigger))
      throw Error("f08_dangerous_privilege");
    const scoped = await c.query(
      "SELECT name,has_table_privilege(current_user,format('public.%I',name),'UPDATE') AS can_update,has_table_privilege(current_user,format('public.%I',name),'INSERT') AS can_insert,has_table_privilege(current_user,format('public.%I',name),'DELETE') AS can_delete FROM unnest($1::text[]) AS name",
      [tables.map(({ name }) => name)],
    );
    if (
      scoped.rows.some(
        (r) =>
          r.can_update ||
          (r.name === "users" && r.can_delete) ||
          (r.name === "delivery_steps" && (r.can_insert || r.can_delete)),
      )
    )
      throw Error("f08_excess_scoped_privilege");
    const createPrivilege = (
      await c.query(
        "SELECT has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_database_privilege(current_user,current_database(),'CREATE') AS database_create",
      )
    ).rows[0];
    if (createPrivilege.schema_create || createPrivilege.database_create)
      throw Error("f08_create_privilege");
    for (const t of tables) {
      const count = await c.query(`SELECT count(*)::int AS visible FROM public."${t.name}"`);
      if (count.rows[0].visible !== 0) throw Error("f08_original_rows_visible");
    }
    await c.query("COMMIT");
    return { role: u.username, originalRowsVisible: false, unscopedPrivileges: false };
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}

/** Delete only the known synthetic user after its restricted children have
 * been removed. Lock/check every cascade child so no unrelated row can be
 * deleted as a side effect. A changed schema retains the user for review. */
export async function cleanupF08User({ ownerFile, fixtureId }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fixtureId))
    throw Error("f08_fixture_id_invalid");
  const u = new URL((await readFile(ownerFile, "utf8")).trim());
  if (
    u.pathname !== "/hive_production_rehearsal_20261105" ||
    createHash("sha256").update(u.hostname.replace("-pooler.", ".")).digest("hex") !==
      "0c2e055f1031ffce660a74f2483fadcbf7a15033a61f4158dc5f3c3c8e8cd933"
  )
    throw Error("f08_database_scope");
  u.hostname = u.hostname.replace("-pooler.", ".");
  const c = new pg.Client({ connectionString: u.toString(), connectionTimeoutMillis: 5000 });
  await c.connect();
  try {
    const identity = (await c.query("SELECT current_database() AS database,current_user AS role"))
      .rows[0];
    if (
      identity.database !== "hive_production_rehearsal_20261105" ||
      identity.role !== "hive_epic_owner"
    )
      throw Error("f08_owner_identity_changed");
    await c.query("BEGIN");
    await c.query(
      "LOCK TABLE public.users,public.navigation_favorites,public.notification_sources IN SHARE MODE",
    );
    const cascades = await c.query(`
      SELECT child.relname AS child,ns.nspname AS schema,con.convalidated,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS child_columns,
        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS parent_columns
      FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace
      WHERE con.contype='f' AND con.confrelid='public.users'::regclass AND con.confdeltype='c' ORDER BY child.relname`);
    if (
      cascades.rows.length !== 2 ||
      cascades.rows.some(
        (r, i) =>
          !r.convalidated ||
          r.schema !== "public" ||
          r.child !== ["navigation_favorites", "notification_sources"][i] ||
          r.child_columns?.join() !== "user_id" ||
          r.parent_columns?.join() !== "id",
      )
    )
      throw Error("f08_cascade_schema_changed");
    for (const name of ["navigation_favorites", "notification_sources"]) {
      const found = await c.query(
        `SELECT EXISTS (SELECT 1 FROM public."${name}" WHERE user_id=$1::uuid) AS present`,
        [fixtureId],
      );
      if (found.rows[0].present) throw Error("f08_cascade_child_present");
    }
    const removed = await c.query(
      "DELETE FROM public.users WHERE id=$1::uuid AND coder_url='https://coder.invalid' AND username=$2 AND email=$3 RETURNING id",
      [fixtureId, `f08-${fixtureId}`, `f08-${fixtureId}@example.invalid`],
    );
    if (removed.rowCount !== 1) throw Error("f08_fixture_user_changed");
    await c.query("COMMIT");
    return true;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}
