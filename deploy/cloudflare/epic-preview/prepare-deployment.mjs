import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Preparation only. The primary verifies account/name and authorizes the exact
// committed revision before invoking Wrangler. This file performs no cloud writes.
const directory = dirname(fileURLToPath(import.meta.url));
const privateDirectory =
  process.env.HIVE_PREVIEW_CREDENTIAL_DIRECTORY ?? "/tmp/hive-epic-coder-auth";
const digest = (data) => createHash("sha256").update(data).digest("hex");
try {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
  const proof = JSON.parse(await readFile(join(directory, "prisma-workerd-evidence.json"), "utf8"));
  assert.equal(proof.testedSourceCommitted, true, "Rerun local proof after committing source");
  assert.equal(proof.sourceBaseRevision, revision, "Local proof must match current commit");
  for (const [name, expected] of Object.entries(proof.fileDigests))
    assert.equal(digest(await readFile(join(directory, name))), expected, "Tested source changed");
  const dirty = execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      ...Object.keys(proof.fileDigests),
      "prepare-deployment.mjs",
      "check-live-preview.mjs",
    ],
    { cwd: directory, encoding: "utf8" },
  ).trim();
  assert.equal(dirty, "", "Commit source before preparing deployment");
  const databaseUrl = (
    await readFile(join(privateDirectory, "neon-preview-probe-url"), "utf8")
  ).trim();
  const coderToken = (await readFile(join(privateDirectory, "session"), "utf8")).trim();
  const host = new URL(databaseUrl).hostname;
  assert.ok(host.startsWith("ep-jolly-sky-b7fhirib") && host.endsWith(".neon.tech"));
  const bearer = randomBytes(32).toString("base64url");
  const runId = randomUUID();
  const config = JSON.parse(await readFile(join(directory, "wrangler.jsonc"), "utf8"));
  assert.equal(config.name, "hive-delivery-capability-preview");
  config.account_id = "225177f82b9234ede14e897fe15e0cb5";
  config.vars = {
    ...config.vars,
    SOURCE_REVISION: revision,
    PROBE_RUN_ID: runId,
    NEON_PREVIEW_HOST: host,
    NEON_PREVIEW_BRANCH_ID: "br-ancient-violet-b7pcun87",
  };
  const secretsFile = join(privateDirectory, "preview-deploy-secrets.json");
  await writeFile(
    secretsFile,
    JSON.stringify({
      DATABASE_URL: databaseUrl,
      PREVIEW_BEARER_TOKEN: bearer,
      CODER_API_TOKEN: coderToken,
    }),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(join(privateDirectory, "preview-live-bearer"), bearer, {
    flag: "wx",
    mode: 0o600,
  });
  const configFile = join(directory, ".deploy-config.jsonc");
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(
    join(privateDirectory, "prepared-deployment.json"),
    JSON.stringify({
      sourceRevision: revision,
      runId,
      sourceSetDigest: proof.sourceSetDigest,
      configDigest: digest(JSON.stringify(config)),
      workerName: config.name,
      accountId: config.account_id,
    }),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      prepared: true,
      sourceRevision: revision,
      runId,
      accountId: config.account_id,
      workerName: config.name,
      configFile,
      secretsFile,
      cloudWrites: 0,
      secretsPrinted: false,
    }),
  );
} catch {
  console.error(
    "Preview preparation failed. Inspect committed proof, source and private-file provenance; no secrets printed.",
  );
  process.exitCode = 1;
}
