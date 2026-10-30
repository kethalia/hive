import { z } from "zod";
import { sourceContextSchema } from "./contracts";
import { githubProviderId } from "./github-contracts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const reason = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/);
const testedMergeSchema = z
  .object({
    headSha: sha,
    baseSha: sha,
    mergeSha: sha,
    workflowId: githubProviderId,
    workflowRevision: sha,
    appId: githubProviderId,
    event: z.enum(["pull_request", "merge_group"]),
    runId: githubProviderId,
    runAttempt: z.number().int().positive().safe(),
    succeeded: z.boolean(),
  })
  .strict();

/** Trusted read-only adapter ABI, never a browser/model request contract. The
 * adapter must fetch effective rules, not infer enforcement from check results.
 * No live adapter is installed by this slice. */
export const releaseRemoteObservationSchema = z
  .object({
    repositoryId: githubProviderId,
    pullRequestId: githubProviderId,
    pullNumber: z.number().int().positive(),
    headRepositoryId: githubProviderId,
    baseRepositoryId: githubProviderId,
    headSha: sha,
    baseRef: z.string().min(1).max(151),
    baseSha: sha,
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    observedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
    rules: z
      .object({
        repositoryId: githubProviderId,
        baseRef: z.string().min(1).max(151),
        contentDigest: digest,
        complete: z.literal(true),
        pullRequestRequired: z.boolean(),
        requiredCheckSelectors: z.array(digest).max(100),
        requireUpToDate: z.boolean(),
        mergeQueueRequired: z.boolean(),
        actorCanBypass: z.boolean(),
      })
      .strict(),
    testedMerge: testedMergeSchema.nullable(),
  })
  .strict();
export type ReleaseRemoteObservation = z.infer<typeof releaseRemoteObservationSchema>;

export const releaseCandidateRequestSchema = z
  .object({ ownerId: uuid, taskId: uuid, expectedSource: sourceContextSchema.optional() })
  .strict();
export type ReleaseCandidateRequest = z.infer<typeof releaseCandidateRequestSchema>;

export const releaseCandidateSchema = z
  .object({
    mode: z.literal("observation"),
    target: z.literal("cloudflare_workers_after_owner_cutover"),
    eligible: z.literal(false),
    mergeAuthorized: z.literal(false),
    deploymentAuthorized: z.literal(false),
    observedAt: z.number().int().nonnegative().safe(),
    taskId: uuid,
    taskVersion: z.number().int().nonnegative(),
    source: sourceContextSchema.nullable(),
    policy: z.object({ versionId: uuid, digest, bindingDigest: digest }).strict().nullable(),
    pullRequest: z
      .object({
        repositoryId: githubProviderId,
        providerAccountId: githubProviderId,
        fullName: z.string().max(140),
        providerId: githubProviderId,
        number: z.number().int().positive(),
        headSha: sha,
        headBranch: z.string().max(151),
        baseRef: z.string().max(151),
      })
      .strict()
      .nullable(),
    remote: z
      .object({
        baseSha: sha,
        rulesDigest: digest,
        testedMerge: testedMergeSchema.nullable(),
        observedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    steps: z
      .array(
        z
          .object({
            stepId: uuid,
            status: z.enum(["informational", "observed", "blocked"]),
            evidenceIds: z.array(uuid).max(40),
          })
          .strict(),
      )
      .max(32),
    blockers: z.array(z.object({ code: reason, stepId: uuid.optional() }).strict()).max(256),
  })
  .strict();
export type ReleaseCandidate = z.infer<typeof releaseCandidateSchema>;
