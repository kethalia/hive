import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The eleven-migration application uses these exact runtime tables.
export const runtimeTables = {
  mutable: ["users", "coder_tokens", "vapid_keys", "template_jobs", "template_notices"],
  deletable: [
    "sessions",
    "push_subscriptions",
    "navigation_favorites",
    "notification_sources",
    "agent_notification_events",
    "agent_notification_rate_windows",
    "terminal_connections",
  ],
  appendAndDelete: ["terminal_events"],
};
const profiles = {
  production: {
    database: "hive_production",
    owner: "hive_epic_owner",
    runtime: "hive_production_runtime",
    other: "hive_foundation_runtime",
  },
  preview: {
    database: "hive_foundation_preview",
    owner: "hive_epic_owner",
    runtime: "hive_foundation_runtime",
    other: "hive_production_runtime",
  },
  "local-test": {
    database: "hive_cutover_migrations_20261113",
    owner: "coder",
    runtime: "hive_cutover_fixture_runtime_20261113",
    other: "hive_cutover_fixture_other_20261113",
  },
};
export const cutoverMigrationNames = [
  "0_init",
  "20260602000000_add_navigation_favorites",
  "20260603000000_add_terminal_controls_beyond_mobile",
  "20260714000000_add_navigation_favorite_position",
  "20260814000000_remove_legacy_tasks",
  "20261016000000_add_agent_notifications",
  "20261016010000_stage_notification_credentials",
  "20261113010000_agent_notification_events",
  "20261113020000_terminal_diagnostics",
  "20261113030000_template_jobs",
  "20261113040000_legacy_rotation_leases",
];
const array = (values) => `ARRAY[${values.map((value) => `'${value}'`).join(",")}]`;

/** Emits reviewable SQL only. Applying it is a separate owner connection action. */
export function runtimeGrantsSql(target, databaseOid) {
  const profile = profiles[target];
  if (
    !Object.hasOwn(profiles, target) ||
    !profile ||
    !Number.isSafeInteger(databaseOid) ||
    databaseOid <= 0 ||
    databaseOid > 4294967295
  )
    throw Error("Select production, preview or local-test and an exact PostgreSQL database OID");
  const { database, owner, runtime, other } = profile;
  const tables = Object.values(runtimeTables).flat().sort();
  return `BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $hive_runtime_grants$
DECLARE
  name text;
  role_name text;
  actual_tables text[];
BEGIN
  IF current_database()<>'${database}' OR current_user<>'${owner}' OR
     NOT EXISTS(SELECT 1 FROM pg_database WHERE oid=${databaseOid} AND datname=current_database() AND pg_get_userbyid(datdba)=current_user) THEN
    RAISE EXCEPTION 'HIVE_GRANT_DATABASE_SCOPE';
  END IF;
  ${target === "local-test" ? "IF current_setting('port')<>'55439' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet THEN RAISE EXCEPTION 'HIVE_GRANT_LOCAL_SCOPE'; END IF;" : ""}
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${runtime}' AND rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR
     EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='${runtime}')) THEN
    RAISE EXCEPTION 'HIVE_GRANT_RUNTIME_ROLE';
  END IF;
  SELECT array_agg(tablename::text ORDER BY tablename) INTO actual_tables FROM pg_tables WHERE schemaname='public';
  IF actual_tables IS DISTINCT FROM ${array([...tables, "_prisma_migrations"].sort())} THEN
    RAISE EXCEPTION 'HIVE_GRANT_TABLE_SET';
  END IF;
  IF EXISTS(SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) OR
     (SELECT array_agg(migration_name::text ORDER BY migration_name) FROM public._prisma_migrations) IS DISTINCT FROM ${array(cutoverMigrationNames)} THEN
    RAISE EXCEPTION 'HIVE_GRANT_MIGRATION_HISTORY';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)='${runtime}') OR
     EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public' AND pg_get_userbyid(nspowner)='${runtime}') THEN
    RAISE EXCEPTION 'HIVE_GRANT_RUNTIME_OWNERSHIP';
  END IF;
  -- Remove blanket defaults (including migration-history access) in this DB.
  -- This changes neither role attributes/membership nor any other database.
  FOREACH role_name IN ARRAY ARRAY['${runtime}','${other}'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',current_user,role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',current_user,role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I',current_database(),role_name);
    END IF;
  END LOOP;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  REVOKE CREATE,TEMPORARY ON DATABASE "${database}" FROM PUBLIC;
  GRANT CONNECT ON DATABASE "${database}" TO "${runtime}";
  GRANT USAGE ON SCHEMA public TO "${runtime}";
  FOREACH name IN ARRAY ${array(runtimeTables.mutable)} LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO "${runtime}"',name);
  END LOOP;
  FOREACH name IN ARRAY ${array(runtimeTables.deletable)} LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO "${runtime}"',name);
  END LOOP;
  GRANT SELECT,INSERT,DELETE ON public.terminal_events TO "${runtime}";
  GRANT USAGE ON SEQUENCE public.terminal_events_id_seq TO "${runtime}";
  IF has_table_privilege('${runtime}','public._prisma_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
     has_schema_privilege('${runtime}','public','CREATE') OR
     has_database_privilege('${runtime}',current_database(),'CREATE,TEMPORARY') THEN
    RAISE EXCEPTION 'HIVE_GRANT_POSTCHECK';
  END IF;
END
$hive_runtime_grants$;
COMMIT;
`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw Error(
      "Usage: node runtime-grants.mjs <production|preview|local-test> <database-oid> (prints SQL only)",
    );
  process.stdout.write(runtimeGrantsSql(process.argv[2], Number(process.argv[3])));
}
