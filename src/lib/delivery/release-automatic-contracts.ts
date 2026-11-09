import { z } from "zod";
import {
  databaseCatalogSchema,
  databaseJobRequestSchema,
  databaseObservationSchema,
  databasePlanApprovalSchema,
  sourceBuildCompatibilitySchema,
} from "../../../services/migrate/src/delivery/wire.mjs";
import { epicMergePreparedSchema } from "./epic-merge-contracts";
export const automaticPreparedSchema = epicMergePreparedSchema.extend({
  riskClass: z.enum(["application_only", "database"]),
});

import { providerBuildIdentitySchema } from "../provider-build";
export const AUTOMATIC_HEALTH_PATH = "/.well-known/hive-release-health";
export const availableProviderBuildSchema = providerBuildIdentitySchema.options[1];
export const automaticHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("automatic-worker-health"),
    origin: z.string().url(),
    worker: z.literal("hive"),
    mode: z.literal("production"),
    nonce: z.string().uuid(),
    build: availableProviderBuildSchema,
    databaseEndpointDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    readiness: z.object({ database: z.literal(true), authentication: z.literal(true) }).strict(),
    observedAt: z.string().datetime(),
  })
  .strict();

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().uuid(),
  timestamp = z.number().int().nonnegative().safe();

import { githubEvidencePolicySchema, githubProviderId } from "./github-contracts";
import { githubSourceDigest } from "./github-evidence.server";
import { releaseActionIdentitySchema } from "./release-action-journal";
import { releaseRiskConfigSchema } from "./release-change-risk.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import {
  releaseTestAttestationSchema,
  releaseTestChallengeRequestSchema,
  releaseTestWorkflowSchema,
} from "./release-tested-attestation.server";
import { releaseTestRunConfigSchema } from "./release-tested-run.server";

const automaticPolicyObject = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("automatic_production"),
    versionId: id,
    ownerId: id,
    repositoryId: githubProviderId,
    providerAccountId: githubProviderId,
    baseBranch: z.literal("main"),
    method: githubReleaseRequestSchema.shape.method,
    validFrom: timestamp,
    expiresAt: timestamp,
    cutoverApproval: z
      .object({ id, approvedBy: z.string().min(1).max(120), approvedAt: timestamp })
      .strict(),
    pipelineUsage: z.literal("existing-connected-builds"),
  })
  .strict();
export const automaticReleasePolicySchema = automaticPolicyObject.refine(
  (p) => p.expiresAt > p.validFrom && p.cutoverApproval.approvedAt <= p.validFrom,
);
const publicOrigin = z
  .string()
  .url()
  .refine((v) => {
    try {
      const url = new URL(v);
      return (
        url.protocol === "https:" &&
        url.origin === v &&
        !url.username &&
        !url.password &&
        !url.hostname.endsWith(".workers.dev") &&
        url.hostname !== "localhost" &&
        !/^[0-9.]+$/.test(url.hostname) &&
        !url.hostname.includes(":")
      );
    } catch {
      return false;
    }
  });
export const automaticReleaseConfigSchema = z
  .object({
    mode: z.literal("automatic-main-builds"),
    policy: automaticReleasePolicySchema,
    target: z
      .object({
        accountId: z.string().regex(/^[a-f0-9]{32}$/),
        worker: z.literal("hive"),
        origin: publicOrigin,
      })
      .strict(),
    risk: releaseRiskConfigSchema,
    tested: z
      .object({ workflow: releaseTestWorkflowSchema, run: releaseTestRunConfigSchema })
      .strict(),
    observation: z.object({ windowMs: z.number().int().min(1000).max(86400000).safe() }).strict(),
  })
  .strict()
  .refine(
    (c) =>
      c.tested.workflow.repositoryId === c.policy.repositoryId &&
      c.tested.run.repositoryId === c.policy.repositoryId &&
      c.tested.run.owner === c.risk.owner &&
      c.tested.run.name === c.risk.name,
  );
export type AutomaticReleaseConfig = z.infer<typeof automaticReleaseConfigSchema>;
export function automaticReleaseTarget(config: AutomaticReleaseConfig) {
  return githubSourceDigest({
    provider: "automatic-main-builds",
    accountId: config.target.accountId,
    worker: config.target.worker,
  });
}
export function automaticReleaseResource(config: AutomaticReleaseConfig) {
  return githubSourceDigest({
    provider: "cloudflare-worker",
    accountId: config.target.accountId,
    script: config.target.worker,
  });
}
export function automaticReleaseAuthority(config: AutomaticReleaseConfig) {
  return githubSourceDigest({
    target: config.target,
    risk: config.risk,
    tested: config.tested,
    observation: config.observation,
    method: config.policy.method,
  });
}
export function automaticReleaseEnrollment(config: AutomaticReleaseConfig) {
  return {
    ...config.policy,
    targetDigest: automaticReleaseTarget(config),
    authorityConfigDigest: automaticReleaseAuthority(config),
    actions: ["merge"] as ["merge"],
  };
}
export const automaticTestEnrollmentSchema = automaticPolicyObject
  .extend({
    targetDigest: digest,
    authorityConfigDigest: digest,
    actions: z.tuple([z.literal("merge")]),
  })
  .strict()
  .refine((p) => p.expiresAt > p.validFrom && p.cutoverApproval.approvedAt <= p.validFrom);
export const cloudflareBuildCheckSchema = z
  .object({
    id: githubProviderId,
    name: z.literal("Workers Builds: hive"),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    appId: z.literal("85455"),
    appSlug: z.literal("cloudflare-workers-and-pages"),
    buildUuid: id,
    status: z.string().min(1).max(80),
    conclusion: z.string().min(1).max(80).nullable(),
    detailsUrl: z.string().url(),
  })
  .strict();
export const automaticBuildsReadSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryId: githubProviderId,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    treeSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    checks: z.array(cloudflareBuildCheckSchema).max(99),
  })
  .strict();
const common = {
  schemaVersion: z.literal(1),
  requestId: id,
  config: automaticReleaseConfigSchema,
  source: z
    .object({
      repositoryId: githubProviderId,
      pullRequestId: githubProviderId,
      pullNumber: z.number().int().positive().safe(),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
      baseRef: z.literal("main"),
      sourceBranch: githubReleaseRequestSchema.shape.baseRef,
    })
    .strict(),
  gates: githubEvidencePolicySchema,
};
export const automaticReleaseRpcSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...common,
      operation: z.literal("prepare"),
      database: databaseCatalogSchema.optional(),
      test: z
        .object({ request: releaseTestChallengeRequestSchema, complete: z.boolean() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("dispatch"),
      database: databaseCatalogSchema.optional(),
      identity: releaseActionIdentitySchema,
      authorityExpiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("lookup"),
      identity: releaseActionIdentitySchema,
      reference: z
        .object({ provider: z.literal("github"), requestId: id })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("database"),
      catalog: databaseCatalogSchema,
      command: z.discriminatedUnion("action", [
        z
          .object({
            action: z.literal("prepare"),
            test: z
              .object({ request: releaseTestChallengeRequestSchema, complete: z.boolean() })
              .strict()
              .optional(),
          })
          .strict(),
        z
          .object({
            action: z.literal("merge"),
            identity: releaseActionIdentitySchema,
            authorityExpiresAt: timestamp,
          })
          .strict(),
        z
          .object({ action: z.literal("builds"), mergeSha: z.string().regex(/^[a-f0-9]{40}$/) })
          .strict(),
        z.object({ action: z.literal("workload"), request: databaseJobRequestSchema }).strict(),
        z
          .object({
            action: z.literal("dispatch"),
            identity: releaseActionIdentitySchema
              .innerType()
              .extend({ kind: z.literal("database_job") }),
            authorityExpiresAt: timestamp,
          })
          .strict(),
        z
          .object({
            action: z.literal("lookup"),
            identity: releaseActionIdentitySchema
              .innerType()
              .extend({ kind: z.literal("database_job") }),
            reference: z
              .object({ provider: z.literal("github-actions"), dispatchId: id })
              .strict()
              .nullable(),
          })
          .strict(),
        z.object({ action: z.literal("verify"), approval: databasePlanApprovalSchema }).strict(),
        z.object({ action: z.literal("baseline") }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...common,
      operation: z.literal("builds"),
      database: databaseCatalogSchema.optional(),
      mergeSha: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
]);
export type AutomaticReleaseRpc = z.infer<typeof automaticReleaseRpcSchema>;

export const automaticObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("automatic-build-observation"),
    mergeSha: z.string().regex(/^[a-f0-9]{40}$/),
    origin: publicOrigin,
    health: automaticHealthSchema,
    firstHealthDigest: digest,
    treeSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    check: cloudflareBuildCheckSchema,
    coverage: z.literal("fixed-origin-db-auth-smoke"),
    observedAt: timestamp,
    expiresAt: timestamp,
  })
  .strict();

export const productionAcceptanceAnchorSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("automatic-production-acceptance"),
    ownerId: id,
    taskId: id,
    releaseId: id,
    generation: z.number().int().positive(),
    targetDigest: digest,
    policyVersionId: id,
    policyDigest: digest,
    authorityConfigDigest: digest,
    snapshotDigest: digest,
    sourceRevisionId: id,
    sourceSha: githubReleaseRequestSchema.shape.headSha,
    mergeSha: githubReleaseRequestSchema.shape.headSha,
    origin: publicOrigin,
    build: availableProviderBuildSchema,
    buildDigest: digest,
    observationId: id,
    observationDigest: digest,
    observation: automaticObservationSchema,
    tested: releaseTestAttestationSchema,
    database: z
      .object({
        kind: z.literal("controlled-source-build"),
        coverage: z.literal("controlled-migration-activation-history"),
        catalogDigest: digest,
        planEventId: id,
        planDigest: digest,
        endpointDigest: digest,
        plan: databasePlanApprovalSchema.innerType().shape.plan,
        sourceBuild: sourceBuildCompatibilitySchema,
        reportEventId: id,
        reportDigest: digest,
        observation: databaseObservationSchema,
      })
      .strict()
      .optional(),
    previewSeal: z
      .object({
        attemptId: id,
        completionEventId: id,
        writerAttemptId: id,
        readinessDigest: digest,
      })
      .strict(),
  })
  .strict();
export type ProductionAcceptanceAnchor = z.infer<typeof productionAcceptanceAnchorSchema>;

export function automaticDatabaseEndpointDigest(raw: string | undefined) {
  try {
    if (!raw) return null;
    const url = new URL(raw);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.slice(1) ||
      url.hash
    )
      return null;
    // Neon documents only this pooler/direct alias. Every other hostname stays exact.
    // https://neon.com/docs/connect/connection-pooling
    const hostname = url.hostname.toLowerCase();
    const host = /^ep-[a-z0-9-]+-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(hostname)
      ? hostname.replace(/-pooler(?=\.)/, "")
      : hostname;
    return githubSourceDigest({
      host,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
    });
  } catch {
    return null;
  }
}
