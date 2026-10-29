import type { Prisma, PrismaClient } from "@hive/db";
import { z } from "zod";
import { deliveryEventLabel } from "./event-labels";
import { deliveryTaskDetailSchema, deliveryTaskPageSchema } from "./read-contracts";

const id = z.string().uuid();
const reportSelect = {
  id: true,
  summary: true,
  difficulty: true,
  difficultyReason: true,
  issues: true,
  remainingUncertainty: true,
  nextAction: true,
  createdAt: true,
  evidence: {
    select: {
      evidence: {
        select: {
          id: true,
          kind: true,
          status: true,
          verificationMode: true,
          environment: true,
          sourceSha: true,
          observedAt: true,
          invalidatedAt: true,
        },
      },
    },
  },
} satisfies Prisma.DeliveryStepReportSelect;
const summarySelect = {
  id: true,
  outcome: true,
  branch: true,
  sourceSha: true,
  createdAt: true,
  version: true,
  pauseRequested: true,
  schedulingPaused: true,
  releaseMode: true,
  project: { select: { fullName: true } },
  steps: { select: { state: true } },
} satisfies Prisma.DeliveryTaskSelect;
type SummaryRow = Prisma.DeliveryTaskGetPayload<{ select: typeof summarySelect }>;
function summary(row: SummaryRow) {
  return {
    id: row.id,
    outcome: row.outcome,
    branch: row.branch,
    sourceSha: row.sourceSha,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    pauseRequested: row.pauseRequested,
    schedulingPaused: row.schedulingPaused,
    releaseMode: row.releaseMode,
    projectName: row.project.fullName,
    counts: {
      total: row.steps.length,
      succeeded: row.steps.filter((step) => step.state === "succeeded").length,
      attention: row.steps.filter((step) => ["blocked", "failed"].includes(step.state)).length,
    },
  };
}

/** Authenticated caller supplies the Hive user UUID, never a browser-selected owner. */
export async function listDeliveryTasks(db: PrismaClient, owner: string, cursor?: string) {
  const ownerId = id.parse(owner);
  const before = cursor
    ? await db.deliveryTask.findUnique({
        where: { ownerId_id: { ownerId, id: id.parse(cursor) } },
        select: { id: true, createdAt: true },
      })
    : null;
  if (cursor && !before) return null;
  const rows = await db.deliveryTask.findMany({
    where: {
      ownerId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 26,
    select: summarySelect,
  });
  return deliveryTaskPageSchema.parse({
    tasks: rows.slice(0, 25).map(summary),
    nextCursor: rows.length > 25 ? rows[24].id : null,
  });
}

export async function readDeliveryTask(
  db: PrismaClient,
  owner: string,
  taskId: string,
  reportId?: string,
) {
  const ownerId = id.parse(owner);
  const task = await db.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId, id: id.parse(taskId) } },
    select: {
      ...summarySelect,
      events: {
        where: { ownerId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 25,
        select: {
          id: true,
          type: true,
          payload: true,
          createdAt: true,
          stepId: true,
          report: { select: { id: true } },
        },
      },
      steps: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 32,
        select: {
          id: true,
          kind: true,
          state: true,
          waitingReason: true,
          acceptancePhase: true,
          attemptCount: true,
          attemptBudget: true,
          dependencies: { select: { dependsOnStepId: true } },
          attempts: {
            orderBy: { leaseGeneration: "desc" },
            take: 1,
            select: {
              requestedModel: true,
              effectiveModel: true,
              requestedEffort: true,
              effectiveEffort: true,
              outcome: true,
              startedAt: true,
              finishedAt: true,
            },
          },
          reports: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: reportSelect,
          },
        },
      },
    },
  });
  if (!task) return null;
  if (reportId) {
    const pinned = await db.deliveryStepReport.findFirst({
      where: { ownerId, id: id.parse(reportId), step: { taskId: task.id } },
      select: { ...reportSelect, stepId: true },
    });
    if (!pinned) return null;
    const step = task.steps.find((step) => step.id === pinned.stepId);
    if (step && !step.reports.some((report) => report.id === pinned.id)) step.reports.push(pinned);
  }
  return deliveryTaskDetailSchema.parse({
    ...summary(task),
    recentEvents: task.events.map((event) => {
      const payload = event.payload;
      const reason =
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof payload.reason === "string"
          ? payload.reason.slice(0, 1000)
          : null;
      return {
        id: event.id,
        label: deliveryEventLabel(event.type),
        reason,
        stepId: event.stepId,
        reportId: event.report?.id ?? null,
        createdAt: event.createdAt.toISOString(),
      };
    }),
    steps: task.steps.map((step) => ({
      ...step,
      dependencies: step.dependencies.map((edge) => edge.dependsOnStepId),
      latestAttempt: step.attempts[0]
        ? {
            ...step.attempts[0],
            startedAt: step.attempts[0].startedAt.toISOString(),
            finishedAt: step.attempts[0].finishedAt?.toISOString() ?? null,
          }
        : null,
      reports: step.reports.map((report) => ({
        ...report,
        createdAt: report.createdAt.toISOString(),
        evidence: report.evidence.map(({ evidence }) => ({
          ...evidence,
          observedAt: evidence.observedAt.toISOString(),
          invalidatedAt: evidence.invalidatedAt?.toISOString() ?? null,
        })),
      })),
    })),
  });
}
