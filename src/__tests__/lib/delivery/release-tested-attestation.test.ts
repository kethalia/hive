import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { verifyReleaseTestToken } from "@/lib/delivery/release-tested-attestation.server";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" };
const workflow = {
  audiencePrefix: "urn:hive:release-tested:preview:",
  repositoryId: "123",
  repositoryOwnerId: "456",
  workflowRef: "trusted/repo/.github/workflows/test.yml@refs/tags/v1",
  workflowSha: "a".repeat(40),
  controlDigest: "b".repeat(64),
};
const request = {
  schemaVersion: 1,
  purpose: "release_test_challenge",
  repositoryId: "123",
  repositoryOwnerId: "456",
  pullNumber: 2,
  headSha: "1".repeat(40),
  baseSha: "2".repeat(40),
  mergeSha: "3".repeat(40),
  treeSha: "4".repeat(40),
  runId: "789",
  runAttempt: 1,
  controlDigest: workflow.controlDigest,
};
const now = 1700000000;
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: workflow.audiencePrefix + githubSourceDigest(request),
  repository_id: "123",
  repository_owner_id: "456",
  sha: request.mergeSha,
  ref: "refs/pull/2/merge",
  event_name: "pull_request",
  run_id: "789",
  run_attempt: "1",
  job_workflow_ref: workflow.workflowRef,
  job_workflow_sha: workflow.workflowSha,
  jti: "fixture",
  iat: now - 1,
  nbf: now - 1,
  exp: now + 300,
};
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(payload: unknown) {
  const bytes = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(payload)}`;
  return `${bytes}.${sign("RSA-SHA256", Buffer.from(bytes), privateKey).toString("base64url")}`;
}
const fetcher: typeof fetch = async () => Response.json({ keys: [jwk] });
const verify = (payload: unknown, c: unknown) =>
  verifyReleaseTestToken(
    payload,
    token(c),
    workflow,
    now * 1000,
    AbortSignal.timeout(1000),
    fetcher,
  );
describe("trusted tested-tree OIDC", () => {
  it("binds exact pull merge, workflow revision and audience", async () => {
    expect((await verify(request, claims)).payloadDigest).toBe(githubSourceDigest(request));
    for (const changed of [
      { job_workflow_sha: "f".repeat(40) },
      { sha: request.headSha },
      { ref: "refs/pull/3/merge" },
      { event_name: "push" },
      { exp: now - 1 },
    ])
      await expect(verify(request, { ...claims, ...changed })).rejects.toThrow();
    await expect(verify({ ...request, treeSha: "5".repeat(40) }, claims)).rejects.toThrow();
  });
  it("domain separates challenge and final nonce-bearing attestation", async () => {
    const { purpose: _, ...scope } = request;
    const attestation = {
      ...scope,
      purpose: "release_test_attestation",
      challengeId: "00000000-0000-4000-8000-000000000001",
      nonce: "c".repeat(64),
      policyDigest: "d".repeat(64),
      checksDigest: "e".repeat(64),
    };
    await expect(verify(attestation, claims)).rejects.toThrow();
    expect(
      (
        await verify(attestation, {
          ...claims,
          aud: workflow.audiencePrefix + githubSourceDigest(attestation),
        })
      ).payload,
    ).toEqual(attestation);
  });
});
