import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readJobsLocalProof } from "./jobs-local-proof.mjs";

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await files(p)));
    else {
      assert.ok(e.isFile());
      out.push(p);
    }
  }
  return out;
}
test("proof requires real runtime scope and every generated client input", async () => {
  const root = "packages/db/src/generated/prisma-workerd",
    names = [
      ...(await files(root)),
      "deploy/cloudflare/jobs/worker.ts",
      "deploy/cloudflare/jobs/pilot-schedule.ts",
      "deploy/cloudflare/jobs/project-tasks.ts",
      "deploy/cloudflare/jobs/run-local-project-tasks.mjs",
      "deploy/cloudflare/app/project-tasks.ts",
      "src/lib/projects/reconcile-transport.ts",
      "src/lib/projects/task.server.ts",
    ];
  const sourceDigests = Object.fromEntries(
    await Promise.all(
      names.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      ]),
    ),
  );
  const revision = "a".repeat(40),
    checks = Object.fromEntries(
      [
        "oneIntentPerWake",
        "authBeforeClaim",
        "jobsHadNoDatabaseOrEncryptionIssuerKeys",
        "awaitedPoolCleanup",
        "sourceStable",
        "sourceTreeClean",
        "generatedClientSetStable",
        "actualScheduledHandler",
        "expiredScheduledHandlerRejected",
      ].map((k) => [k, true]),
    );
  const proof = {
    passed: true,
    baseRevision: revision,
    endingBaseRevision: revision,
    testedSourcesCommitted: true,
    scope: {
      generatedClientNotCommitted: true,
      actualWorkerd: true,
      actualLocalPostgreSQL: true,
      actualPrivateServiceBinding: true,
    },
    checks,
    sourceDigests,
  };
  const path = join(await mkdtemp(join(tmpdir(), "hive-jobs-proof-test-")), "proof.json");
  await writeFile(path, JSON.stringify(proof));
  assert.equal((await readJobsLocalProof(path, revision)).passed, true);
  for (const change of [
    (p) => (p.scope.actualWorkerd = false),
    (p) => (p.scope.actualLocalPostgreSQL = false),
    (p) => (p.checks.sourceTreeClean = false),
    (p) => delete p.sourceDigests[names[0]],
    (p) => (p.sourceDigests[names[0]] = "0".repeat(64)),
  ]) {
    const item = structuredClone(proof);
    change(item);
    await writeFile(path, JSON.stringify(item));
    await assert.rejects(readJobsLocalProof(path, revision));
  }
});
