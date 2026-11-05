import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function readJobsLocalProof(path, revision) {
  const proof = JSON.parse(await readFile(path, "utf8"));
  assert.equal(proof.passed, true);
  assert.equal(proof.baseRevision, revision);
  assert.equal(proof.endingBaseRevision, revision);
  assert.equal(proof.testedSourcesCommitted, true);
  assert.equal(proof.scope.generatedClientNotCommitted, true);
  for (const name of [
    "oneIntentPerWake",
    "authBeforeClaim",
    "jobsHadNoDatabaseOrEncryptionIssuerKeys",
    "awaitedPoolCleanup",
    "sourceStable",
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
