import { z } from "zod";
import { guardianCanonical, guardianDigestSchema } from "./guardian-contracts";

const uuid = z.string().uuid();
const digest = guardianDigestSchema;
export const UNUSED_INTERMEDIATE_MANIFEST =
  "b16854fee6f44c96652c5b8bd64b9b3025e28037f93ab4bfe86c9bd218dd4efe";
export const guardianTransferEndpointSchema = z
  .object({ buildId: uuid, lifetimeId: uuid, configSha256: digest, packageManifestSha256: digest })
  .strict();
export const guardianUnusedEpochHopSchema = z
  .object({
    schemaVersion: z.literal(1),
    buildId: uuid,
    lifetimeId: uuid,
    configSha256: digest,
    packageManifestSha256: z.literal(UNUSED_INTERMEDIATE_MANIFEST),
    originalProofDigest: digest,
    oldJournalDigests: z
      .object({
        lifetime: digest,
        project: digest,
        supervisor: digest.nullable(),
        config: digest,
        controller: digest.nullable(),
      })
      .strict(),
    neverEnrolled: z.literal(true),
    nativeCreationAttempted: z.literal(false),
    firstPromptSubmissionAttempted: z.literal(false),
  })
  .strict();
export const guardianTransferContinuationSchema = z
  .object({
    schemaVersion: z.literal(2),
    originalProofDigest: digest,
    unusedEpochHop: guardianUnusedEpochHopSchema,
    finalSuccessor: guardianTransferEndpointSchema,
  })
  .strict()
  .refine((v) => Buffer.byteLength(guardianCanonical(v)) <= 4096);
export type GuardianTransferContinuation = z.infer<typeof guardianTransferContinuationSchema>;
export const guardianVolumeSchema = z
  .object({
    pvcUid: uuid,
    pvcName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    namespace: z.literal("coder"),
    storageClass: z.literal("longhorn"),
    capacity: z.string().regex(/^[1-9][0-9]{0,3}Gi$/),
    boundVolumeName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    accessModes: z.tuple([z.literal("ReadWriteOnce")]),
    containerName: z.literal("dev"),
    podVolumeName: z.literal("home"),
    mountPath: z.literal("/home/coder"),
    subPath: z.literal(""),
    subPathExpr: z.literal(""),
    readOnly: z.literal(false),
    claimReadOnly: z.literal(false),
  })
  .strict();
const physical = z
  .object({
    device: z.string().regex(/^[0-9]{1,24}$/),
    inode: z.string().regex(/^[1-9][0-9]{0,24}$/),
  })
  .strict();
export const guardianPhysicalSetSchema = z
  .object({ root: physical, project: physical, checkout: physical })
  .strict();
export const guardianRemountMappingSchema = z
  .object({
    old: guardianPhysicalSetSchema,
    current: guardianPhysicalSetSchema,
    oldRootRecordSha256: digest,
    oldProjectRecordSha256: digest,
    oldLeaseDigest: digest,
  })
  .strict()
  .superRefine((v, c) => {
    const a = v.old,
      b = v.current;
    if (
      a.root.device !== a.project.device ||
      a.root.device !== a.checkout.device ||
      b.root.device !== b.project.device ||
      b.root.device !== b.checkout.device ||
      a.root.device === b.root.device ||
      ["root", "project", "checkout"].some(
        (k) => a[k as keyof typeof a].inode !== b[k as keyof typeof b].inode,
      )
    )
      c.addIssue({ code: "custom", message: "Exact single-volume remount required" });
  });
/** Public trusted-operator enrollment; never supplied by a host/caller. It is
 * explicit legacy provider evidence, not a guest-derived historical fsid. */
export const guardianRemountAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("unused-checkout-remount"),
    ownerId: uuid,
    coderOwnerId: uuid,
    workspaceId: uuid,
    templateId: uuid,
    projectId: uuid,
    taskId: uuid,
    originalProofDigest: digest,
    oldBuildId: uuid,
    oldLifetimeId: uuid,
    held: guardianTransferEndpointSchema,
    heldJournalDigests: guardianUnusedEpochHopSchema.shape.oldJournalDigests,
    final: guardianTransferEndpointSchema,
    finalTemplateVersionId: uuid,
    volume: guardianVolumeSchema,
    mapping: guardianRemountMappingSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type GuardianRemountAttestation = z.infer<typeof guardianRemountAttestationSchema>;
export const guardianRemountTicketSchema = z
  .object({
    attestationDigest: digest,
    continuationDigest: digest,
    originalProofDigest: digest,
    recoveryId: uuid,
    ownerId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    final: guardianTransferEndpointSchema,
    volume: guardianVolumeSchema,
    mapping: guardianRemountMappingSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type GuardianRemountTicket = z.infer<typeof guardianRemountTicketSchema>;
export const guardianRemountInspectionSchema = z
  .object({
    attestationDigest: digest,
    continuationDigest: digest,
    mappingDigest: digest,
    volumeDigest: digest,
    mapping: guardianRemountMappingSchema,
  })
  .strict();
export function guardianRemountEnrollments(env: Record<string, string | undefined> = process.env) {
  const rows = z
    .array(guardianRemountAttestationSchema)
    .max(8)
    .parse(JSON.parse(env.HIVE_GUARDIAN_REMOUNT_ATTESTATIONS_JSON ?? "[]"));
  if (new Set(rows.map((v) => `${v.ownerId}/${v.taskId}`)).size !== rows.length)
    throw Error("Remount enrollment rejected");
  return rows;
}
