import { z } from "zod";
import { sourceShaSchema } from "./contracts";

export const githubProviderId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const label = z.string().min(1).max(300);
const status = z.string().min(1).max(80);
const date = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const criterion = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const criteria = z.array(criterion).min(1).max(20);
export const githubSourceTargetSchema = z
  .object({
    schemaVersion: z.literal(1),
    providerRepositoryId: githubProviderId,
    providerAccountId: githubProviderId,
    fullName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
      .refine((value) => ![".", ".."].includes(value.split("/")[1])),
    pullNumber: z.number().int().positive().max(2147483647),
    expectedHeadSha: sourceShaSchema,
  })
  .strict();
export type GitHubSourceTarget = z.infer<typeof githubSourceTargetSchema>;

const job = z
  .object({
    id: githubProviderId,
    runId: githubProviderId,
    runAttempt: z.number().int().positive().safe(),
    name: label,
    status,
    conclusion: status.nullable(),
    startedAt: date.nullable(),
    completedAt: date.nullable(),
    checkRunUrl: z.string().max(1000),
  })
  .strict();
const marker = z
  .object({
    code_review: z
      .object({
        commit_sha: sourceShaSchema.nullable(),
        status: status.nullable(),
        has_any_findings: z.boolean().nullable(),
        has_unresolved_findings: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();
export const githubSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("github"),
    providerAccountId: githubProviderId,
    repository: z.object({ id: githubProviderId, fullName: z.string().min(3).max(140) }).strict(),
    pullRequest: z
      .object({
        id: githubProviderId,
        number: z.number().int().positive(),
        headSha: sourceShaSchema,
        headRepositoryId: githubProviderId,
        baseRepositoryId: githubProviderId,
        authorId: githubProviderId,
        state: status,
        draft: z.boolean(),
        updatedAt: date,
      })
      .strict(),
    observedAt: date,
    collectionsComplete: z.literal(true),
    workflowRuns: z
      .array(
        z
          .object({
            id: githubProviderId,
            workflowId: githubProviderId,
            checkSuiteId: githubProviderId,
            runNumber: z.number().int().positive().safe(),
            runAttempt: z.number().int().positive().safe(),
            headSha: sourceShaSchema,
            status,
            conclusion: status.nullable(),
            updatedAt: date,
            event: status,
            jobs: z.array(job).max(500),
          })
          .strict(),
      )
      .max(20),
    checks: z
      .array(
        z
          .object({
            id: githubProviderId,
            checkSuiteId: githubProviderId,
            name: label,
            headSha: sourceShaSchema,
            status,
            conclusion: status.nullable(),
            startedAt: date.nullable(),
            completedAt: date.nullable(),
            appId: githubProviderId,
            appSlug: label,
          })
          .strict(),
      )
      .max(500),
    reviews: z
      .array(
        z
          .object({
            id: githubProviderId,
            userId: githubProviderId,
            state: status,
            commitId: sourceShaSchema.nullable(),
            submittedAt: date.nullable(),
            bodyDigest: digest,
          })
          .strict(),
      )
      .max(500),
    reviewSummaries: z
      .array(
        z
          .object({
            id: githubProviderId,
            userId: githubProviderId,
            userType: status,
            appId: githubProviderId.nullable(),
            updatedAt: date,
            createdAt: date,
            bodyDigest: digest,
            marker: marker.nullable(),
            markerPresent: z.boolean(),
            markerCount: z.number().int().nonnegative().max(1000),
          })
          .strict(),
      )
      .max(500),
    reviewThreads: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            isResolved: z.boolean(),
            isOutdated: z.boolean(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type GitHubSnapshot = z.infer<typeof githubSnapshotSchema>;

export const githubEvidencePolicySchema = z
  .object({
    version: z.string().min(1).max(100),
    maxAgeMs: z.number().int().positive().max(900000),
    checks: z
      .array(
        z
          .object({
            name: label,
            workflowId: githubProviderId,
            appId: githubProviderId,
            appSlug: z.literal("github-actions"),
            events: z
              .array(z.enum(["pull_request", "push", "workflow_dispatch", "merge_group"]))
              .min(1)
              .max(4),
            criterionIds: criteria,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    codexReview: z
      .object({ userId: githubProviderId, appId: githubProviderId, criterionIds: criteria })
      .strict()
      .nullable(),
    formalReviewers: z
      .array(z.object({ userId: githubProviderId, criterionIds: criteria }).strict())
      .max(20)
      .default([]),
  })
  .strict();
export type GitHubEvidencePolicy = z.infer<typeof githubEvidencePolicySchema>;
export const githubCheckProducer = (repositoryId: string, workflowId: string, appId: string) =>
  `github-actions:${repositoryId}:workflow:${workflowId}:app:${appId}`;
export const githubBotReviewProducer = (repositoryId: string, userId: string, appId: string) =>
  `github-codex-review:${repositoryId}:user:${userId}:app:${appId}`;
export const githubFormalReviewProducer = (repositoryId: string, userId: string) =>
  `github-review:${repositoryId}:user:${userId}`;
