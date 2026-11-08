import { appendFileSync } from "node:fs";
import { runSourceBuildCompatibility } from "./compatibility-source-build.mjs";
import { runWorkerdCompatibility } from "./compatibility-workerd.mjs";
import { digest, requireValue } from "./contracts.mjs";
import { deriveSourceBuildApproval } from "./source-build-approval.mjs";
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
  if (config.kind === "automatic-source-build") {
    requireValue(
      process.env.TRUSTED_REVISION === config.recipeSha &&
        process.version === `v${config.toolchain.node}`,
      "migration_recipe_changed",
    );
    const approval = deriveSourceBuildApproval(
      JSON.parse(process.env.HIVE_DELIVERY_DATABASE_CATALOG_JSON ?? ""),
      JSON.parse(process.env.HIVE_DATABASE_SOURCE_APPROVAL_INTENT_JSON ?? ""),
      result.actualSourceBuild,
    );
    requireValue(typeof process.env.GITHUB_OUTPUT === "string", "migration_workflow_output");
    appendFileSync(process.env.GITHUB_OUTPUT, `approval-json=${JSON.stringify(approval)}\n`);
  }
  console.log(JSON.stringify(result));
} catch {
  console.error("[database-compatibility] Isolated scenario held.");
  process.exitCode = 1;
}
