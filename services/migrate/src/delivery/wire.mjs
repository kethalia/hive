import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { digest, requireValue, validatePlan, validateScope } from "./contracts.mjs";

const sha = z.string().regex(/^[a-f0-9]{40}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid(),
  provider = z.string().regex(/^[1-9][0-9]{0,19}$/),
  stamp = z.number().int().nonnegative().safe();
const image = z
  .string()
  .max(500)
  .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const containerCompatibilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogId: z.string().uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    postgresImage: image,
    oldImage: image,
    newImage: image,
    scenarioImage: image,
    oldAppDigest: z.string().regex(/^[a-f0-9]{64}$/),
    newAppDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compatibilityDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !v.oldImage.endsWith(`@sha256:${v.oldAppDigest}`) ||
      !v.newImage.endsWith(`@sha256:${v.newAppDigest}`)
    )
      ctx.addIssue({ code: "custom", message: "Artifact digest mismatch" });
  });

const artifactUrl = z
  .string()
  .url()
  .max(2000)
  .refine((raw) => {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  });
export const workerdCompatibilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("workerd"),
    catalogId: uuid,
    planDigest: hash,
    sourceSha: sha,
    oldAppDigest: hash,
    newAppDigest: hash,
    compatibilityDigest: hash,
    postgresImage: image,
    oldAuthDigest: hash,
    newAuthDigest: hash,
    oldArtifactUrl: artifactUrl,
    newArtifactUrl: artifactUrl,
    scenarioPath: z.string().regex(/^scripts\/release\/compatibility\/[A-Za-z0-9_-]+\.mjs$/),
    scenarioDigest: hash,
    compatibilityDate: z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/),
  })
  .strict();
export const compatibilityConfigSchema = z.union([
  containerCompatibilitySchema,
  workerdCompatibilitySchema,
]);

export const databaseCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuid,
    ownerId: uuid,
    repositoryId: provider,
    repositoryOwnerId: provider,
    environmentKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    targetDigest: hash,
    targetId: uuid,
    databaseName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
    databaseHost: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
    databasePort: z.number().int().min(1).max(65535),
    workflowRef: z.string().min(1).max(250),
    workflowSha: sha,
    dispatcherSha: sha,
    branchRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/),
    authorityOrigin: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === "https:" && u.origin === v && !u.username && !u.password;
      }),
    authorityPublicKeyPem: z.string().min(40).max(4096),
    validFrom: stamp,
    expiresAt: stamp,
    compatibilityTest: z
      .object({
        config: compatibilityConfigSchema,
        repositoryOwner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
        repositoryName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        workflowId: provider,
        jobName: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.expiresAt > v.validFrom && !v.branchRef.includes("..") && !v.branchRef.includes("//"),
  );
const common = {
  schemaVersion: z.literal(1),
  catalogId: uuid,
  ownerId: uuid,
  taskId: uuid,
  sourceSha: sha,
  githubRunId: provider,
  githubRunAttempt: z.number().int().positive().safe(),
};
export const databasePlanApprovalSchema = z
  .object({
    ...common,
    purpose: z.literal("approve_database_plan"),
    plan: z.unknown().transform((v) => validatePlan(v)),
    compatibility: z
      .object({
        contractDigest: hash,
        mixedVersionChecksDigest: hash,
        databaseEnforcedInvariantDigest: hash,
      })
      .strict(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.plan.sourceSha !== v.sourceSha ||
      v.plan.compatibilityDigest !== v.compatibility.contractDigest ||
      Buffer.byteLength(JSON.stringify(v)) > 49152
    )
      c.addIssue({ code: "custom", message: "Invalid database plan artifact" });
  });
export const databaseJobRequestSchema = z
  .object({
    ...common,
    purpose: z.literal("database_job"),
    requestId: uuid,
    releaseId: uuid,
    targetDigest: hash,
    generation: z.number().int().positive().safe(),
    planEventId: uuid,
    operation: z.enum(["read_plan", "authorize", "observe", "report"]),
    action: z.enum([
      "begin",
      "read",
      "expand",
      "compatible",
      "backfill",
      "integrity",
      "certificate",
      "activate",
      "contract",
    ]),
    observation: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.operation === "report") !== Boolean(v.observation) ||
      Buffer.byteLength(JSON.stringify(v)) > 32768
    )
      c.addIssue({ code: "custom", message: "Invalid job observation" });
  });
export const databaseSignedResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("database_job_response"),
    catalogId: uuid,
    requestDigest: hash,
    observedAt: stamp,
    expiresAt: stamp,
    data: z.record(z.unknown()),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
const domain = "hive-database-job-response-v1\n";
export function signDatabaseResponse(unsigned, privatePem) {
  const key = createPrivateKey(privatePem);
  requireValue(key.asymmetricKeyType === "ed25519", "migration_signer_invalid");
  const signature = sign(null, Buffer.from(domain + digest(unsigned)), key).toString("base64url");
  return databaseSignedResponseSchema.parse({ ...unsigned, signature });
}
export function verifyDatabaseResponse(raw, request, catalog, now = Date.now()) {
  const envelope = databaseSignedResponseSchema.parse(raw),
    { signature, ...unsigned } = envelope,
    key = createPublicKey(catalog.authorityPublicKeyPem);
  requireValue(
    key.asymmetricKeyType === "ed25519" &&
      verify(
        null,
        Buffer.from(domain + digest(unsigned)),
        key,
        Buffer.from(signature, "base64url"),
      ),
    "migration_response_invalid",
  );
  requireValue(
    catalog.validFrom <= now &&
      catalog.expiresAt > now &&
      envelope.catalogId === catalog.id &&
      envelope.requestDigest === digest(request) &&
      envelope.observedAt <= now + 1000 &&
      envelope.expiresAt > now &&
      envelope.expiresAt <= envelope.observedAt + 30000,
    "migration_response_stale",
  );
  return envelope;
}
export function databaseScope(catalog) {
  return validateScope({
    ownerId: catalog.ownerId,
    repositoryId: catalog.repositoryId,
    environmentKey: catalog.environmentKey,
    targetId: catalog.targetId,
    databaseName: catalog.databaseName,
  });
}
export function assertDatabaseEndpoint(rawUrl, catalog) {
  const u = new URL(rawUrl);
  requireValue(
    ["postgres:", "postgresql:"].includes(u.protocol) &&
      u.hostname === catalog.databaseHost &&
      Number(u.port || 5432) === catalog.databasePort &&
      decodeURIComponent(u.pathname.slice(1)) === catalog.databaseName,
    "migration_database_endpoint_changed",
  );
  return rawUrl;
}
export function databaseOidcAudience(request) {
  return `urn:hive:database-job:v1:${digest(request)}`;
}
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
export const databaseObservationSchema = z
  .object({
    runId: uuid,
    phase: z.enum([
      "pending",
      "expanded",
      "compatible",
      "backfilled",
      "verified",
      "activated",
      "contract_held",
    ]),
    version: z.number().int().nonnegative().safe(),
    cursor: decimal,
    highWater: decimal,
    changedRows: decimal,
    checkpointDigest: hash,
    planDigest: hash,
    scopeDigest: hash,
    sourceSha: sha,
    beforeSchemaDigest: hash,
    afterSchemaDigest: hash,
    oldAppDigest: hash,
    newAppDigest: hash,
    compatibilityDigest: hash,
    compatibilityReceiptDigest: hash.nullable(),
    integrity: z
      .object({
        violations: z.literal("0"),
        totalRows: decimal,
        queryDigest: hash,
        schemaDigest: hash,
      })
      .strict()
      .nullable(),
    activationReceiptDigest: hash.nullable(),
    contractAuthorized: z.literal(false),
    executionAuthorized: z.literal(false),
    kind: z.literal("database_compatibility_observation").optional(),
    scope: z.unknown().optional(),
    observedAt: stamp.optional(),
    expiresAt: stamp.optional(),
    activationAuthorized: z.literal(false).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      BigInt(v.cursor) > BigInt(v.highWater) ||
      (v.kind !== undefined) !==
        (v.observedAt !== undefined &&
          v.expiresAt !== undefined &&
          v.scope !== undefined &&
          v.activationAuthorized === false)
    )
      c.addIssue({ code: "custom", message: "Invalid database observation" });
  });
