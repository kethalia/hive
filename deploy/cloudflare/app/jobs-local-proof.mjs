import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const generatedRoot = "packages/db/src/generated/prisma-workerd";
async function generatedFiles(directory = generatedRoot) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await generatedFiles(path)));
    else {
      assert.ok(entry.isFile());
      files.push(path);
    }
  }
  return files.sort();
}

export async function readJobsLocalProof(path, revision) {
  const proof = JSON.parse(await readFile(path, "utf8"));
  assert.equal(proof.passed, true);
  assert.equal(proof.baseRevision, revision);
  assert.equal(proof.endingBaseRevision, revision);
  assert.equal(proof.testedSourcesCommitted, true);
  assert.equal(proof.scope.generatedClientNotCommitted, true);
  assert.equal(proof.scope.actualWorkerd, true);
  assert.equal(proof.scope.actualLocalPostgreSQL, true);
  assert.equal(proof.scope.actualPrivateServiceBinding, true);
  for (const name of [
    "oneIntentPerWake",
    "authBeforeClaim",
    "jobsHadNoDatabaseOrEncryptionIssuerKeys",
    "awaitedPoolCleanup",
    "sourceStable",
    "sourceTreeClean",
    "generatedClientSetStable",
    "actualScheduledHandler",
    "expiredScheduledHandlerRejected",
  ])
    assert.equal(proof.checks[name], true);
  for (const path of [
    "deploy/cloudflare/jobs/worker.ts",
    "deploy/cloudflare/jobs/pilot-schedule.ts",
    "deploy/cloudflare/jobs/project-tasks.ts",
    "deploy/cloudflare/jobs/run-local-project-tasks.mjs",
    "deploy/cloudflare/app/project-tasks.ts",
    "src/lib/projects/reconcile-transport.ts",
    "src/lib/projects/task.server.ts",
  ])
    assert.match(proof.sourceDigests[path], /^[a-f0-9]{64}$/);
  const generated = await generatedFiles();
  assert.ok(generated.length > 0);
  assert.deepEqual(
    Object.keys(proof.sourceDigests)
      .filter((path) => path.startsWith(`${generatedRoot}/`))
      .sort(),
    generated,
  );
  for (const [source, expected] of Object.entries(proof.sourceDigests)) {
    assert.ok(!source.startsWith("/") && !source.split("/").includes(".."));
    assert.equal(
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
      expected,
    );
  }
  return { passed: true, sourceRevision: revision, actualWorkerd: true, oneIntentPerWake: true };
}
