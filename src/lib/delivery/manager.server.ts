import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { requireAppliedSourceForAction } from "@/lib/codex-session/guardian-application-gate.server";
import type { GuardianPolicy } from "@/lib/codex-session/guardian-contracts";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import type { SourceContext } from "./contracts";
import { githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import {
  authenticateCheckoutHost,
  lockManagerCheckout,
  managerCheckoutIdentity,
} from "./manager-binding.server";
import { managerEnvelopeSchema, managerProofPayload } from "./manager-contracts";
import { authorizeProgressionClaim } from "./progression.server";
import { DeliveryRepository, type EvidencePolicy } from "./repository";
import { resolveAttemptSource, resolveTaskSource } from "./source-resolver.server";
import { DeliveryConflict } from "./state";

if (typeof window !== "undefined") throw new Error("Delivery manager is server-only.");
export interface ManagerDependencies {
  // Real deployment uses fresh server-owned Coder owner/build/app authorization.
  reauthorize(binding: RegistrationBinding): Promise<RegistrationBinding>;
  // Controller-owned adapter policy, never read from the host envelope.
  evidencePolicy?: EvidencePolicy;
  resolveEvidencePolicy?(
    scope: ManagerPolicyScope,
    tx?: Prisma.TransactionClient,
  ): Promise<ResolvedManagerEvidencePolicy | null> | ResolvedManagerEvidencePolicy | null;
  bindTaskPolicy?(
    tx: Prisma.TransactionClient,
    ownerId: string,
    taskId: string,
    preparationIntentId: string,
  ): Promise<void>;
  authorizeTaskPolicy?(
    tx: Prisma.TransactionClient,
    ownerId: string,
    taskId: string,
    operation: string,
  ): Promise<void>;
  allowedModelEfforts?: readonly { model: string; effort: string }[];
  // Test/explicit controller composition only. Routes/config do not opt in.
  progressionProtocol?: 1;
  // Trusted constructor only; production defaults to the deployment guardian gate.
  guardianPolicy?: GuardianPolicy;
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
  sourceRevisionId?: string;
  sourceVersion?: number;
  sourcePullNumber?: number;
}
export interface ResolvedManagerEvidencePolicy {
  mandatoryRepositoryGates?: true;
  pendingRequirements?: readonly {
    stepId: string;
    criterionId: string;
    kind: string;
    reason: "acceptance_evaluator_unavailable" | "acceptance_evaluator_provenance_pending";
  }[];
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
  context?: SourceContext,
): Promise<ManagerPolicyScope> {
  const source = await resolveTaskSource(tx, ownerId, taskId, context, true);
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
    ...(source.context
      ? {
          sourceRevisionId: source.context.revisionId,
          sourceVersion: source.context.version,
          sourcePullNumber: source.task.currentSourceRevision?.pullNumber,
        }
      : {}),
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
                guardianPolicy: this.dependencies.guardianPolicy,
                allowBlocked: input.command.operation === "fail_attempt",
              });
              const scope = await loadPolicyScope(
                tx,
                ownerId,
                resultCommand.payload.taskId,
                resultCommand.payload.stepId,
                host,
                input.sourceContext,
              );
              return resolvePolicy(scope, tx);
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
    let currentSourceContext: SourceContext | undefined;
    let claimInputSha: string | undefined;
    let progression: Awaited<ReturnType<typeof authorizeProgressionClaim>> | null = null;
    const progressionReceipt = () =>
      progression ? { cursorVersion: progression.cursorVersion, progressionProtocol: 1 } : {};
    const repository = new DeliveryRepository(
      this.db,
      selectedPolicy?.policy ?? this.dependencies.evidencePolicy,
      async (tx) => {
        const scope = await lockManagerCheckout(tx, input, registered, {
          guardianPolicy: this.dependencies.guardianPolicy,
          create: input.command.operation === "create_task",
          allowBlocked: input.command.operation === "fail_attempt",
          progressionProtocol: this.dependencies.progressionProtocol,
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
            task.managerBindingId !== scope.binding.id
          )
            throw new RegistrationRejected();
          const source = await resolveTaskSource(tx, ownerId, task.id, input.sourceContext, true);
          currentSourceContext = source.context;
          claimInputSha = source.headSha;
          await this.dependencies.authorizeTaskPolicy?.(
            tx,
            ownerId,
            task.id,
            input.command.operation,
          );
        } else if (input.sourceContext) {
          throw new DeliveryConflict("source_context_stale");
        }
        const operation = input.command.operation;
        await requireAppliedSourceForAction(tx, {
          ownerId,
          managerBindingId: scope.binding.id,
          ...(operation === "create_task" ? {} : { taskId: input.command.payload.taskId }),
          action:
            operation === "complete_step"
              ? "completion"
              : operation === "report_step"
                ? "report"
                : operation === "fail_attempt"
                  ? "failure"
                  : "execution",
          ...(operation === "complete_step" ||
          operation === "report_step" ||
          operation === "fail_attempt"
            ? { attemptId: input.command.payload.attemptId }
            : {}),
          parentTurnId: input.nativeTurnId,
        });
        if (resultCommand && resolvePolicy) {
          const currentScope = await loadPolicyScope(
            tx,
            ownerId,
            resultCommand.payload.taskId,
            resultCommand.payload.stepId,
            scope,
            input.sourceContext,
          );
          const currentPolicy = await resolvePolicy(currentScope, tx);
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
          if (scope.binding.progressionProtocol === 1) {
            progression = await authorizeProgressionClaim(tx, ownerId, scope.binding, input);
            nativeSequence = progression.sequence;
          } else if (input.continuation) {
            throw new DeliveryConflict("progression_disabled");
          } else if (scope.binding.activeAttemptId) {
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
          if (
            scope.binding.progressionProtocol === 1 &&
            scope.binding.currentAttemptId !== attempt.id
          ) {
            const replay = await tx.deliveryEvent.findUnique({
              where: { ownerId_id: { ownerId, id: input.eventId } },
            });
            if (replay?.attemptId !== attempt.id)
              throw new DeliveryConflict("native_attempt_not_current");
          }
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
        if (progression) {
          if (
            input.command.operation !== "claim_step" ||
            (progression.continuing && !input.continuation)
          )
            throw new DeliveryConflict("invalid_continuation");
          const continuation = input.continuation;
          const changed = await tx.deliveryManagerBinding.updateMany({
            where: {
              ownerId,
              id: expected.id,
              progressionProtocol: 1,
              blockedReason: null,
              cursorVersion: progression.cursorVersion - 1,
              ...(progression.continuing
                ? { currentAttemptId: continuation?.priorAttemptId }
                : { activeAttemptId: null, currentAttemptId: null }),
            },
            data: {
              currentAttemptId: attempt.id,
              cursorVersion: progression.cursorVersion,
              ...(!progression.continuing ? { activeAttemptId: attempt.id } : {}),
            },
          });
          if (changed.count !== 1) throw new DeliveryConflict("checkout_writer_busy");
          if (progression.continuing && continuation)
            await tx.deliveryEvent.create({
              data: {
                id: randomUUID(),
                ownerId,
                taskId: input.command.payload.taskId,
                attemptId: attempt.id,
                stepId: input.command.payload.stepId,
                aggregateKey: `boundary-consumed/${continuation.boundaryEventId}`,
                aggregateVersion: 1,
                type: "native_boundary_consumed",
                policyVersion: "manager-progression-v1",
                requestDigest: githubSourceDigest({
                  claimEventId: input.eventId,
                  continuation: input.continuation,
                }),
                payload: {
                  boundaryEventId: continuation.boundaryEventId,
                  claimEventId: input.eventId,
                  cursorVersion: progression.cursorVersion,
                },
              },
            });
          return;
        }
        const changed = await tx.deliveryManagerBinding.updateMany({
          where: { ownerId, id: expected.id, activeAttemptId: null, blockedReason: null },
          data: { activeAttemptId: attempt.id },
        });
        if (changed.count !== 1) throw new DeliveryConflict("checkout_writer_busy");
      },
      async (tx, attempts) => {
        if (
          !progression?.continuing ||
          attempts.some(
            (attempt) =>
              attempt.managerBindingId !== expected.id ||
              !["reported", "succeeded"].includes(attempt.outcome),
          )
        )
          throw new DeliveryConflict("native_reconciliation_required");
        if (input.command.operation !== "claim_step")
          throw new DeliveryConflict("invalid_continuation");
        for (const attempt of attempts)
          await resolveAttemptSource(tx, ownerId, input.command.payload.taskId, attempt.id, false);
      },
      async (tx, task) => {
        await this.dependencies.bindTaskPolicy?.(
          tx,
          ownerId,
          task.id,
          input.checkoutBinding.preparationIntentId,
        );
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
          ...(await repository.claimStep(
            ownerId,
            {
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
            },
            () =>
              progression
                ? {
                    cursorVersion: progression.cursorVersion,
                    sequence: progression.sequence,
                    ...(input.continuation ? { continuation: input.continuation } : {}),
                    ...(currentSourceContext ? { sourceContext: currentSourceContext } : {}),
                  }
                : undefined,
          )),
          managerBindingId: expected.id,
          checkoutBindingDigest: expected.bindingDigest,
          nativeSequence,
          ...progressionReceipt(),
          ...(currentSourceContext ? { sourceContext: currentSourceContext } : {}),
          inputSourceSha: claimInputSha,
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
