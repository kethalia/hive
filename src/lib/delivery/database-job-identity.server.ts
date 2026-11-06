import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import {
  databaseCatalogSchema,
  databaseOidcAudience,
} from "../../../services/migrate/src/delivery/wire.mjs";
import { githubSourceDigest } from "./github-evidence.server";

const provider = z.string().regex(/^[1-9][0-9]{0,19}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/);
const claimsSchema = z
  .object({
    iss: z.literal("https://token.actions.githubusercontent.com"),
    aud: z.string(),
    repository_id: provider,
    repository_owner_id: provider,
    sha,
    ref: z.string(),
    event_name: z.literal("workflow_dispatch"),
    run_id: provider,
    run_attempt: z.string().regex(/^[1-9][0-9]{0,9}$/),
    job_workflow_ref: z.string().min(1).max(250),
    job_workflow_sha: sha,
    jti: z.string().min(1).max(200),
    iat: z.number().int().safe(),
    nbf: z.number().int().safe(),
    exp: z.number().int().safe(),
  })
  .passthrough();
function decode(value: string, max: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > max) throw Error("database_oidc_invalid");
  const b = Buffer.from(value, "base64url");
  if (b.toString("base64url") !== value) throw Error("database_oidc_invalid");
  return b;
}
/** Purpose-bound workload identity. The protected reusable workflow must
 * independently approve SQL/compatibility; JWT possession is not DB authority. */
export async function verifyDatabaseJobIdentity(
  request: { sourceSha: string; githubRunId: string; githubRunAttempt: number },
  token: string,
  rawCatalog: unknown,
  nowMs: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const catalog = databaseCatalogSchema.parse(rawCatalog),
    now = Math.floor(nowMs / 1000);
  if (typeof token !== "string" || token.length > 16384) throw Error("database_oidc_invalid");
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("database_oidc_invalid");
  const header = z
    .object({
      alg: z.literal("RS256"),
      kid: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
      typ: z.literal("JWT").optional(),
    })
    .passthrough()
    .parse(JSON.parse(decode(parts[0], 2048).toString("utf8")));
  const claims = claimsSchema.parse(JSON.parse(decode(parts[1], 12000).toString("utf8")));
  if (
    claims.aud !== databaseOidcAudience(request) ||
    claims.repository_id !== catalog.repositoryId ||
    claims.repository_owner_id !== catalog.repositoryOwnerId ||
    claims.sha !== catalog.dispatcherSha ||
    claims.ref !== catalog.branchRef ||
    claims.job_workflow_ref !== catalog.workflowRef ||
    claims.job_workflow_sha !== catalog.workflowSha ||
    claims.run_id !== request.githubRunId ||
    claims.run_attempt !== String(request.githubRunAttempt) ||
    claims.iat > now + 30 ||
    claims.nbf > now + 30 ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 600
  )
    throw Error("database_oidc_scope");
  const response = await fetcher("https://token.actions.githubusercontent.com/.well-known/jwks", {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw Error("database_oidc_unavailable");
  const set = z
    .object({ keys: z.array(z.object({ kid: z.string() }).passthrough()).max(100) })
    .passthrough()
    .parse(await boundedReleaseJson(response, 262144, signal));
  const matches = set.keys.filter((k) => k.kid === header.kid);
  if (matches.length !== 1) throw Error("database_oidc_unavailable");
  const key = z
    .object({
      kty: z.literal("RSA"),
      n: z.string(),
      e: z.string(),
      use: z.literal("sig").optional(),
      alg: z.literal("RS256").optional(),
    })
    .passthrough()
    .parse(matches[0]);
  if (
    decode(key.n, 4096).length < 256 ||
    decode(key.e, 64).length === 0 ||
    signal.aborted ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" }),
      decode(parts[2], 2048),
    )
  )
    throw Error("database_oidc_invalid");
  return {
    jtiDigest: githubSourceDigest({ issuer: claims.iss, jti: claims.jti }),
    expiresAt: claims.exp * 1000,
    workflowDigest: githubSourceDigest({ ref: catalog.workflowRef, sha: catalog.workflowSha }),
  };
}
