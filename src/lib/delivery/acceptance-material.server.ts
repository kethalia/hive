import { createHash } from "node:crypto";
import type { Prisma } from "@hive/db";
import {
  type AcceptanceJobScope,
  acceptanceCandidateSchema,
  acceptanceDigest,
  acceptanceJobScopeSchema,
  acceptancePlanResultSchema,
} from "./acceptance-contracts";
import type { AcceptanceMaterial, AcceptanceStore } from "./acceptance-store.server";
import { canonicalGitHubSource } from "./github-evidence.server";
import type { ManagerPolicyScope, ResolvedManagerEvidencePolicy } from "./manager.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
function check(v: unknown): asserts v {
  if (!v) throw new DeliveryConflict("acceptance_material_unavailable");
}
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export class AcceptanceMaterialResolver {
  constructor(
    private readonly policies: RepositoryPolicyStore,
    private readonly resolveEvidence: (
      scope: ManagerPolicyScope,
      tx: Tx,
    ) => Promise<ResolvedManagerEvidencePolicy | null>,
  ) {}
  async current(tx: Tx, ownerId: string, managerBindingId: string) {
    const binding = await tx.deliveryManagerBinding.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: managerBindingId } },
    });
    check(binding.currentAttemptId);
    const attempt = await tx.deliveryAttempt.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: binding.currentAttemptId } },
      include: { step: { include: { task: true } } },
    });
    const bound = await this.policies.resolveTask(tx, ownerId, attempt.step.taskId);
    check(
      bound &&
        !bound.task.pauseRequested &&
        !bound.task.schedulingPaused &&
        bound.task.managerBindingId === binding.id &&
        bound.task.currentSourceRevision,
    );
    const revision = bound.task.currentSourceRevision;
    check(revision.headSha === bound.task.sourceSha);
    const plan = await tx.deliveryAcceptancePlan.findFirst({
      where: { ownerId, intentId: binding.preparationIntentId },
      orderBy: { createdAt: "asc" },
    });
    check(plan);
    const content = acceptancePlanResultSchema.parse(plan.content);
    check(content.outcome === "ready");
    const criterionIds = attempt.step.criterionIds.filter((id) => id.startsWith("acceptance:"));
    check(
      criterionIds.length &&
        criterionIds.every((id) =>
          content.requirements.some((r) => r.id === id && r.phase === attempt.step.acceptancePhase),
        ),
    );
    const project = await tx.deliveryProject.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: bound.task.projectId } },
    });
    const policy = await this.resolveEvidence(
      {
        ownerId,
        projectId: project.id,
        taskId: bound.task.id,
        stepId: attempt.stepId,
        repositoryId: project.providerRepositoryId,
        providerAccountId: project.providerAccountId,
        fullName: project.fullName,
        sourceSha: revision.headSha,
        branch: bound.task.branch,
        managerBindingId: binding.id,
        checkoutBindingDigest: binding.bindingDigest,
        stepKind: attempt.step.kind,
        criterionIds: attempt.step.criterionIds,
        requiredEvidenceKinds: attempt.step.requiredEvidenceKinds,
        acceptancePhase: attempt.step.acceptancePhase,
        sourceRevisionId: revision.id,
        sourceVersion: revision.version,
        sourcePullNumber: revision.pullNumber,
      },
      tx,
    );
    check(policy);
    const evidence = await tx.deliveryEvidence.findMany({
      where: {
        ownerId,
        stepId: attempt.stepId,
        sourceSha: revision.headSha,
        invalidatedAt: null,
        producer: { in: [...policy.policy.trustedProducers] },
        policyVersion: policy.policy.version,
      },
      orderBy: { id: "asc" },
      take: 41,
    });
    check(evidence.length <= 40);
    // This authenticates each provider fact; it does not treat CI as semantics.
    await policy.authorizeReferences(
      tx,
      evidence.map((e) => e.id),
      false,
    );
    const facts = evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      status: e.status,
      sourceSha: e.sourceSha,
      criterionIds: e.criterionIds,
      producer: e.producer,
      contentDigest: e.contentDigest,
      observedAt: e.observedAt.toISOString(),
    }));
    return {
      binding,
      attempt,
      bound,
      revision,
      plan,
      content,
      criterionIds,
      policy,
      facts,
      evidence,
    };
  }
  async prepare(
    tx: Tx,
    store: AcceptanceStore,
    ownerId: string,
    managerBindingId: string,
    raw: unknown,
  ) {
    const current = await this.current(tx, ownerId, managerBindingId),
      candidate = this.verifyCandidate(raw, current.revision.manifestDigest);
    const snapshot = await tx.deliveryAcceptanceIntent.findUniqueOrThrow({
      where: { ownerId_intentId: { ownerId, intentId: current.binding.preparationIntentId } },
    });
    check(current.plan.producerDigest === store.producerDigest);
    const scope: AcceptanceJobScope = {
      ownerId,
      projectId: current.bound.task.projectId,
      preparationIntentId: snapshot.intentId,
      repositoryPolicyVersionId: snapshot.policyVersionId,
      repositoryPolicyDigest: snapshot.policyDigest,
      intentDigest: snapshot.intentDigest,
      producerDigest: store.producerDigest,
      kind: "review",
      taskId: current.bound.task.id,
      stepId: current.attempt.stepId,
      attemptId: current.attempt.id,
      planDigest: current.plan.planDigest,
      sourceRevisionId: current.revision.id,
      sourceSha: current.revision.headSha,
      sourceVersion: current.revision.version,
      sourceTreeSha: current.revision.treeSha,
      evidenceDigest: acceptanceDigest(current.facts),
      artifactDigest: acceptanceDigest(candidate),
    };
    const job = await store.enqueue(tx, scope, candidate);
    return { phase: job.phase, jobId: job.id };
  }
  verifyCandidate(raw: unknown, manifestDigest: string) {
    const candidate = acceptanceCandidateSchema.parse(raw);
    check(acceptanceDigest(candidate.manifest) === manifestDigest);
    check(
      candidate.contents.length === candidate.manifest.files.length &&
        new Set(candidate.contents.map((f) => f.path)).size === candidate.contents.length,
    );
    for (const file of candidate.manifest.files) {
      const content = candidate.contents.find((f) => f.path === file.path);
      check(content);
      const bytes = Buffer.from(content.text);
      check(
        bytes.length === file.size &&
          sha(content.text) === file.contentDigest &&
          createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") ===
            file.blobSha,
      );
    }
    return candidate;
  }
  async material(tx: Tx, scope: AcceptanceJobScope, stored: unknown): Promise<AcceptanceMaterial> {
    acceptanceJobScopeSchema.parse(scope);
    check(scope.taskId);
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: scope.ownerId, id: scope.taskId } },
    });
    check(task.managerBindingId);
    const current = await this.current(tx, scope.ownerId, task.managerBindingId);
    check(
      current.attempt.id === scope.attemptId &&
        current.attempt.stepId === scope.stepId &&
        current.revision.id === scope.sourceRevisionId &&
        current.revision.headSha === scope.sourceSha &&
        current.revision.version === scope.sourceVersion &&
        current.plan.planDigest === scope.planDigest &&
        acceptanceDigest(current.facts) === scope.evidenceDigest,
    );
    const candidate = this.verifyCandidate(stored, current.revision.manifestDigest);
    check(acceptanceDigest(candidate) === scope.artifactDigest);
    const artifacts = candidate.contents.map((file, index) => ({
      entryId: `source:${index}`,
      path: file.path,
      text: file.text,
      digest: sha(file.text),
      bytes: Buffer.byteLength(file.text),
    }));
    const factsText = canonicalGitHubSource(current.facts);
    artifacts.push({
      entryId: "evidence:provider",
      path: "provider-facts",
      text: factsText,
      digest: sha(factsText),
      bytes: Buffer.byteLength(factsText),
    });
    return {
      evidencePolicyVersion: current.policy.policy.version,
      payload: {
        kind: "review",
        contextLimit:
          "sealed_changed_files_only; unchanged source and production observations not supplied",
        sourceSha: scope.sourceSha,
        parentSha: current.revision.inputSha,
        treeSha: current.revision.treeSha,
        manifest: candidate.manifest,
        plan: {
          ...current.content,
          requirements: current.content.requirements.map((r) => ({
            ...r,
            meaningDigest: sha(r.meaning),
          })),
        },
        planDigest: current.plan.planDigest,
        intentDigest: scope.intentDigest,
        requestedCriterionIds: current.criterionIds,
        acceptancePhase: current.attempt.step.acceptancePhase,
        artifacts,
      },
      review: {
        intentDigest: scope.intentDigest,
        plan: {
          ...current.content,
          requirements: current.content.requirements.map((r) => ({
            ...r,
            meaningDigest: sha(r.meaning),
          })),
        },
        planDigest: current.plan.planDigest,
        sourceSha: current.revision.headSha,
        criterionIds: current.criterionIds,
        phase: current.attempt.step.acceptancePhase as
          | "implementation_preview"
          | "activation_production",
        artifacts: new Map(artifacts.map((a) => [a.entryId, { digest: a.digest, bytes: a.bytes }])),
      },
    };
  }
}
