import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const uuid = z.string().uuid();

/** Deployment enrollment is immutable for a given authority digest. The
 * reusable workflow owns the test recipe; candidate code runs on a separate
 * runner with no OIDC or controller credentials. */
export const releaseTestWorkflowSchema = z
  .object({
    audiencePrefix: z.string().regex(/^urn:hive:release-tested:[a-z0-9_-]{1,48}:$/),
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    workflowRef: z.string().min(1).max(250),
    workflowSha: sha,
    controlDigest: digest,
  })
  .strict();
export const releaseTestChallengeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("release_test_challenge"),
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    pullNumber: z.number().int().positive().safe(),
    headSha: sha,
    baseSha: sha,
    mergeSha: sha,
    treeSha: sha,
    runId: providerId,
    runAttempt: z.number().int().positive().safe(),
    controlDigest: digest,
  })
  .strict();
export const releaseTestAttestationSchema = releaseTestChallengeRequestSchema
  .omit({ purpose: true })
  .extend({
    purpose: z.literal("release_test_attestation"),
    challengeId: uuid,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    policyDigest: digest,
    checksDigest: digest,
  })
  .strict();
const claimsSchema = z
  .object({
    iss: z.literal("https://token.actions.githubusercontent.com"),
    aud: z.string(),
    repository_id: providerId,
    repository_owner_id: providerId,
    sha,
    ref: z.string(),
    event_name: z.literal("pull_request"),
    run_id: providerId,
    run_attempt: providerId,
    job_workflow_ref: z.string(),
    job_workflow_sha: sha,
    jti: z.string().min(1).max(200),
    iat: z.number().int().safe(),
    nbf: z.number().int().safe(),
    exp: z.number().int().safe(),
  })
  .passthrough();
const part = (value: string, max: number) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > max)
    throw Error("release_test_token_invalid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw Error("release_test_token_invalid");
  return bytes;
};
/** Authenticates exact request bytes and the GitHub-hosted reviewed reusable
 * workflow. This alone is not test proof: callers must validate the challenge,
 * independently fetch workflow/job completion, and bind current policy. */
export async function verifyReleaseTestToken(
  raw: unknown,
  token: string,
  rawWorkflow: unknown,
  nowMs: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const payload = z
    .union([releaseTestChallengeRequestSchema, releaseTestAttestationSchema])
    .parse(raw);
  const workflow = releaseTestWorkflowSchema.parse(rawWorkflow);
  if (typeof token !== "string" || token.length > 16384) throw Error("release_test_token_invalid");
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("release_test_token_invalid");
  const header = z
    .object({ alg: z.literal("RS256"), kid: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/) })
    .passthrough()
    .parse(JSON.parse(part(parts[0], 2048).toString("utf8")));
  const claims = claimsSchema.parse(JSON.parse(part(parts[1], 12000).toString("utf8")));
  const now = Math.floor(nowMs / 1000),
    payloadDigest = githubSourceDigest(payload);
  if (
    claims.aud !== `${workflow.audiencePrefix}${payloadDigest}` ||
    claims.repository_id !== workflow.repositoryId ||
    claims.repository_id !== payload.repositoryId ||
    claims.repository_owner_id !== workflow.repositoryOwnerId ||
    claims.repository_owner_id !== payload.repositoryOwnerId ||
    claims.sha !== payload.mergeSha ||
    claims.ref !== `refs/pull/${payload.pullNumber}/merge` ||
    claims.job_workflow_ref !== workflow.workflowRef ||
    claims.job_workflow_sha !== workflow.workflowSha ||
    claims.run_id !== payload.runId ||
    claims.run_attempt !== String(payload.runAttempt) ||
    payload.controlDigest !== workflow.controlDigest ||
    claims.iat > now + 30 ||
    claims.nbf > now + 30 ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 600
  )
    throw Error("release_test_token_scope");
  const response = await fetcher("https://token.actions.githubusercontent.com/.well-known/jwks", {
    method: "GET",
    redirect: "manual",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400))
    throw Error("release_test_keys_unavailable");
  const keys = z
    .object({ keys: z.array(z.object({ kid: z.string() }).passthrough()).max(100) })
    .passthrough()
    .parse(await boundedReleaseJson(response, 262144, signal))
    .keys.filter((key) => key.kid === header.kid);
  if (keys.length !== 1) throw Error("release_test_keys_unavailable");
  const selected = z
    .object({
      kty: z.literal("RSA"),
      n: z.string(),
      e: z.string(),
      use: z.literal("sig").optional(),
      alg: z.literal("RS256").optional(),
    })
    .passthrough()
    .parse(keys[0]);
  if (part(selected.n, 4096).length < 256 || !part(selected.e, 64).length)
    throw Error("release_test_keys_unavailable");
  const key = createPublicKey({ key: { kty: "RSA", n: selected.n, e: selected.e }, format: "jwk" });
  if (
    signal.aborted ||
    !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, part(parts[2], 2048))
  )
    throw Error("release_test_token_invalid");
  return {
    payload,
    payloadDigest,
    jtiDigest: githubSourceDigest({ issuer: claims.iss, jti: claims.jti }),
    expiresAt: claims.exp * 1000,
  };
}
