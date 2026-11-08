import { runSourceBuildCompatibility } from "./compatibility-source-build.mjs";
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
  requireValue(
    ["workerd", "automatic-source-build"].includes(config.kind),
    "migration_container_target_unsupported",
  );
  const result =
    config.kind === "automatic-source-build"
      ? await runSourceBuildCompatibility(config, {
          artifactDirectory: process.env.HIVE_DATABASE_SOURCE_ARTIFACT_DIRECTORY,
        })
      : await runWorkerdCompatibility(config);
  console.log(JSON.stringify(result));
} catch {
  console.error("[database-compatibility] Isolated scenario held.");
  process.exitCode = 1;
}
