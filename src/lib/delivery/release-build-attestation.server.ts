import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";

const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{40}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const component = z
  .object({
    script: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
    versionId: uuid,
    artifactDigest: digest,
    configDigest: digest,
    providerScriptHash: z.string().min(1).max(256),
  })
  .strict();
export const releaseBuildManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: uuid,
    ownerId: uuid,
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    mergeSha: sha,
    targetDigest: digest,
    runId: providerId,
    runAttempt: z.number().int().positive().safe(),
    app: component,
    auth: component,
  })
  .strict()
  .refine((v) => v.app.script !== v.auth.script);
export const releaseBuildChallengeSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("release_build_challenge"),
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    mergeSha: sha,
    targetDigest: digest,
    publisherConfigDigest: digest,
    runId: providerId,
    runAttempt: z.number().int().positive().safe(),
  })
  .strict();
export type ReleaseBuildManifest = z.infer<typeof releaseBuildManifestSchema>;
export const releaseBuildWorkflowSchema = z
  .object({
    audiencePrefix: z.string().regex(/^urn:hive:release-build:[a-z0-9_-]{1,48}:$/),
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    workflowRef: z.string().min(1).max(250),
    workflowSha: sha,
    mode: z.enum(["preview", "production"]).optional(),
    productionEnabled: z.boolean().optional(),
    branchRef: z
      .string()
      .regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/)
      .refine((v) => !v.includes("..") && !v.includes("//")),
  })
  .strict()
  .superRefine((v, ctx) => {
    const mode = v.mode ?? "preview";
    if (
      (mode === "preview" &&
        ["refs/heads/main", "refs/heads/master"].includes(v.branchRef.toLowerCase())) ||
      (mode === "production" && v.productionEnabled !== true)
    )
      ctx.addIssue({ code: "custom", message: "Release environment is not enabled" });
  });
const claimsSchema = z
  .object({
    iss: z.literal("https://token.actions.githubusercontent.com"),
    aud: z.string(),
    repository_id: providerId,
    repository_owner_id: providerId,
    sha,
    ref: z.string(),
    event_name: z.literal("push"),
    run_id: providerId,
    run_attempt: z.string().regex(/^[1-9][0-9]{0,9}$/),
    job_workflow_ref: z.string().min(1).max(250),
    job_workflow_sha: sha,
    jti: z.string().min(1).max(200),
    iat: z.number().int().safe(),
    nbf: z.number().int().safe(),
    exp: z.number().int().safe(),
  })
  .passthrough();
const headerSchema = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
    typ: z.literal("JWT").optional(),
  })
  .passthrough();
function part(value: string, max: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > max)
    throw new Error("release_build_token_invalid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("release_build_token_invalid");
  return bytes;
}

/** The pinned reusable workflow requests a GitHub OIDC token whose audience
 * includes the canonical manifest digest. The JWT is authentication, not a
 * substitute for separately verifying the workflow's upload/build procedure.
 * Callers must journal the token jti digest and revalidate source/target/merge
 * in the same database transaction as attestation insertion. */
export async function verifyReleaseBuildToken(
  rawManifest: unknown,
  token: string,
  rawApproved: unknown,
  nowMs: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const manifest = releaseBuildManifestSchema.parse(rawManifest);
  const result = await verifyBuildIdentity(manifest, token, rawApproved, nowMs, signal, fetcher);
  return { ...result, manifest };
}

/** A separately domain-separated OIDC audience authenticates a request to
 * discover deployment-owned configuration; DB authority is still rechecked. */
export async function verifyReleaseBuildChallenge(
  rawChallenge: unknown,
  token: string,
  rawApproved: unknown,
  nowMs: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const challenge = releaseBuildChallengeSchema.parse(rawChallenge);
  const result = await verifyBuildIdentity(challenge, token, rawApproved, nowMs, signal, fetcher);
  return { ...result, challenge };
}

async function verifyBuildIdentity(
  manifest: z.infer<typeof releaseBuildChallengeSchema> | ReleaseBuildManifest,
  token: string,
  rawApproved: unknown,
  nowMs: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const approved = releaseBuildWorkflowSchema.parse(rawApproved);
  z.number().int().nonnegative().safe().parse(nowMs);
  if (typeof token !== "string" || token.length > 16384)
    throw new Error("release_build_token_invalid");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("release_build_token_invalid");
  const header = headerSchema.parse(JSON.parse(part(parts[0], 2048).toString("utf8")));
  const claims = claimsSchema.parse(JSON.parse(part(parts[1], 12000).toString("utf8")));
  const signature = part(parts[2], 2048),
    now = Math.floor(nowMs / 1000);
  const manifestDigest = githubSourceDigest(manifest);
  if (
    claims.aud !== `${approved.audiencePrefix}${manifestDigest}` ||
    claims.repository_id !== approved.repositoryId ||
    claims.repository_owner_id !== approved.repositoryOwnerId ||
    claims.repository_id !== manifest.repositoryId ||
    claims.repository_owner_id !== manifest.repositoryOwnerId ||
    claims.sha !== manifest.mergeSha ||
    claims.ref !== approved.branchRef ||
    claims.job_workflow_ref !== approved.workflowRef ||
    claims.job_workflow_sha !== approved.workflowSha ||
    claims.run_id !== manifest.runId ||
    claims.run_attempt !== String(manifest.runAttempt) ||
    claims.iat > now + 30 ||
    claims.nbf > now + 30 ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 600
  )
    throw new Error("release_build_token_scope");
  const response = await fetcher("https://token.actions.githubusercontent.com/.well-known/jwks", {
    method: "GET",
    redirect: "error",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("release_build_keys_unavailable");
  const keyset = z
    .object({
      keys: z.array(z.object({ kid: z.string() }).passthrough()).max(100),
    })
    .passthrough()
    .parse(await boundedReleaseJson(response, 262144, signal));
  const keys = keyset.keys.filter((key) => key.kid === header.kid);
  if (keys.length !== 1) throw new Error("release_build_keys_unavailable");
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
  if (part(selected.n, 4096).length < 256 || part(selected.e, 64).length === 0)
    throw new Error("release_build_keys_unavailable");
  const key = createPublicKey({ key: { kty: "RSA", n: selected.n, e: selected.e }, format: "jwk" });
  if (
    signal.aborted ||
    !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)
  )
    throw new Error("release_build_token_invalid");
  return {
    manifestDigest,
    jtiDigest: githubSourceDigest({ issuer: claims.iss, jti: claims.jti }),
    expiresAt: claims.exp * 1000,
    workflowSha: claims.job_workflow_sha,
  };
}
