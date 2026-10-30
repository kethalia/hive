import { Prisma, type PrismaClient } from "@hive/db";
import { lockProducerMetadata } from "@/lib/codex-session/guardian-store.server";
import {
  lockActiveRegistration,
  RegistrationRejected,
} from "@/lib/codex-session/registration-store.server";
import { canonicalGitHubSource } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import type {
  ManagerDependencies,
  ManagerPolicyScope,
  ResolvedManagerEvidencePolicy,
} from "./manager.server";
import { authenticateCheckoutHost, lockManagerCheckout } from "./manager-binding.server";
import { resolveAttemptSource } from "./source-resolver.server";
import { assertCompletionEvidence, DeliveryConflict, isInformationalStep } from "./state";
import {
  type DeliveryStatusResponse,
  deliveryStatusProofPayload,
  deliveryStatusRequestSchema,
  deliveryStatusResponseSchema,
} from "./status-contracts";

/** Current-claim factual read. No mutation, source-application release or action
 * permission follows from a successful response or evidence coverage snapshot. */
export class DeliveryStatusService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: Pick<
      ManagerDependencies,
      "reauthorize" | "guardianPolicy" | "resolveEvidencePolicy"
    >,
  ) {}
  async read(value: unknown) {
    const wire = JSON.parse(canonicalGitHubSource(value));
    const input = deliveryStatusRequestSchema.parse(wire);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      deliveryStatusProofPayload(wire),
    );
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(
          async (tx) => {
            const active = await lockActiveRegistration(tx, {
              ownerId: authenticated.ownerId,
              registrationId: input.registrationId,
            });
            const producer = await lockProducerMetadata(
              tx,
              {
                hiveUserId: authenticated.ownerId,
                registrationId: input.registrationId,
                workspaceId: active.slot.workspaceId,
                buildId: active.registration.buildId,
                serverInstanceId: input.serverInstanceId,
                managerThreadId: input.managerThreadId,
                projectId: input.checkoutBinding.projectId,
                preparationIntentId: input.checkoutBinding.preparationIntentId,
                repositoryId: input.checkoutBinding.repositoryId,
                leaseId: input.checkoutBinding.leaseId,
                leaseGeneration: input.checkoutBinding.leaseGeneration,
              },
              this.dependencies.guardianPolicy,
            );
            const host = await lockManagerCheckout(tx, input, authenticated, {
              guardianPolicy: this.dependencies.guardianPolicy,
              allowBlocked: true,
            });
            if (
              host.binding.id !== input.managerBindingId ||
              host.binding.progressionProtocol !== 1 ||
              host.binding.currentAttemptId !== input.attemptId
            )
              throw new RegistrationRejected();
            const rows = await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM delivery_tasks WHERE owner_id=${authenticated.ownerId}::uuid AND id=${input.taskId}::uuid FOR UPDATE`;
            if (rows.length !== 1) throw new RegistrationRejected();
            const resolved = await resolveAttemptSource(
              tx,
              authenticated.ownerId,
              input.taskId,
              input.attemptId,
            );
            const { task, attempt } = resolved,
              step = attempt.step;
            if (
              task.managerBindingId !== host.binding.id ||
              task.projectId !== input.checkoutBinding.projectId ||
              task.conversationId !== host.conversation.id ||
              step.id !== input.stepId ||
              attempt.leaseGeneration !== input.attemptLeaseGeneration ||
              attempt.sourceSha !== input.inputSourceSha
            )
              throw new RegistrationRejected();
            const claim = await tx.deliveryEvent.findFirst({
              where: {
                ownerId: authenticated.ownerId,
                attemptId: attempt.id,
                type: "attempt_started",
              },
            });
            const nativeClaim = (
              claim?.payload as {
                nativeClaim?: {
                  sourceContext?: unknown;
                  managerThreadId?: unknown;
                  cursorVersion?: unknown;
                };
              } | null
            )?.nativeClaim;
            if (
              !nativeClaim ||
              nativeClaim.managerThreadId !== input.managerThreadId ||
              nativeClaim.cursorVersion !== host.binding.cursorVersion ||
              canonicalGitHubSource(nativeClaim.sourceContext ?? null) !==
                canonicalGitHubSource(input.inputSourceContext)
            )
              throw new RegistrationRejected();
            const project = await tx.deliveryProject.findUniqueOrThrow({
              where: { ownerId_id: { ownerId: authenticated.ownerId, id: task.projectId } },
            });
            const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]
              .now;
            const blockers: DeliveryStatusResponse["blockers"] = [];
            if (task.pauseRequested || task.schedulingPaused) blockers.push("task_paused");
            if (host.binding.blockedReason) blockers.push("native_reconciliation_required");
            if (host.intent.phase === "blocked") blockers.push("preparation_held");
            if (attempt.leaseExpiresAt <= now) blockers.push("attempt_lease_expired");
            if (attempt.outcome !== "running" || step.state !== "running")
              blockers.push("attempt_not_running");
            const application = await tx.deliverySourceApplication.findFirst({
              where: {
                ownerId: authenticated.ownerId,
                admissionId: producer.admissionId,
                taskId: task.id,
              },
              orderBy: { applicationVersion: "desc" },
            });
            const applicationPhase = !resolved.context
              ? "base"
              : application?.targetRevisionId === resolved.context.revisionId
                ? application.phase === "applied"
                  ? "applied"
                  : "pending"
                : "accepted";
            if (["accepted", "pending"].includes(applicationPhase))
              blockers.push("source_application_pending");
            const policyScope: ManagerPolicyScope = {
              ownerId: authenticated.ownerId,
              projectId: task.projectId,
              taskId: task.id,
              stepId: step.id,
              repositoryId: project.providerRepositoryId,
              providerAccountId: project.providerAccountId,
              fullName: project.fullName,
              sourceSha: resolved.headSha,
              branch: task.branch,
              managerBindingId: host.binding.id,
              checkoutBindingDigest: host.binding.bindingDigest,
              stepKind: step.kind,
              criterionIds: step.criterionIds,
              requiredEvidenceKinds: step.requiredEvidenceKinds,
              acceptancePhase: step.acceptancePhase,
              ...(resolved.context
                ? {
                    sourceRevisionId: resolved.context.revisionId,
                    sourceVersion: resolved.context.version,
                    sourcePullNumber: task.currentSourceRevision?.pullNumber,
                  }
                : {}),
            };
            const readPolicy = async (): Promise<ResolvedManagerEvidencePolicy | null> => {
              try {
                return (await this.dependencies.resolveEvidencePolicy?.(policyScope)) ?? null;
              } catch (error) {
                if (
                  !(error instanceof DeliveryConflict) &&
                  !(
                    error instanceof Error &&
                    error.message === "GitHub controller policy unavailable"
                  )
                )
                  throw error;
                return null;
              }
            };
            const policy = await readPolicy();
            const policyIdentity = policy
              ? canonicalGitHubSource({
                  authorityDigest: policy.authorityDigest,
                  policy: policy.policy,
                })
              : null;
            let requirementStatus: DeliveryStatusResponse["evidence"]["requirementStatus"] = "held";
            let references: string[] = [];
            let evidenceExpiresAt = Infinity;
            const observations: DeliveryStatusResponse["evidence"]["observations"] = [];
            if (isInformationalStep(step)) requirementStatus = "informational";
            else if (!policy) blockers.push("policy_unavailable");
            else {
              const evidence = await tx.deliveryEvidence.findMany({
                where: {
                  ownerId: authenticated.ownerId,
                  stepId: step.id,
                  sourceSha: resolved.headSha,
                  producer: { in: [...policy.policy.trustedProducers] },
                  policyVersion: policy.policy.version,
                },
                orderBy: [{ observedAt: "desc" }, { id: "desc" }],
                take: 41,
              });
              if (evidence.length > 40) blockers.push("evidence_limit");
              else {
                try {
                  await policy.authorizeReferences(
                    tx,
                    evidence.map((v) => v.id),
                    false,
                  );
                  observations.push(
                    ...evidence.map((v) => ({
                      id: v.id,
                      kind: v.kind,
                      status: v.status,
                      verificationMode: v.verificationMode,
                      sourceSha: v.sourceSha,
                      observedAt: v.observedAt.getTime(),
                      invalidatedAt: v.invalidatedAt?.getTime() ?? null,
                    })),
                  );
                  const selectedPolicy = policy.policy;
                  const candidates = evidence.filter(
                    (v) =>
                      v.status === "passed" &&
                      v.invalidatedAt === null &&
                      v.observedAt <= now &&
                      now.getTime() - v.observedAt.getTime() <= selectedPolicy.maxAgeMs &&
                      (step.acceptancePhase !== "activation_production" ||
                        v.verificationMode === "production"),
                  );
                  references = candidates.map((v) => v.id);
                  await policy.authorizeReferences(tx, references, true);
                  assertCompletionEvidence({
                    ownerId: authenticated.ownerId,
                    stepId: step.id,
                    sourceSha: resolved.headSha,
                    criterionIds: step.criterionIds,
                    requiredKinds: step.requiredEvidenceKinds,
                    acceptancePhase: step.acceptancePhase,
                    policyVersion: policy.policy.version,
                    trustedProducers: policy.policy.trustedProducers,
                    now,
                    maxAgeMs: policy.policy.maxAgeMs,
                    evidence: candidates,
                  });
                  requirementStatus = "satisfied";
                  evidenceExpiresAt = Math.min(
                    ...candidates.map((v) => v.observedAt.getTime() + selectedPolicy.maxAgeMs),
                  );
                } catch (error) {
                  if (!(error instanceof DeliveryConflict)) throw error;
                  requirementStatus = "missing";
                  blockers.push(
                    error.code === "missing_evidence" ||
                      error.code === "github_policy_evidence_missing"
                      ? "evidence_missing"
                      : error.code === "invalid_evidence"
                        ? "evidence_invalid"
                        : "evidence_provenance_unavailable",
                  );
                  if (!observations.length) references = [];
                }
              }
            }
            const latestPolicy = await readPolicy();
            if (
              policyIdentity !==
              (latestPolicy
                ? canonicalGitHubSource({
                    authorityDigest: latestPolicy.authorityDigest,
                    policy: latestPolicy.policy,
                  })
                : null)
            )
              throw new DeliveryConflict("status_policy_changed");
            // Re-evaluate time after any policy/provenance work. Locked rows cannot
            // renew/revoke behind this read; elapsed time is never renewed authority.
            const end = (
              await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
            )[0].now.getTime();
            if (requirementStatus === "satisfied" && evidenceExpiresAt <= end) {
              requirementStatus = "missing";
              references = [];
              blockers.push("evidence_missing");
            }
            const runtime = await tx.codexGuardianRuntime.findUniqueOrThrow({
              where: { id: producer.runtimeId },
            });
            const expiresAt = Math.min(
              end + 30000,
              input.expiresAt,
              host.registration.expiresAt.getTime(),
              runtime.authorityUntil.getTime(),
              requirementStatus === "satisfied" ? evidenceExpiresAt : Infinity,
            );
            if (input.issuedAt > end || expiresAt <= end || end - now.getTime() > 5000)
              throw new RegistrationRejected();
            const {
              metadataPins,
              metadataPinsDigest,
              metadataPolicyDigest,
              namespaceReceiptDigest,
              ...admission
            } = producer;
            const response = deliveryStatusResponseSchema.parse({
              schemaVersion: 1,
              action: "read_delivery_status",
              requestId: input.requestId,
              observedAt: end,
              expiresAt,
              scope: {
                ownerId: authenticated.ownerId,
                registrationId: input.registrationId,
                serverInstanceId: input.serverInstanceId,
                managerThreadId: input.managerThreadId,
                managerBindingId: host.binding.id,
                checkoutBindingDigest: host.binding.bindingDigest,
                checkoutBinding: input.checkoutBinding,
                taskId: task.id,
                stepId: step.id,
                attemptId: attempt.id,
                attemptLeaseGeneration: attempt.leaseGeneration,
                inputSourceSha: attempt.sourceSha,
                inputSourceContext: input.inputSourceContext,
              },
              admission,
              metadata: {
                pins: metadataPins,
                pinsDigest: metadataPinsDigest,
                policyDigest: metadataPolicyDigest,
                namespaceReceiptDigest,
              },
              task: {
                version: task.version,
                pauseRequested: task.pauseRequested,
                schedulingPaused: task.schedulingPaused,
              },
              step: {
                kind: step.kind,
                state: step.state,
                version: step.version,
                acceptancePhase: step.acceptancePhase,
                criterionIds: step.criterionIds,
                requiredEvidenceKinds: step.requiredEvidenceKinds,
              },
              attempt: {
                outcome: attempt.outcome,
                leaseExpiresAt: attempt.leaseExpiresAt.getTime(),
              },
              source: {
                physicalBase: resolved.physicalBase,
                headSha: resolved.headSha,
                sourceContext: resolved.context ?? null,
                applicationPhase,
                operationId: task.currentSourceRevision?.operationId ?? null,
                pullNumber: task.currentSourceRevision?.pullNumber ?? null,
              },
              evidence: {
                policyVersion: policy?.policy.version ?? null,
                requirementStatus,
                referenceIds: references,
                observations,
              },
              blockers,
              executionAuthorized: false,
              publicationAuthorized: false,
              cleanupAuthorized: false,
            });
            if (Buffer.byteLength(JSON.stringify(response)) > 32768)
              throw new DeliveryConflict("status_response_limit");
            return response;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 10000,
          },
        );
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
}
