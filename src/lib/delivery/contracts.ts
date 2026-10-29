import { z } from "zod";

export const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z.string().uuid();
const label = z.string().min(1).max(160);
const criterion = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
export const evidenceKindSchema = z.enum([
  "analysis",
  "change",
  "review",
  "check",
  "artifact",
  "migration",
  "observation",
]);
export const stepStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_external",
  "blocked",
  "succeeded",
  "failed",
  "canceled",
]);
export const stepDefinitionSchema = z
  .object({
    id: identifier,
    kind: z.enum([
      "understand",
      "implement",
      "review",
      "validate",
      "release",
      "observe",
      "migrate",
      "backfill",
    ]),
    acceptancePhase: z
      .enum(["implementation_preview", "activation_production"])
      .default("implementation_preview"),
    criterionIds: z
      .array(criterion)
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length),
    requiredEvidenceKinds: z
      .array(evidenceKindSchema)
      .min(1)
      .max(7)
      .refine((values) => new Set(values).size === values.length),
    attemptBudget: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export const taskDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifier,
    id: identifier,
    projectId: identifier,
    epicId: identifier.optional(),
    conversationId: identifier.optional(),
    outcome: z.string().min(1).max(4000),
    branch: z.string().min(1).max(255),
    sourceSha: sourceShaSchema,
    steps: z.array(stepDefinitionSchema).min(1).max(32),
    dependencies: z
      .array(z.object({ stepId: identifier, dependsOnStepId: identifier }).strict())
      .max(128)
      .default([]),
  })
  .strict();
export const leaseRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifier,
    taskId: identifier,
    stepId: identifier,
    expectedVersion: z.number().int().nonnegative(),
    leaseHolder: label,
    leaseMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60_000)
      .default(60_000),
    requestedModel: label.nullable().default(null),
    effectiveModel: label.nullable().default(null),
    requestedEffort: label.nullable().default(null),
    effectiveEffort: label.nullable().default(null),
  })
  .strict();
export const completionSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifier,
    taskId: identifier,
    stepId: identifier,
    attemptId: identifier,
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    sourceSha: sourceShaSchema,
    evidenceIds: z
      .array(identifier)
      .min(1)
      .max(50)
      .refine((values) => new Set(values).size === values.length),
    report: z
      .object({
        summary: z.string().min(1).max(4000),
        difficulty: z.enum(["low", "moderate", "high"]),
        difficultyReason: z.string().min(1).max(1000),
        issues: z
          .array(
            z
              .object({
                summary: z.string().min(1).max(1000),
                resolution: z.string().min(1).max(1000),
              })
              .strict(),
          )
          .max(20),
        remainingUncertainty: z.string().max(2000),
        nextAction: z.string().min(1).max(2000),
      })
      .strict(),
  })
  .strict();
export const evidenceInputSchema = z
  .object({
    id: identifier,
    stepId: identifier,
    remoteId: z.string().min(1).max(200),
    kind: evidenceKindSchema,
    status: z.enum(["passed", "failed", "unknown"]),
    verificationMode: z.enum(["unit", "simulated", "integration", "browser", "production"]),
    environment: label,
    sourceSha: sourceShaSchema,
    artifactDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    criterionIds: z.array(criterion).min(1).max(20),
    objectKey: z.string().min(1).max(1000),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.date(),
  })
  .strict()
  .refine(
    (value) => value.kind !== "artifact" || value.artifactDigest !== null,
    "Artifact evidence requires an immutable digest",
  );
export const pauseRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: identifier,
    taskId: identifier,
    expectedVersion: z.number().int().nonnegative(),
    paused: z.boolean(),
  })
  .strict();
export const projectBindingSchema = z
  .object({
    provider: z.literal("github"),
    providerRepositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    fullName: z.string().min(3).max(140),
  })
  .strict();
export const conversationBindingSchema = z
  .object({
    projectId: identifier,
    workspaceId: identifier,
    nativeThreadId: z.string().min(1).max(160),
    buildId: identifier,
    serverInstanceId: label,
    nativePath: z.string().min(1).max(4096).nullable().default(null),
  })
  .strict();
export type DeliveryStepState = z.infer<typeof stepStateSchema>;
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
