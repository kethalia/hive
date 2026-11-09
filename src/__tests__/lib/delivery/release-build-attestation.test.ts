import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  verifyReleaseBuildChallenge,
  verifyReleaseBuildToken,
} from "@/lib/delivery/release-build-attestation.server";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" };
const manifest = {
  schemaVersion: 1,
  releaseId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  repositoryId: "123",
  repositoryOwnerId: "456",
  mergeSha: "a".repeat(40),
  targetDigest: "b".repeat(64),
  runId: "789",
  runAttempt: 1,
  app: {
    script: "preview-app",
    versionId: "00000000-0000-4000-8000-000000000003",
    artifactDigest: "c".repeat(64),
    configDigest: "d".repeat(64),
    providerScriptHash: "app-hash",
  },
  auth: {
    script: "preview-auth",
    versionId: "00000000-0000-4000-8000-000000000004",
    artifactDigest: "e".repeat(64),
    configDigest: "f".repeat(64),
    providerScriptHash: "auth-hash",
  },
};
const approved = {
  audiencePrefix: "urn:hive:release-build:preview:",
  repositoryId: "123",
  repositoryOwnerId: "456",
  workflowRef: "trusted/build/.github/workflows/upload.yml@refs/tags/v1",
  workflowSha: "1".repeat(40),
  branchRef: "refs/heads/preview",
};
const now = 1700000000;
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: `${approved.audiencePrefix}${githubSourceDigest(manifest)}`,
  repository_id: "123",
  repository_owner_id: "456",
  sha: manifest.mergeSha,
  ref: approved.branchRef,
  event_name: "push",
  run_id: "789",
  run_attempt: "1",
  job_workflow_ref: approved.workflowRef,
  job_workflow_sha: approved.workflowSha,
  jti: "fixture-jti",
  iat: now - 5,
  nbf: now - 5,
  exp: now + 300,
};
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(
  payload: unknown,
  header = { alg: "RS256", kid: "fixture", typ: "JWT", x5t: "fixture" },
) {
  const content = `${encode(header)}.${encode(payload)}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
}
const fetcher: typeof fetch = async (url, init) => {
  expect(String(url)).toBe("https://token.actions.githubusercontent.com/.well-known/jwks");
  expect(init?.redirect).toBe("error");
  return Response.json({ keys: [jwk] });
};
describe("GitHub release build OIDC", () => {
  it("separates the upload challenge audience from the manifest audience", async () => {
    const { app: _app, auth: _auth, ownerId: _owner, releaseId: _release, ...identity } = manifest;
    const challenge = {
      ...identity,
      purpose: "release_build_challenge",
      publisherConfigDigest: "f".repeat(64),
    };
    const challengeClaims = {
      ...claims,
      aud: `${approved.audiencePrefix}${githubSourceDigest(challenge)}`,
    };
    const signal = new AbortController().signal;
    const verified = await verifyReleaseBuildChallenge(
      challenge,
      token(challengeClaims),
      approved,
      now * 1000,
      signal,
      fetcher,
    );
    expect(verified.challenge).toEqual(challenge);
    await expect(
      verifyReleaseBuildChallenge(challenge, token(claims), approved, now * 1000, signal, fetcher),
    ).rejects.toThrow();
    await expect(
      verifyReleaseBuildToken(
        manifest,
        token(challengeClaims),
        approved,
        now * 1000,
        signal,
        fetcher,
      ),
    ).rejects.toThrow();
  });
  it("authenticates an exact manifest, reviewed reusable workflow and run", async () => {
    const verified = await verifyReleaseBuildToken(
      manifest,
      token(claims),
      approved,
      now * 1000,
      new AbortController().signal,
      fetcher,
    );
    expect(verified.manifestDigest).toBe(githubSourceDigest(manifest));
    expect(verified.workflowSha).toBe(approved.workflowSha);
  });
  it("rejects manifest tampering, foreign workflow/source, expired tokens and changed signatures", async () => {
    const signal = new AbortController().signal;
    await expect(
      verifyReleaseBuildToken(
        { ...manifest, mergeSha: "2".repeat(40) },
        token(claims),
        approved,
        now * 1000,
        signal,
        fetcher,
      ),
    ).rejects.toThrow();
    await expect(
      verifyReleaseBuildToken(
        manifest,
        token({ ...claims, job_workflow_sha: "2".repeat(40) }),
        approved,
        now * 1000,
        signal,
        fetcher,
      ),
    ).rejects.toThrow();
    await expect(
      verifyReleaseBuildToken(
        manifest,
        token({ ...claims, exp: now - 1 }),
        approved,
        now * 1000,
        signal,
        fetcher,
      ),
    ).rejects.toThrow();
    const valid = token(claims),
      sections = valid.split(".");
    sections[2] = Buffer.alloc(256).toString("base64url");
    await expect(
      verifyReleaseBuildToken(manifest, sections.join("."), approved, now * 1000, signal, fetcher),
    ).rejects.toThrow();
  });
  it("rejects duplicate keys, unapproved main branch and algorithm confusion", async () => {
    const signal = new AbortController().signal;
    await expect(
      verifyReleaseBuildToken(
        manifest,
        token(claims),
        { ...approved, branchRef: "refs/heads/main" },
        now * 1000,
        signal,
        fetcher,
      ),
    ).rejects.toThrow();
    await expect(
      verifyReleaseBuildToken(
        manifest,
        token(claims, { alg: "HS256", kid: "fixture", typ: "JWT", x5t: "fixture" }),
        approved,
        now * 1000,
        signal,
        fetcher,
      ),
    ).rejects.toThrow();
    await expect(
      verifyReleaseBuildToken(manifest, token(claims), approved, now * 1000, signal, async () =>
        Response.json({ keys: [jwk, jwk] }),
      ),
    ).rejects.toThrow();
  });
  it("accepts main only under an explicitly enabled production workflow", async () => {
    const production = {
      ...approved,
      mode: "production",
      productionEnabled: true,
      branchRef: "refs/heads/main",
    };
    const payload = { ...claims, ref: production.branchRef };
    expect(
      (
        await verifyReleaseBuildToken(
          manifest,
          token(payload),
          production,
          now * 1000,
          new AbortController().signal,
          fetcher,
        )
      ).manifestDigest,
    ).toBe(githubSourceDigest(manifest));
    await expect(
      verifyReleaseBuildToken(
        manifest,
        token(payload),
        { ...production, productionEnabled: false },
        now * 1000,
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow();
  });
});
