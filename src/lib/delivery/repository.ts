// Foundational persistence only: no HTTP result ingestion, queue consumer, merge,
// deployment, runtime registration, or external-evidence producer is enabled here.
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import {
  attemptFailureSchema,
  completionSchema,
  conversationBindingSchema,
  evidenceInputSchema,
  expiredAttemptReconciliationSchema,
  informationalReportSchema,
  leaseRequestSchema,
  nativeDelegationSchema,
  nativeRuntimeBindingSchema,
  pauseRequestSchema,
  projectBindingSchema,
  runtimeBindingRequestSchema,
  runtimeObservationPayloadSchema,
  runtimeObservationSchema,
  sourceChangeSchema,
  stepControlSchema,
  taskDefinitionSchema,
} from "./contracts";
import { NATIVE_OBSERVER_PRODUCER, nativeSourceInputSchema } from "./native-contracts";
import {
  assertAcyclicSteps,
  assertCompletionEvidence,
  DeliveryConflict,
  dependencySatisfied,
  dependentClosure,
  isInformationalStep,
} from "./state";

type Transaction = Prisma.TransactionClient;
const ownerSchema = z.string().uuid();
export interface EvidencePolicy {
  version: string;
  trustedProducers: readonly string[];
  maxAgeMs: number;
  trustedRuntimeAdapters?: readonly string[];
  maxRuntimeObservationAgeMs?: number;
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

interface KnownDatabaseError {
  code: string;
  clientVersion: string;
  name: string;
  meta?: Record<string, unknown>;
}
function knownDatabaseError(
  error: unknown,
  code: "P2002" | "P2034" | "P2010",
): error is KnownDatabaseError {
  if (!error || typeof error !== "object") return false;
  const value = error as Partial<KnownDatabaseError>;
  return (
    value.name === "PrismaClientKnownRequestError" &&
    value.code === code &&
    typeof value.clientVersion === "string" &&
    /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.clientVersion)
  );
}

function replayKeyCollision(error: unknown, models: readonly string[], evidence = false) {
  if (!knownDatabaseError(error, "P2002") || !models.includes(String(error.meta?.modelName)))
    return false;
  let target: unknown = error.meta?.target;
  if (target === undefined) {
    // PrismaNeon/workerd reports the same constraint through its adapter cause,
    // without Node's meta.target. Accept only the observed structured variant.
    const adapter = error.meta?.driverAdapterError;
    if (
      !adapter ||
      typeof adapter !== "object" ||
      !("name" in adapter) ||
      adapter.name !== "DriverAdapterError" ||
      !("cause" in adapter) ||
      !adapter.cause ||
      typeof adapter.cause !== "object"
    )
      return false;
    const cause = adapter.cause;
    if (
      !("kind" in cause) ||
      cause.kind !== "UniqueConstraintViolation" ||
      !("constraint" in cause) ||
      !cause.constraint ||
      typeof cause.constraint !== "object" ||
      !("fields" in cause.constraint)
    )
      return false;
    target = cause.constraint.fields;
  }
  if (!Array.isArray(target) || !target.every((field) => typeof field === "string")) return false;
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
    // Server-held authorization executes in every transaction/retry. Never a
    // callback constructed from manager JSON or a middleware-only result.
    private readonly authorizeTransaction?: (tx: Transaction) => Promise<void>,
    private readonly afterAttemptClaimed?: (
      tx: Transaction,
      attempt: { id: string; managerBindingId: string | null },
    ) => Promise<void>,
    // Controller-only same-writer exception. Never set from a manager boolean.
    private readonly authorizeClaimWriters?: (
      tx: Transaction,
      attempts: readonly {
        id: string;
        managerBindingId: string | null;
        sourceSha: string;
        outcome: string;
      }[],
    ) => Promise<void>,
  ) {
    if (
      !policy.version.trim() ||
      !Number.isFinite(policy.maxAgeMs) ||
      policy.maxAgeMs <= 0 ||
      policy.trustedProducers.some((producer) => !producer.trim()) ||
      (policy.trustedRuntimeAdapters ?? []).some((producer) => !producer.trim()) ||
      (policy.maxRuntimeObservationAgeMs !== undefined &&
        (!Number.isFinite(policy.maxRuntimeObservationAgeMs) ||
          policy.maxRuntimeObservationAgeMs <= 0))
    )
      throw new DeliveryConflict("invalid_evidence_policy");
    this.policy = {
      ...policy,
      trustedProducers: [...policy.trustedProducers],
      trustedRuntimeAdapters: [...(policy.trustedRuntimeAdapters ?? [])],
      maxRuntimeObservationAgeMs: policy.maxRuntimeObservationAgeMs ?? 60_000,
    };
  }
  private async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            await this.authorizeTransaction?.(tx);
            return operation(tx);
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 10_000,
          },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          (knownDatabaseError(error, "P2034") ||
            (knownDatabaseError(error, "P2010") && error.meta?.code === "40001"))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }
  private runtimeAuthority(producer: string) {
    if (!this.policy.trustedRuntimeAdapters?.includes(producer))
      throw new DeliveryConflict("untrusted_runtime_adapter");
  }
  private proofQuiescent(
    attempt: { outcome: string; runtimeBindingDigest: string | null; quiescedAt: Date | null },
    event?: { policyVersion: string; payload: unknown },
  ) {
    // Unbound successful steps are controller bookkeeping only: fresh leases do
    // not authorize native execution before binding. Every unknown/failed/live
    // execution still requires a positively verified native lifetime observation.
    if (!attempt.runtimeBindingDigest) return attempt.outcome === "succeeded";
    if (!attempt.quiescedAt || !event || event.policyVersion !== this.policy.version) return false;
    const proof = runtimeObservationPayloadSchema.safeParse(event.payload);
    return (
      proof.success &&
      this.policy.trustedRuntimeAdapters?.includes(proof.data.producer) &&
      proof.data.bindingDigest === attempt.runtimeBindingDigest &&
      proof.data.nativeTurn === "quiescent" &&
      proof.data.backgroundProcesses === "quiescent" &&
      proof.data.externalOperations === "quiescent" &&
      proof.data.externalEffects === "none"
    );
  }
  private async pendingWriters(
    tx: Transaction,
    ownerId: string,
    taskId: string,
    stepIds?: string[],
  ) {
    const attempts = await tx.deliveryAttempt.findMany({
      where: { ownerId, step: { taskId }, ...(stepIds ? { stepId: { in: stepIds } } : {}) },
    });
    const observations = await tx.$queryRaw<
      { attempt_id: string; policy_version: string; payload: unknown }[]
    >`
      SELECT DISTINCT ON (attempt_id) attempt_id, policy_version, payload FROM delivery_events
      WHERE owner_id = ${ownerId}::uuid AND task_id = ${taskId}::uuid
        AND type IN ('native_attempt_quiescent', 'native_attempt_observed')
      ORDER BY attempt_id, aggregate_version DESC`;
    const latest = new Map(
      observations.map((event) => [
        event.attempt_id,
        { policyVersion: event.policy_version, payload: event.payload },
      ]),
    );
    return attempts.filter((attempt) => !this.proofQuiescent(attempt, latest.get(attempt.id)));
  }
  private async refreshPause(tx: Transaction, ownerId: string, taskId: string) {
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: taskId } },
    });
    const schedulingPaused =
      task.pauseRequested && (await this.pendingWriters(tx, ownerId, taskId)).length === 0;
    if (task.schedulingPaused !== schedulingPaused)
      await tx.deliveryTask.update({
        where: { ownerId_id: { ownerId, id: taskId } },
        data: { schedulingPaused },
      });
  }
  private async runtimeAttempt(
    tx: Transaction,
    ownerId: string,
    input: { taskId: string; stepId: string; attemptId: string },
  ) {
    const task = await lockTask(tx, ownerId, input.taskId);
    const step = await tx.deliveryStep.findUnique({
      where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
    });
    const attempt =
      step &&
      (await tx.deliveryAttempt.findUnique({
        where: { ownerId_stepId_id: { ownerId, stepId: step.id, id: input.attemptId } },
      }));
    if (!step || !attempt) throw new DeliveryConflict("attempt_not_found");
    return { task, step, attempt };
  }
  private async safetyPause(
    tx: Transaction,
    ownerId: string,
    taskId: string,
    causeEventId: string,
  ) {
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: taskId } },
    });
    if (!task.pauseRequested) {
      await tx.deliveryTask.update({
        where: { ownerId_id: { ownerId, id: task.id } },
        data: { pauseRequested: true, schedulingPaused: false, version: { increment: 1 } },
      });
      await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId,
          taskId,
          aggregateKey: `task/${task.id}`,
          aggregateVersion: task.version + 1,
          type: "safety_pause_requested",
          requestDigest: digest("safety_pause_requested", { causeEventId }),
          policyVersion: this.policy.version,
          payload: { causeEventId },
        },
      });
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
    if (input.initialEpic && input.epicId !== input.initialEpic.id)
      throw new DeliveryConflict("epic_binding_conflict");
    assertAcyclicSteps(
      input.steps.map((step) => step.id),
      input.dependencies,
    );
    const requestDigest = digest("task_created", input);
    return this.transaction(async (tx) => {
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { taskId: previous.taskId, replayed: true };
      if (input.initialEpic) {
        const existingEpic = await tx.deliveryEpic.findUnique({
          where: { ownerId_id: { ownerId, id: input.initialEpic.id } },
        });
        if (existingEpic) {
          if (
            existingEpic.projectId !== input.projectId ||
            existingEpic.outcome !== input.initialEpic.outcome ||
            JSON.stringify(existingEpic.criteria) !== JSON.stringify(input.initialEpic.criteria)
          )
            throw new DeliveryConflict("epic_binding_conflict");
        } else {
          await tx.deliveryEpic.create({
            data: {
              ...input.initialEpic,
              ownerId,
              projectId: input.projectId,
            },
          });
        }
      }
      const task = await tx.deliveryTask.create({
        data: {
          id: input.id,
          ownerId,
          projectId: input.projectId,
          epicId: input.epicId,
          conversationId: input.conversationId,
          managerBindingId: input.managerBindingId,
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
  async claimStep(
    owner: string,
    value: unknown,
    trustedNativeReceipt?: () =>
      | Pick<
          NonNullable<z.infer<typeof leaseRequestSchema>["nativeClaim"]>,
          "cursorVersion" | "sequence" | "continuation"
        >
      | undefined,
  ) {
    const ownerId = ownerSchema.parse(owner);
    const input = leaseRequestSchema.parse(value);
    return this.transaction(async (tx) => {
      if (input.nativeClaim && trustedNativeReceipt)
        input.nativeClaim = { ...input.nativeClaim, ...trustedNativeReceipt() };
      const requestDigest = digest("attempt_started", input);
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
      if (!["pending", "ready"].includes(step.state))
        throw new DeliveryConflict(
          step.state === "running" ? "reconciliation_required" : "step_not_ready",
        );
      if (step.dependencies.some((edge) => !dependencySatisfied(edge.dependsOn)))
        throw new DeliveryConflict("dependencies_pending");
      const writers = await this.pendingWriters(tx, ownerId, task.id);
      if (writers.length) {
        if (!this.authorizeClaimWriters)
          throw new DeliveryConflict("native_reconciliation_required");
        await this.authorizeClaimWriters(tx, writers);
      }
      if (step.attemptCount >= step.attemptBudget)
        throw new DeliveryConflict("attempt_budget_exhausted");
      const timestamp = await now(tx);
      const leaseGeneration = step.leaseGeneration + 1;
      const version = step.version + 1;
      const attempt = await tx.deliveryAttempt.create({
        data: {
          ownerId,
          stepId: step.id,
          managerBindingId: task.managerBindingId,
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
          ...(input.nativeClaim ? { payload: { nativeClaim: input.nativeClaim } } : {}),
          requestDigest,
          policyVersion: this.policy.version,
        },
      });
      await this.afterAttemptClaimed?.(tx, attempt);
      return {
        attemptId: attempt.id,
        leaseGeneration,
        leaseExpiresAt: attempt.leaseExpiresAt,
        version,
        replayed: false,
        outcome: "running",
        canRun: false,
        needsRuntimeBinding: true,
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
      await this.refreshPause(tx, ownerId, task.id);
      return { eventId: input.eventId, reportId: report.id, version, replayed: false };
    });
  }

  /** Accept model-authored analysis as workflow reporting, not independent
   * verification. Existing runtime identities/writer holds remain untouched. */
  async reportStep(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner),
      input = informationalReportSchema.parse(value);
    const requestDigest = digest("step_reported", input);
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
          informational: true,
        };
      }
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      if (!isInformationalStep(step)) throw new DeliveryConflict("informational_step_only");
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
      const version = step.version + 1;
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: { state: "reported", version },
      });
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: { outcome: "reported", finishedAt: timestamp },
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
          type: "step_reported",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { acceptance: "informational", independentVerification: false },
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
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      await this.refreshPause(tx, ownerId, task.id);
      return {
        eventId: input.eventId,
        reportId: report.id,
        version,
        replayed: false,
        informational: true,
      };
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
      const running = (await this.pendingWriters(tx, ownerId, task.id)).length;
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

  /** Exact installed native observer scope; no manager-reported pass/producer. */
  async recordNativeSource(owner: string, producer: string, value: unknown) {
    this.runtimeAuthority(producer);
    const ownerId = ownerSchema.parse(owner),
      input = nativeSourceInputSchema.parse(value);
    const requestDigest = digest("native_source_observed", {
      producer,
      input,
      policyVersion: this.policy.version,
    });
    return this.transaction(async (tx) => {
      const { task, step, attempt } = await this.runtimeAttempt(tx, ownerId, input);
      const manager = await tx.deliveryManagerBinding.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: input.managerBindingId } },
      });
      if (
        task.managerBindingId !== manager.id ||
        attempt.managerBindingId !== manager.id ||
        attempt.leaseGeneration !== input.leaseGeneration
      )
        throw new DeliveryConflict("native_source_binding_mismatch");
      const previous = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId, id: input.eventId } },
      });
      const timestamp = await now(tx);
      const block = async (reason: string, eventId: string, advanceSequence: boolean) => {
        const conflict = await tx.deliveryEvent.findUnique({
          where: { ownerId_id: { ownerId, id: eventId } },
        });
        if (!conflict) {
          const runtimeVersion = attempt.runtimeVersion + 1;
          await tx.deliveryAttempt.update({
            where: { ownerId_id: { ownerId, id: attempt.id } },
            data: { runtimeVersion },
          });
          await tx.deliveryManagerBinding.update({
            where: { ownerId_id: { ownerId, id: manager.id } },
            data: {
              blockedReason: reason,
              ...(advanceSequence ? { nativeSequence: input.sequence } : {}),
            },
          });
          await tx.deliveryEvent.create({
            data: {
              id: eventId,
              ownerId,
              taskId: task.id,
              stepId: step.id,
              attemptId: attempt.id,
              aggregateKey: `attempt/${attempt.id}`,
              aggregateVersion: runtimeVersion,
              type: "native_source_conflict",
              requestDigest,
              policyVersion: this.policy.version,
              payload: {
                producer,
                nativeSourceKind: input.source.kind,
                sequence: input.sequence,
                reason,
                source: input.source,
              },
            },
          });
          await this.safetyPause(tx, ownerId, task.id, eventId);
          await tx.deliveryOutbox.create({ data: { ownerId, eventId, channel: "push" } });
        }
        return {
          accepted: advanceSequence,
          blocked: true,
          replayed: !!conflict,
          sequence: input.sequence,
          activeAttemptHeld: true,
        };
      };
      if (previous) {
        if (previous.requestDigest !== requestDigest) {
          const hex = digest("native_source_conflict", {
            ownerId,
            eventId: input.eventId,
            requestDigest,
          });
          const conflictId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
          return block("native_source_replay_conflict", conflictId, false);
        }
        return {
          accepted: true,
          replayed: true,
          blocked: manager.blockedReason !== null,
          sequence: input.sequence,
          runtimeVersion: previous.aggregateVersion,
          activeAttemptHeld: true,
          ...(input.source.kind === "root_boundary"
            ? { boundaryEventId: input.eventId, cursorVersion: input.source.cursorVersion }
            : {}),
        };
      }
      const currentAttemptId =
        manager.progressionProtocol === 1 ? manager.currentAttemptId : manager.activeAttemptId;
      if (currentAttemptId !== attempt.id) {
        if (manager.progressionProtocol === 1)
          return block("native_attempt_not_current", input.eventId, false);
        throw new DeliveryConflict("native_attempt_not_held");
      }
      if (input.sequence !== manager.nativeSequence + 1)
        throw new DeliveryConflict("native_sequence_gap");
      if (Date.parse(input.source.observedAt) > timestamp.getTime())
        throw new DeliveryConflict("native_observation_future");
      const claim = await tx.deliveryEvent.findFirst({
        where: { ownerId, attemptId: attempt.id, type: "attempt_started" },
      });
      const claimed = (
        claim?.payload as {
          nativeClaim?: { managerThreadId?: unknown; parentTurnId?: unknown };
        } | null
      )?.nativeClaim;
      if (
        claimed?.managerThreadId !== manager.nativeThreadId ||
        claimed?.parentTurnId !== input.source.parentTurnId
      )
        return block("native_parent_turn_mismatch", input.eventId, true);
      if (input.source.kind === "root_boundary") {
        if (
          producer !== NATIVE_OBSERVER_PRODUCER ||
          manager.progressionProtocol !== 1 ||
          manager.blockedReason ||
          manager.cursorVersion !== input.source.cursorVersion ||
          input.source.nextParentTurnId === input.source.parentTurnId ||
          !["reported", "succeeded"].includes(attempt.outcome) ||
          step.state !== attempt.outcome ||
          attempt.sourceSha !== manager.sourceSha ||
          task.sourceSha !== manager.sourceSha ||
          task.pauseRequested ||
          task.schedulingPaused ||
          attempt.leaseExpiresAt <= timestamp ||
          timestamp.getTime() - Date.parse(input.source.observedAt) >
            (this.policy.maxRuntimeObservationAgeMs ?? 60_000)
        )
          throw new DeliveryConflict("native_boundary_not_ready");
        if (attempt.runtimeBindingDigest) {
          const terminal = await tx.deliveryEvent.findFirst({
            where: {
              ownerId,
              attemptId: attempt.id,
              type: { in: ["native_attempt_observed", "native_source_conflict"] },
            },
            orderBy: { aggregateVersion: "desc" },
          });
          const observation = terminal?.payload as {
            nativeSourceKind?: unknown;
            turnStatus?: unknown;
          } | null;
          if (
            observation?.nativeSourceKind !== "turn_completed" ||
            observation.turnStatus !== "completed"
          )
            throw new DeliveryConflict("native_boundary_child_unfinished");
        } else if (attempt.outcome !== "reported" || !isInformationalStep(step)) {
          throw new DeliveryConflict("native_boundary_execution_unverified");
        }
        if (
          await tx.deliveryEvent.findFirst({
            where: {
              ownerId,
              type: "attempt_started",
              attempt: { managerBindingId: manager.id },
              payload: {
                path: ["nativeClaim", "parentTurnId"],
                equals: input.source.nextParentTurnId,
              },
            },
          })
        )
          throw new DeliveryConflict("native_boundary_turn_reused");
        const aggregateKey = `manager-boundary/${manager.id}/${manager.cursorVersion}`;
        if (
          await tx.deliveryEvent.findUnique({
            where: {
              ownerId_aggregateKey_aggregateVersion: { ownerId, aggregateKey, aggregateVersion: 1 },
            },
          })
        )
          throw new DeliveryConflict("native_boundary_already_observed");
        await tx.deliveryEvent.create({
          data: {
            id: input.eventId,
            ownerId,
            taskId: task.id,
            stepId: step.id,
            attemptId: attempt.id,
            aggregateKey,
            aggregateVersion: 1,
            type: "native_root_boundary",
            requestDigest,
            policyVersion: this.policy.version,
            payload: {
              producer,
              managerBindingId: manager.id,
              sequence: input.sequence,
              source: input.source,
            },
          },
        });
        await tx.deliveryManagerBinding.update({
          where: { id: manager.id },
          data: { nativeSequence: input.sequence },
        });
        return {
          accepted: true,
          blocked: false,
          replayed: false,
          sequence: input.sequence,
          boundaryEventId: input.eventId,
          cursorVersion: manager.cursorVersion,
          activeAttemptHeld: true,
        };
      }
      const runtimeVersion = attempt.runtimeVersion + 1;
      let payload: Prisma.InputJsonObject;
      let eventType = "native_command_observed",
        unsafe = false;
      if (input.source.kind === "started") {
        if (attempt.runtimeBindingDigest)
          return block("native_child_already_bound", input.eventId, true);
        if (input.source.childThreadId === manager.nativeThreadId)
          return block("native_child_binding_invalid", input.eventId, true);
        const user = await tx.user.findUniqueOrThrow({
          where: { id: ownerId },
          select: { coderUserId: true },
        });
        const binding = {
          coderOwnerId: user.coderUserId,
          workspaceId: manager.workspaceId,
          buildId: manager.buildId,
          serverInstanceId: manager.serverInstanceId,
          managerThreadId: manager.nativeThreadId,
          nativeThreadId: input.source.childThreadId,
          nativeTurnId: input.source.childTurnId,
          operationId: input.source.spawnCallId,
          lifetimeId: manager.serverInstanceId,
          sourceSha: attempt.sourceSha,
        };
        const bindingDigest = digest("native_binding", {
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          leaseGeneration: attempt.leaseGeneration,
          binding,
        });
        const settingsMatch =
          !!attempt.requestedModel &&
          !!attempt.requestedEffort &&
          attempt.requestedModel === input.source.requestedModel &&
          attempt.requestedEffort === input.source.requestedEffort &&
          attempt.requestedModel === input.source.effectiveModel &&
          attempt.requestedEffort === input.source.effectiveEffort;
        unsafe =
          !settingsMatch ||
          attempt.leaseExpiresAt <= timestamp ||
          attempt.outcome !== "running" ||
          step.state !== "running";
        await tx.deliveryAttempt.update({
          where: { ownerId_id: { ownerId, id: attempt.id } },
          data: {
            runtimeVersion,
            runtimeBinding: binding,
            runtimeBindingDigest: bindingDigest,
            effectiveModel: input.source.effectiveModel,
            effectiveEffort: input.source.effectiveEffort,
          },
        });
        eventType = "native_runtime_started";
        payload = {
          producer,
          nativeSourceKind: "started",
          sequence: input.sequence,
          binding,
          bindingDigest,
          settingsMatch,
          source: input.source,
        };
      } else {
        const binding = nativeRuntimeBindingSchema.safeParse(attempt.runtimeBinding);
        if (
          !binding.success ||
          binding.data.nativeThreadId !== input.source.childThreadId ||
          binding.data.nativeTurnId !== input.source.childTurnId ||
          binding.data.operationId !== input.source.spawnCallId
        )
          return block("native_child_turn_mismatch", input.eventId, true);
        await tx.deliveryAttempt.update({
          where: { ownerId_id: { ownerId, id: attempt.id } },
          data: { runtimeVersion },
        });
        payload = {
          producer,
          nativeSourceKind: input.source.kind,
          sequence: input.sequence,
          source: input.source,
        };
        if (input.source.kind === "turn_completed") {
          eventType = "native_attempt_observed";
          unsafe = input.source.status !== "completed";
          payload = {
            ...payload,
            turnStatus: input.source.status,
            schemaVersion: 1,
            bindingDigest: attempt.runtimeBindingDigest,
            remoteId: input.source.childTurnId,
            proofDigest: digest("native_turn_source", input.source),
            observedAt: input.source.observedAt,
            nativeTurn: "quiescent",
            backgroundProcesses: "unknown",
            externalOperations: "unknown",
            externalEffects: "unknown",
            ...(unsafe
              ? {
                  reason:
                    "Native child ended without successful completion; writer reconciliation remains required.",
                }
              : {}),
          };
        }
      }
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          aggregateKey: `attempt/${attempt.id}`,
          aggregateVersion: runtimeVersion,
          type: eventType,
          requestDigest,
          policyVersion: this.policy.version,
          payload,
        },
      });
      await tx.deliveryManagerBinding.update({
        where: { ownerId_id: { ownerId, id: manager.id } },
        data: {
          nativeSequence: input.sequence,
          ...(unsafe
            ? {
                blockedReason:
                  input.source.kind === "started"
                    ? "native_settings_or_lease_unverified"
                    : "native_turn_failed",
              }
            : {}),
        },
      });
      if (unsafe) {
        await this.safetyPause(tx, ownerId, task.id, input.eventId);
        await tx.deliveryOutbox.create({
          data: { ownerId, eventId: input.eventId, channel: "push" },
        });
      }
      return {
        accepted: true,
        replayed: false,
        blocked: unsafe || manager.blockedReason !== null,
        sequence: input.sequence,
        runtimeVersion,
        activeAttemptHeld: true,
      };
    });
  }

  /** Trusted host adapter only. A manager-controlled request cannot register a native writer. */
  async bindAttemptRuntime(owner: string, producer: string, value: unknown) {
    this.runtimeAuthority(producer);
    const ownerId = ownerSchema.parse(owner);
    const input = runtimeBindingRequestSchema.parse(value);
    const requestDigest = digest("native_runtime_bound", {
      producer,
      input,
      policyVersion: this.policy.version,
    });
    return this.transaction(async (tx) => {
      const { task, step, attempt } = await this.runtimeAttempt(tx, ownerId, input);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous)
        return {
          bindingDigest: attempt.runtimeBindingDigest,
          runtimeVersion: previous.aggregateVersion,
          replayed: true,
          canRun: false,
          needsReconciliation: true,
        };
      if (attempt.runtimeVersion !== input.expectedRuntimeVersion)
        throw new DeliveryConflict("runtime_version_conflict");
      if (attempt.runtimeBindingDigest) throw new DeliveryConflict("runtime_already_bound");
      const user = await tx.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { coderUserId: true },
      });
      const conversation =
        task.conversationId &&
        (await tx.deliveryConversation.findUnique({
          where: { ownerId_id: { ownerId, id: task.conversationId } },
        }));
      if (
        !conversation ||
        user.coderUserId !== input.binding.coderOwnerId ||
        conversation.projectId !== task.projectId ||
        conversation.workspaceId !== input.binding.workspaceId ||
        conversation.buildId !== input.binding.buildId ||
        conversation.serverInstanceId !== input.binding.serverInstanceId ||
        conversation.nativeThreadId !== input.binding.managerThreadId ||
        attempt.sourceSha !== input.binding.sourceSha
      )
        throw new DeliveryConflict("runtime_binding_unregistered");
      const bindingDigest = digest("native_binding", {
        ownerId,
        taskId: task.id,
        stepId: step.id,
        attemptId: attempt.id,
        leaseGeneration: attempt.leaseGeneration,
        binding: input.binding,
      });
      const runtimeVersion = attempt.runtimeVersion + 1;
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: {
          runtimeBinding: input.binding,
          runtimeBindingDigest: bindingDigest,
          runtimeVersion,
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          aggregateKey: `attempt/${attempt.id}`,
          aggregateVersion: runtimeVersion,
          type: "native_runtime_bound",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { producer, binding: input.binding, bindingDigest },
        },
      });
      const timestamp = await now(tx);
      const canRun =
        !task.pauseRequested &&
        !task.schedulingPaused &&
        step.state === "running" &&
        attempt.outcome === "running" &&
        step.leaseGeneration === attempt.leaseGeneration &&
        attempt.leaseExpiresAt > timestamp &&
        task.sourceSha === attempt.sourceSha;
      return {
        bindingDigest,
        runtimeVersion,
        replayed: false,
        canRun,
        needsReconciliation: !canRun,
      };
    });
  }

  /** A finished turn alone is insufficient: child processes and effects must be reconciled too. */
  /** Installed native observer only, never structured manager report fields. */
  async recordNativeDelegation(owner: string, producer: string, value: unknown) {
    this.runtimeAuthority(producer);
    const ownerId = ownerSchema.parse(owner);
    const input = nativeDelegationSchema.parse(value);
    const requestDigest = digest("native_delegation_observed", {
      producer,
      input,
      policyVersion: this.policy.version,
    });
    return this.transaction(async (tx) => {
      const { task, step, attempt } = await this.runtimeAttempt(tx, ownerId, input);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { runtimeVersion: previous.aggregateVersion, replayed: true };
      if (attempt.runtimeVersion !== input.expectedRuntimeVersion)
        throw new DeliveryConflict("runtime_version_conflict");
      const binding = nativeRuntimeBindingSchema.safeParse(attempt.runtimeBinding);
      if (
        !binding.success ||
        attempt.runtimeBindingDigest !== input.bindingDigest ||
        binding.data.managerThreadId !== input.managerThreadId ||
        binding.data.nativeThreadId !== input.childThreadId ||
        binding.data.operationId !== input.spawnCallId
      )
        throw new DeliveryConflict("native_delegation_binding_mismatch");
      if (
        (attempt.effectiveModel !== null && attempt.effectiveModel !== input.effectiveModel) ||
        (attempt.effectiveEffort !== null && attempt.effectiveEffort !== input.effectiveEffort)
      )
        throw new DeliveryConflict("native_settings_conflict");
      const settingsMatch =
        attempt.requestedModel !== null &&
        attempt.requestedEffort !== null &&
        input.requestedModel === attempt.requestedModel &&
        input.requestedEffort === attempt.requestedEffort &&
        input.effectiveModel === attempt.requestedModel &&
        input.effectiveEffort === attempt.requestedEffort;
      const runtimeVersion = attempt.runtimeVersion + 1;
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: {
          runtimeVersion,
          effectiveModel: input.effectiveModel,
          effectiveEffort: input.effectiveEffort,
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          aggregateKey: `attempt/${attempt.id}`,
          aggregateVersion: runtimeVersion,
          type: "native_delegation_observed",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { producer, ...input, settingsMatch },
        },
      });
      if (!settingsMatch) await this.safetyPause(tx, ownerId, task.id, input.eventId);
      return { runtimeVersion, replayed: false, settingsMatch };
    });
  }
  async observeAttemptRuntime(owner: string, producer: string, value: unknown) {
    this.runtimeAuthority(producer);
    const ownerId = ownerSchema.parse(owner);
    const input = runtimeObservationSchema.parse(value);
    const requestDigest = digest("native_attempt_observed", {
      producer,
      input,
      policyVersion: this.policy.version,
    });
    return this.transaction(async (tx) => {
      const { task, step, attempt } = await this.runtimeAttempt(tx, ownerId, input);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous)
        return {
          eventId: previous.id,
          runtimeVersion: previous.aggregateVersion,
          replayed: true,
          canRetry: false,
        };
      if (attempt.runtimeVersion !== input.expectedRuntimeVersion)
        throw new DeliveryConflict("runtime_version_conflict");
      if (!attempt.runtimeBindingDigest || attempt.runtimeBindingDigest !== input.bindingDigest)
        throw new DeliveryConflict("runtime_binding_mismatch");
      const timestamp = await now(tx);
      if (
        input.observedAt > timestamp ||
        timestamp.getTime() - input.observedAt.getTime() >
          (this.policy.maxRuntimeObservationAgeMs ?? 60_000)
      )
        throw new DeliveryConflict("stale_runtime_observation");
      const payload = runtimeObservationPayloadSchema.parse({
        schemaVersion: 1,
        producer,
        bindingDigest: input.bindingDigest,
        remoteId: input.remoteId,
        proofDigest: input.proofDigest,
        nativeTurn: input.nativeTurn,
        backgroundProcesses: input.backgroundProcesses,
        externalOperations: input.externalOperations,
        externalEffects: input.externalEffects,
        observedAt: input.observedAt.toISOString(),
      });
      const quiescent =
        payload.nativeTurn === "quiescent" &&
        payload.backgroundProcesses === "quiescent" &&
        payload.externalOperations === "quiescent" &&
        payload.externalEffects === "none";
      const runtimeVersion = attempt.runtimeVersion + 1;
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: {
          runtimeVersion,
          ...(quiescent && !attempt.quiescedAt ? { quiescedAt: timestamp } : {}),
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          aggregateKey: `attempt/${attempt.id}`,
          aggregateVersion: runtimeVersion,
          type: quiescent ? "native_attempt_quiescent" : "native_attempt_observed",
          requestDigest,
          policyVersion: this.policy.version,
          payload,
        },
      });
      if (attempt.quiescedAt && !quiescent) {
        // Later contradictory facts halt scheduling; old accepted reports stay immutable.
        await this.safetyPause(tx, ownerId, task.id, input.eventId);
        await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      }
      await this.refreshPause(tx, ownerId, task.id);
      return { eventId: input.eventId, runtimeVersion, replayed: false, canRetry: false };
    });
  }

  /** Expiry is released only by a trusted adapter referencing its accepted terminal proof. */
  async reconcileExpiredAttempt(owner: string, producer: string, value: unknown) {
    this.runtimeAuthority(producer);
    const ownerId = ownerSchema.parse(owner);
    const input = expiredAttemptReconciliationSchema.parse(value);
    const requestDigest = digest("expired_attempt_reconciled", {
      producer,
      input,
      policyVersion: this.policy.version,
    });
    return this.transaction(async (tx) => {
      const { task, step, attempt } = await this.runtimeAttempt(tx, ownerId, input);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      const latestAttempt = await tx.deliveryAttempt.findFirst({
        where: { ownerId, stepId: step.id },
        orderBy: { leaseGeneration: "desc" },
      });
      const timestamp = await now(tx);
      if (
        latestAttempt?.id !== attempt.id ||
        attempt.outcome !== "running" ||
        !["running", "waiting_external", "blocked"].includes(step.state)
      )
        throw new DeliveryConflict("stale_attempt");
      if (attempt.leaseExpiresAt > timestamp) throw new DeliveryConflict("lease_not_expired");
      const proof = await tx.deliveryEvent.findFirst({
        where: {
          ownerId,
          taskId: task.id,
          stepId: step.id,
          attemptId: attempt.id,
          type: { in: ["native_attempt_quiescent", "native_attempt_observed"] },
        },
        orderBy: { aggregateVersion: "desc" },
      });
      const parsedProof = runtimeObservationPayloadSchema.safeParse(proof?.payload);
      if (
        !proof ||
        proof.id !== input.quiescenceEventId ||
        !parsedProof.success ||
        !this.proofQuiescent(attempt, {
          policyVersion: proof.policyVersion,
          payload: proof.payload,
        }) ||
        timestamp.getTime() - new Date(parsedProof.data.observedAt).getTime() >
          (this.policy.maxRuntimeObservationAgeMs ?? 60_000)
      )
        throw new DeliveryConflict("native_not_quiescent");
      const version = step.version + 1;
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: { outcome: "expired_quiescent", finishedAt: timestamp },
      });
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: {
          state: "failed",
          waitingReason: input.reason,
          version,
          leaseGeneration: { increment: 1 },
        },
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
          type: "expired_attempt_reconciled",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { producer, quiescenceEventId: proof.id, reason: input.reason },
        },
      });
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      await this.refreshPause(tx, ownerId, task.id);
      return { version, replayed: false };
    });
  }

  async failAttempt(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = attemptFailureSchema.parse(value);
    const requestDigest = digest("attempt_failed", input);
    return this.transaction(async (tx) => {
      const { task, step, attempt } = await this.runtimeAttempt(tx, ownerId, input);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      const timestamp = await now(tx);
      if (
        !["running", "waiting_external"].includes(step.state) ||
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
      if (
        evidence.length !== input.evidenceIds.length ||
        evidence.some(
          (proof) =>
            proof.sourceSha !== task.sourceSha ||
            proof.invalidatedAt !== null ||
            proof.policyVersion !== this.policy.version ||
            !this.policy.trustedProducers.includes(proof.producer),
        )
      )
        throw new DeliveryConflict("invalid_evidence");
      const version = step.version + 1;
      await tx.deliveryAttempt.update({
        where: { ownerId_id: { ownerId, id: attempt.id } },
        data: { outcome: input.disposition, finishedAt: timestamp },
      });
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: {
          state: input.disposition,
          waitingReason: input.reason,
          version,
          leaseGeneration: { increment: 1 },
        },
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
          type: input.disposition === "failed" ? "attempt_failed" : "attempt_blocked",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { reason: input.reason },
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
      if (input.evidenceIds.length)
        await tx.deliveryReportEvidence.createMany({
          data: input.evidenceIds.map((evidenceId) => ({
            ownerId,
            stepId: step.id,
            reportId: report.id,
            evidenceId,
          })),
        });
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      await this.refreshPause(tx, ownerId, task.id);
      return { version, replayed: false };
    });
  }

  async blockStep(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = stepControlSchema.parse(value);
    const requestDigest = digest("step_blocked", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      if (["succeeded", "reported", "canceled"].includes(step.state))
        throw new DeliveryConflict("invalid_transition");
      const version = step.version + 1;
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: {
          state: "blocked",
          waitingReason: input.reason,
          version,
          ...(["running", "waiting_external"].includes(step.state)
            ? { leaseGeneration: { increment: 1 } }
            : {}),
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          aggregateKey: `step/${step.id}`,
          aggregateVersion: version,
          type: "step_blocked",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { reason: input.reason },
        },
      });
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      await this.refreshPause(tx, ownerId, task.id);
      return { version, replayed: false };
    });
  }

  async retryStep(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = stepControlSchema.parse(value);
    const requestDigest = digest("step_retry_requested", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
        include: { dependencies: { include: { dependsOn: true } } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      if (task.pauseRequested || task.schedulingPaused) throw new DeliveryConflict("task_paused");
      if (!["failed", "blocked"].includes(step.state))
        throw new DeliveryConflict("explicit_reopen_required");
      if (step.attemptCount >= step.attemptBudget)
        throw new DeliveryConflict("attempt_budget_exhausted");
      if ((await this.pendingWriters(tx, ownerId, task.id, [step.id])).length)
        throw new DeliveryConflict("native_not_quiescent");
      const active = await tx.deliveryAttempt.count({
        where: { ownerId, stepId: step.id, outcome: "running" },
      });
      if (active) throw new DeliveryConflict("attempt_reconciliation_required");
      const version = step.version + 1;
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: {
          state: step.dependencies.every((edge) => dependencySatisfied(edge.dependsOn))
            ? "ready"
            : "pending",
          waitingReason: null,
          version,
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          aggregateKey: `step/${step.id}`,
          aggregateVersion: version,
          type: "step_retry_requested",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { reason: input.reason },
        },
      });
      return { version, replayed: false };
    });
  }

  private async invalidateSteps(
    tx: Transaction,
    ownerId: string,
    taskId: string,
    ids: Set<string>,
    causeEventId: string,
    reason: string,
    pendingIds = ids,
  ) {
    const timestamp = await now(tx);
    const steps = await tx.deliveryStep.findMany({
      where: { ownerId, taskId },
      include: { dependencies: true },
    });
    const held = new Set(
      (await this.pendingWriters(tx, ownerId, taskId, [...ids])).map((attempt) => attempt.stepId),
    );
    const invalidated = await tx.deliveryEvidence.updateMany({
      where: { ownerId, stepId: { in: [...ids] }, invalidatedAt: null },
      data: { invalidatedAt: timestamp },
    });
    await tx.deliveryAttempt.updateMany({
      where: { ownerId, stepId: { in: [...ids] }, outcome: "running" },
      data: { outcome: "superseded", finishedAt: timestamp },
    });
    for (const step of steps) {
      if (!ids.has(step.id)) continue;
      const dependenciesDone = step.dependencies.every(
        (edge) =>
          !pendingIds.has(edge.dependsOnStepId) &&
          steps.some(
            (candidate) => candidate.id === edge.dependsOnStepId && dependencySatisfied(candidate),
          ),
      );
      const state =
        step.state === "canceled"
          ? "canceled"
          : held.has(step.id)
            ? "blocked"
            : dependenciesDone
              ? "ready"
              : "pending";
      const waitingReason = held.has(step.id)
        ? `Previous native execution requires reconciliation: ${reason}`.slice(0, 1000)
        : null;
      const version = step.version + 1;
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: {
          state,
          waitingReason,
          version,
          leaseGeneration: { increment: 1 },
          reopenGeneration: { increment: 1 },
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId,
          taskId,
          stepId: step.id,
          aggregateKey: `step/${step.id}`,
          aggregateVersion: version,
          type: "step_invalidated",
          requestDigest: digest("step_invalidated", { causeEventId, stepId: step.id, reason }),
          policyVersion: this.policy.version,
          payload: { causeEventId, reason },
        },
      });
    }
    return { invalidatedEvidenceCount: invalidated.count, held: held.size > 0 };
  }

  async reopenStep(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = stepControlSchema.parse(value);
    const requestDigest = digest("step_reopened", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      const step = await tx.deliveryStep.findUnique({
        where: { ownerId_taskId_id: { ownerId, taskId: task.id, id: input.stepId } },
      });
      if (!step) throw new DeliveryConflict("step_not_found");
      if (step.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      if (!["succeeded", "reported"].includes(step.state))
        throw new DeliveryConflict("invalid_transition");
      const edges = await tx.deliveryStepDependency.findMany({
        where: { ownerId, taskId: task.id },
      });
      const affected = dependentClosure([step.id], edges);
      // Root event uses the caller's digest for safe replay; descendants use their
      // own versions and retain immutable reports from earlier completions.
      const timestamp = await now(tx);
      const held = (await this.pendingWriters(tx, ownerId, task.id, [...affected])).length > 0;
      await tx.deliveryEvidence.updateMany({
        where: { ownerId, stepId: step.id, invalidatedAt: null },
        data: { invalidatedAt: timestamp },
      });
      const descendants = new Set([...affected].filter((id) => id !== step.id));
      if (descendants.size)
        await this.invalidateSteps(
          tx,
          ownerId,
          task.id,
          descendants,
          input.eventId,
          input.reason,
          affected,
        );
      await tx.deliveryStep.update({
        where: { ownerId_id: { ownerId, id: step.id } },
        data: {
          state: held ? "blocked" : "ready",
          waitingReason: held ? "Previous native execution requires reconciliation." : null,
          version: { increment: 1 },
          leaseGeneration: { increment: 1 },
          reopenGeneration: { increment: 1 },
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          stepId: step.id,
          aggregateKey: `step/${step.id}`,
          aggregateVersion: step.version + 1,
          type: "step_reopened",
          requestDigest,
          policyVersion: this.policy.version,
          payload: { reason: input.reason, affectedSteps: [...affected] },
        },
      });
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      if (held) await this.safetyPause(tx, ownerId, task.id, input.eventId);
      await this.refreshPause(tx, ownerId, task.id);
      return { version: step.version + 1, replayed: false };
    });
  }

  async changeSource(owner: string, value: unknown) {
    const ownerId = ownerSchema.parse(owner);
    const input = sourceChangeSchema.parse(value);
    const requestDigest = digest("source_changed", input);
    return this.transaction(async (tx) => {
      const task = await lockTask(tx, ownerId, input.taskId);
      const previous = await replay(tx, ownerId, input.eventId, requestDigest);
      if (previous) return { version: previous.aggregateVersion, replayed: true };
      if (task.version !== input.expectedVersion) throw new DeliveryConflict("version_conflict");
      if (task.sourceSha === input.sourceSha) throw new DeliveryConflict("source_unchanged");
      const steps = await tx.deliveryStep.findMany({
        where: { ownerId, taskId: task.id },
        select: { id: true },
      });
      const invalidated = await this.invalidateSteps(
        tx,
        ownerId,
        task.id,
        new Set(steps.map((step) => step.id)),
        input.eventId,
        input.reason,
      );
      const version = task.version + 1;
      await tx.deliveryTask.update({
        where: { ownerId_id: { ownerId, id: task.id } },
        data: {
          sourceSha: input.sourceSha,
          version,
          pauseRequested: true,
          schedulingPaused: false,
        },
      });
      await tx.deliveryEvent.create({
        data: {
          id: input.eventId,
          ownerId,
          taskId: task.id,
          aggregateKey: `task/${task.id}`,
          aggregateVersion: version,
          type: "source_changed",
          requestDigest,
          policyVersion: this.policy.version,
          payload: {
            previousSourceSha: task.sourceSha,
            sourceSha: input.sourceSha,
            reason: input.reason,
            invalidatedEvidenceCount: invalidated.invalidatedEvidenceCount,
          },
        },
      });
      await tx.deliveryOutbox.create({ data: { ownerId, eventId: input.eventId } });
      await this.refreshPause(tx, ownerId, task.id);
      return { version, replayed: false };
    });
  }
}
