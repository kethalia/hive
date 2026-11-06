import { z } from "zod";
import { sourceContextSchema } from "@/lib/delivery/contracts";
import { sourceProducerAdmissionSchema } from "@/lib/delivery/source-transport-contracts";
import {
  guardianDigestSchema,
  guardianIdleSnapshotSchema,
  guardianMetadataEvidenceSchema,
} from "./guardian-contracts";

const uuid = z.string().uuid();
/** Pinned outer attestation of an installed input barrier, not kernel quiescence.
 * The server does not receive local HMAC keys. The approved outer verifies the
 * fixed signed journals and attests their exact digests under its separate key.
 * unknownInputs excludes only unaccounted native input/tool/child/CLI facts;
 * background kernel writers are not proven absent and the physical hold remains. */
export const guardianApplicationInputBarrierSchema = z
  .object({
    id: uuid,
    generation: z.number().int().positive(),
    projectId: uuid,
    observedAt: z.string().datetime({ offset: true }),
    closed: z.literal(true),
    rootCompleted: z.literal(true),
    controllerJournalDigest: guardianDigestSchema,
    supervisorJournalDigest: guardianDigestSchema,
    commandInventoryDigest: guardianDigestSchema,
    terminalInventoryDigest: guardianDigestSchema,
    sourceSpoolDigest: guardianDigestSchema,
    pendingCommands: z.literal(0),
    activeCli: z.literal(0),
    pendingInputs: z.literal(0),
    unknownInputs: z.literal(0),
  })
  .strict();
export type GuardianApplicationInputBarrier = z.infer<typeof guardianApplicationInputBarrierSchema>;

export const guardianApplicationReservationSchema = z
  .object({
    projectId: uuid,
    applicationId: uuid,
    publicationOperationId: uuid,
    expectedAppliedSourceContext: sourceContextSchema.nullable(),
    targetSourceContext: sourceContextSchema,
    idleSnapshot: guardianIdleSnapshotSchema,
    inputBarrier: guardianApplicationInputBarrierSchema,
  })
  .strict();
export type GuardianApplicationReservation = z.infer<typeof guardianApplicationReservationSchema>;

/** Values come only from the pinned outer's independent verified fixed-journal
 * read. HEAD/index hashes alone cannot release an application input fence. */
export const guardianApplicationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicationId: uuid,
    publicationOperationId: uuid,
    sourceContext: sourceContextSchema,
    previousSourceContext: sourceContextSchema.nullable(),
    inputBarrierId: uuid,
    inputBarrierDigest: guardianDigestSchema,
    metadataPinsDigest: guardianDigestSchema,
    namespaceReceiptDigest: guardianDigestSchema,
    managedReceiptDigest: guardianDigestSchema,
    sourceOperationDigest: guardianDigestSchema,
    controllerJournalDigest: guardianDigestSchema,
    supervisorJournalDigest: guardianDigestSchema,
    appliedHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
    appliedIndexDigest: guardianDigestSchema,
    sourceUpdating: z.literal(false),
    controllerSourceContext: sourceContextSchema,
    supervisorSourceContext: sourceContextSchema,
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type GuardianApplicationReceipt = z.infer<typeof guardianApplicationReceiptSchema>;

export const guardianApplicationActions = [
  guardianApplicationReservationSchema.extend({ action: z.literal("apply_reserve") }),
  z.object({ action: z.literal("apply_verify"), projectId: uuid, applicationId: uuid }).strict(),
  z
    .object({
      action: z.literal("apply_commit"),
      projectId: uuid,
      applicationId: uuid,
      appliedReceipt: guardianApplicationReceiptSchema,
    })
    .strict(),
] as const;

export const guardianApplicationAuthoritySchema = z
  .object({
    schemaVersion: z.literal(1),
    applicationId: uuid,
    phase: z.enum(["pending", "applied"]),
    operationId: uuid,
    sourceContext: sourceContextSchema,
    previousSourceContext: sourceContextSchema.nullable(),
    parentSha: z.string().regex(/^[a-f0-9]{40}$/),
    treeSha: z.string().regex(/^[a-f0-9]{40}$/),
    manifestDigest: guardianDigestSchema,
    metadataIdentity: guardianMetadataEvidenceSchema.shape.pins,
    producer: sourceProducerAdmissionSchema
      .extend({
        barrierGeneration: z.literal(0),
        metadataPinsDigest: guardianDigestSchema,
        metadataPolicyDigest: guardianDigestSchema,
        namespaceReceiptDigest: guardianDigestSchema,
      })
      .strict(),
    inputBarrier: z
      .object({ id: uuid, digest: guardianDigestSchema, generation: z.number().int().positive() })
      .strict(),
    expiresAt: z.number().int().positive(),
    applicationAuthorized: z.literal(true),
    executionAuthorized: z.literal(false),
    cleanupAuthorized: z.literal(false),
  })
  .strict();
export type GuardianApplicationAuthority = z.infer<typeof guardianApplicationAuthoritySchema>;
