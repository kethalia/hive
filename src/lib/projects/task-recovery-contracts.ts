import { z } from "zod";
import { guardianRemountInspectionSchema } from "../codex-session/guardian-remount-contracts";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryScopeSchema = z
  .object({
    recoveryId: uuid,
    ownerId: uuid,
    coderOwnerId: uuid,
    projectId: uuid,
    taskId: uuid,
    workspaceId: uuid,
    originalRequestId: uuid,
    intentVersion: z.string().min(1).max(64),
    intentDigest: digest,
    hostRequestDigest: digest,
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export const recoveryInspectionSchema = z
  .object({
    outcome: z.enum(["task_absent", "existing_preexecution"]),
    remount: guardianRemountInspectionSchema.optional(),
    taskFingerprint: digest,
    buildId: uuid,
    lifetimeId: uuid,
    guardianGeneration: z.number().int().positive(),
  })
  .strict();
export const recoveryAuthorizationSchema = z
  .object({
    inspectionDigest: digest,
    authorizedVersion: z.string().min(1).max(64),
    buildId: uuid,
    lifetimeId: uuid,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export const recoveryReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    recoveryId: uuid,
    scopeDigest: digest,
    inspectionDigest: digest,
    authorizationDigest: digest,
    outcome: z.enum(["task_absent", "existing_preexecution"]),
    buildId: uuid,
    lifetimeId: uuid,
  })
  .strict();
export type RecoveryScope = z.infer<typeof recoveryScopeSchema>;
export type RecoveryInspection = z.infer<typeof recoveryInspectionSchema>;
export type RecoveryAuthorization = z.infer<typeof recoveryAuthorizationSchema>;
