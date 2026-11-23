import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The twelve-migration application uses these exact runtime tables.
export const runtimeTables = {
  mutable: ["users", "coder_tokens", "vapid_keys", "template_jobs", "template_notices"],
  deletable: [
    "coder_oauth_accounts",
    "better_auth_verifications",
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
  "oauth-preview": {
    database: "hive_coder_oauth_preview",
    owner: "hive_epic_owner",
    runtime: "hive_coder_oauth_runtime",
    other: "hive_production_runtime",
  },
  "accounts-preview": {
    database: "hive_workspace_accounts_preview",
    owner: "hive_epic_owner",
    runtime: "hive_accounts_runtime",
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
  "20261114010000_coder_oauth_better_auth",
];
const managedProjectTables = {
  appendOnly: [
    "codex_guardian_barriers",
    "codex_guardian_operation_receipts",
    "codex_guardian_stop_decisions",
    "codex_guardian_tree_receipts",
    "codex_registered_threads",
    "delivery_epics",
    "delivery_events",
    "delivery_report_evidence",
    "delivery_source_revisions",
    "delivery_step_dependencies",
    "delivery_step_reports",
  ],
  mutable: [
    "codex_guardian_admissions",
    "codex_guardian_enrollment_grants",
    "codex_guardian_runtimes",
    "codex_host_registrations",
    "codex_host_slots",
    "codex_registration_grants",
    "delivery_attempts",
    "delivery_conversations",
    "delivery_evidence",
    "delivery_manager_bindings",
    "delivery_outbox",
    "delivery_projects",
    "delivery_source_applications",
    "delivery_steps",
    "delivery_tasks",
    "project_task_intents",
    "project_task_recoveries",
  ],
};
const managedProjectMigrations = [
  "20261029000000_add_delivery_foundation",
  "20261029010000_delivery_audit_integrity",
  "20261029020000_delivery_report_event_binding",
  "20261029030000_delivery_runtime_recovery",
  "20261029050000_codex_host_registration",
  "20261029060000_codex_heartbeat_ack",
  "20261029070000_project_task_intents",
  "20261029071000_project_intent_payload_guards",
  "20261029072000_project_intent_source_context",
  "20261029073000_project_preparation_progress",
  "20261029090000_delivery_manager_binding",
  "20261029100000_delivery_informational_report",
  "20261029100100_delivery_report_null_guard",
  "20261029110000_delivery_manager_progression",
  "20261029120000_delivery_source_revisions",
  "20261029130000_guardian_admission",
  "20261029140000_delivery_source_application",
  "20261105140000_guardian_tree_closure",
  "20261105150000_guardian_tree_receipt_runtime_grants",
  "20261106001000_guardian_operation_receipts",
  "20261106020000_project_task_recovery",
  "20261108020000_account_maintenance",
  "20261108030000_unstarted_authorization_retirement",
  "20261108040000_unused_epoch_remount",
  "20261108050000_unused_recovery_resumption",
  "20261108060000_unused_bootstrap_predecessor",
];
const array = (values) => `ARRAY[${values.map((value) => `'${value}'`).join(",")}]`;

/** Emits reviewable SQL only. Applying it is a separate owner connection action. */
export function runtimeGrantsSql(target, databaseOid, schema = "baseline") {
  const profile = profiles[target];
  if (
    !Object.hasOwn(profiles, target) ||
    !profile ||
    !Number.isSafeInteger(databaseOid) ||
    databaseOid <= 0 ||
    databaseOid > 4294967295
  )
    throw Error(
      "Select production, preview, oauth-preview, accounts-preview or local-test and an exact PostgreSQL database OID",
    );
  if (!["baseline", "managed-projects"].includes(schema))
    throw Error("Select the baseline or managed-projects migration set");
  const managed = schema === "managed-projects";
  const { database, owner, runtime, other } = profile;
  const tables = Object.values(runtimeTables).flat();
  const migrations = [...cutoverMigrationNames];
  const mutable = [...runtimeTables.mutable];
  if (managed) {
    tables.push(...Object.values(managedProjectTables).flat());
    migrations.push(...managedProjectMigrations);
    mutable.push(...managedProjectTables.mutable);
  }
  const managedGrants = managed
    ? `
  FOREACH name IN ARRAY ${array(managedProjectTables.appendOnly)} LOOP
    EXECUTE format('GRANT SELECT,INSERT ON TABLE public.%I TO "${runtime}"',name);
  END LOOP;
  GRANT EXECUTE ON FUNCTION
    public.hive_check_account_maintenance_epoch(public.delivery_manager_bindings,public.delivery_manager_bindings),
    public.hive_guardian_unstarted_event(public.codex_guardian_operation_receipts),
    public.hive_guardian_unstarted_event_v1(public.codex_guardian_operation_receipts),
    public.hive_guardian_unused_resumption(public.codex_guardian_operation_receipts)
  TO "${runtime}";
`
    : "";
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
     (SELECT array_agg(migration_name::text ORDER BY migration_name) FROM public._prisma_migrations) IS DISTINCT FROM ${array(migrations.sort())} THEN
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
  FOREACH name IN ARRAY ${array(mutable)} LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO "${runtime}"',name);
  END LOOP;
  FOREACH name IN ARRAY ${array(runtimeTables.deletable)} LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO "${runtime}"',name);
  END LOOP;
  GRANT SELECT,INSERT,DELETE ON public.terminal_events TO "${runtime}";
  GRANT USAGE ON SEQUENCE public.terminal_events_id_seq TO "${runtime}";
  ${managedGrants}
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
  if (![4, 5].includes(process.argv.length))
    throw Error(
      "Usage: node runtime-grants.mjs <production|preview|oauth-preview|accounts-preview|local-test> <database-oid> [baseline|managed-projects] (prints SQL only)",
    );
  process.stdout.write(runtimeGrantsSql(process.argv[2], Number(process.argv[3]), process.argv[4]));
}
