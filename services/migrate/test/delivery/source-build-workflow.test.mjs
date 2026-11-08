import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../../.github/workflows/controlled-database-job.yml", import.meta.url),
  "utf8",
);
test("source compatibility stays in the existing controlled workflow with credential-free candidate and scenario jobs", () => {
  const jobs = Object.fromEntries(
    [...workflow.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:\n|$(?![\s\S]))/gm)].map(
      (m) => [m[1], m[2]],
    ),
  );
  for (const name of ["source-input", "source-build", "compatibility"]) {
    assert.ok(jobs[name], name);
    assert.match(jobs[name], /id-token: none/);
    assert.doesNotMatch(jobs[name], /secrets\.|id-token: write|DATABASE_URL:|ACTIONS_ID_TOKEN/);
  }
  assert.match(jobs["source-build"], /git rev-list --parents -n 1 HEAD/);
  assert.match(jobs["source-build"], /git rev-parse HEAD\^\{tree\}/);
  assert.match(jobs["source-build"], /wrangler deploy --dry-run/);
  assert.doesNotMatch(
    workflow,
    /versions upload|CLOUDFLARE.*TOKEN|publisher\.mjs|cloudflare-upload/,
  );
  assert.match(jobs.compatibility, /ref: \$\{\{ inputs.trusted-revision/);
  assert.match(jobs.compatibility, /database-source-artifacts\/old/);
  assert.match(jobs.compatibility, /database-source-artifacts\/new/);
  for (const name of ["approval", "database"]) {
    assert.match(jobs[name], /environment: hive-database-change/);
    assert.match(jobs[name], /id-token: write/);
    assert.doesNotMatch(jobs[name], /pnpm build|wrangler|matrix.revision|candidate/);
  }
  assert.match(workflow, /enabled:\n {8}type: boolean\n {8}default: false/);
  for (const match of workflow.matchAll(/uses: ([^\s]+)/g))
    assert.match(match[1], /@[a-f0-9]{40}$/);
});
