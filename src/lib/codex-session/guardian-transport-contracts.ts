import { z } from "zod";
import { epicLeaseReleaseSchema } from "@/lib/delivery/epic-closure-contracts";
import { guardianApplicationActions } from "./guardian-application-contracts";
import { guardianTreeReceiptSchema } from "./guardian-closure-contracts";
import {
  guardianCanonical,
  guardianCheckoutSchema,
  guardianDigestSchema,
  guardianIdleSnapshotSchema,
  guardianMetadataEvidenceSchema,
  guardianPreparationSchema,
} from "./guardian-contracts";

const uuid = z.string().uuid();
const boundedId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const key = z.string().min(80).max(512);
export const guardianRuntimeIdentitySchema = z
  .object({
    lifetimeId: uuid,
    bindingDigest: guardianDigestSchema,
    outerPublicKeyPem: key,
    packageManifestSha256: guardianDigestSchema,
    guardianElfSha256: guardianDigestSchema,
    nodeSha256: guardianDigestSchema,
    policyDigest: guardianDigestSchema,
    metadataPolicyDigest: guardianDigestSchema,
    configSha256: guardianDigestSchema,
  })
  .strict();
const processIdentity = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    startTime: z.string().regex(/^[1-9][0-9]{0,24}$/),
    bootId: uuid,
    executable: z.string().min(1).max(512),
    device: z.string().regex(/^[0-9]{1,24}$/),
    inode: z.string().regex(/^[1-9][0-9]{0,24}$/),
  })
  .strict();
export const guardianStartupEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("ready"),
    phase: z.literal("open"),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    configSha256: guardianDigestSchema,
    packageManifestSha256: guardianDigestSchema,
    nodeSha256: guardianDigestSchema,
    workerSha256: guardianDigestSchema,
    guardianSha256: guardianDigestSchema,
    port: z.number().int().min(1024).max(65535),
    lifetimeId: uuid,
    bindingDigest: guardianDigestSchema,
    generation: z.number().int().positive(),
    ownershipDigest: guardianDigestSchema,
    projects: z
      .array(z.object({ projectId: uuid, bindingDigest: guardianDigestSchema }).strict())
      .max(32),
    outerIdentity: processIdentity,
    guardianIdentity: processIdentity,
    workerIdentity: processIdentity,
  })
  .strict();
export const guardianIdentityResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    nonce: guardianDigestSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    identity: guardianRuntimeIdentitySchema,
    startup: guardianStartupEvidenceSchema,
    proof: signature,
  })
  .strict();
export type GuardianIdentityResponse = z.infer<typeof guardianIdentityResponseSchema>;
export function guardianIdentityProofPayload(
  value: Omit<GuardianIdentityResponse, "proof"> | GuardianIdentityResponse,
) {
  const { proof: _proof, ...body } = value as GuardianIdentityResponse;
  return `hive-guardian-identity-v1\n${guardianCanonical(body)}`;
}
export const guardianEnrollmentClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.literal("hive:workspace-guardian"),
    scope: z.literal("workspace:guardian:enroll"),
    jti: uuid,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    runtimeId: uuid,
    hiveUserId: uuid,
    coderOwnerId: uuid,
    workspaceId: uuid,
    agentId: uuid,
    buildId: uuid,
    appId: uuid,
    lifetimeId: uuid,
    outerKeyFingerprint: guardianDigestSchema,
    bindingDigest: guardianDigestSchema,
    identityDigest: guardianDigestSchema,
    startupDigest: guardianDigestSchema,
  })
  .strict();
export type GuardianEnrollmentClaims = z.infer<typeof guardianEnrollmentClaimsSchema>;
export const guardianEmptyCloseClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.literal("hive:workspace-guardian"),
    scope: z.literal("workspace:guardian:recover-empty-close"),
    jti: uuid,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    runtimeId: uuid,
    hiveUserId: uuid,
    coderOwnerId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    lifetimeId: uuid,
    runtimeGeneration: z.literal(1),
  })
  .strict();

const common = {
  schemaVersion: z.literal(1),
  runtimeId: uuid,
  eventId: uuid,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  proof: signature,
};
const generation = { runtimeGeneration: z.number().int().positive() };
const enrollmentEnvelope = z
  .object({ ...common, action: z.literal("enroll"), grant: z.string().min(100).max(16384) })
  .strict();

const guardianOperationEnvelopes = [
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("prepare"),
      preparation: guardianPreparationSchema,
      preparationDigest: guardianDigestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("checkout"),
      checkout: guardianCheckoutSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("native"),
      projectId: uuid,
      registrationId: uuid,
      managerThreadId: boundedId,
      metadata: guardianMetadataEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("fence"),
      projectId: uuid,
      preparationDigest: guardianDigestSchema,
    })
    .strict(),
] as const;
export const guardianOperationEnvelopeSchema = z.discriminatedUnion(
  "action",
  guardianOperationEnvelopes,
);
export type GuardianOperationEnvelope = z.infer<typeof guardianOperationEnvelopeSchema>;

export const guardianTransportEnvelopeSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("operation_readback"),
      nonce: guardianDigestSchema,
      lifetimeId: uuid,
      configSha256: guardianDigestSchema,
      originalRequest: guardianOperationEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("epic_release_prepare"),
      projectId: uuid,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("epic_release_submit"),
      projectId: uuid,
      releaseReceipt: epicLeaseReleaseSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("epic_archive_ack"),
      projectId: uuid,
      archiveDigest: guardianDigestSchema,
      sourceArchiveDigest: guardianDigestSchema,
    })
    .strict(),
  z.object({ ...common, ...generation, action: z.literal("drain_ready") }).strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("tree_closed"),
      barrierId: uuid,
      receipt: guardianTreeReceiptSchema,
    })
    .strict(),
  guardianApplicationActions[0].extend({ ...common, ...generation }).strict(),
  guardianApplicationActions[1].extend({ ...common, ...generation }).strict(),
  guardianApplicationActions[2].extend({ ...common, ...generation }).strict(),
  enrollmentEnvelope,
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("enrollment_readback"),
      nonce: guardianDigestSchema,
      grantId: uuid,
      tokenDigest: guardianDigestSchema,
      consumptionDigest: guardianDigestSchema,
      identityDigest: guardianDigestSchema,
      lifetimeId: uuid,
      configSha256: guardianDigestSchema,
      startupDigest: guardianDigestSchema,
      originalEnrollment: enrollmentEnvelope,
    })
    .strict(),
  guardianOperationEnvelopes[0],
  guardianOperationEnvelopes[1],
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("launch"),
      nativeLaunchId: uuid,
      launchIntentDigest: guardianDigestSchema,
      projectIds: z.array(uuid).min(1).max(32),
    })
    .strict(),
  guardianOperationEnvelopes[2],
  guardianOperationEnvelopes[3],
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("metadata"),
      projectId: uuid,
      admissionId: uuid,
      admissionGeneration: z.number().int().positive(),
      metadataPinsDigest: guardianDigestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      ...generation,
      action: z.literal("close"),
      emptyCloseGrant: z.string().min(100).max(16384).optional(),
      barrierId: uuid,
      ownershipDigest: guardianDigestSchema,
      projectBindings: z
        .array(z.object({ projectId: uuid, bindingDigest: guardianDigestSchema }).strict())
        .max(32),
      snapshots: z.array(guardianIdleSnapshotSchema).max(32),
    })
    .strict(),
]);
export type GuardianTransportEnvelope = z.infer<typeof guardianTransportEnvelopeSchema>;
export function guardianTransportProofPayload(
  value: Omit<GuardianTransportEnvelope, "proof"> | GuardianTransportEnvelope,
) {
  const { proof: _proof, ...body } = value as GuardianTransportEnvelope;
  return `hive-guardian-controller-v1\nPOST\n/api/codex-host/guardians\n${guardianCanonical(body)}`;
}
