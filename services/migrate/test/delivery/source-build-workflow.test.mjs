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

test("typed database dispatch reuses CI with an immutable recipe pin and skips unrelated jobs", async () => {
  const ci = await readFile(
    new URL("../../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(ci, /options: \[validate, database\]/);
  assert.match(ci, /default: validate/);
  assert.match(ci, /format\('hive-database\/\{0\}\/\{1\}'/);
  assert.match(ci, /cancel-in-progress: \$\{\{ inputs.operation != 'database' \}\}/);
  assert.match(
    ci,
    /uses: kethalia\/hive\/\.github\/workflows\/controlled-database-job.yml@b11dd01ba7db090e1b7ee0eb75a6043b81982b51/,
  );
  assert.match(ci, /fromJSON\(inputs.database-catalog-json\).automaticExecutionEnabled == true/);
  for (const job of ["build-lint-test", "migration-integration", "quality", "helm-lint"])
    assert.ok(ci.includes(`  ${job}:\n    if: \${{ inputs.operation != 'database' }}`));
  assert.doesNotMatch(
    ci,
    /HIVE_DELIVERY_DATABASE_GITHUB_TOKEN|CLOUDFLARE.*TOKEN|controlled-worker-upload/,
  );
});
