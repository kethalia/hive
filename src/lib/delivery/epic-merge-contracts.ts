import { z } from "zod";
import { githubEvidencePolicySchema, githubProviderId } from "./github-contracts";
import { githubSourceDigest } from "./github-evidence.server";
import { releaseActionIdentitySchema } from "./release-action-journal";
import { releaseRiskConfigSchema } from "./release-change-risk.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import {
  releaseTestChallengeRequestSchema,
  releaseTestWorkflowSchema,
} from "./release-tested-attestation.server";
import { releaseTestRunConfigSchema } from "./release-tested-run.server";

const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const epicMergePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("epic_preview_integration"),
    versionId: id,
    ownerId: id,
    repositoryId: githubProviderId,
    providerAccountId: githubProviderId,
    baseBranch: githubReleaseRequestSchema.shape.baseRef.refine(
      (v) => !["main", "master"].includes(v.toLowerCase()),
    ),
    method: githubReleaseRequestSchema.shape.method,
    validFrom: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict()
  .refine((v) => v.expiresAt > v.validFrom);
export const epicMergeConfigSchema = z
  .object({
    policy: epicMergePolicySchema,
    risk: releaseRiskConfigSchema,
    tested: z
      .object({ workflow: releaseTestWorkflowSchema, run: releaseTestRunConfigSchema })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.tested.workflow.repositoryId === v.policy.repositoryId &&
      v.tested.run.repositoryId === v.policy.repositoryId &&
      v.tested.run.owner === v.risk.owner &&
      v.tested.run.name === v.risk.name,
  );
export type EpicMergeConfig = z.infer<typeof epicMergeConfigSchema>;
export function epicMergeTarget(config: EpicMergeConfig) {
  return githubSourceDigest({
    purpose: config.policy.purpose,
    repositoryId: config.policy.repositoryId,
    baseBranch: config.policy.baseBranch,
  });
}
export function epicMergeAuthority(config: EpicMergeConfig) {
  return githubSourceDigest({
    risk: config.risk,
    tested: config.tested,
    baseBranch: config.policy.baseBranch,
    method: config.policy.method,
  });
}
export function epicMergeEnrollment(config: EpicMergeConfig) {
  return {
    ...config.policy,
    targetDigest: epicMergeTarget(config),
    authorityConfigDigest: epicMergeAuthority(config),
    actions: ["merge"] as ["merge"],
  };
}
export const epicMergeTestEnrollmentSchema = epicMergePolicySchema
  .innerType()
  .extend({
    targetDigest: digest,
    authorityConfigDigest: digest,
    actions: z.tuple([z.literal("merge")]),
  })
  .strict()
  .refine((v) => v.expiresAt > v.validFrom);
const source = z
  .object({
    repositoryId: githubProviderId,
    pullRequestId: githubProviderId,
    pullNumber: z.number().int().positive().safe(),
    headSha: githubReleaseRequestSchema.shape.headSha,
    baseRef: githubReleaseRequestSchema.shape.baseRef,
    sourceBranch: githubReleaseRequestSchema.shape.baseRef,
  })
  .strict();
const common = {
  schemaVersion: z.literal(1),
  requestId: id,
  config: epicMergeConfigSchema,
  source,
  gates: githubEvidencePolicySchema,
};
export const epicMergeRpcRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...common,
      operation: z.literal("prepare"),
      test: z
        .object({ request: releaseTestChallengeRequestSchema, complete: z.boolean() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ ...common, operation: z.literal("dispatch"), identity: releaseActionIdentitySchema })
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
]);
export type EpicMergeRpcRequest = z.infer<typeof epicMergeRpcRequestSchema>;
export const epicMergePreparedSchema = z
  .object({
    request: githubReleaseRequestSchema,
    riskClass: z.literal("application_only"),
    rulesDigest: digest,
    testedMergeSha: githubReleaseRequestSchema.shape.headSha,
    testedTreeSha: githubReleaseRequestSchema.shape.headSha,
  })
  .strict();
export const epicMergeRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: id,
    operation: z.enum(["prepare", "dispatch", "lookup", "builds", "database"]),
    result: z.unknown(),
  })
  .strict();
