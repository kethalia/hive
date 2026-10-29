import { Prisma, type PrismaClient } from "@hive/db";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import {
  authenticateCheckoutHost,
  lockManagerCheckout,
  managerCheckoutIdentity,
} from "./manager-binding.server";
import { managerEnvelopeSchema, managerProofPayload } from "./manager-contracts";
import { DeliveryRepository, type EvidencePolicy } from "./repository";
import { DeliveryConflict } from "./state";

if (typeof window !== "undefined") throw new Error("Delivery manager is server-only.");
export interface ManagerDependencies {
  // Real deployment uses fresh server-owned Coder owner/build/app authorization.
  reauthorize(binding: RegistrationBinding): Promise<RegistrationBinding>;
  // Controller-owned adapter policy, never read from the host envelope.
  evidencePolicy?: EvidencePolicy;
  resolveEvidencePolicy?(
    scope: ManagerPolicyScope,
  ): Promise<ResolvedManagerEvidencePolicy | null> | ResolvedManagerEvidencePolicy | null;
  allowedModelEfforts?: readonly { model: string; effort: string }[];
}
export interface ManagerPolicyScope {
  ownerId: string;
  projectId: string;
  taskId: string;
  stepId: string;
  repositoryId: string;
  providerAccountId: string;
  fullName: string;
  sourceSha: string;
  branch: string;
  managerBindingId: string;
  checkoutBindingDigest: string;
  stepKind: string;
  criterionIds: string[];
  requiredEvidenceKinds: string[];
  acceptancePhase: string;
}
export interface ResolvedManagerEvidencePolicy {
  policy: EvidencePolicy;
  authorityDigest: string;
  authorizeReferences(
    tx: Prisma.TransactionClient,
    ids: string[],
    requireCoverage: boolean,
  ): Promise<void>;
}
const resolutionDigest = (value: ResolvedManagerEvidencePolicy | null) =>
  value
    ? githubSourceDigest({ authorityDigest: value.authorityDigest, policy: value.policy })
    : null;
async function loadPolicyScope(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
  stepId: string,
  host: Awaited<ReturnType<typeof lockManagerCheckout>>,
): Promise<ManagerPolicyScope> {
  const task = await tx.deliveryTask.findUnique({
    where: { ownerId_id: { ownerId, id: taskId } },
    include: { project: true, steps: { where: { id: stepId } } },
  });
  const step = task?.steps[0];
  if (
    !task ||
    !step ||
    task.projectId !== host.thread.projectId ||
    task.conversationId !== host.thread.conversationId ||
    task.managerBindingId !== host.binding.id ||
    task.sourceSha !== host.binding.sourceSha ||
    task.project.provider !== "github"
  )
    throw new RegistrationRejected();
  return {
    ownerId,
    projectId: task.projectId,
    taskId: task.id,
    stepId: step.id,
    repositoryId: task.project.providerRepositoryId,
    providerAccountId: task.project.providerAccountId,
    fullName: task.project.fullName,
    sourceSha: task.sourceSha,
    branch: task.branch,
    managerBindingId: host.binding.id,
    checkoutBindingDigest: host.binding.bindingDigest,
    stepKind: step.kind,
    criterionIds: step.criterionIds,
    requiredEvidenceKinds: step.requiredEvidenceKinds,
    acceptancePhase: step.acceptancePhase,
  };
}
/** No producer trust can be supplied by a manager request. Until external adapters
 * are configured, the empty allowlist intentionally prevents successful reports. */
export class DeliveryManagerService {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: ManagerDependencies,
  ) {}

  async execute(value: unknown) {
    const input = managerEnvelopeSchema.parse(value);
    const wire = value as Record<string, unknown>;
    const registered = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      managerProofPayload(wire),
    );
    const ownerId = registered.ownerId;
    const thread = await this.db.codexRegisteredThread.findFirst({
      where: {
        ownerId,
        registrationId: registered.id,
        nativeThreadId: input.managerThreadId,
        projectId: input.checkoutBinding.projectId,
      },
    });
    if (!thread) throw new RegistrationRejected();
    const conversation = await this.db.deliveryConversation.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: thread.conversationId } },
    });
    const expected = managerCheckoutIdentity(
      {
        ownerId,
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        buildId: registered.buildId,
        serverInstanceId: registered.serverInstanceId,
        nativeThreadId: input.managerThreadId,
      },
      input.checkoutBinding,
    );
    const resultCommand =
      input.command.operation === "complete_step" ||
      (input.command.operation === "fail_attempt" && input.command.payload.evidenceIds.length > 0)
        ? input.command
        : null;
    let selectedPolicy: ResolvedManagerEvidencePolicy | null = null;
    const resolvePolicy = this.dependencies.resolveEvidencePolicy;
    if (resultCommand && resolvePolicy) {
      for (let retry = 0; ; retry++) {
        try {
          selectedPolicy = await this.db.$transaction(
            async (tx) => {
              const host = await lockManagerCheckout(tx, input, registered, {
                allowBlocked: input.command.operation === "fail_attempt",
              });
              const scope = await loadPolicyScope(
                tx,
                ownerId,
                resultCommand.payload.taskId,
                resultCommand.payload.stepId,
                host,
              );
              return resolvePolicy(scope);
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10000,
              timeout: 10000,
            },
          );
          break;
        } catch (error) {
          if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
        }
      }
    }
    const selectedPolicyDigest = resolutionDigest(selectedPolicy);
    let nativeSequence = 0;
    const repository = new DeliveryRepository(
      this.db,
      selectedPolicy?.policy ?? this.dependencies.evidencePolicy,
      async (tx) => {
        const scope = await lockManagerCheckout(tx, input, registered, {
          create: input.command.operation === "create_task",
          allowBlocked: input.command.operation === "fail_attempt",
        });
        nativeSequence = scope.binding.nativeSequence;
        if (scope.binding.id !== expected.id) throw new RegistrationRejected();
        if (input.command.operation !== "create_task") {
          const task = await tx.deliveryTask.findUnique({
            where: { ownerId_id: { ownerId, id: input.command.payload.taskId } },
          });
          if (
            !task ||
            task.projectId !== scope.thread.projectId ||
            task.conversationId !== scope.thread.conversationId ||
            task.managerBindingId !== scope.binding.id ||
            task.sourceSha !== scope.binding.sourceSha
          )
            throw new RegistrationRejected();
        }
        if (resultCommand && resolvePolicy) {
          const currentScope = await loadPolicyScope(
            tx,
            ownerId,
            resultCommand.payload.taskId,
            resultCommand.payload.stepId,
            scope,
          );
          const currentPolicy = await resolvePolicy(currentScope);
          if (resolutionDigest(currentPolicy) !== selectedPolicyDigest)
            throw new DeliveryConflict("manager_policy_changed");
          await currentPolicy?.authorizeReferences(
            tx,
            resultCommand.payload.evidenceIds,
            resultCommand.operation === "complete_step",
          );
        }
        if (input.command.operation === "claim_step") {
          const other = await tx.deliveryManagerBinding.findFirst({
            where: {
              ownerId,
              preparationIntentId: scope.intent.id,
              activeAttemptId: { not: null },
              id: { not: scope.binding.id },
            },
          });
          if (other) throw new DeliveryConflict("checkout_writer_reconciliation_required");
          if (scope.binding.activeAttemptId) {
            const prior = await tx.deliveryEvent.findUnique({
              where: { ownerId_id: { ownerId, id: input.eventId } },
            });
            if (prior?.attemptId !== scope.binding.activeAttemptId)
              throw new DeliveryConflict("checkout_writer_busy");
          }
        }
        if (
          input.command.operation === "complete_step" ||
          input.command.operation === "report_step" ||
          input.command.operation === "fail_attempt"
        ) {
          const attempt = await tx.deliveryAttempt.findUnique({
            where: { ownerId_id: { ownerId, id: input.command.payload.attemptId } },
          });
          if (
            !attempt ||
            attempt.managerBindingId !== scope.binding.id ||
            !attempt.leaseHolder.startsWith(`manager/${scope.binding.id}/`)
          )
            throw new RegistrationRejected();
          if (input.command.operation === "complete_step") {
            const binding = attempt.runtimeBinding as Record<string, unknown> | null;
            if (
              !binding ||
              binding.managerThreadId !== input.managerThreadId ||
              binding.serverInstanceId !== input.serverInstanceId ||
              binding.workspaceId !== scope.slot.workspaceId ||
              binding.buildId !== scope.registration.buildId ||
              binding.coderOwnerId !== scope.slot.coderOwnerId
            )
              throw new RegistrationRejected();
            if (
              !attempt.effectiveModel ||
              !attempt.effectiveEffort ||
              attempt.effectiveModel !== attempt.requestedModel ||
              attempt.effectiveEffort !== attempt.requestedEffort
            )
              throw new DeliveryConflict("native_settings_unverified");
            const native = await tx.deliveryEvent.findFirst({
              where: { ownerId, attemptId: attempt.id, type: "native_attempt_observed" },
              orderBy: { aggregateVersion: "desc" },
            });
            const observation = native?.payload as {
              nativeSourceKind?: unknown;
              turnStatus?: unknown;
            } | null;
            if (
              observation?.nativeSourceKind !== "turn_completed" ||
              observation.turnStatus !== "completed"
            )
              throw new DeliveryConflict("native_execution_unverified");
          }
        }
      },
      async (tx, attempt) => {
        if (attempt.managerBindingId !== expected.id)
          throw new DeliveryConflict("manager_binding_conflict");
        const changed = await tx.deliveryManagerBinding.updateMany({
          where: { ownerId, id: expected.id, activeAttemptId: null, blockedReason: null },
          data: { activeAttemptId: attempt.id },
        });
        if (changed.count !== 1) throw new DeliveryConflict("checkout_writer_busy");
      },
    );
    const common = { schemaVersion: 1, eventId: input.eventId };
    switch (input.command.operation) {
      case "create_task":
        return repository.createTask(ownerId, {
          ...input.command.payload,
          ...common,
          projectId: thread.projectId,
          conversationId: thread.conversationId,
          managerBindingId: expected.id,
          sourceSha: input.checkoutBinding.revision,
        });
      case "claim_step": {
        const claimPayload = input.command.payload;
        if (
          !this.dependencies.allowedModelEfforts?.some(
            (value) =>
              value.model === claimPayload.requestedModel &&
              value.effort === claimPayload.requestedEffort,
          )
        )
          throw new DeliveryConflict("native_model_policy_denied");
        return {
          ...(await repository.claimStep(ownerId, {
            ...input.command.payload,
            ...common,
            leaseHolder: `manager/${expected.id}/${input.nativeCallId}`.slice(0, 160),
            effectiveModel: null,
            effectiveEffort: null,
            nativeClaim: {
              managerThreadId: input.managerThreadId,
              parentTurnId: input.nativeTurnId,
              callId: input.nativeCallId,
            },
          })),
          managerBindingId: expected.id,
          checkoutBindingDigest: expected.bindingDigest,
          nativeSequence,
        };
      }
      case "complete_step":
      case "report_step":
      case "fail_attempt": {
        const payload = input.command.payload;
        if (input.command.operation === "complete_step")
          return repository.completeStep(ownerId, { ...payload, ...common });
        if (input.command.operation === "report_step")
          return repository.reportStep(ownerId, { ...payload, ...common });
        return repository.failAttempt(ownerId, { ...payload, ...common });
      }
      default:
        throw new DeliveryConflict("unsupported_manager_operation");
    }
  }
}
