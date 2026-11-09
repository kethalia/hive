import { z } from "zod";
import { sourceContextSchema, sourceShaSchema } from "./contracts";
import { canonicalGitHubSource } from "./github-evidence.server";
import { managerCheckoutSchema } from "./manager-contracts";
import { sourceProducerAdmissionSchema } from "./source-transport-contracts";

const id = z.string().uuid(),
  label = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
/** Read-only, freshly authenticated operation lookup. No old publication grant. */
export const sourceStateRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("read_source_state"),
    requestId: id,
    registrationId: id,
    serverInstanceId: label,
    managerThreadId: label,
    checkoutBinding: managerCheckoutSchema,
    taskId: id,
    operationId: id,
    revisionId: id.optional(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export function sourceStateProofPayload(value: Record<string, unknown>) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-source-transport-v1\nPOST\n/api/delivery/source-publication/state\n${canonicalGitHubSource(unsigned)}`;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const inode = z
  .object({
    device: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    inode: z.string().regex(/^[1-9][0-9]{0,19}$/),
  })
  .strict();
export const sourceStateResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("read_source_state"),
    requestId: id,
    observedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    scope: z
      .object({
        ownerId: id,
        registrationId: id,
        serverInstanceId: label,
        managerThreadId: label,
        managerBindingId: id,
        checkoutBindingDigest: digest,
        checkoutBinding: managerCheckoutSchema,
        taskId: id,
      })
      .strict(),
    admission: sourceProducerAdmissionSchema,
    metadata: z
      .object({
        pins: z.object({ checkout: inode, git: inode }).strict(),
        pinsDigest: digest,
        policyDigest: digest,
        namespaceReceiptDigest: digest,
      })
      .strict(),
    accepted: z
      .object({
        operationId: id,
        sourceContext: sourceContextSchema,
        previousRevisionId: id.nullable(),
        parentSha: sourceShaSchema,
        treeSha: sourceShaSchema,
        manifestDigest: digest,
        repositoryId: providerId,
        providerAccountId: providerId,
        fullName: z.string().min(3).max(140),
        branch: z.string().min(1).max(255),
        baseBranch: z.string().min(1).max(255),
        pullRequestId: providerId,
        pullNumber: z.number().int().positive(),
        producingAttemptId: id,
        stepId: id,
        proofDigest: digest,
      })
      .strict(),
    current: z
      .object({
        sourceContext: sourceContextSchema,
        headSha: sourceShaSchema,
        version: z.number().int().positive(),
        physicalBase: sourceShaSchema,
        branch: z.string().min(1).max(255),
      })
      .strict(),
    isCurrent: z.boolean(),
    publicationAuthorized: z.literal(false),
    executionAuthorized: z.literal(false),
  })
  .strict();
export type SourceStateResponse = z.infer<typeof sourceStateResponseSchema>;
