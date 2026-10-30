import { z } from "zod";
import { sourceContextSchema, sourceShaSchema } from "./contracts";
import { canonicalGitHubSource } from "./github-evidence.server";
import { managerCheckoutSchema } from "./manager-contracts";

const id = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  providerId = z.string().regex(/^[1-9][0-9]{0,19}$/),
  label = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export const sourceProducerAdmissionSchema = z
  .object({
    runtimeId: id,
    runtimeGeneration: z.number().int().positive(),
    admissionId: id,
    admissionGeneration: z.number().int().positive(),
    producerDigest: digest,
    checkoutIncarnation: id,
    barrierGeneration: z.number().int().nonnegative(),
  })
  .strict();
export type SourceProducerAdmission = z.infer<typeof sourceProducerAdmissionSchema>;
export interface SourceProducerScope {
  hiveUserId: string;
  registrationId: string;
  workspaceId: string;
  buildId: string;
  serverInstanceId: string;
  managerThreadId: string;
  projectId: string;
  preparationIntentId: string;
  repositoryId: string;
  leaseId: string;
  leaseGeneration: number;
}
export const sourcePublicationPolicySchema = z
  .object({
    version: z.string().min(1).max(100),
    authorName: z
      .string()
      .min(1)
      .max(100)
      .refine((v) => v.trim() === v)
      .refine((v) => [...v].every((c) => !/[\p{C}\p{Zl}\p{Zp}<>]/u.test(c))),
    authorEmail: z
      .string()
      .min(3)
      .max(254)
      .email()
      .refine((v) => [...v].every((c) => c !== " " && !/[\p{C}\p{Zl}\p{Zp}<>]/u.test(c))),
    baseBranch: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/)
      .refine(
        (v) =>
          !v.includes("..") &&
          !v.includes("//") &&
          !v.endsWith("/") &&
          !v.endsWith(".") &&
          !v.endsWith(".lock"),
      ),
    allowedPrefixes: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
      .min(1)
      .max(10),
    maxFiles: z.number().int().min(1).max(100),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
  })
  .strict();
const host = {
  schemaVersion: z.literal(1),
  action: z.literal("publish_source_revision"),
  registrationId: id,
  serverInstanceId: label,
  managerThreadId: label,
  checkoutBinding: managerCheckoutSchema,
  sourceContext: sourceContextSchema.optional(),
  taskId: id,
  stepId: id,
  attemptId: id,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
};
export const sourceTargetSchema = z
  .object({ headSha: sourceShaSchema, treeSha: sourceShaSchema, manifestDigest: digest })
  .strict();
export const sourcePolicyRequestSchema = z
  .object({ ...host, requestId: id, operationId: id })
  .strict();
export const sourcePublicationGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("publish_source_revision"),
    id,
    nonce: digest,
    expiresAt: z.number().int().positive(),
    registrationId: id,
    ownerId: id,
    managerBindingId: id,
    checkoutBindingDigest: digest,
    taskId: id,
    stepId: id,
    attemptId: id,
    operationId: id,
    sourceContext: sourceContextSchema.optional(),
    sourceVersion: z.number().int().nonnegative(),
    parentSha: sourceShaSchema,
    cursorVersion: z.number().int().positive(),
    nativeSequence: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    repositoryId: providerId,
    providerAccountId: providerId,
    fullName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
    branch: z.string().min(1).max(255),
    target: sourceTargetSchema,
    policy: sourcePublicationPolicySchema,
    policyDigest: digest,
    admission: sourceProducerAdmissionSchema,
  })
  .strict();
export const sourceManifestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            contentDigest: digest,
            size: z
              .number()
              .int()
              .nonnegative()
              .max(1024 * 1024),
            mode: z.enum(["100644", "100755"]),
            blobSha: sourceShaSchema,
          })
          .strict(),
      )
      .max(100),
    deletions: z.array(z.string().min(1).max(240)).max(100),
  })
  .strict();
export const sourceChallengeRequestSchema = z
  .object({
    ...host,
    requestId: id,
    operationId: id,
    policyDigest: digest,
    manifest: sourceManifestSchema,
    target: sourceTargetSchema,
  })
  .strict();
export const sourceReadbackSchema = z
  .object({
    observedAt: z.string().datetime({ offset: true }),
    providerAccountId: providerId,
    repositoryId: providerId,
    fullName: z.string().min(3).max(140),
    manifest: sourceManifestSchema,
    commit: z
      .object({ sha: sourceShaSchema, treeSha: sourceShaSchema, parentSha: sourceShaSchema })
      .strict(),
    reference: z
      .object({ name: z.string().min(1).max(280), sha: sourceShaSchema, type: z.literal("commit") })
      .strict(),
    pullRequest: z
      .object({
        id: providerId,
        number: z.number().int().positive().max(2147483647),
        headRepositoryId: providerId,
        baseRepositoryId: providerId,
        headRef: z.string().min(1).max(255),
        headSha: sourceShaSchema,
        baseRef: z.string().min(1).max(255),
        state: z.literal("open"),
        draft: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const sourcePublishEnvelopeSchema = z
  .object({ ...host, challengeId: id, nonce: digest, readback: sourceReadbackSchema })
  .strict();
export type SourcePolicyRequest = z.infer<typeof sourcePolicyRequestSchema>;
export type SourceChallengeRequest = z.infer<typeof sourceChallengeRequestSchema>;
export type SourcePublicationGrant = z.infer<typeof sourcePublicationGrantSchema>;
export type SourcePublishEnvelope = z.infer<typeof sourcePublishEnvelopeSchema>;
export function sourceTransportProofPayload(
  phase: "policy" | "challenge" | "publish",
  value: Record<string, unknown>,
) {
  const { proof: _proof, ...unsigned } = value;
  const path =
    phase === "policy"
      ? "/api/delivery/source-publication/policy"
      : phase === "challenge"
        ? "/api/delivery/source-publication/challenge"
        : "/api/delivery/source-publication";
  return `hive-source-transport-v1\nPOST\n${path}\n${canonicalGitHubSource(unsigned)}`;
}
