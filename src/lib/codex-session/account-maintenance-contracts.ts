import { z } from "zod";

const uuid = z.string().uuid();
const version = z.number().int().nonnegative().safe();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const accountMaintenancePurpose = "account-maintenance" as const;
export const accountMaintenancePhaseSchema = z.enum([
  "requested",
  "waiting-boundary",
  "closing",
  "ready",
  "resuming",
  "held",
  "finished",
]);
const parkedTaskSchema = z
  .object({
    taskId: uuid,
    version,
    sourceVersion: version,
    pauseRequested: z.boolean(),
    schedulingPaused: z.boolean(),
    pauseEventId: uuid,
  })
  .strict();
const parkedRuntimeSchema = z
  .object({
    runtimeId: uuid,
    runtimeGeneration: version.positive(),
    lifetimeId: uuid,
    buildId: uuid,
    configSha256: sha,
  })
  .strict();
/** Durable control metadata only. Never a prompt, credential, path or generic
 * command. An expired UI request cannot clear this retained admission hold. */
export const accountMaintenanceStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal(accountMaintenancePurpose),
    id: uuid,
    ownerId: uuid,
    coderOwnerId: uuid,
    coderOrigin: z
      .string()
      .url()
      .refine((s) => new URL(s).protocol === "https:" && new URL(s).origin === s),
    workspaceId: uuid,
    buildId: uuid,
    phase: accountMaintenancePhaseSchema,
    requestedAt: z.string().datetime(),
    runtimes: z.array(parkedRuntimeSchema).min(1).max(16),
    tasks: z.array(parkedTaskSchema).max(32),
    projects: z
      .array(
        z
          .object({
            projectId: uuid,
            preparationIntentId: uuid,
            nativeThreadId: uuid,
            leaseId: uuid,
            leaseGeneration: version.positive(),
            checkoutDigest: sha,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    barrierIds: z.array(uuid).max(16),
    treeReceiptDigests: z.array(sha).max(16),
    idleRuntimeId: uuid.nullable(),
    resumeRequestId: uuid.nullable(),
    resumeIntentRuntimeId: uuid.nullable(),
    resumeIntentEventId: uuid.nullable(),
    holdReason: z
      .enum([
        "boundary-not-idle",
        "exit-unverified",
        "workspace-changed",
        "lease-or-source-changed",
        "history-unverified",
        "external-outcome-unknown",
        "authorization-unavailable",
      ])
      .nullable(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      new Set(s.runtimes.map((r) => r.runtimeId)).size !== s.runtimes.length ||
      new Set(s.tasks.map((t) => t.taskId)).size !== s.tasks.length ||
      new Set(s.barrierIds).size !== s.barrierIds.length ||
      new Set(s.treeReceiptDigests).size !== s.treeReceiptDigests.length ||
      s.runtimes.some((r) => r.buildId !== s.buildId)
    ) {
      ctx.addIssue({ code: "custom", message: "Maintenance cohort is invalid" });
    }
    if (
      ["ready", "resuming", "finished"].includes(s.phase) &&
      (s.barrierIds.length !== s.runtimes.length ||
        s.treeReceiptDigests.length !== s.runtimes.length)
    ) {
      ctx.addIssue({ code: "custom", message: "Physical closure is unverified" });
    }
  });
export type AccountMaintenanceState = z.infer<typeof accountMaintenanceStateSchema>;

export const accountMaintenanceRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("request"),
      requestId: uuid,
      expectedVersion: version,
      runtimeId: uuid,
      runtimeGeneration: version.positive(),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("resume"),
      requestId: uuid,
      expectedVersion: version,
      maintenanceId: uuid,
      confirmed: z.literal(true),
    })
    .strict(),
]);
export const accountMaintenanceViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    version,
    maintenanceId: uuid.nullable(),
    state: z.enum(["available", ...accountMaintenancePhaseSchema.options]),
    holdReason: z.string().max(80).nullable(),
    runtimeId: uuid.nullable(),
    runtimeGeneration: version.positive().nullable(),
  })
  .strict();

/** Factual idle observation, deliberately independent of task completion or even
 * creation of a delivery manager claim (login may fail before the first claim). */
export const accountMaintenanceIdleSnapshotSchema = z
  .object({
    projectId: uuid,
    admissionId: uuid,
    admissionGeneration: version.positive(),
    managerThreadId: z.string().min(1).max(100),
    firstPromptRequestId: uuid,
    firstPromptDigest: sha,
    observedAt: z.string().datetime({ offset: true }),
    historyDigest: sha,
    loadedInventoryDigest: sha,
    fullHistory: z.literal(true),
    historyBytes: version.max(2097152),
    rootTurns: version.max(100),
    pendingHandlers: z.literal(0),
    pendingObservers: z.literal(0),
    unknownFacts: z.literal(0),
    activeRoots: z.literal(0),
    threadIds: z.array(z.string().min(1).max(100)).min(1).max(64),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      !s.threadIds.includes(s.managerThreadId) ||
      new Set(s.threadIds).size !== s.threadIds.length
    ) {
      ctx.addIssue({ code: "custom", message: "Native inventory is incomplete" });
    }
  });
export type AccountMaintenanceIdleSnapshot = z.infer<typeof accountMaintenanceIdleSnapshotSchema>;

// Owner API only. This purpose is intentionally absent from the model/host
// GuardianOperationEnvelope. It also works before a DeliveryTask was created.
export const maintenanceOwnerResumeSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("maintenance_resume_intent"),
    ownerId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    slotId: uuid,
    maintenanceId: uuid,
    maintenanceVersion: version.positive(),
    requestId: uuid,
    idleRuntimeId: uuid,
    idleRuntimeGeneration: version.positive(),
    parkedJournalDigest: sha,
    projects: z
      .array(
        z
          .object({
            projectId: uuid,
            preparationIntentId: uuid,
            requestId: uuid,
            requestDigest: sha,
            sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
            nativeThreadId: uuid,
            firstPromptRequestId: uuid,
            firstPromptDigest: sha,
            historyDigest: sha,
            leaseId: uuid,
            leaseGeneration: version.positive(),
            checkoutDigest: sha,
            oldRuntimeId: uuid,
            oldBarrierId: uuid,
            oldTreeReceiptId: uuid,
            oldTreeReceiptDigest: sha,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.projects.map((p) => p.preparationIntentId)).size !== value.projects.length ||
      value.projects.some((p) => p.requestId !== p.firstPromptRequestId)
    )
      ctx.addIssue({ code: "custom", message: "Retained intent is ambiguous" });
  });
export type MaintenanceOwnerResume = z.infer<typeof maintenanceOwnerResumeSchema>;

export const maintenanceArchiveSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("account-maintenance-archive"),
    ownerId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    maintenanceId: uuid,
    maintenanceVersion: version.positive(),
    runtimeId: uuid,
    runtimeGeneration: version.positive(),
    requestId: uuid,
    issuedAt: version,
    expiresAt: version.positive(),
    parkedJournalDigest: sha,
    projects: z
      .array(
        z
          .object({
            preparationIntentId: uuid,
            nativeThreadId: uuid,
            firstPromptRequestId: uuid,
            firstPromptDigest: sha,
            historyDigest: sha,
            checkoutDigest: sha,
            leaseId: uuid,
            leaseGeneration: version.positive(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type MaintenanceArchive = z.infer<typeof maintenanceArchiveSchema>;

// Private, outer-signed native-finalization evidence. Never a model tool input.
export const maintenanceNativeRebindSchema = z
  .object({
    maintenanceId: uuid,
    ownerIntentRuntimeId: uuid,
    ownerIntentEventId: uuid,
    parkedJournalDigest: sha,
    historyDigest: sha,
    leaseValidUntil: z.string().datetime({ offset: true }),
  })
  .strict();
export type MaintenanceNativeRebind = z.infer<typeof maintenanceNativeRebindSchema>;
// Private first-claim continuation, attached by the installed owner-resume path.
// It is deliberately absent from model-controlled command/payload schemas.
export const maintenanceClaimContinuationSchema = z
  .object({
    ownerIntentRuntimeId: uuid,
    ownerIntentEventId: uuid,
    epochRuntimeId: uuid,
    nativeReceiptEventId: uuid,
    epochResumeEventId: uuid,
    epochVersion: version.positive(),
    inputRequestId: uuid,
  })
  .strict();

export const accountMaintenanceGrantSchema = z
  .object({
    iss: z.string().url(),
    aud: z.literal("hive:workspace-guardian"),
    scope: z.literal("workspace:guardian:account-maintenance"),
    action: z.enum(["pause", "inspect-resume", "resume"]),
    jti: uuid,
    iat: version,
    exp: version.positive(),
    runtimeId: uuid,
    runtimeGeneration: version.positive(),
    lifetimeId: uuid,
    hiveUserId: uuid,
    coderOwnerId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    maintenanceId: uuid,
    maintenanceVersion: version.positive(),
    ownerIntentRuntimeId: uuid.nullable(),
    ownerIntentEventId: uuid.nullable(),
    parkedJournalDigest: sha.nullable(),
  })
  .strict();

export const maintenanceResumeScopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("account-maintenance"),
    maintenanceId: uuid,
    maintenanceVersion: version.positive(),
    ownerRequestId: uuid,
    ownerId: uuid,
    workspaceId: uuid,
    buildId: uuid,
    slotId: uuid,
    managerBindingId: uuid,
    previousEpochVersion: version,
    projectId: uuid,
    preparationIntentId: uuid,
    managerThreadId: z.string().min(1).max(100),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    leaseId: uuid,
    leaseGeneration: version.positive(),
    leaseValidUntil: z.string().datetime({ offset: true }),
    writerAttemptId: uuid.nullable(),
    writerRuntimeVersion: version,
    currentAttemptId: uuid.nullable(),
    cursorVersion: version,
    nativeSequence: version,
    checkoutDigest: sha,
    parkedHistoryDigest: sha,
    parkedJournalDigest: sha,
    oldRuntimeId: uuid,
    oldBarrierId: uuid,
    oldTreeReceiptId: uuid,
    oldTreeReceiptDigest: sha,
    ownerIntentRuntimeId: uuid,
    ownerIntentEventId: uuid,
    newRuntimeId: uuid,
    newNativeReceiptEventId: uuid,
    newRegistrationId: uuid,
    newServerInstanceId: z.string().min(1).max(160),
    newMetadataPinsDigest: sha,
    tasks: z
      .array(
        z
          .object({
            taskId: uuid,
            version,
            sourceVersion: version,
            sourceRevisionId: uuid.nullable(),
            sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type MaintenanceResumeScope = z.infer<typeof maintenanceResumeScopeSchema>;

const maintenanceReadyAuthorizationSchema = z
  .object({
    projectId: uuid,
    nativeReceiptEventId: uuid,
    managerBindingId: uuid.nullable(),
    executionEpochVersion: version,
    runnable: z.boolean(),
    completed: z.boolean(),
    claimContinuation: maintenanceClaimContinuationSchema.nullable(),
    holdReason: z
      .enum(["maintenance_previous_attempt_held", "maintenance_external_effect_held"])
      .nullable(),
  })
  .strict();
/** Fixed control-plane projection. Task/step snapshots belong to per-project
 * signed status reads, never the shared guardian FD response. */
export function maintenanceReadyAuthorization(
  value: z.infer<typeof maintenanceReadyAuthorizationSchema>,
) {
  const {
    projectId,
    nativeReceiptEventId,
    managerBindingId,
    executionEpochVersion,
    runnable,
    completed,
    claimContinuation,
    holdReason,
  } = value;
  return maintenanceReadyAuthorizationSchema.parse({
    projectId,
    nativeReceiptEventId,
    managerBindingId,
    executionEpochVersion,
    runnable,
    completed,
    claimContinuation,
    holdReason,
  });
}
export const maintenanceReadyResponseSchema = z
  .object({
    ready: z.literal(true),
    maintenanceId: uuid,
    ownerIntentRuntimeId: uuid,
    ownerIntentEventId: uuid,
    runnableProjectIds: z.array(uuid).max(32),
    authorizations: z.array(maintenanceReadyAuthorizationSchema).min(1).max(32),
  })
  .strict();
