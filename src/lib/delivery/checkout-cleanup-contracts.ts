import { z } from "zod";
import {
  guardianDigestSchema as digest,
  guardianCheckoutSchema,
} from "@/lib/codex-session/guardian-contracts";
import { guardianVolumeSchema } from "@/lib/codex-session/guardian-remount-contracts";

const uuid = z.string().uuid(),
  physical = guardianCheckoutSchema.shape.checkoutIdentity;
export const checkoutCleanupBindingSchema = z
  .object({
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    taskId: uuid,
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    rootIdentity: physical,
    projectIdentity: physical,
    checkoutIdentity: physical,
    checkoutIncarnation: uuid,
    leaseGeneration: z.number().int().positive(),
    renewalSequence: z.number().int().nonnegative(),
    cleanupRequestId: uuid,
  })
  .strict();
export const checkoutVolumeEvidenceSchema = z
  .object({
    templateVersionId: uuid,
    buildId: uuid,
    lifetimeId: uuid,
    resourceId: uuid,
    observedAt: z.number().int().positive(),
    volume: guardianVolumeSchema,
    volumeDigest: digest,
  })
  .strict();
export const checkoutCleanupRequestSchema = z
  .object({
    closedRuntimeId: uuid,
    projectId: uuid,
    binding: checkoutCleanupBindingSchema,
    controllerArchiveDigest: digest,
    sourceArchiveDigest: digest,
    retry: z
      .object({
        previousAuthorizationDigest: digest,
        disposition: z.literal("not_started"),
        observedAt: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const checkoutCleanupClaimsSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("managed-checkout-cleanup"),
    authorizationId: uuid,
    ownerId: uuid,
    hiveUserId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    lifetimeId: uuid,
    configSha256: digest,
    closedRuntimeId: uuid,
    closedLifetimeId: uuid,
    barrierId: uuid,
    treeReceiptDigest: digest,
    projectId: uuid,
    deliveryTaskId: uuid,
    binding: checkoutCleanupBindingSchema,
    sourceArchiveDigest: digest,
    controllerArchiveDigest: digest,
    preservationDigest: digest,
    leaseReleaseDigest: digest,
    completionEventId: uuid,
    completionEventIds: z.array(uuid).min(1).max(64),
    policyVersion: uuid,
    artifact: z
      .object({
        key: z.string().min(1).max(512),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        objectVersion: z.string().min(1).max(256),
        size: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 * 1024),
      })
      .strict(),
    productionObservation: z
      .object({
        id: uuid,
        releaseId: uuid,
        revision: z.string().regex(/^[a-f0-9]{40}$/),
        mergeSha: z.string().regex(/^[a-f0-9]{40}$/),
        sourceRevisionId: uuid,
        buildDigest: digest,
        observationDigest: digest,
      })
      .strict(),
    previousAuthorizationDigest: digest.optional(),
    refreshInspectionDigest: digest.optional(),
    currentVolume: checkoutVolumeEvidenceSchema,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine((v) => Boolean(v.previousAuthorizationDigest) === Boolean(v.refreshInspectionDigest));
export const checkoutCleanupReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorizationId: uuid,
    authorizationDigest: digest,
    cleanupRequestId: uuid,
    bindingDigest: digest,
    outcome: z.literal("checkout_removed"),
    currentVolumeDigest: digest,
    recordDigests: z.object({ root: digest, project: digest }).strict(),
  })
  .strict();
export type CheckoutCleanupRequest = z.infer<typeof checkoutCleanupRequestSchema>;
export type CheckoutCleanupClaims = z.infer<typeof checkoutCleanupClaimsSchema>;
export type CheckoutVolumeEvidence = z.infer<typeof checkoutVolumeEvidenceSchema>;
