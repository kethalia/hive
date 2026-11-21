import { createHash } from "node:crypto";
import { z } from "zod";

export const guardianDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const GUARDIAN_METADATA_POLICY_DIGEST =
  "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b";
export const guardianPackagePinSchema = z
  .object({
    packageManifestSha256: guardianDigestSchema,
    guardianElfSha256: guardianDigestSchema,
    nodeSha256: guardianDigestSchema,
    protocol: z.literal("guardian-v1"),
    policyDigest: guardianDigestSchema,
    metadataPolicyDigest: z.literal(GUARDIAN_METADATA_POLICY_DIGEST),
  })
  .strict();
export type GuardianPackagePin = z.infer<typeof guardianPackagePinSchema>;
export interface GuardianPolicy {
  enabled: boolean;
  producerEnabled: boolean;
  packages: readonly GuardianPackagePin[];
}
export function guardianDeploymentPolicy(
  env: Record<string, string | undefined> = process.env,
): GuardianPolicy {
  if (env.HIVE_GUARDIAN_ENABLED !== "true")
    return { enabled: false, producerEnabled: false, packages: [] };
  const packages = z
    .array(guardianPackagePinSchema)
    .min(1)
    .max(16)
    .parse(JSON.parse(env.HIVE_GUARDIAN_APPROVED_PACKAGES_JSON ?? "null"));
  if (new Set(packages.map((p) => p.packageManifestSha256)).size !== packages.length)
    throw new Error("Guardian policy rejected");
  return {
    enabled: true,
    producerEnabled: env.HIVE_GUARDIAN_PRODUCER_ENABLED === "true",
    packages,
  };
}
export function guardianCanonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, item]) => [k, sorted(item)]),
          )
        : v;
  return JSON.stringify(sorted(value));
}
export const guardianDigest = (value: unknown) =>
  createHash("sha256").update(guardianCanonical(value)).digest("hex");
// The already deployed controller uses insertion-order JSON for this exact tuple.
export const guardianPreparationSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.literal("preparation"),
    ownerId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    projectId: uuid,
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    taskId: uuid,
    requestId: uuid,
    baseSha: z.string().regex(/^[a-f0-9]{40}$/),
    requestDigest: guardianDigestSchema,
  })
  .strict();
export type GuardianPreparation = z.infer<typeof guardianPreparationSchema>;
export const preparationDigest = (value: GuardianPreparation) =>
  createHash("sha256")
    .update(JSON.stringify(guardianPreparationSchema.parse(value)))
    .digest("hex");
export const guardianCheckoutSchema = z
  .object({
    projectId: uuid,
    preparationIntentId: uuid,
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    leaseId: uuid,
    leaseGeneration: z.number().int().positive(),
    checkoutIncarnation: uuid,
    checkoutIdentity: z
      .object({
        device: z.string().regex(/^[0-9]{1,24}$/),
        inode: z.string().regex(/^[1-9][0-9]{0,24}$/),
      })
      .strict(),
  })
  .strict();
export type GuardianCheckout = z.infer<typeof guardianCheckoutSchema>;
export const guardianMetadataEvidenceSchema = z
  .object({
    pins: z
      .object({
        checkout: guardianCheckoutSchema.shape.checkoutIdentity,
        git: guardianCheckoutSchema.shape.checkoutIdentity,
      })
      .strict(),
    namespaceReceiptDigest: guardianDigestSchema,
    nativeLaunchId: uuid,
    launchIntentDigest: guardianDigestSchema,
    metadataPolicyDigest: guardianDigestSchema,
  })
  .strict();
export type GuardianMetadataEvidence = z.infer<typeof guardianMetadataEvidenceSchema>;
export const guardianIdleSnapshotSchema = z
  .object({
    projectId: uuid,
    admissionId: uuid,
    admissionGeneration: z.number().int().positive(),
    managerBindingId: uuid,
    currentAttemptId: uuid,
    managerThreadId: z.string().min(1).max(160),
    parentTurnId: z.string().min(1).max(160),
    cursorVersion: z.number().int().positive(),
    nativeSequence: z.number().int().nonnegative(),
    observedAt: z.string().datetime({ offset: true }),
    historyDigest: guardianDigestSchema,
    loadedInventoryDigest: guardianDigestSchema,
    fullHistory: z.literal(true),
    rootTurns: z.number().int().positive().max(20),
    historyBytes: z.number().int().positive().max(2097152),
    pendingHandlers: z.literal(0),
    pendingObservers: z.literal(0),
    unknownFacts: z.literal(0),
    activeRoots: z.literal(0),
  })
  .strict();
export type GuardianIdleSnapshot = z.infer<typeof guardianIdleSnapshotSchema>;
export const producerScopeSchema = z
  .object({
    hiveUserId: uuid,
    registrationId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    serverInstanceId: z.string().min(1).max(160),
    managerThreadId: z.string().min(1).max(160),
    projectId: uuid,
    preparationIntentId: uuid,
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    leaseId: uuid,
    leaseGeneration: z.number().int().positive(),
  })
  .strict();
export type GuardianProducerScope = z.infer<typeof producerScopeSchema>;
export interface GuardianProducerAdmission {
  runtimeId: string;
  runtimeGeneration: number;
  admissionId: string;
  admissionGeneration: number;
  producerDigest: string;
  checkoutIncarnation: string;
  barrierGeneration: number;
}
