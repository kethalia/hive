export function managedProjectTemplateIds() {
  if (
    process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true" ||
    process.env.HIVE_PROJECT_TASKS_ENABLED !== "true" ||
    process.env.HIVE_CODEX_GATEWAY_ENABLED !== "true" ||
    process.env.HIVE_GUARDIAN_ENABLED !== "true" ||
    process.env.HIVE_GUARDIAN_PRODUCER_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_MANAGER_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_NATIVE_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED === "true"
  )
    return [];
  return (process.env.HIVE_CODEX_SOFTWARE_TEMPLATE_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[a-f0-9-]{36}$/.test(id));
}
