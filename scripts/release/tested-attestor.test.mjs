import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { assertManagedTestSource, attestTestedTree } from "./tested-attestor.mjs";

const config = {
  controllerOrigin: "https://preview.example.invalid",
  audiencePrefix: "urn:hive:release-tested:fixture:",
  controlDigest: "a".repeat(64),
};
const identity = {
  repositoryId: "1",
  repositoryOwnerId: "2",
  pullNumber: 3,
  headSha: "1".repeat(40),
  baseSha: "2".repeat(40),
  mergeSha: "3".repeat(40),
  treeSha: "4".repeat(40),
  runId: "5",
  runAttempt: 1,
};
test("trusted attestor requests purpose separated tokens and sends nonce without candidate-supplied URL", async () => {
  const calls = [],
    fetcher = async (raw, init) => {
      const url = String(raw);
      calls.push({ url, init });
      if (url.startsWith("https://runner.actions.githubusercontent.com"))
        return Response.json({ value: "signed.fixture.token" });
      if (url.endsWith("/challenge"))
        return Response.json({
          challengeId: "00000000-0000-4000-8000-000000000001",
          nonce: "b".repeat(64),
          policyDigest: "c".repeat(64),
          checksDigest: "d".repeat(64),
        });
      if (url.endsWith("/attestation")) return Response.json({ accepted: true });
      throw Error("unexpected request");
    };
  assert.deepEqual(
    await attestTestedTree({
      config,
      identity,
      oidcUrl: "https://runner.actions.githubusercontent.com/token",
      oidcToken: "fixture",
      previewBearer: "fixture",
      fetcher,
      signal: AbortSignal.timeout(1000),
    }),
    { accepted: true },
  );
  assert.equal(calls.length, 4);
  assert.notEqual(
    new URL(calls[0].url).searchParams.get("audience"),
    new URL(calls[2].url).searchParams.get("audience"),
  );
  assert.equal(JSON.parse(calls[3].init.body).nonce, "b".repeat(64));
  await assert.rejects(
    attestTestedTree({
      config: { ...config, controllerOrigin: "http://bad.invalid" },
      identity,
      oidcUrl: "https://runner.actions.githubusercontent.com/token",
      oidcToken: "fixture",
      previewBearer: "fixture",
      fetcher,
      signal: AbortSignal.timeout(1000),
    }),
  );
});
test("public previews require the signed OIDC proof without an extra bearer token", async () => {
  const sent = [];
  const fetcher = async (url, init) => {
    if (String(url).includes("runner.actions.githubusercontent.com"))
      return Response.json({ value: "signed.fixture.token" });
    sent.push(init.headers);
    return Response.json(
      String(url).endsWith("/challenge")
        ? {
            challengeId: "00000000-0000-4000-8000-000000000001",
            nonce: "b".repeat(64),
            policyDigest: "c".repeat(64),
            checksDigest: "d".repeat(64),
          }
        : { accepted: true },
    );
  };
  await attestTestedTree({
    config,
    identity,
    oidcUrl: "https://runner.actions.githubusercontent.com/token",
    oidcToken: "fixture",
    fetcher,
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(sent.length, 2);
  for (const headers of sent) {
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers["X-Hive-Release-OIDC"], "signed.fixture.token");
  }
});
test("candidate test job has no OIDC and attestor depends on it", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/controlled-tested-tree.yml", import.meta.url),
    "utf8",
  );
  const testJob = workflow.split("  test:\n")[1].split("  attest:\n")[0];
  assert.match(testJob, /id-token: none/);
  assert.doesNotMatch(testJob, /HIVE_RELEASE_PREVIEW_BEARER|id-token: write/);
  assert.match(workflow, /needs: test/);
  assert.match(workflow, /claims\.job_workflow_sha !== process\.env\.TRUSTED_REVISION/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
});

test("managed scope is checked before candidate execution and again by the isolated attestor", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/controlled-tested-tree.yml", import.meta.url),
    "utf8",
  );
  const scope =
    /- name: Verify managed source scope[\s\S]*? {8}run: \|\n([\s\S]*?) {6}- uses: actions\/checkout/
      .exec(workflow)[1]
      .split("\n")
      .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
      .join("\n");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const branch = `codex/delivery/${uuid}/${uuid}`;
  const base = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "kethalia/hive",
    EXPECTED_SOURCE_BASE: "codex/delivery-system-design",
    SOURCE_BASE: "codex/delivery-system-design",
    SOURCE_BRANCH: branch,
    SOURCE_REPOSITORY: "kethalia/hive",
    BASE_REPOSITORY: "kethalia/hive",
  };
  for (const patch of [
    {},
    { SOURCE_BRANCH: "codex/delivery-system-design" },
    { SOURCE_BRANCH: "codex/preview-integration-merge" },
    { SOURCE_BRANCH: "codex/delivery/not-a-task/not-an-operation" },
    { SOURCE_BRANCH: `${branch}/extra` },
    { SOURCE_BASE: "main" },
    { SOURCE_REPOSITORY: "other/hive" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
  ]) {
    const env = { ...base, ...patch },
      valid = Object.keys(patch).length === 0;
    const result = spawnSync(
      "/usr/bin/bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", scope],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status === 0, valid, JSON.stringify(patch));
    const event = {
      pull_request: {
        base: { ref: env.SOURCE_BASE, repo: { full_name: env.BASE_REPOSITORY } },
        head: { ref: env.SOURCE_BRANCH, repo: { full_name: env.SOURCE_REPOSITORY } },
      },
    };
    if (env.GITHUB_EVENT_NAME !== "pull_request") continue;
    if (valid)
      assert.doesNotThrow(() =>
        assertManagedTestSource(event, env.GITHUB_REPOSITORY, env.EXPECTED_SOURCE_BASE),
      );
    else
      assert.throws(() =>
        assertManagedTestSource(event, env.GITHUB_REPOSITORY, env.EXPECTED_SOURCE_BASE),
      );
  }
  assert.doesNotMatch(workflow, /vars\.HIVE_RELEASE_TESTED/);
  assert.match(workflow, /if: \$\{\{ inputs\.attestation-enabled \}\}/);
  assert.match(
    workflow,
    /HIVE_TESTED_MANAGED_SOURCE_BASE: \$\{\{ inputs\.managed-source-base \}\}/,
  );
});

test("public caller pins the producer, opts in explicitly and skips epic/feature/main/fork PRs", async () => {
  const caller = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = caller.split("  trusted-tested-tree:\n")[1].split("  build-lint-test:\n")[0];
  const pinned =
    /uses: kethalia\/hive\/\.github\/workflows\/controlled-tested-tree\.yml@([a-f0-9]{40})/.exec(
      job,
    )[1];
  assert.match(job, new RegExp(`trusted-revision: ${pinned}`));
  assert.match(job, /attestation-enabled: false/);
  assert.match(job, /managed-source-base: codex\/delivery-system-design/);
  assert.match(job, /contents: read\n {6}id-token: write/);
  assert.doesNotMatch(job, /secrets:|vars\.|contents: write|pull-requests: write/);
  const publicConfig = JSON.parse(/attestation-config-json: >-\n\s+(\{[^\n]+\})/.exec(job)[1]);
  const recipe = await readFile(
    new URL("../../.github/workflows/controlled-tested-tree.yml", import.meta.url),
  );
  const attestor = await readFile(new URL("./tested-attestor.mjs", import.meta.url));
  assert.equal(
    publicConfig.controlDigest,
    createHash("sha256")
      .update(recipe)
      .update(Buffer.from([0]))
      .update(attestor)
      .digest("hex"),
  );
  assert.equal(
    publicConfig.controllerOrigin,
    "https://codex-delivery-system-design-hive.b00ste.workers.dev",
  );
  assert.equal(publicConfig.audiencePrefix, "urn:hive:release-tested:epic-preview:");
  const condition = /if: >-\n([\s\S]*?) {4}permissions:/.exec(job)[1].trim();
  const uuid = "00000000-0000-4000-8000-000000000001",
    branch = `codex/delivery/${uuid}/${uuid}`;
  for (const [event, base, head, repository, expected] of [
    ["pull_request", "codex/delivery-system-design", branch, "kethalia/hive", true],
    ["pull_request", "main", "codex/delivery-system-design", "kethalia/hive", false],
    [
      "pull_request",
      "codex/delivery-system-design",
      "codex/preview-integration-merge",
      "kethalia/hive",
      false,
    ],
    ["pull_request", "main", branch, "kethalia/hive", false],
    ["pull_request", "codex/delivery-system-design", branch, "other/hive", false],
    ["workflow_dispatch", "codex/delivery-system-design", branch, "kethalia/hive", false],
  ]) {
    const github = {
      event_name: event,
      repository: "kethalia/hive",
      event: {
        pull_request: { base: { ref: base }, head: { ref: head, repo: { full_name: repository } } },
      },
    };
    assert.equal(
      runInNewContext(
        condition,
        { github, startsWith: (value, prefix) => value.startsWith(prefix) },
        { timeout: 1000 },
      ),
      expected,
    );
  }
});
