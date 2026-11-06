import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { withReleaseDeadline } from "../../../deploy/cloudflare/app/release-health";
import { publicationBody, publicationFetch } from "../templates/publication-io";
import {
  nativeArtifactSchema,
  nativeDigest,
  nativePublisherIdentitySchema,
  nativePublisherPolicySchema,
} from "./release-native-preview-contracts";

const id = z
  .union([z.string().regex(/^[1-9][0-9]{0,19}$/), z.number().int().positive().safe()])
  .transform(String);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const nativeBuildPolicySchema = z
  .object({
    owner: z.literal("kethalia"),
    name: z.literal("hive"),
    repositoryId: id,
    repositoryOwnerId: id,
    workflowId: id,
    callerWorkflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.yml$/),
    callerWorkflowBlobSha: sha,
    reusableWorkflowPath: z
      .string()
      .regex(
        /^kethalia\/hive\/\.github\/workflows\/[A-Za-z0-9_.-]+\.yml@(?:refs\/heads\/[A-Za-z0-9_./-]+|[a-f0-9]{40})$/,
      ),
    workflowSha: sha,
  })
  .strict();
async function json(
  url: string,
  token: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const response = await publicationFetch(
    Promise.resolve().then(() =>
      fetcher(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
    ),
    signal,
  );
  if (response.status !== 200 || response.redirected) {
    void response.body?.cancel().catch(() => {});
    throw Error("native_authority_unavailable");
  }
  return JSON.parse(Buffer.from(await publicationBody(response, 262144, signal)).toString("utf8"));
}
function part(value: string, limit: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > limit) throw Error();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw Error();
  return bytes;
}
/** Separate publisher context: its OIDC sha/ref identify reviewed publisher code,
 * never candidate source. Payload audience binds the actual operation/manifest. */
export async function verifyNativePublisher(
  raw: unknown,
  token: string,
  purpose: "artifact" | "grant" | "reauthorize" | "receipt",
  rawPolicy: unknown,
  nowMs: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  try {
    const policy = nativePublisherPolicySchema.parse(rawPolicy);
    if (typeof token !== "string" || token.length > 16384) throw Error();
    const pieces = token.split(".");
    if (pieces.length !== 3) throw Error();
    const header = z
      .object({
        alg: z.literal("RS256"),
        kid: z.string().min(1).max(200),
        typ: z.literal("JWT").optional(),
      })
      .parse(JSON.parse(part(pieces[0], 2048).toString("utf8")));
    const claims = z
      .object({
        iss: z.literal("https://token.actions.githubusercontent.com"),
        aud: z.string(),
        sub: z.literal("repo:kethalia/hive:environment:hive-native-release"),
        repository_id: id,
        repository_owner_id: id,
        run_id: id,
        run_attempt: z.string().regex(/^[1-9][0-9]{0,9}$/),
        event_name: z.enum(["workflow_run", "workflow_dispatch"]),
        job_workflow_ref: z.string(),
        job_workflow_sha: sha,
        sha,
        ref: z.string(),
        iat: z.number().int().safe(),
        nbf: z.number().int().safe(),
        exp: z.number().int().safe(),
        jti: z.string().min(1).max(200),
      })
      .parse(JSON.parse(part(pieces[1], 12000).toString("utf8")));
    const now = Math.floor(nowMs / 1000);
    if (
      claims.aud !== `${policy.audiencePrefix}${purpose}:${nativeDigest(raw)}` ||
      claims.repository_id !== policy.repositoryId ||
      claims.repository_owner_id !== policy.repositoryOwnerId ||
      claims.job_workflow_ref !== policy.workflowRef ||
      claims.job_workflow_sha !== policy.workflowSha ||
      claims.sha !== policy.contextSha ||
      claims.ref !== policy.ref ||
      claims.iat > now + 30 ||
      claims.nbf > now + 30 ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 600
    )
      throw Error();
    const keys = z
      .object({
        keys: z
          .array(
            z
              .object({
                kid: z.string(),
                kty: z.literal("RSA"),
                n: z.string(),
                e: z.string(),
                alg: z.literal("RS256").optional(),
                use: z.literal("sig").optional(),
              })
              .passthrough(),
          )
          .max(100),
      })
      .parse(
        await json(
          "https://token.actions.githubusercontent.com/.well-known/jwks",
          undefined,
          signal,
          fetcher,
        ),
      )
      .keys.filter((key) => key.kid === header.kid);
    if (keys.length !== 1 || part(keys[0].n, 4096).length < 256 || !part(keys[0].e, 64).length)
      throw Error();
    const key = createPublicKey({ key: { kty: "RSA", n: keys[0].n, e: keys[0].e }, format: "jwk" });
    if (
      signal.aborted ||
      !verify("RSA-SHA256", Buffer.from(`${pieces[0]}.${pieces[1]}`), key, part(pieces[2], 2048))
    )
      throw Error();
    return {
      publisher: nativePublisherIdentitySchema.parse({
        repositoryId: claims.repository_id,
        repositoryOwnerId: claims.repository_owner_id,
        runId: claims.run_id,
        runAttempt: Number(claims.run_attempt),
        workflowSha: claims.job_workflow_sha,
      }),
      expiresAt: claims.exp * 1000,
    };
  } catch {
    throw Error("native_publisher_unauthorized");
  }
}

/** Completed builder and immutable artifact are independently fetched; publisher
 * workflow identity is not substituted for candidate build/source authority. */
export async function verifyNativeBuilder(
  rawManifest: unknown,
  rawPolicy: unknown,
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  try {
    const manifest = nativeArtifactSchema.parse(rawManifest),
      p = nativeBuildPolicySchema.parse(rawPolicy),
      b = manifest.builder;
    if (
      !token ||
      /[\r\n]/.test(token) ||
      b.repositoryId !== p.repositoryId ||
      b.repositoryOwnerId !== p.repositoryOwnerId ||
      b.workflowId !== p.workflowId ||
      b.runAttempt !== 1
    )
      throw Error();
    return await withReleaseDeadline(
      async (deadline) => {
        const root = `https://api.github.com/repos/${p.owner}/${p.name}`;
        const branch = "codex/delivery-system-design";
        // GitHub documents path with an optional @ref suffix. It is a caller
        // locator, never artifact authority: the bytes are pinned separately.
        const callerRunPath = z.enum([
          p.callerWorkflowPath,
          `${p.callerWorkflowPath}@${branch}`,
          `${p.callerWorkflowPath}@refs/heads/${branch}`,
          `${p.callerWorkflowPath}@${manifest.sourceSha}`,
        ]);
        // Artifact metadata identifies the run, not its attempt. Until a
        // stronger provenance format exists, accept only an unretried first
        // run and check its latest attempt on both sides of the artifact read.
        const latest = async () => {
          const run = z
            .object({
              id,
              run_attempt: z.literal(1),
              workflow_id: id,
              status: z.literal("completed"),
              conclusion: z.literal("success"),
              head_sha: sha,
              repository: z.object({ id }),
              head_repository: z.object({ id }),
              event: z.enum(["push", "workflow_dispatch"]),
              head_branch: z.literal(branch),
              path: callerRunPath,
            })
            .parse(await json(`${root}/actions/runs/${b.runId}`, token, deadline, fetcher));
          if (
            run.id !== b.runId ||
            run.workflow_id !== p.workflowId ||
            run.head_sha !== manifest.sourceSha ||
            run.repository.id !== p.repositoryId ||
            run.head_repository.id !== p.repositoryId
          )
            throw Error();
        };
        await latest();
        const caller = z
          .object({
            type: z.literal("file"),
            encoding: z.literal("base64"),
            path: z.literal(p.callerWorkflowPath),
            sha: z.literal(p.callerWorkflowBlobSha),
            size: z.number().int().positive().max(32768),
            content: z.string().max(45000),
          })
          .parse(
            await json(
              `${root}/contents/${p.callerWorkflowPath}?ref=${manifest.sourceSha}`,
              token,
              deadline,
              fetcher,
            ),
          );
        const encoded = caller.content.replace(/[\r\n]/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Error();
        const callerBytes = Buffer.from(encoded, "base64");
        if (
          callerBytes.toString("base64") !== encoded ||
          callerBytes.length !== caller.size ||
          createHash("sha1")
            .update(`blob ${callerBytes.length}\0`)
            .update(callerBytes)
            .digest("hex") !== p.callerWorkflowBlobSha
        )
          throw Error();
        const run = z
          .object({
            id,
            run_attempt: z.number().int().positive(),
            workflow_id: id,
            status: z.literal("completed"),
            conclusion: z.literal("success"),
            head_sha: sha,
            repository: z.object({ id }),
            head_repository: z.object({ id }),
            event: z.enum(["push", "workflow_dispatch"]),
            head_branch: z.literal(branch),
            path: callerRunPath,
            referenced_workflows: z.array(z.object({ path: z.string(), sha })).max(32),
          })
          .parse(
            await json(
              `${root}/actions/runs/${b.runId}/attempts/${b.runAttempt}`,
              token,
              deadline,
              fetcher,
            ),
          );
        if (
          run.id !== b.runId ||
          run.run_attempt !== b.runAttempt ||
          run.workflow_id !== p.workflowId ||
          run.head_sha !== manifest.sourceSha ||
          run.repository.id !== p.repositoryId ||
          run.head_repository.id !== p.repositoryId ||
          run.referenced_workflows.filter(
            (w) => w.path === p.reusableWorkflowPath && w.sha === p.workflowSha,
          ).length !== 1
        )
          throw Error();
        const artifact = z
          .object({
            id,
            name: z.literal("hive-native-release"),
            expired: z.literal(false),
            digest: z.string(),
            size_in_bytes: z
              .number()
              .int()
              .positive()
              .max(128 * 1024 * 1024),
            expires_at: z.string(),
            workflow_run: z.object({
              id,
              repository_id: id,
              head_repository_id: id,
              head_sha: sha,
            }),
          })
          .parse(await json(`${root}/actions/artifacts/${b.artifactId}`, token, deadline, fetcher));
        if (
          artifact.id !== b.artifactId ||
          artifact.digest !== `sha256:${b.artifactZipDigest}` ||
          artifact.workflow_run.id !== b.runId ||
          artifact.workflow_run.repository_id !== p.repositoryId ||
          artifact.workflow_run.head_repository_id !== p.repositoryId ||
          artifact.workflow_run.head_sha !== manifest.sourceSha ||
          Date.parse(artifact.expires_at) <= Date.now() ||
          !Number.isFinite(Date.parse(artifact.expires_at))
        )
          throw Error();
        await latest();
        return {
          provider: "github-completed-native-builder" as const,
          sourceSha: manifest.sourceSha,
          runId: b.runId,
          runAttempt: b.runAttempt,
          artifactId: b.artifactId,
          artifactZipDigest: b.artifactZipDigest,
          workflowSha: p.workflowSha,
          expiresAt: Date.parse(artifact.expires_at),
          status: "completed" as const,
          conclusion: "success" as const,
        };
      },
      signal,
      15000,
    );
  } catch {
    throw Error("native_builder_unverified");
  }
}
