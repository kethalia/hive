import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/controlled-worker-upload.yml", import.meta.url),
  "utf8",
);
test("untrusted builder has no OIDC or cloud secret and publisher uses reviewed checkout", () => {
  const [build, publish] = workflow.split("\n  publish:\n");
  const buildJob = build.split("\n  build:\n")[1];
  assert.ok(publish);
  assert.match(buildJob, /id-token: none/);
  assert.doesNotMatch(
    buildJob,
    /secrets\.|id-token: write|ACTIONS_ID_TOKEN|CLOUDFLARE_UPLOAD_TOKEN/,
  );
  assert.match(publish, /id-token: write/);
  assert.match(publish, /if: \$\{\{ vars\.HIVE_RELEASE_UPLOAD_ENABLED == 'true' \}\}/);
  assert.match(publish, /ref: \$\{\{ vars\.HIVE_RELEASE_PUBLISHER_SHA \}\}/);
  assert.match(publish, /claims\.job_workflow_sha !== process\.env\.PUBLISHER_SHA/);
  assert.match(publish, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(publish, /runner\.temp.*artifact/);
  assert.match(publish, /trusted-publisher\/scripts\/release\/publisher\.mjs/);
  assert.doesNotMatch(publish, /pnpm build|wrangler|deployments|release\.tar.*(?:node|exec)/);
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
});

test("dry-run bundles use absolute workspace output paths consumed by packaging", () => {
  for (const component of ["app", "auth"]) {
    assert.ok(
      workflow.includes(
        `--config deploy/cloudflare/${component}/wrangler.jsonc --outdir "$GITHUB_WORKSPACE/build/${component}"`,
      ),
    );
  }
  assert.match(workflow, /node scripts\/release\/pack-build\.mjs/);
});
