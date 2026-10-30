import { z } from "zod";
import { sourceContextSchema, sourceShaSchema } from "./contracts";
import { canonicalGitHubSource } from "./github-evidence.server";
import { managerCheckoutSchema } from "./manager-contracts";
import { sourceStateResponseSchema } from "./source-state-contracts";

const id = z.string().uuid(),
  label = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export const deliveryStatusRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("read_delivery_status"),
    requestId: id,
    registrationId: id,
    serverInstanceId: label,
    managerThreadId: label,
    checkoutBinding: managerCheckoutSchema,
    managerBindingId: id,
    taskId: id,
    stepId: id,
    attemptId: id,
    attemptLeaseGeneration: z.number().int().positive(),
    inputSourceSha: sourceShaSchema,
    inputSourceContext: sourceContextSchema.nullable(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export function deliveryStatusProofPayload(value: Record<string, unknown>) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-delivery-status-v1\nPOST\n/api/delivery/host/status\n${canonicalGitHubSource(unsigned)}`;
}
export const deliveryStatusBlockerSchema = z.enum([
  "task_paused",
  "native_reconciliation_required",
  "preparation_held",
  "attempt_lease_expired",
  "attempt_not_running",
  "source_application_pending",
  "policy_unavailable",
  "evidence_missing",
  "evidence_invalid",
  "evidence_provenance_unavailable",
  "evidence_limit",
]);
export const deliveryStatusResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("read_delivery_status"),
    requestId: id,
    observedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    scope: sourceStateResponseSchema.shape.scope
      .extend({
        stepId: id,
        attemptId: id,
        attemptLeaseGeneration: z.number().int().positive(),
        inputSourceSha: sourceShaSchema,
        inputSourceContext: sourceContextSchema.nullable(),
      })
      .strict(),
    admission: sourceStateResponseSchema.shape.admission,
    metadata: sourceStateResponseSchema.shape.metadata,
    task: z
      .object({
        version: z.number().int().nonnegative(),
        pauseRequested: z.boolean(),
        schedulingPaused: z.boolean(),
      })
      .strict(),
    step: z
      .object({
        kind: label,
        state: label,
        version: z.number().int().nonnegative(),
        acceptancePhase: label,
        criterionIds: z.array(label).max(64),
        requiredEvidenceKinds: z.array(label).max(32),
      })
      .strict(),
    attempt: z.object({ outcome: label, leaseExpiresAt: z.number().int().nonnegative() }).strict(),
    source: z
      .object({
        physicalBase: sourceShaSchema,
        headSha: sourceShaSchema,
        sourceContext: sourceContextSchema.nullable(),
        applicationPhase: z.enum(["base", "accepted", "pending", "applied"]),
        operationId: id.nullable(),
        pullNumber: z.number().int().positive().nullable(),
      })
      .strict(),
    evidence: z
      .object({
        policyVersion: z.string().min(1).max(160).nullable(),
        requirementStatus: z.enum(["satisfied", "missing", "held", "informational"]),
        referenceIds: z.array(id).max(40),
        observations: z
          .array(
            z
              .object({
                id,
                kind: label,
                status: label,
                verificationMode: label,
                sourceSha: sourceShaSchema,
                observedAt: z.number().int().nonnegative(),
                invalidatedAt: z.number().int().nonnegative().nullable(),
              })
              .strict(),
          )
          .max(40),
      })
      .strict(),
    blockers: z.array(deliveryStatusBlockerSchema).max(16),
    executionAuthorized: z.literal(false),
    publicationAuthorized: z.literal(false),
    cleanupAuthorized: z.literal(false),
  })
  .strict();
export type DeliveryStatusResponse = z.infer<typeof deliveryStatusResponseSchema>;
