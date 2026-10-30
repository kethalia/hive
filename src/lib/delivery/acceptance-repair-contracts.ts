import { z } from "zod";
import { sourceContextSchema } from "./contracts";

// Controller-owned ledger. No repair operation is added to the model command schema.
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_AUTOMATIC_REPAIRS = 2;
export const repairReservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    repairId: id,
    ownerId: id,
    projectId: id,
    taskId: id,
    stepId: id,
    attemptId: id,
    managerBindingId: id,
    preparationIntentId: id,
    registrationId: id,
    serverInstanceId: z.string().min(1).max(160),
    managerThreadId: z.string().min(1).max(160),
    parentTurnId: z.string().min(1).max(160),
    cursorVersion: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    leaseExpiresAt: z.number().int().positive(),
    sourceContext: sourceContextSchema,
    publicationOperationId: id,
    stepDigest: digest,
    planDigest: digest,
    policyDigest: digest,
    producerDigest: digest,
    feedbackDigest: digest,
    feedback: z
      .object({
        reason: z.enum(["semantic_review_failed", "required_check_failed"]),
        reviewJobId: id.nullable(),
        reviewResultDigest: digest.nullable(),
        requirements: z
          .array(
            z
              .object({
                id: z.string().min(1).max(96),
                meaning: z.string().min(1).max(4096),
                observation: z.string().min(1).max(4096),
              })
              .strict(),
          )
          .max(32),
        failedEvidence: z
          .array(
            z
              .object({
                id,
                contentDigest: digest,
                criterionIds: z.array(z.string().max(96)).max(32),
              })
              .strict(),
          )
          .max(40),
      })
      .strict(),
    reportId: id,
    ordinal: z.number().int().min(1).max(MAX_AUTOMATIC_REPAIRS),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65536);
export type RepairReservation = z.infer<typeof repairReservationSchema>;
