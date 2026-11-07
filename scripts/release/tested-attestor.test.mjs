import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { attestTestedTree } from "./tested-attestor.mjs";

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
