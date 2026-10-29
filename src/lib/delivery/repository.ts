// Foundational persistence only: no HTTP result ingestion, queue consumer, merge,
// deployment, runtime registration, or external-evidence producer is enabled here.
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import {
  completionSchema,
  conversationBindingSchema,
  evidenceInputSchema,
  leaseRequestSchema,
  pauseRequestSchema,
  projectBindingSchema,
  taskDefinitionSchema,
} from "./contracts";
import { assertAcyclicSteps, assertCompletionEvidence, DeliveryConflict } from "./state";

type Transaction = Prisma.TransactionClient;
const ownerSchema = z.string().uuid();
interface EvidencePolicy {
  version: string;
  trustedProducers: readonly string[];
  maxAgeMs: number;
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function digest(operation: string, value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify([operation, canonical(value)]))
    .digest("hex");
}
async function now(tx: Transaction) {
  return (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
}
async function lockTask(tx: Transaction, ownerId: string, taskId: string) {
  const found = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM delivery_tasks WHERE owner_id = ${ownerId}::uuid AND id = ${taskId}::uuid FOR UPDATE`;
  if (found.length !== 1) throw new DeliveryConflict("task_not_found");
  const task = await tx.deliveryTask.findUnique({ where: { ownerId_id: { ownerId, id: taskId } } });
  if (!task) throw new DeliveryConflict("task_not_found");
  return task;
}
async function replay(tx: Transaction, ownerId: string, eventId: string, requestDigest: string) {
  const event = await tx.deliveryEvent.findUnique({
    where: { ownerId_id: { ownerId, id: eventId } },
  });
  if (event && event.requestDigest !== requestDigest)
    throw new DeliveryConflict("event_replay_conflict");
  return event;
}

function replayKeyCollision(error: unknown, models: readonly string[], evidence = false) {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002" ||
    !models.includes(String(error.meta?.modelName))
  )
    return false;
  const target = error.meta?.target;
  if (!Array.isArray(target)) return false;
  const fields = target.join(",");
  return [
    "id",
    "owner_id,id",
    "ownerId,id",
    ...(evidence
      ? ["owner_id,step_id,producer,remote_id", "ownerId,stepId,producer,remoteId"]
      : []),
  ].includes(fields);
}

export class DeliveryRepository {
  private readonly policy: EvidencePolicy;
  constructor(
    private readonly db: PrismaClient,
    policy: EvidencePolicy = { version: "disabled-v1", trustedProducers: [], maxAgeMs: 3600_000 },
  ) {
    if (
      !policy.version.trim() ||
      !Number.isFinite(policy.maxAgeMs) ||
      policy.maxAgeMs <= 0 ||
      policy.trustedProducers.some((producer) => !producer.trim())
    )
      throw new DeliveryConflict("invalid_evidence_policy");
    this.policy = { ...policy, trustedProducers: [...policy.trustedProducers] };
  }
  private async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 10_000,
        });
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034"
        )
          continue;
        throw error;
      }
    }
  }
  async bindProject(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = projectBindingSchema.parse(value);
    return this.db.deliveryProject.upsert({
      where: {
        ownerId_provider_providerRepositoryId: {
          ownerId,
          provider: input.provider,
          providerRepositoryId: input.providerRepositoryId,
        },
      },
      create: { ownerId, ...input },
      update: { providerAccountId: input.providerAccountId, fullName: input.fullName },
    });
  }
  // Only a verified host-registration integration may call this; there is no
  // manager-controlled endpoint accepting workspace/build/server bindings.
  async bindConversation(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = conversationBindingSchema.parse(value);
    return this.transaction(async (tx) => {
      const project = await tx.deliveryProject.findUnique({
        where: { ownerId_id: { ownerId, id: input.projectId } },
      });
      if (!project) throw new DeliveryConflict("project_not_found");
      const existing = await tx.deliveryConversation.findUnique({
        where: {
          ownerId_workspaceId_nativeThreadId: {
            ownerId,
            workspaceId: input.workspaceId,
            nativeThreadId: input.nativeThreadId,
          },
        },
      });
      if (existing && existing.projectId !== input.projectId)
        throw new DeliveryConflict("conversation_project_conflict");
      return tx.deliveryConversation.upsert({
        where: {
          ownerId_workspaceId_nativeThreadId: {
            ownerId,
            workspaceId: input.workspaceId,
            nativeThreadId: input.nativeThreadId,
          },
        },
        create: { ownerId, ...input },
        update: {
          buildId: input.buildId,
          serverInstanceId: input.serverInstanceId,
          nativePath: input.nativePath,
        },
      });
    });
  }
  async createTask(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = taskDefinitionSchema.parse(value);
    assertAcyclicSteps(
      input.steps.map((step) => step.id),
      input.dependencies,
    );
    const requestDigest = digest("task_created", input);
    return this.transaction(async (tx) => {
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { taskId: previous.taskId, replayed: true };
      const task = await tx.deliveryTask.create({
        data: {
          id: input.id,
          ownerId,
          projectId: input.projectId,
          epicId: input.epicId,
          conversationId: input.conversationId,
          outcome: input.outcome,
          branch: input.branch,
          sourceSha: input.sourceSha,
        },
      });
      await tx.deliveryStep.createMany({
        data: input.steps.map((step) => ({
          ...step,
          ownerId,
          taskId: task.id,
          state: input.dependencies.some((edge) => edge.stepId === step.id) ? "pending" : "ready",
        })),
      });
      if (input.dependencies.length)
        await tx.deliveryStepDependency.createMany({
          data: input.dependencies.map((edge) => ({ ...edge, ownerId, taskId: task.id })),
        });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          aggregateKey: `task/${task.id}`,
          aggregateVersion: 0,
          type: "task_created",
          requestDigest,
          policyVersion: this.policy.version,
        },
      });
      return { taskId: task.id, replayed: false };
    }).catch(async (error: unknown) => {
      if (!replayKeyCollision(error, ["DeliveryTask", "DeliveryEvent"])) throw error;
      const existing = await this.db.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId, id: input.eventId } },
      });
      if (!existing) throw error;
      if (existing.requestDigest !== requestDigest)
        throw new DeliveryConflict("event_replay_conflict");
      return { taskId: existing.taskId, replayed: true };
    });
  }
  async getTask(owner: string, taskId: string) {
    const ownerId = ownerSchema.parse(owner);
    return this.db.deliveryTask.findUnique({
      where: { ownerId_id: { ownerId, id: z.string().uuid().parse(taskId) } },
      include: { steps: { include: { attempts: true, reports: { include: { evidence: true } } } } },
    });
  }
  async claimStep(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = leaseRequestSchema.parse(value);
    const requestDigest = digest("attempt_started", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous?.attemptId) {
        const attempt = await tx.deliveryAttempt.findUniqueOrThrow({
          where: { ownerId_id: { ownerId, id: previous.attemptId } },
        });
        return {
          attemptId: attempt.id,
          leaseGeneration: attempt.leaseGeneration,
          leaseExpiresAt: attempt.leaseExpiresAt,
          version: previous.aggregateVersion,
          replayed: true,
          outcome: attempt.outcome,
          canRun: false,
          needsReconciliation: true,
        };
      }
      if (task.pauseRequested || task.schedulingPaused) throw new DeliveryConflict("task_paused");
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
        include: { dependencies: { include: { dependsOn: true } } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      if (step.kind === "release" || step.acceptancePhase === "activation_production")
        throw new DeliveryConflict("release_disabled");
      if (!["pending", "ready", "failed"].includes(step.state))
        throw new DeliveryConflict(
          step.state === "running" ? "reconciliation_required" : "step_not_ready",
        );
      if (step.dependencies.some((edge) => edge.dependsOn.state !== "succeeded"))
        throw new DeliveryConflict("dependencies_pending");
      if (step.attemptCount >= step.attemptBudget)
        throw new DeliveryConflict("attempt_budget_exhausted");
      const timestamp = await now(tx);
      const leaseGeneration = step.leaseGeneration + 1;
      const version = step.version + 1;
      const attempt = await tx.deliveryAttempt.create({
        data: {
          ownerId,
          stepId: step.id,
          leaseGeneration,
          leaseHolder: input.leaseHolder,
          leaseExpiresAt: new Date(timestamp.getTime() + input.leaseMs),
          sourceSha: task.sourceSha,
          requestedModel: input.requestedModel,
          effectiveModel: input.effectiveModel,
          requestedEffort: input.requestedEffort,
          effectiveEffort: input.effectiveEffort,
        },
      });
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: { state: "running", version, leaseGeneration, attemptCount: { increment: 1 } },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          aggregateKey: `step/${step.id}`,
          aggregateVersion: version,
          type: "attempt_started",
          requestDigest,
          policyVersion: this.policy.version,
        },
      });
      return {
        attemptId: attempt.id,
        leaseGeneration,
        leaseExpiresAt: attempt.leaseExpiresAt,
        version,
        replayed: false,
        outcome: "running",
        canRun: true,
        needsReconciliation: false,
      };
    });
  }
  // Trusted adapter method only. Reports cannot insert evidence or choose a producer.
  async recordEvidence(owner: string, producer: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    if (!this.policy.trustedProducers.includes(producer))
      throw new DeliveryConflict("untrusted_evidence_producer");
    const input = evidenceInputSchema.parse(value);
    if (
      !input.objectKey.startsWith(`delivery/${ownerId}/`) ||
      input.objectKey.split("/").includes("..")
    )
      throw new DeliveryConflict("invalid_evidence_location");
    const requestDigest = digest("evidence_ingested", {
      ...input,
      producer,
      policyVersion: this.policy.version,
    });
    return this.transaction(async (tx) => {
      const existing = await tx.deliveryEvidence.findUnique({
        where: { ownerId_id: { ownerId, id: input.id } },
      });
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          throw new DeliveryConflict("evidence_replay_conflict");
        return existing;
      }
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_id: { ownerId, id: input.stepId } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      const task = await lockTask(tx, ownerId, step.taskId);
      const timestamp = await now(tx);
      if (
        task.sourceSha !== input.sourceSha ||
        input.observedAt > timestamp ||
        input.criterionIds.some((id) => !step.criterionIds.includes(id))
      )
        throw new DeliveryConflict("invalid_evidence");
      return tx.deliveryEvidence.create({
        data: { ...input, ownerId, producer, requestDigest, policyVersion: this.policy.version },
      });
    }).catch(async (error: unknown) => {
      if (!replayKeyCollision(error, ["DeliveryEvidence"], true)) throw error;
      const existing = await this.db.deliveryEvidence.findUnique({
        where: { ownerId_id: { ownerId, id: input.id } },
      });
      if (!existing) throw error;
      if (existing.requestDigest !== requestDigest)
        throw new DeliveryConflict("evidence_replay_conflict");
      return existing;
    });
  }
  async completeStep(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = completionSchema.parse(value);
    const requestDigest = digest("step_completed", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) {
        const report = await tx.deliveryStepReport.findUniqueOrThrow({
          where: { ownerId_eventId: { ownerId, eventId: previous.id } },
        });
        return {
          eventId: previous.id,
          reportId: report.id,
          version: previous.aggregateVersion,
          replayed: true,
        };
      }
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      const attempt = await tx.deliveryAttempt.findUnique({
        where: { ownerId_stepId_id: { ownerId, stepId: step.id, id: input.attemptId } },
      });
      const timestamp = await now(tx);
      if (
        !attempt ||
        step.state !== "running" ||
        attempt.outcome !== "running" ||
        attempt.leaseGeneration !== input.leaseGeneration ||
        step.leaseGeneration !== input.leaseGeneration ||
        attempt.leaseExpiresAt <= timestamp
      )
        throw new DeliveryConflict("stale_attempt");
      if (task.sourceSha !== input.sourceSha || attempt.sourceSha !== input.sourceSha)
        throw new DeliveryConflict("source_revision_changed");
      const evidence = await tx.deliveryEvidence.findMany({
        where: { ownerId, stepId: step.id, id: { in: input.evidenceIds } },
      });
      if (evidence.length !== input.evidenceIds.length)
        throw new DeliveryConflict("evidence_not_found");
      assertCompletionEvidence({
        ownerId,
        stepId: step.id,
        sourceSha: task.sourceSha,
        acceptancePhase: step.acceptancePhase,
        criterionIds: step.criterionIds,
        requiredKinds: step.requiredEvidenceKinds,
        policyVersion: this.policy.version,
        trustedProducers: this.policy.trustedProducers,
        now: timestamp,
        maxAgeMs: this.policy.maxAgeMs,
        evidence,
      });
      const version = step.version + 1;
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: { state: "succeeded", version },
      });
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: { outcome: "succeeded", finishedAt: timestamp },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          aggregateKey: `step/${step.id}`,
          aggregateVersion: version,
          type: "step_completed",
          requestDigest,
          policyVersion: this.policy.version,
        },
      });
      const report = await tx.deliveryStepReport.create({
        data: {
          ownerId,
          stepId: step.id,
          attemptId: attempt.id,
          eventId: input.eventId,
          ...input.report,
        },
      });
      await tx.deliveryReportEvidence.createMany({
        data: input.evidenceIds.map((evidenceId) => ({
          ownerId,
          stepId: step.id,
          reportId: report.id,
          evidenceId,
        })),
      });
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      if (
        task.pauseRequested &&
        (await tx.deliveryStep.count({
          where: { ownerId, taskId: task.id, state: { in: ["running", "waiting_external"] } },
        })) === 0
      )
        await tx.deliveryTask.update({
          where: { ownerId_id: { ownerId, id: task.id } },
          data: { schedulingPaused: true },
        });
      return { eventId: input.eventId, reportId: report.id, version, replayed: false };
    });
  }
  async setPaused(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = pauseRequestSchema.parse(value);
    const requestDigest = digest("pause_changed", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      if (task.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      const running = await tx.deliveryStep.count({
        where: { ownerId, taskId: task.id, state: { in: ["running", "waiting_external"] } },
      });
      await tx.deliveryTask.update({
        where: { ownerId_id: { ownerId, id: task.id } },
        data: {
          pauseRequested: input.paused,
          schedulingPaused: input.paused && running === 0,
          version: { increment: 1 },
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          aggregateKey: `task/${task.id}`,
          aggregateVersion: task.version + 1,
          type: input.paused ? "pause_requested" : "scheduling_resumed",
          requestDigest,
          policyVersion: this.policy.version,
        },
      });
      return { version: task.version + 1, replayed: false };
    });
  }
}
