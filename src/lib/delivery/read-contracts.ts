import { z } from "zod";

const id = z.string().uuid();
const timestamp = z.string().datetime();
export const deliveryPauseReceiptSchema = z.object({
  version: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export const deliveryTaskSummarySchema = z.object({
  id,
  outcome: z.string(),
  projectName: z.string(),
  branch: z.string(),
  sourceSha: z.string(),
  createdAt: timestamp,
  version: z.number().int(),
  pauseRequested: z.boolean(),
  schedulingPaused: z.boolean(),
  releaseMode: z.literal("disabled"),
  counts: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    reported: z.number().int().default(0),
    attention: z.number().int(),
  }),
});
export const deliveryTaskPageSchema = z.object({
  tasks: z.array(deliveryTaskSummarySchema).max(25),
  nextCursor: id.nullable(),
});
export const deliveryReportSchema = z.object({
  id,
  informational: z.boolean().default(false),
  sourceSha: z.string().optional(),
  summary: z.string(),
  difficulty: z.string(),
  difficultyReason: z.string(),
  issues: z.array(z.object({ summary: z.string(), resolution: z.string() })),
  remainingUncertainty: z.string(),
  nextAction: z.string(),
  createdAt: timestamp,
  evidence: z.array(
    z.object({
      id,
      kind: z.string(),
      status: z.string(),
      verificationMode: z.string(),
      environment: z.string(),
      sourceSha: z.string(),
      observedAt: timestamp,
      invalidatedAt: timestamp.nullable(),
    }),
  ),
});
export const deliveryTaskDetailSchema = deliveryTaskSummarySchema.extend({
  manager: z
    .object({
      projectId: id,
      conversationId: id,
      workspaceId: id,
      threadId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
    })
    .nullable()
    .default(null),
  recentEvents: z
    .array(
      z.object({
        id,
        label: z.string(),
        reason: z.string().nullable(),
        stepId: id.nullable(),
        reportId: id.nullable(),
        notificationStatus: z
          .enum(["pending", "processing", "delivered", "failed"])
          .nullable()
          .default(null),
        createdAt: timestamp,
      }),
    )
    .max(25)
    .default([]),
  steps: z
    .array(
      z.object({
        id,
        kind: z.string(),
        state: z.string(),
        waitingReason: z.string().nullable().default(null),
        acceptancePhase: z.string(),
        attemptCount: z.number().int(),
        attemptBudget: z.number().int(),
        dependencies: z.array(id),
        reports: z.array(deliveryReportSchema),
        latestAttempt: z
          .object({
            requestedModel: z.string().nullable(),
            effectiveModel: z.string().nullable(),
            requestedEffort: z.string().nullable(),
            effectiveEffort: z.string().nullable(),
            outcome: z.string(),
            startedAt: timestamp,
            finishedAt: timestamp.nullable(),
          })
          .nullable(),
      }),
    )
    .max(32),
});
export type DeliveryTaskSummary = z.infer<typeof deliveryTaskSummarySchema>;
export type DeliveryTaskPage = z.infer<typeof deliveryTaskPageSchema>;
export type DeliveryTaskDetail = z.infer<typeof deliveryTaskDetailSchema>;
export type DeliveryReport = z.infer<typeof deliveryReportSchema>;
