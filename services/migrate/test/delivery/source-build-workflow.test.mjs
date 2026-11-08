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
  assert.match(jobs["source-build"], /ref: \$\{\{ env.HIVE_DATABASE_TRUSTED_RECIPE_SHA \}\}/);
  assert.match(
    jobs["source-build"],
    /recipe\/services\/migrate\/src\/delivery\/pack-source-build.mjs/,
  );
  assert.match(jobs["source-build"], /working-directory: candidate/);
  assert.doesNotMatch(jobs["source-build"], /scripts\/release\/pack-build.mjs/);
  assert.doesNotMatch(
    workflow,
    /versions upload|CLOUDFLARE.*TOKEN|publisher\.mjs|cloudflare-upload/,
  );
  assert.match(
    jobs.compatibility,
    /ref: \$\{\{ inputs.enabled && env.HIVE_DATABASE_TRUSTED_RECIPE_SHA/,
  );
  assert.match(jobs.compatibility, /database-source-artifacts\/old/);
  assert.match(jobs.compatibility, /database-source-artifacts\/new/);
  for (const name of ["approval", "database"]) {
    assert.match(jobs[name], /environment: hive-database-change/);
    assert.match(jobs[name], /id-token: write/);
    assert.doesNotMatch(jobs[name], /pnpm build|wrangler|matrix.revision|candidate/);
  }
  assert.match(workflow, /enabled:\n {8}type: boolean\n {8}default: false/);
  assert.match(workflow, /HIVE_DATABASE_TRUSTED_RECIPE_SHA: '[a-f0-9]{40}'/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ inputs.trusted-revision/);
  assert.match(jobs.approval, /needs.compatibility.outputs.approval-json/);
  assert.doesNotMatch(
    jobs.approval,
    /HIVE_DELIVERY_DATABASE_APPROVAL_JSON: \$\{\{ inputs.approval-json/,
  );
  for (const name of ["approval", "database"]) {
    assert.match(
      jobs[name],
      /HIVE_DATABASE_JOB_PURPOSE: \$\{\{ inputs.enabled && 'automatic-source-build' \|\| 'legacy-protected'/,
    );
    assert.match(
      jobs[name],
      /inputs.enabled && inputs.catalog-json \|\| \(!inputs.enabled && vars.HIVE_DELIVERY_DATABASE_CATALOG_JSON\)/,
    );
  }
  for (const match of workflow.matchAll(/uses: ([^\s]+)/g))
    assert.match(match[1], /@[a-f0-9]{40}$/);
});

test("typed database dispatch reuses CI with an immutable recipe pin and skips unrelated jobs", async () => {
  const ci = await readFile(
    new URL("../../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(ci, /options: \[validate, database\]/);
  assert.match(
    ci,
    /HIVE_D10_SOURCE_BUILD_TEST_DATABASE_URL: postgresql:\/\/hive:hive-test-password@localhost:5432\/hive_d10_test/,
  );
  assert.match(ci, /POSTGRES_HOST_AUTH_METHOD: password/);
  assert.match(ci, /default: validate/);
  assert.match(ci, /format\('hive-database\/\{0\}\/\{1\}'/);
  assert.match(ci, /cancel-in-progress: \$\{\{ inputs.operation != 'database' \}\}/);
  assert.match(
    ci,
    /uses: kethalia\/hive\/\.github\/workflows\/controlled-database-job.yml@c4c3b91e5f057a656ef6d5dff888dd0923e975d3/,
  );
  assert.match(
    workflow,
    /HIVE_DATABASE_TRUSTED_RECIPE_SHA: '898ed70a2a317c508a240c5c06757a7f27ead6a8'/,
  );
  assert.match(ci, /trusted-revision: 898ed70a2a317c508a240c5c06757a7f27ead6a8/);
  assert.match(
    ci,
    /inputs.database-trusted-revision == '898ed70a2a317c508a240c5c06757a7f27ead6a8'/,
  );
  assert.match(ci, /fromJSON\(inputs.database-catalog-json\).automaticExecutionEnabled == true/);
  for (const job of ["build-lint-test", "migration-integration", "quality", "helm-lint"])
    assert.ok(ci.includes(`  ${job}:\n    if: \${{ inputs.operation != 'database' }}`));
  assert.doesNotMatch(
    ci,
    /HIVE_DELIVERY_DATABASE_GITHUB_TOKEN|CLOUDFLARE.*TOKEN|controlled-worker-upload/,
  );
});
