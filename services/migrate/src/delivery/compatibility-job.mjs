import { runWorkerdCompatibility } from "./compatibility-workerd.mjs";
import { digest, requireValue } from "./contracts.mjs";
import { compatibilityConfigSchema } from "./wire.mjs";

try {
  const config = compatibilityConfigSchema.parse(
    JSON.parse(process.env.HIVE_DATABASE_COMPATIBILITY_CONFIG_JSON ?? ""),
  );
  requireValue(
    digest(config) === process.env.HIVE_DATABASE_COMPATIBILITY_DIGEST,
    "migration_compatibility_catalog_changed",
  );
  // D09 deploys Worker release archives; OCI image manifests are not Worker artifacts.
  requireValue(config.kind === "workerd", "migration_container_target_unsupported");
  const result = await runWorkerdCompatibility(config);
  console.log(JSON.stringify(result));
} catch {
  console.error("[database-compatibility] Isolated scenario held.");
  process.exitCode = 1;
}
