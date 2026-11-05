import { z } from "zod";
import { githubProviderId } from "./github-contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const timestamp = z.number().int().nonnegative().safe();

/** Enrolled by a separately trusted operator, never supplied by a manager or
 * inferred from an observed PR. An enrollment can authorize future releases
 * within its exact bounded scope without another per-release approval. */
export const releasePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    versionId: uuid,
    ownerId: uuid,
    repositoryId: githubProviderId,
    providerAccountId: githubProviderId,
    environmentKey: key,
    targetDigest: digest,
    targetResources: z
      .array(digest)
      .length(2)
      .refine((v) => v[0] < v[1]),
    actions: z
      .array(z.enum(["merge", "promote", "recover"]))
      .min(1)
      .max(3),
    riskClasses: z
      .array(z.enum(["application_only", "database"]))
      .min(1)
      .max(2),
    observationWindowMs: z.number().int().min(1000).max(86400000).safe(),
    observationConfigDigest: digest,
    buildAuthorityDigest: digest,
    authorityConfigDigest: digest,
    validFrom: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.expiresAt <= value.validFrom ||
      new Set(value.actions).size !== value.actions.length ||
      new Set(value.riskClasses).size !== value.riskClasses.length
    )
      ctx.addIssue({ code: "custom", message: "Invalid release policy" });
  });
export type ReleasePolicy = z.infer<typeof releasePolicySchema>;

/** This is a comparison of already authenticated, freshly derived state. It
 * cannot authenticate policy enrollment, classify source, authorize a provider
 * operation, prove quiescence, or substitute for transactional locking. The
 * current D09 implementation explicitly excludes database and unknown changes. */
export const releasePolicyScopeSchema = z
  .object({
    ownerId: uuid,
    repositoryId: githubProviderId,
    providerAccountId: githubProviderId,
    environmentKey: key,
    targetDigest: digest,
    action: z.enum(["merge", "promote", "recover"]),
    riskClass: z.enum(["application_only", "database", "unknown"]),
  })
  .strict();
export type ReleasePolicyScope = z.infer<typeof releasePolicyScopeSchema>;

export function releasePolicyCovers(rawPolicy: unknown, rawScope: unknown, now: number): boolean {
  const policy = releasePolicySchema.parse(rawPolicy);
  const scope = releasePolicyScopeSchema.parse(rawScope);
  timestamp.parse(now);
  return (
    policy.validFrom <= now &&
    now < policy.expiresAt &&
    policy.ownerId === scope.ownerId &&
    policy.repositoryId === scope.repositoryId &&
    policy.providerAccountId === scope.providerAccountId &&
    policy.environmentKey === scope.environmentKey &&
    policy.targetDigest === scope.targetDigest &&
    policy.actions.includes(scope.action) &&
    scope.riskClass !== "unknown" &&
    policy.riskClasses.includes(scope.riskClass)
  );
}
