import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runWorkerdCompatibility } from "./compatibility-workerd.mjs";
import { requireValue } from "./contracts.mjs";
import { sourceBuildCompatibilitySchema } from "./wire.mjs";

/** The fixed workflow downloads two credential-free build outputs as inert data.
 * Only the reviewed scenario runs in this job; candidate archives are decoded
 * and loaded by workerd, never imported into the trusted Node process. */
export async function runSourceBuildCompatibility(
  raw,
  { artifactDirectory, fixtureDatabaseUrl } = {},
) {
  const config = sourceBuildCompatibilitySchema.parse(raw);
  requireValue(typeof artifactDirectory === "string", "migration_source_artifacts_missing");
  const root = await realpath(resolve(artifactDirectory));
  const sourceArtifacts = {};
  for (const name of ["old", "new"]) {
    const path = join(root, name, "release.tar"),
      stat = await lstat(path);
    requireValue(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size <= 128 * 1024 * 1024 &&
        (await realpath(path)) === path,
      "migration_source_artifact_path",
    );
    sourceArtifacts[name] = await readFile(path);
    requireValue(sourceArtifacts[name].length === stat.size, "migration_source_artifact_changed");
  }
  return runWorkerdCompatibility(config, { sourceArtifacts, fixtureDatabaseUrl });
}
