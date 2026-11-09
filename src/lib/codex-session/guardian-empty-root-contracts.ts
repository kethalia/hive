import { z } from "zod";
import { guardianDigestSchema as digest, guardianCanonical } from "./guardian-contracts";
import { guardianVolumeSchema } from "./guardian-remount-contracts";

const physical = z
  .object({
    device: z.string().regex(/^[0-9]{1,24}$/),
    inode: z.string().regex(/^[1-9][0-9]{0,24}$/),
  })
  .strict();
const record = z
  .object({ old: physical, current: physical, recordSha256: digest, newRecordSha256: digest })
  .strict();
/** Installed host evidence, authenticated by the current identity packet. This
 * is never an operator-supplied remount authorization. */
export const unusedBootstrapSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("unused-bootstrap-root"),
    coderOrigin: z.string().url(),
    hiveUserId: z.string().uuid(),
    ownerId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    templateId: z.string().uuid(),
    oldBuildId: z.string().uuid(),
    oldLifetimeId: z.string().uuid(),
    oldConfigSha256: digest,
    oldPackageManifestSha256: digest,
    newBuildId: z.string().uuid(),
    newConfigSha256: digest,
    newPackageManifestSha256: digest,
    outerArchiveSha256: digest,
    projectArchiveSha256: digest,
    rootRecordSha256: digest,
    openedProjectsDigest: digest,
    historyDigest: digest,
  })
  .strict();
export type UnusedBootstrap = z.infer<typeof unusedBootstrapSchema>;
export const emptyRootVolumeSchema = z
  .object({
    templateVersionId: z.string().uuid(),
    buildId: z.string().uuid(),
    lifetimeId: z.string().uuid(),
    resourceId: z.string().uuid(),
    observedAt: z.number().int().positive(),
    volume: guardianVolumeSchema,
    volumeDigest: digest,
  })
  .strict();
export const emptyRootCleanupReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorizationId: z.string().uuid(),
    authorizationDigest: digest,
    cleanupRequestId: z.string().uuid(),
    bindingDigest: digest,
    outcome: z.literal("checkout_removed"),
    currentVolumeDigest: digest,
    recordDigests: z.object({ root: digest, project: digest }).strict(),
  })
  .strict();
export const emptyRootProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["initial-current", "remount", "initial-unused-remount"]),
    root: record.extend({ path: z.literal("/home/coder/projects/.hive-managed") }).strict(),
    projects: z
      .array(
        record
          .extend({
            repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
            cleanupToken: z.string().min(100).max(12000),
            cleanupReceipt: emptyRootCleanupReceiptSchema,
          })
          .strict(),
      )
      .max(8),
    previousEnrollment: z.string().min(100).max(12000).optional(),
    unusedBootstrap: unusedBootstrapSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.mode === "initial-unused-remount") !== !!v.unusedBootstrap ||
      (v.unusedBootstrap &&
        (v.projects.length !== 0 ||
          v.previousEnrollment ||
          v.unusedBootstrap.rootRecordSha256 !== v.root.recordSha256 ||
          v.root.old.inode !== v.root.current.inode ||
          v.unusedBootstrap.oldBuildId === v.unusedBootstrap.newBuildId))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unused bootstrap scope" });
    if (Buffer.byteLength(guardianCanonical(v)) > 16384)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "empty root proposal bound" });
  });
export const emptyRootAnchorSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("empty-managed-root"),
    proposalDigest: digest,
    currentVolume: emptyRootVolumeSchema,
    records: z.object({ root: digest, projects: z.record(z.string(), digest) }).strict(),
    identities: z.object({ root: physical, projects: z.record(z.string(), physical) }).strict(),
    unusedBootstrapDigest: digest.optional(),
  })
  .strict();
export type EmptyRootProposal = z.infer<typeof emptyRootProposalSchema>;
export type EmptyRootAnchor = z.infer<typeof emptyRootAnchorSchema>;
export type EmptyRootVolume = z.infer<typeof emptyRootVolumeSchema>;

// Historical signed F06 facts; extra fields remain covered by the exact signature
// and immutable ledger digest. Expiry is history, never new cleanup authority.
export const emptyRootCleanupHistorySchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("managed-checkout-cleanup"),
    authorizationId: z.string().uuid(),
    ownerId: z.string().uuid(),
    hiveUserId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    buildId: z.string().uuid(),
    lifetimeId: z.string().uuid(),
    configSha256: digest,
    closedRuntimeId: z.string().uuid(),
    closedLifetimeId: z.string().uuid(),
    barrierId: z.string().uuid(),
    treeReceiptDigest: digest,
    projectId: z.string().uuid(),
    deliveryTaskId: z.string().uuid(),
    binding: z
      .object({
        repositoryId: z.string(),
        taskId: z.string().uuid(),
        revision: z.string().regex(/^[a-f0-9]{40}$/),
        rootIdentity: physical,
        projectIdentity: physical,
        checkoutIdentity: physical,
        checkoutIncarnation: z.string().uuid(),
        leaseGeneration: z.number().int().positive(),
        renewalSequence: z.number().int().nonnegative(),
        cleanupRequestId: z.string().uuid(),
      })
      .strict(),
    sourceArchiveDigest: digest,
    controllerArchiveDigest: digest,
    preservationDigest: digest,
    leaseReleaseDigest: digest,
    completionEventId: z.string().uuid(),
    completionEventIds: z.array(z.string().uuid()).min(1).max(64),
    policyVersion: z.string().uuid(),
    currentVolume: emptyRootVolumeSchema,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .passthrough();
