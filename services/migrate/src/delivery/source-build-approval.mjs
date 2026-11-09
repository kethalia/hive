import { digest, requireValue, validatePlan } from "./contracts.mjs";
import {
  databaseCatalogSchema,
  databasePlanApprovalSchema,
  sourceBuildOutputSchema,
  verifySourceBuildApproval,
} from "./wire.mjs";
/** Called only after the fixed trusted scenario succeeds, using its actual output. */
export function deriveSourceBuildApproval(rawCatalog, rawIntent, rawOutput) {
  const catalog = databaseCatalogSchema.parse(rawCatalog),
    mode = catalog.compatibilityTest?.config;
  requireValue(mode?.kind === "automatic-source-build", "migration_source_intent_invalid");
  const output = sourceBuildOutputSchema.parse(rawOutput);
  requireValue(
    rawIntent &&
      Object.keys(rawIntent).sort().join() ===
        "catalogId,dispatchId,ownerId,planIntent,sourceSha,taskId" &&
      rawIntent.catalogId === catalog.id &&
      rawIntent.ownerId === catalog.ownerId &&
      rawIntent.sourceSha === mode.sourceSha &&
      digest(rawIntent.planIntent) === digest(catalog.automaticPlan),
    "migration_source_intent_changed",
  );
  const plan = validatePlan({
    ...catalog.automaticPlan,
    oldAppDigest: output.oldAppDigest,
    newAppDigest: output.newAppDigest,
  });
  const approval = {
    catalogId: catalog.id,
    ownerId: catalog.ownerId,
    taskId: rawIntent.taskId,
    sourceSha: mode.sourceSha,
    dispatchId: rawIntent.dispatchId,
    plan,
    compatibility: {
      contractDigest: plan.compatibilityDigest,
      mixedVersionChecksDigest: digest(mode),
      databaseEnforcedInvariantDigest: digest({
        schemaDigest: plan.afterSchemaDigest,
        sql: plan.integritySql,
        tables: plan.integrityTables,
      }),
      actualSourceBuild: output,
    },
  };
  verifySourceBuildApproval(approval, catalog);
  // Validate the public shape without claiming a real workflow identity here.
  databasePlanApprovalSchema.parse({
    ...approval,
    schemaVersion: 1,
    purpose: "approve_database_plan",
    githubRunId: "1",
    githubRunAttempt: 1,
  });
  return approval;
}
