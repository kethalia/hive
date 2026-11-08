import { z } from "zod";
import { guardianTransferEndpointSchema } from "./guardian-remount-contracts";

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Public operator enrollment, separate from the immutable legacy attestation.
 * It authorizes one owner-requested renewal, never automatic reconciliation. */
export const guardianResumptionApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("unused-recovery-resumption"),
    id: uuid,
    ownerId: uuid,
    coderOwnerId: uuid,
    workspaceId: uuid,
    projectId: uuid,
    taskId: uuid,
    recoveryId: uuid,
    runtimeId: uuid,
    retirementEventId: uuid,
    attestationDigest: digest,
    continuationDigest: digest,
    final: guardianTransferEndpointSchema,
    originalAuthorityUntil: z.number().int().positive(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine((a) => a.expiresAt > a.issuedAt && a.expiresAt - a.issuedAt <= 3600000);
export type GuardianResumptionApproval = z.infer<typeof guardianResumptionApprovalSchema>;
export function guardianResumptionApprovals(env: Record<string, string | undefined>) {
  const values = z
    .array(guardianResumptionApprovalSchema)
    .max(8)
    .parse(JSON.parse(env.HIVE_GUARDIAN_RECOVERY_RESUMPTIONS_JSON ?? "[]"));
  if (
    new Set(values.map((a) => `${a.ownerId}/${a.runtimeId}`)).size !== values.length ||
    new Set(values.map((a) => `${a.ownerId}/${a.recoveryId}`)).size !== values.length ||
    new Set(values.map((a) => `${a.ownerId}/${a.id}`)).size !== values.length
  )
    throw Error("Recovery resumption enrollment rejected");
  return values;
}
