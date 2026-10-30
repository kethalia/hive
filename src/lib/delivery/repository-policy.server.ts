import type { Prisma, PrismaClient } from "@hive/db";
import {
  acceptanceEvidenceProducer,
  acceptancePlanForIntent,
  authorizeAcceptanceEvidence,
  bindAcceptanceTask,
} from "./acceptance-policy.server";

import { githubSourceDigest } from "./github-evidence.server";
import {
  resolveConfiguredGitHubManagerPolicy,
  resolveControllerGitHubManagerPolicy,
  resolveControllerGitHubTargetPolicy,
} from "./github-policy.server";
import type { ManagerPolicyScope, ResolvedManagerEvidencePolicy } from "./manager.server";
import { repositoryGateDescriptors } from "./repository-policy-contracts";
import { RepositoryPolicyStore } from "./repository-policy-store.server";
import { resolveControllerSourcePolicy } from "./source-policy.server";
import { assertCompletionEvidence, DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
export function repositoryPolicyStore(
  db: PrismaClient,
  verifyRepository?: ConstructorParameters<typeof RepositoryPolicyStore>[1]["verifyRepository"],
) {
  return new RepositoryPolicyStore(db, {
    enabled: process.env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED === "true",
    readCatalog() {
      const raw = process.env.HIVE_DELIVERY_REPOSITORY_POLICIES_JSON;
      if (!raw || Buffer.byteLength(raw) > 262144)
        throw new DeliveryConflict("repository_policy_catalog_unavailable");
      return JSON.parse(raw);
    },
    verifyRepository:
      verifyRepository ??
      (async () => {
        throw new DeliveryConflict("repository_policy_verification_unavailable");
      }),
  });
}

/** Persisted binding is always consulted before legacy flags/maps. These
 * callbacks run inside the caller's existing owner/registration/task transaction;
 * no middleware-only authorization or task-provided policy selector exists. */
function stepEvidence(
  bound: NonNullable<Awaited<ReturnType<RepositoryPolicyStore["resolveTask"]>>>,
  stepId: string,
) {
  if (!bound.task.steps.some((step) => step.id === stepId))
    throw new DeliveryConflict("repository_policy_scope_changed");
  const policy = structuredClone(bound.projection.compiledEvidencePolicy);
  const coverage = bound.projection.criterionCoverage.filter((c) => c.stepId === stepId);
  const groups = repositoryGateDescriptors(policy);
  for (const group of groups) {
    const allowed = group.criteria.filter(
      (id) =>
        id.startsWith("repo:") ||
        coverage.some(
          (c) =>
            c.criterionId === id &&
            c.kind === group.kind &&
            c.evaluatorGateKeys.includes(group.key),
        ),
    );
    group.criteria.splice(0, group.criteria.length, ...allowed);
  }
  if (new Set(groups.flatMap((g) => g.criteria.map((id) => `${g.kind}/${id}`))).size > 40)
    throw new DeliveryConflict("repository_policy_evidence_limit");
  return {
    policy,
    repositoryCriterionIds: [
      ...new Set(groups.flatMap((g) => g.criteria.filter((id) => id.startsWith("repo:")))),
    ].sort(),
  };
}
export function repositoryPolicyAdapters(
  store: RepositoryPolicyStore,
  { independentAcceptance = true } = {},
) {
  async function resolve(scope: { ownerId: string; taskId: string }, tx?: Tx) {
    if (!tx) throw new DeliveryConflict("repository_policy_transaction_required");
    return store.resolveTask(tx, scope.ownerId, scope.taskId);
  }
  async function manager(
    scope: ManagerPolicyScope,
    tx?: Tx,
  ): Promise<ResolvedManagerEvidencePolicy | null> {
    const bound = await resolve(scope, tx);
    if (!bound) return resolveControllerGitHubManagerPolicy(scope);
    if (
      bound.task.projectId !== scope.projectId ||
      bound.task.managerBindingId !== scope.managerBindingId ||
      bound.task.sourceSha !== scope.sourceSha ||
      bound.task.branch !== scope.branch ||
      !bound.task.steps.some((step) => step.id === scope.stepId)
    )
      throw new DeliveryConflict("repository_policy_scope_changed");
    const publication = bound.task.currentSourceRevision;
    if (!publication || publication.headSha !== scope.sourceSha)
      throw new DeliveryConflict("repository_policy_pr_pending");
    const configured = {
      pullNumber: publication.pullNumber,
      policy: stepEvidence(bound, scope.stepId).policy,
    };
    const resolved = resolveConfiguredGitHubManagerPolicy(scope, configured);
    if (!tx) throw new DeliveryConflict("repository_policy_transaction_required");
    const acceptance = independentAcceptance
      ? await acceptancePlanForIntent(tx, scope.ownerId, bound.binding.intentId)
      : null;
    const semanticProducer = acceptance ? acceptanceEvidenceProducer(acceptance.digest) : null;
    const supports = (id: string, kind: string) =>
      acceptance &&
      kind === "review" &&
      scope.acceptancePhase === "implementation_preview" &&
      acceptance.plan.requirements.some((r) => r.id === id && r.phase === scope.acceptancePhase);
    const pending = bound.projection.pendingRequirements.filter(
      (p) => p.stepId === scope.stepId && !supports(p.criterionId, p.kind),
    );
    const evidencePolicy = semanticProducer
      ? {
          ...resolved.policy,
          trustedProducers: [...resolved.policy.trustedProducers, semanticProducer],
        }
      : resolved.policy;
    return {
      ...resolved,
      policy: evidencePolicy,
      mandatoryRepositoryGates: true,
      pendingRequirements: pending,
      authorityDigest: githubSourceDigest({
        policyVersionId: bound.binding.policyVersionId,
        policyDigest: bound.binding.policyDigest,
        bindingDigest: bound.binding.bindingDigest,
        evidence: resolved.authorityDigest,
        ...(acceptance
          ? {
              acceptancePlanDigest: acceptance.row.planDigest,
              acceptanceProducer: acceptance.digest,
            }
          : {}),
      }),
      async authorizeReferences(transaction, ids, requireCoverage) {
        // Re-lock at the eventual mutation/observation, not just at selection.
        const fresh = await store.resolveTask(transaction, scope.ownerId, scope.taskId);
        if (!fresh || fresh.binding.bindingDigest !== bound.binding.bindingDigest)
          throw new DeliveryConflict("repository_policy_binding_changed");
        const supplied = await transaction.deliveryEvidence.findMany({
          where: { ownerId: scope.ownerId, id: { in: ids } },
          select: { id: true, producer: true },
        });
        const semanticIds = supplied
          .filter((e) => e.producer === semanticProducer)
          .map((e) => e.id);
        await resolved.authorizeReferences(
          transaction,
          ids.filter((id) => !semanticIds.includes(id)),
          requireCoverage,
        );
        if (acceptance)
          await authorizeAcceptanceEvidence(
            transaction,
            scope,
            bound.binding.intentId,
            semanticIds,
            requireCoverage,
          );
        if (requireCoverage) {
          const evidence = await transaction.deliveryEvidence.findMany({
            where: { ownerId: scope.ownerId, stepId: scope.stepId, id: { in: ids } },
          });
          const now = (
            await transaction.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
          )[0].now;
          // Provenance coverage alone does not establish that every mandatory
          // repository check/review passed, is current, and meets phase quality.
          const groups = [
            ...configured.policy.checks.map((g) => ({ kind: "check", ids: g.criterionIds })),
            ...(configured.policy.codexReview
              ? [{ kind: "review", ids: configured.policy.codexReview.criterionIds }]
              : []),
            ...configured.policy.formalReviewers.map((g) => ({
              kind: "review",
              ids: g.criterionIds,
            })),
          ];
          for (const group of groups)
            assertCompletionEvidence({
              ownerId: scope.ownerId,
              stepId: scope.stepId,
              sourceSha: scope.sourceSha,
              acceptancePhase: scope.acceptancePhase,
              criterionIds: group.ids,
              requiredKinds: [group.kind],
              policyVersion: resolved.policy.version,
              trustedProducers: resolved.policy.trustedProducers,
              now,
              maxAgeMs: resolved.policy.maxAgeMs,
              evidence,
            });
          const semanticCriteria = scope.criterionIds.filter((id) => supports(id, "review"));
          if (semanticProducer && semanticCriteria.length)
            assertCompletionEvidence({
              ownerId: scope.ownerId,
              stepId: scope.stepId,
              sourceSha: scope.sourceSha,
              acceptancePhase: scope.acceptancePhase,
              criterionIds: semanticCriteria,
              requiredKinds: ["review"],
              policyVersion: resolved.policy.version,
              trustedProducers: [semanticProducer],
              now,
              maxAgeMs: resolved.policy.maxAgeMs,
              evidence,
            });
          if (pending.length) throw new DeliveryConflict(pending[0].reason);
        }
      },
    };
  }
  return {
    store,
    resolveEvidencePolicy: manager,
    async resolvePolicy(scope: { ownerId: string; taskId: string; repositoryId: string }, tx?: Tx) {
      const bound = await resolve(scope, tx);
      if (!bound) return resolveControllerSourcePolicy(scope);
      if (bound.task.managerBinding?.repositoryId !== scope.repositoryId)
        throw new DeliveryConflict("repository_policy_scope_changed");
      return bound.policy.source;
    },
    async resolveTargetPolicy(
      scope: {
        ownerId: string;
        taskId: string;
        stepId: string;
        repositoryId: string;
        sourceSha: string;
      },
      tx?: Tx,
    ) {
      const bound = await resolve(scope, tx);
      if (!bound) return resolveControllerGitHubTargetPolicy(scope.taskId);
      const publication = bound.task.currentSourceRevision;
      if (
        bound.task.managerBinding?.repositoryId !== scope.repositoryId ||
        bound.task.sourceSha !== scope.sourceSha
      )
        throw new DeliveryConflict("repository_policy_scope_changed");
      if (!publication || publication.headSha !== scope.sourceSha)
        throw new DeliveryConflict("repository_policy_pr_pending");
      return { pullNumber: publication.pullNumber, ...stepEvidence(bound, scope.stepId) };
    },
    async authorizeTaskPolicy(tx: Tx, ownerId: string, taskId: string, operation: string) {
      const bound = await resolve({ ownerId, taskId }, tx);
      if (!bound || operation !== "claim_step" || !bound.task.sourceRevisionId) return;
      const binding = bound.task.managerBinding;
      if (!binding?.currentAttemptId)
        throw new DeliveryConflict("repository_policy_progression_unbound");
      const previous = await tx.deliveryAttempt.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: binding.currentAttemptId } },
        include: { step: true },
      });
      const project = await tx.deliveryProject.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: bound.task.projectId } },
      });
      const policy = await manager(
        {
          ownerId,
          projectId: project.id,
          taskId,
          stepId: previous.stepId,
          repositoryId: project.providerRepositoryId,
          providerAccountId: project.providerAccountId,
          fullName: project.fullName,
          sourceSha: bound.task.sourceSha,
          branch: bound.task.branch,
          managerBindingId: binding.id,
          checkoutBindingDigest: binding.bindingDigest,
          stepKind: previous.step.kind,
          criterionIds: previous.step.criterionIds,
          requiredEvidenceKinds: previous.step.requiredEvidenceKinds,
          acceptancePhase: previous.step.acceptancePhase,
          sourceRevisionId: bound.task.sourceRevisionId,
          sourceVersion: bound.task.sourceVersion,
          sourcePullNumber: bound.task.currentSourceRevision?.pullNumber,
        },
        tx,
      );
      if (!policy) throw new DeliveryConflict("repository_policy_progression_unbound");
      const evidence = await tx.deliveryEvidence.findMany({
        where: {
          ownerId,
          stepId: previous.stepId,
          sourceSha: bound.task.sourceSha,
          producer: { in: [...policy.policy.trustedProducers] },
          policyVersion: policy.policy.version,
          status: "passed",
          invalidatedAt: null,
        },
        take: 41,
      });
      if (evidence.length > 40) throw new DeliveryConflict("repository_policy_evidence_limit");
      await policy.authorizeReferences(
        tx,
        evidence.map((e) => e.id),
        true,
      );
    },
    async bindCreatedTask(tx: Tx, ownerId: string, taskId: string, intentId: string) {
      // Legacy unbound tasks remain supported only while enrollment is off.
      // A pinned intent cannot silently produce a weaker unbound task.
      const pins = await tx.$queryRaw<
        { versionId: string | null; projectId: string }[]
      >`SELECT project_id AS "projectId", repository_policy_version_id AS "versionId" FROM project_task_intents WHERE owner_id=${ownerId}::uuid AND id=${intentId}::uuid FOR UPDATE`;
      if (
        !store.enabled &&
        !pins[0]?.versionId &&
        (!pins[0] || !(await store.projectEnrolled(tx, ownerId, pins[0].projectId)))
      )
        return;
      await store.bindCreatedTask(tx, ownerId, taskId, intentId);
      await bindAcceptanceTask(tx, ownerId, taskId, intentId);
    },
  };
}
