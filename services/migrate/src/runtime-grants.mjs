// Fixed application-table privileges. No model, request, or database content can
// select additional tables. Existing unrelated role privileges are not revoked.
const append = [
  "delivery_native_release_artifacts",
  "delivery_native_release_baselines",
  "delivery_native_publication_grants",
  "delivery_native_publication_receipts",
  "delivery_epics",
  "delivery_step_dependencies",
  "delivery_events",
  "delivery_step_reports",
  "delivery_report_evidence",
  "codex_registered_threads",
  "delivery_source_revisions",
  "codex_guardian_barriers",
  "codex_guardian_stop_decisions",
  "codex_guardian_tree_receipts",
  "codex_guardian_operation_receipts",
  "template_publication_events",
  "delivery_acceptance_intents",
  "delivery_acceptance_plans",
  "delivery_release_target_members",
  "delivery_release_observations",
  "delivery_release_build_attestations",
  "delivery_release_build_verifications",
  "delivery_release_authority_facts",
  "delivery_release_test_challenges",
  "delivery_release_test_attestations",
  "delivery_release_deployment_observations",
  "delivery_epic_plans",
  "delivery_epic_task_inputs",
  "delivery_epic_preservations",
  "delivery_epic_lineage_proofs",
  "delivery_epic_lease_releases",
  "delivery_epic_task_archives",
];
const mutable = [
  "coder_oauth_flows",
  "users",
  "coder_tokens",
  "sessions",
  "push_subscriptions",
  "navigation_favorites",
  "vapid_keys",
  "notification_sources",
  "agent_notification_events",
  "agent_notification_rate_windows",
  "delivery_projects",
  "delivery_conversations",
  "delivery_tasks",
  "delivery_steps",
  "delivery_attempts",
  "delivery_evidence",
  "delivery_outbox",
  "codex_host_slots",
  "codex_registration_grants",
  "codex_host_registrations",
  "project_task_intents",
  "project_task_recoveries",
  "delivery_manager_bindings",
  "codex_guardian_runtimes",
  "codex_guardian_enrollment_grants",
  "codex_guardian_admissions",
  "delivery_source_applications",
  "credential_rotation_schedules",
  "credential_rotation_operations",
  "credential_expiry_notices",
  "template_publication_targets",
  "template_publication_jobs",
  "template_publication_notices",
  "delivery_repository_policies",
  "delivery_repository_policy_versions",
  "delivery_task_policy_bindings",
  "delivery_acceptance_jobs",
  "delivery_release_targets",
  "delivery_releases",
  "delivery_release_actions",
  "delivery_release_scheduler_cursors",
  "delivery_epic_plan_heads",
  "delivery_epic_start_intents",
  "delivery_epic_writer_reservations",
];
const deletable = [
  "coder_oauth_flows",
  "sessions",
  "push_subscriptions",
  "navigation_favorites",
  "notification_sources",
  "agent_notification_events",
  "agent_notification_rate_windows",
];
const array = (names) => `ARRAY[${names.map((name) => `'${name}'`).join(",")}]`;

/** SQL data is fixed and schema is hex encoded; it runs after completed migrations. */
export function runtimeGrantsSql(schema, runtimeRole = "hive_app_runtime") {
  if (!["hive_app_runtime", "hive_native_runtime"].includes(runtimeRole))
    throw new Error(
      "HIVE_MIGRATE_RUNTIME_ROLE must select hive_app_runtime or hive_native_runtime.",
    );
  // Only the two fixed deployment roles reach SQL. Quote the selected identifier;
  // caller/database content cannot choose another role or grant CONNECT.
  const role = `"${runtimeRole}"`;
  const hex = Buffer.from(schema).toString("hex");
  return `DO $hive_runtime_grants$
DECLARE
  target_schema text := pg_catalog.convert_from(pg_catalog.decode('${hex}', 'hex'), 'UTF8');
  name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${runtimeRole}') THEN RETURN; END IF;
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO ${role}', target_schema);
  FOREACH name IN ARRAY ${array(append)} LOOP
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON TABLE %I.%I TO ${role}', target_schema, name);
  END LOOP;
  FOREACH name IN ARRAY ${array(mutable)} LOOP
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO ${role}', target_schema, name);
  END LOOP;
  FOREACH name IN ARRAY ${array(deletable)} LOOP
    EXECUTE pg_catalog.format('GRANT DELETE ON TABLE %I.%I TO ${role}', target_schema, name);
  END LOOP;
END
$hive_runtime_grants$;`;
}
