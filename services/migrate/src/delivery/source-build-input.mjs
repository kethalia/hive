import { appendFileSync } from "node:fs";
import { digest, requireValue } from "./contracts.mjs";
import { sourceBuildCompatibilitySchema } from "./wire.mjs";

const config = sourceBuildCompatibilitySchema.parse(
  JSON.parse(process.env.HIVE_DATABASE_COMPATIBILITY_CONFIG_JSON ?? ""),
);
requireValue(
  digest(config) === process.env.HIVE_DATABASE_COMPATIBILITY_DIGEST,
  "migration_compatibility_catalog_changed",
);
requireValue(
  /^[a-f0-9]{40}$/.test(process.env.TRUSTED_REVISION ?? "") &&
    config.recipeSha === process.env.TRUSTED_REVISION &&
    process.version === `v${config.toolchain.node}`,
  "migration_workflow_revision",
);
const matrix = [
  { label: "old", revision: config.baseline.sourceSha, tree: config.baseline.treeSha },
  {
    label: "new",
    revision: config.candidate.mergeSha,
    tree: config.candidate.treeSha,
    base: config.candidate.baseSha,
    head: config.candidate.headSha,
  },
];
requireValue(typeof process.env.GITHUB_OUTPUT === "string", "migration_workflow_output");
appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: matrix })}\n`);
