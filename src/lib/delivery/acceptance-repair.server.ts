import { randomUUID } from "node:crypto";
import type { Prisma } from "@hive/db";
import { requireAppliedSourceForAction } from "@/lib/codex-session/guardian-application-gate.server";
import { acceptanceDeploymentConfig } from "./acceptance-config.server";
import {
  acceptanceDigest,
  acceptanceJobScopeSchema,
  acceptanceReviewResultSchema,
} from "./acceptance-contracts";
import type { AcceptanceMaterialResolver } from "./acceptance-material.server";
import {
  MAX_AUTOMATIC_REPAIRS,
  type RepairReservation,
  repairReservationSchema,
} from "./acceptance-repair-contracts";
import type { AcceptanceAuthority, AcceptanceStore } from "./acceptance-store.server";
import { repositoryGateDescriptors } from "./repository-policy-contracts";
import { assertCompletionEvidence, DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const aggregate = (attemptId: string) => `acceptance-repair/${attemptId}`;
function check(condition: unknown, reason = "acceptance_repair_scope_changed"): asserts condition {
  if (!condition) throw new DeliveryConflict(reason);
}
export function repairStepDigest(
  step: {
    id: string;
    taskId: string;
    kind: string;
    criterionIds: string[];
    requiredEvidenceKinds: string[];
    acceptancePhase: string;
    attemptBudget: number;
  },
  dependencies: string[],
) {
  return acceptanceDigest({
    id: step.id,
    taskId: step.taskId,
    kind: step.kind,
    criterionIds: step.criterionIds,
    requiredEvidenceKinds: step.requiredEvidenceKinds,
    acceptancePhase: step.acceptancePhase,
    attemptBudget: step.attemptBudget,
    dependencies: [...dependencies].sort(),
  });
}
/** Factual immutable reservation read. Positive uses must also check current
 * producer, task/source, original step, budget and the consumed boundary. */
export async function loadRepairReservation(tx: Tx, ownerId: string, attemptId: string) {
  const event = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId,
        aggregateKey: aggregate(attemptId),
        aggregateVersion: 1,
      },
    },
  });
  if (!event) return null;
  const value = repairReservationSchema.parse(event.payload);
  check(
    event.type === "acceptance_repair_reserved" &&
      event.id === value.repairId &&
      event.ownerId === value.ownerId &&
      value.ownerId === ownerId &&
      event.attemptId === attemptId &&
      value.attemptId === attemptId &&
      event.taskId === value.taskId &&
      event.stepId === value.stepId &&
      event.requestDigest === acceptanceDigest(value) &&
      value.feedbackDigest === acceptanceDigest(value.feedback),
  );
  return value;
}
export async function currentRepairReservation(
  tx: Tx,
  ownerId: string,
  managerBindingId: string,
  attemptId: string,
  options: { ready?: boolean; stepId?: string } = {},
) {
  const value = await loadRepairReservation(tx, ownerId, attemptId);
  if (!value) return null;
  const configured = acceptanceDeploymentConfig();
  check(
    configured && acceptanceDigest(configured) === value.producerDigest,
    "acceptance_repair_disabled",
  );
  const policy = await tx.deliveryTaskPolicyBinding.findUniqueOrThrow({
    where: { ownerId_taskId: { ownerId, taskId: value.taskId } },
    include: { version: { include: { parent: true } } },
  });
  await tx.$queryRaw`SELECT id FROM delivery_repository_policies WHERE id=${policy.version.policyId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM delivery_repository_policy_versions WHERE id=${policy.policyVersionId}::uuid FOR SHARE`;
  check(
    policy.intentId === value.preparationIntentId &&
      policy.projectId === value.projectId &&
      policy.policyDigest === value.policyDigest &&
      !policy.version.revokedAt &&
      !policy.version.parent.revokedAt,
    "acceptance_repair_policy_changed",
  );
  const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: managerBindingId } },
  });
  const task = await tx.deliveryTask.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: value.taskId } },
  });
  const attempt = await tx.deliveryAttempt.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: attemptId } },
    include: { step: { include: { dependencies: true } } },
  });
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  check(
    binding.currentAttemptId === attemptId &&
      binding.id === value.managerBindingId &&
      binding.nativeThreadId === value.managerThreadId &&
      binding.serverInstanceId === value.serverInstanceId &&
      binding.cursorVersion === value.cursorVersion &&
      !binding.blockedReason &&
      binding.preparationIntentId === value.preparationIntentId &&
      task.managerBindingId === binding.id &&
      task.projectId === value.projectId &&
      !task.pauseRequested &&
      !task.schedulingPaused &&
      task.sourceRevisionId === value.sourceContext.revisionId &&
      task.sourceVersion === value.sourceContext.version &&
      task.sourceSha === value.sourceContext.headSha &&
      attempt.managerBindingId === binding.id &&
      attempt.outcome === "failed" &&
      attempt.outputRevisionId === task.sourceRevisionId &&
      attempt.leaseGeneration === value.leaseGeneration &&
      attempt.leaseExpiresAt.getTime() === value.leaseExpiresAt &&
      value.leaseExpiresAt > now.getTime() &&
      attempt.stepId === value.stepId &&
      (!options.stepId || options.stepId === value.stepId) &&
      repairStepDigest(
        attempt.step,
        attempt.step.dependencies.map((d) => d.dependsOnStepId),
      ) === value.stepDigest,
  );
  const ready = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId,
        aggregateKey: aggregate(attemptId),
        aggregateVersion: 2,
      },
    },
  });
  if (options.ready)
    check(ready?.type === "acceptance_repair_ready" && attempt.step.state === "ready");
  else check(["failed", "ready"].includes(attempt.step.state));
  check(
    !(await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId,
          aggregateKey: `repair-consumed/${value.repairId}`,
          aggregateVersion: 1,
        },
      },
    })),
    "acceptance_repair_consumed",
  );
  return value;
}
export class AcceptanceRepairController {
  constructor(
    private readonly material: AcceptanceMaterialResolver,
    private readonly store: AcceptanceStore,
  ) {}
  async prepare(tx: Tx, authority: AcceptanceAuthority, managerBindingId: string) {
    const configured = acceptanceDeploymentConfig();
    check(
      configured && acceptanceDigest(configured) === this.store.producerDigest,
      "acceptance_repair_disabled",
    );
    const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: authority.ownerId, id: managerBindingId } },
    });
    check(binding.currentAttemptId);
    const existing = await loadRepairReservation(tx, authority.ownerId, binding.currentAttemptId);
    if (existing) {
      check(
        existing.registrationId === authority.registrationId &&
          existing.producerDigest === this.store.producerDigest,
      );
      await currentRepairReservation(tx, authority.ownerId, binding.id, binding.currentAttemptId);
      return this.response(existing, "reserved");
    }
    const current = await this.material.current(tx, authority.ownerId, managerBindingId);
    const { attempt, bound, revision, plan, content, facts } = current;
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_tasks WHERE owner_id=${authority.ownerId}::uuid AND id=${bound.task.id}::uuid FOR UPDATE`;
    check(
      locked.length === 1 &&
        binding.id === current.binding.id &&
        binding.currentAttemptId === attempt.id &&
        binding.cursorVersion > 0 &&
        !binding.blockedReason &&
        attempt.outputRevisionId === revision.id &&
        ((attempt.outcome === "running" &&
          ["running", "waiting_external"].includes(attempt.step.state) &&
          attempt.step.leaseGeneration === attempt.leaseGeneration) ||
          (attempt.outcome === "failed" &&
            attempt.step.state === "failed" &&
            attempt.step.leaseGeneration === attempt.leaseGeneration + 1)) &&
        ["implement", "review", "validate"].includes(attempt.step.kind) &&
        attempt.step.acceptancePhase === "implementation_preview" &&
        !attempt.step.requiredEvidenceKinds.some((kind) =>
          ["change", "migration"].includes(kind),
        ) &&
        plan.producerDigest === this.store.producerDigest,
    );
    const requirements = content.requirements.filter((r) => current.criterionIds.includes(r.id));
    const checkCriteria = new Set(
      repositoryGateDescriptors(bound.policy.evidenceGates)
        .filter((g) => g.kind === "check")
        .flatMap((g) => g.criteria),
    );
    const observedNow = (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const failures = facts.filter(
      (f) =>
        Date.parse(f.observedAt) <= observedNow &&
        observedNow - Date.parse(f.observedAt) <= current.policy.policy.maxAgeMs &&
        f.kind === "check" &&
        f.status === "failed" &&
        f.criterionIds.some((id) => checkCriteria.has(id)),
    );
    const jobs = await tx.deliveryAcceptanceJob.findMany({
      where: {
        ownerId: authority.ownerId,
        intentId: authority.preparationIntentId,
        kind: "review",
        phase: "completed",
        producerDigest: this.store.producerDigest,
      },
      orderBy: { completedAt: "desc" },
      take: 16,
    });
    const review = jobs.find((j) => {
      const scope = acceptanceJobScopeSchema.parse(j.scope);
      return (
        scope.attemptId === attempt.id &&
        scope.sourceRevisionId === revision.id &&
        scope.sourceSha === revision.headSha &&
        scope.sourceVersion === revision.version &&
        scope.planDigest === plan.planDigest &&
        scope.evidenceDigest === acceptanceDigest(facts)
      );
    });
    const result = review ? acceptanceReviewResultSchema.parse(review.result) : null;
    if (!failures.length && result?.outcome === "pass") {
      const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
      try {
        for (const gate of repositoryGateDescriptors(bound.policy.evidenceGates))
          assertCompletionEvidence({
            ownerId: authority.ownerId,
            stepId: attempt.stepId,
            sourceSha: revision.headSha,
            acceptancePhase: attempt.step.acceptancePhase as "implementation_preview",
            criterionIds: gate.criteria,
            requiredKinds: [gate.kind],
            policyVersion: current.policy.policy.version,
            trustedProducers: current.policy.policy.trustedProducers,
            now,
            maxAgeMs: current.policy.policy.maxAgeMs,
            evidence: current.evidence,
          });
        return {
          phase: "passed",
          jobId: review?.id,
          resultDigest: review?.resultDigest,
          executionAuthorized: false,
        };
      } catch (error) {
        if (!(error instanceof DeliveryConflict)) throw error;
      }
    }
    if (!failures.length && result?.outcome !== "fail")
      return {
        phase: result?.outcome === "insufficient" ? "held" : "waiting",
        reason:
          result?.outcome === "insufficient"
            ? "acceptance_context_unavailable"
            : "independent_checks_pending",
        executionAuthorized: false,
      };
    const count = await tx.deliveryEvent.count({
      where: {
        ownerId: authority.ownerId,
        taskId: bound.task.id,
        stepId: attempt.stepId,
        type: "acceptance_repair_reserved",
      },
    });
    check(
      count < MAX_AUTOMATIC_REPAIRS && attempt.step.attemptCount < attempt.step.attemptBudget,
      "acceptance_repair_budget_exhausted",
    );
    const claim = await tx.deliveryEvent.findFirstOrThrow({
      where: { ownerId: authority.ownerId, attemptId: attempt.id, type: "attempt_started" },
    });
    const native = (
      claim.payload as {
        nativeClaim: { parentTurnId: string; managerThreadId: string; cursorVersion: number };
      }
    ).nativeClaim;
    check(
      native.managerThreadId === authority.managerThreadId &&
        native.cursorVersion === binding.cursorVersion,
    );
    const dependencies = await tx.deliveryStepDependency.findMany({
      where: { ownerId: authority.ownerId, stepId: attempt.stepId },
    });
    const feedback: RepairReservation["feedback"] = {
      reason: failures.length ? "required_check_failed" : "semantic_review_failed",
      reviewJobId: review?.id ?? null,
      reviewResultDigest: review?.resultDigest ?? null,
      requirements: requirements.map((r) => ({
        id: r.id,
        meaning: r.meaning,
        observation:
          result?.requirements.find((o) => o.id === r.id)?.rationale ??
          "A required independently observed check failed. Reproduce the current source failure locally; preserve this requirement.",
      })),
      failedEvidence: failures.map((f) => ({
        id: f.id,
        contentDigest: f.contentDigest,
        criterionIds: f.criterionIds,
      })),
    };
    const value = repairReservationSchema.parse({
      schemaVersion: 1,
      repairId: randomUUID(),
      ownerId: authority.ownerId,
      projectId: authority.projectId,
      taskId: bound.task.id,
      stepId: attempt.stepId,
      attemptId: attempt.id,
      managerBindingId,
      preparationIntentId: authority.preparationIntentId,
      registrationId: authority.registrationId,
      serverInstanceId: authority.serverInstanceId,
      managerThreadId: authority.managerThreadId,
      parentTurnId: native.parentTurnId,
      cursorVersion: binding.cursorVersion,
      leaseGeneration: attempt.leaseGeneration,
      leaseExpiresAt: attempt.leaseExpiresAt.getTime(),
      sourceContext: {
        revisionId: revision.id,
        version: revision.version,
        headSha: revision.headSha,
      },
      publicationOperationId: revision.operationId,
      stepDigest: repairStepDigest(
        attempt.step,
        dependencies.map((d) => d.dependsOnStepId),
      ),
      planDigest: plan.planDigest,
      policyDigest: bound.binding.policyDigest,
      producerDigest: this.store.producerDigest,
      feedbackDigest: acceptanceDigest(feedback),
      feedback,
      reportId: randomUUID(),
      ordinal: count + 1,
    });
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    check(attempt.leaseExpiresAt > now, "acceptance_repair_lease_expired");
    await tx.deliveryEvent.create({
      data: {
        id: value.repairId,
        ownerId: value.ownerId,
        taskId: value.taskId,
        stepId: value.stepId,
        attemptId: value.attemptId,
        aggregateKey: aggregate(value.attemptId),
        aggregateVersion: 1,
        type: "acceptance_repair_reserved",
        policyVersion: "acceptance-repair-v1",
        requestDigest: acceptanceDigest(value),
        payload: json(value),
      },
    });
    await tx.deliveryStepReport.create({
      data: {
        id: value.reportId,
        ownerId: value.ownerId,
        stepId: value.stepId,
        attemptId: value.attemptId,
        eventId: value.repairId,
        summary: "Independent evidence requires a bounded repair of this exact candidate.",
        difficulty: "unknown",
        difficultyReason: "Controller records observed failure, not a model estimate.",
        issues: json(feedback),
        remainingUncertainty:
          "No execution or physical-writer quiescence is attested by this reservation.",
        nextAction:
          "Apply the accepted source under the existing input barrier, then request the same-step repair claim.",
      },
    });
    if (attempt.outcome === "running")
      await tx.deliveryAttempt.update({
        where: { id: attempt.id },
        data: { outcome: "failed", finishedAt: now },
      });
    await tx.deliveryStep.update({
      where: { id: attempt.stepId },
      data: {
        state: "failed",
        waitingReason: "independent_acceptance_repair",
        version: { increment: 1 },
        ...(attempt.outcome === "running" ? { leaseGeneration: { increment: 1 } } : {}),
      },
    });
    await tx.deliveryOutbox.create({ data: { ownerId: value.ownerId, eventId: value.repairId } });
    return this.response(value, "reserved");
  }
  async ready(tx: Tx, authority: AcceptanceAuthority, managerBindingId: string, repairId: string) {
    const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: authority.ownerId, id: managerBindingId } },
    });
    check(binding.currentAttemptId);
    const value = await currentRepairReservation(
      tx,
      authority.ownerId,
      managerBindingId,
      binding.currentAttemptId,
    );
    check(
      value &&
        value.repairId === repairId &&
        value.registrationId === authority.registrationId &&
        value.serverInstanceId === authority.serverInstanceId &&
        value.producerDigest === this.store.producerDigest,
    );
    await requireAppliedSourceForAction(tx, {
      ownerId: authority.ownerId,
      managerBindingId,
      taskId: value.taskId,
      action: "execution",
    });
    const prior = await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId: authority.ownerId,
          aggregateKey: aggregate(value.attemptId),
          aggregateVersion: 2,
        },
      },
    });
    if (!prior) {
      await tx.deliveryStep.update({
        where: { id: value.stepId },
        data: { state: "ready", waitingReason: null, version: { increment: 1 } },
      });
      await tx.deliveryEvent.create({
        data: {
          id: randomUUID(),
          ownerId: value.ownerId,
          taskId: value.taskId,
          stepId: value.stepId,
          attemptId: value.attemptId,
          aggregateKey: aggregate(value.attemptId),
          aggregateVersion: 2,
          type: "acceptance_repair_ready",
          policyVersion: "acceptance-repair-v1",
          requestDigest: acceptanceDigest({ repairId }),
          payload: { repairId },
        },
      });
    }
    const step = await tx.deliveryStep.findUniqueOrThrow({ where: { id: value.stepId } });
    return {
      ...this.response(value, "ready"),
      expectedVersion: step.version,
      attemptBudgetRemaining: step.attemptBudget - step.attemptCount,
    };
  }
  private response(value: RepairReservation, phase: "reserved" | "ready") {
    return {
      phase,
      reservation: value,
      eventId: value.repairId,
      reportId: value.reportId,
      executionAuthorized: false,
      publicationAuthorized: false,
      cleanupAuthorized: false,
    };
  }
}

/** Historical failed cohort member remains a physical writer. This function
 * recognizes only a ready, controller-reserved repair in this same binding; it
 * does not mark the writer quiescent or permit a different checkout. */
export async function repairWriterHeld(
  tx: Tx,
  ownerId: string,
  managerBindingId: string,
  attemptId: string,
) {
  const value = await loadRepairReservation(tx, ownerId, attemptId);
  if (!value || value.managerBindingId !== managerBindingId) return false;
  const ready = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId,
        aggregateKey: aggregate(attemptId),
        aggregateVersion: 2,
      },
    },
  });
  if (ready?.type !== "acceptance_repair_ready") return false;
  const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
    where: { ownerId_id: { ownerId, id: managerBindingId } },
  });
  if (binding.currentAttemptId === attemptId)
    return !!(await currentRepairReservation(tx, ownerId, managerBindingId, attemptId, {
      ready: true,
    }));
  const consumed = await tx.deliveryEvent.findUnique({
    where: {
      ownerId_aggregateKey_aggregateVersion: {
        ownerId,
        aggregateKey: `repair-consumed/${value.repairId}`,
        aggregateVersion: 1,
      },
    },
  });
  if (
    !consumed ||
    consumed.type !== "acceptance_repair_consumed" ||
    consumed.taskId !== value.taskId ||
    consumed.stepId !== value.stepId ||
    !consumed.attemptId
  )
    return false;
  const payload = consumed.payload as { repairId?: string; claimEventId?: string };
  if (
    payload.repairId !== value.repairId ||
    !payload.claimEventId ||
    consumed.requestDigest !== acceptanceDigest(payload)
  )
    return false;
  const claim = await tx.deliveryEvent.findUnique({
    where: { ownerId_id: { ownerId, id: payload.claimEventId } },
  });
  const next = await tx.deliveryAttempt.findUnique({
    where: { ownerId_id: { ownerId, id: consumed.attemptId } },
  });
  return (
    claim?.type === "attempt_started" &&
    claim.taskId === value.taskId &&
    claim.stepId === value.stepId &&
    claim.attemptId === next?.id &&
    next?.managerBindingId === managerBindingId &&
    next.sourceSha === value.sourceContext.headSha
  );
}
