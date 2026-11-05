import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, requireValue } from "./contracts.mjs";

// Every executable image, including Postgres and the reviewed scenario, must be
// selected by the deployment-owned catalog as an immutable registry digest.
import { containerCompatibilitySchema } from "./wire.mjs";

/** Runs only on a disposable GitHub-hosted runner without OIDC or production
 * secrets. The operator-reviewed scenario image implements prepare and verify;
 * its contents and the app image semantics are part of the catalog review. */
export function runContainerCompatibility(
  raw,
  {
    docker = (args, options = {}) =>
      execFileSync("docker", args, { stdio: "ignore", timeout: 120000, ...options }),
  } = {},
) {
  const config = containerCompatibilitySchema.parse(raw);
  const suffix = randomBytes(12).toString("hex"),
    network = `hive-d10-${suffix}`;
  const pg = `${network}-pg`,
    old = `${network}-old`,
    next = `${network}-new`;
  const password = randomBytes(24).toString("hex");
  const databaseUrl = `postgresql://hive:${password}@${pg}:5432/hive_compatibility`;
  const isolated = [
    "--network",
    network,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
  ];
  try {
    for (const ref of [
      config.postgresImage,
      config.oldImage,
      config.newImage,
      config.scenarioImage,
    ]) {
      docker(["pull", ref]);
      const inspected = String(
        docker(["image", "inspect", "--format", "{{json .RepoDigests}}", ref], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      requireValue(JSON.parse(inspected).includes(ref), "migration_compatibility_image_changed");
    }
    docker(["network", "create", "--internal", network]);
    docker([
      "run",
      "-d",
      "--name",
      pg,
      ...isolated,
      "-e",
      "POSTGRES_USER=hive",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=hive_compatibility",
      config.postgresImage,
    ]);
    // pg_isready -t bounds each try; no host-published ports or production target.
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      try {
        docker(["exec", pg, "pg_isready", "-U", "hive", "-d", "hive_compatibility", "-t", "1"]);
        ready = true;
      } catch {
        execFileSync("sleep", ["1"]);
      }
    }
    requireValue(ready, "migration_compatibility_database_unavailable");
    const scenarioEnv = [
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      "-e",
      `HIVE_PLAN_DIGEST=${config.planDigest}`,
      "-e",
      `HIVE_SOURCE_SHA=${config.sourceSha}`,
      "-e",
      `HIVE_COMPATIBILITY_DIGEST=${config.compatibilityDigest}`,
      "-e",
      `HIVE_OLD_APP=http://${old}:8080`,
      "-e",
      `HIVE_NEW_APP=http://${next}:8080`,
    ];
    docker(["run", "--rm", ...isolated, ...scenarioEnv, config.scenarioImage, "prepare"]);
    docker([
      "run",
      "-d",
      "--name",
      old,
      ...isolated,
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      config.oldImage,
    ]);
    docker([
      "run",
      "-d",
      "--name",
      next,
      ...isolated,
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      config.newImage,
    ]);
    docker(["run", "--rm", ...isolated, ...scenarioEnv, config.scenarioImage, "verify"]);
    return {
      schemaVersion: 1,
      catalogDigest: digest(config),
      planDigest: config.planDigest,
      sourceSha: config.sourceSha,
      oldAppDigest: config.oldAppDigest,
      newAppDigest: config.newAppDigest,
      compatibilityDigest: config.compatibilityDigest,
    };
  } finally {
    for (const name of [old, next, pg]) {
      try {
        docker(["rm", "-f", name]);
      } catch {}
    }
    try {
      docker(["network", "rm", network]);
    } catch {}
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = containerCompatibilitySchema.parse(
      JSON.parse(process.env.HIVE_DATABASE_COMPATIBILITY_CONFIG_JSON ?? ""),
    );
    requireValue(
      digest(config) === process.env.HIVE_DATABASE_COMPATIBILITY_DIGEST,
      "migration_compatibility_catalog_changed",
    );
    console.log(JSON.stringify(runContainerCompatibility(config)));
  } catch {
    console.error("[database-compatibility] Isolated scenario held.");
    process.exitCode = 1;
  }
}
