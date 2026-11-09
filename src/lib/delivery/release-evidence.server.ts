import type { Prisma } from "@hive/db";
import {
  acceptanceEvidenceProducer,
  acceptancePlanForIntent,
  bindAcceptanceTask,
} from "./acceptance-policy.server";
import type { ManagerPolicyScope } from "./manager.server";
import { repositoryPolicyAdapters } from "./repository-policy.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { resolveAttemptSource, resolveTaskSource } from "./source-resolver.server";
import { assertCompletionEvidence, DeliveryConflict, isInformationalStep } from "./state";

/** Locked exact-source semantic acceptance and repository CI/review authority.
 * The same policy adapters and provenance validators used by the release
 * candidate read are applied again at each journal authorization. */
export async function verifyReleaseEvidence(
  tx: Prisma.TransactionClient,
  store: RepositoryPolicyStore,
  scope: {
    ownerId: string;
    taskId: string;
    sourceSha: string;
    /** Only premerge callers may select the implementation milestone. Omission
     * verifies the entire task, including production acceptance. */
    milestone?: "implementation_preview" | "task_complete";
  },
  /** Internal receipt projection only. Never pass this at an execution boundary. */
  history?: { pausedReceiptOnly: true },
) {
  try {
    const task = await tx.deliveryTask.findUnique({
      where: { ownerId_id: { ownerId: scope.ownerId, id: scope.taskId } },
      include: { project: true, steps: { orderBy: { id: "asc" } } },
    });
    if (!task || (!history?.pausedReceiptOnly && (task.pauseRequested || task.schedulingPaused)))
      return false;
    const source = await resolveTaskSource(tx, scope.ownerId, scope.taskId);
    if (
      !source.context ||
      !source.task.currentSourceRevision ||
      !source.task.managerBinding ||
      source.headSha !== scope.sourceSha
    )
      return false;
    await resolveAttemptSource(
      tx,
      scope.ownerId,
      scope.taskId,
      source.task.currentSourceRevision.producingAttemptId,
    );
    const bound = await store.resolveTask(tx, scope.ownerId, scope.taskId);
    if (
      !bound ||
      bound.task.sourceRevisionId !== source.context.revisionId ||
      bound.task.sourceSha !== scope.sourceSha
    )
      return false;
    const acceptance = await acceptancePlanForIntent(tx, scope.ownerId, bound.binding.intentId);
    const actionable = task.steps.filter((step) => !isInformationalStep(step));
    if (
      !acceptance ||
      actionable.length === 0 ||
      actionable.some(
        (step) =>
          !["implementation_preview", "activation_production"].includes(step.acceptancePhase),
      ) ||
      (scope.milestone !== undefined &&
        !["implementation_preview", "task_complete"].includes(scope.milestone))
    )
      return false;
    const selected =
      scope.milestone === "implementation_preview"
        ? actionable.filter((step) => step.acceptancePhase === "implementation_preview")
        : actionable;
    if (
      (scope.milestone === "implementation_preview" &&
        actionable.some(
          (step) =>
            step.acceptancePhase === "activation_production" &&
            ["failed", "canceled"].includes(step.state),
        )) ||
      selected.length === 0 ||
      (scope.milestone === "implementation_preview" &&
        !acceptance.plan.requirements.some(
          (requirement) => requirement.phase === "implementation_preview",
        ))
    )
      return false;
    // The premerge milestone defers production completion, never production
    // plan coverage. Revalidate every immutable requirement before selecting
    // evidence, including requirements outside this milestone.
    await bindAcceptanceTask(tx, scope.ownerId, scope.taskId, bound.binding.intentId);
    const semanticProducer = acceptanceEvidenceProducer(acceptance.digest);
    const adapters = repositoryPolicyAdapters(store),
      now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    for (const step of selected) {
      if (step.state !== "succeeded") return false;
      const policyScope: ManagerPolicyScope = {
        ownerId: scope.ownerId,
        taskId: task.id,
        stepId: step.id,
        projectId: task.projectId,
        repositoryId: task.project.providerRepositoryId,
        providerAccountId: task.project.providerAccountId,
        fullName: task.project.fullName,
        sourceSha: scope.sourceSha,
        branch: task.branch,
        managerBindingId: source.task.managerBinding.id,
        checkoutBindingDigest: source.task.managerBinding.bindingDigest,
        stepKind: step.kind,
        criterionIds: step.criterionIds,
        requiredEvidenceKinds: step.requiredEvidenceKinds,
        acceptancePhase: step.acceptancePhase,
        sourceRevisionId: source.context.revisionId,
        sourceVersion: source.context.version,
        sourcePullNumber: source.task.currentSourceRevision.pullNumber,
      };
      const policy = await adapters.resolveEvidencePolicy(policyScope, tx);
      if (!policy?.mandatoryRepositoryGates || policy.pendingRequirements?.length) return false;
      const evidence = await tx.deliveryEvidence.findMany({
        where: {
          ownerId: scope.ownerId,
          stepId: step.id,
          sourceSha: scope.sourceSha,
          policyVersion: policy.policy.version,
          producer: { in: [...policy.policy.trustedProducers] },
          invalidatedAt: null,
          status: "passed",
        },
        take: 41,
      });
      if (evidence.length > 40) return false;
      if (
        step.criterionIds.some((id) =>
          acceptance.plan.requirements.some((r) => r.id === id && r.phase === step.acceptancePhase),
        ) &&
        !evidence.some((item) => item.producer === semanticProducer)
      )
        return false;
      await policy.authorizeReferences(
        tx,
        evidence.map((e) => e.id),
        true,
      );
      assertCompletionEvidence({
        ownerId: scope.ownerId,
        stepId: step.id,
        sourceSha: scope.sourceSha,
        criterionIds: step.criterionIds,
        requiredKinds: step.requiredEvidenceKinds,
        acceptancePhase: step.acceptancePhase,
        policyVersion: policy.policy.version,
        trustedProducers: policy.policy.trustedProducers,
        maxAgeMs: policy.policy.maxAgeMs,
        now,
        evidence,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof DeliveryConflict) return false;
    throw error;
  }
}
