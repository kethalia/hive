import { randomUUID } from "node:crypto";
import { decrypt } from "@hive/auth";
import { Prisma, type PrismaClient } from "@hive/db";
import { requireAppliedSourceForAction } from "@/lib/codex-session/guardian-application-gate.server";
import type { GuardianPolicy } from "@/lib/codex-session/guardian-contracts";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { inheritedAcceptanceCriteriaSchema } from "./acceptance-contracts";
import { acceptancePlanForIntent } from "./acceptance-policy.server";
import { refreshProductionForClaim } from "./acceptance-production.server";
import { repairWriterHeld } from "./acceptance-repair.server";
import type { SourceContext } from "./contracts";
import { bindEpicAcceptance } from "./epic-acceptance";
import { authorizeEpicClaim } from "./epic-claim.server";
import { epicDigest, epicPlanSchema } from "./epic-contracts";
import { writeEpicPlan } from "./epic-plan.server";
import { compileManagerEpicProposal, managerEpicContext } from "./epic-planning.server";
import { githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import {
  authenticateCheckoutHost,
  lockManagerCheckout,
  managerCheckoutReference,
} from "./manager-binding.server";
import { managerEnvelopeSchema, managerProofPayload } from "./manager-contracts";
import { authorizeProgressionClaim, recheckMaintenanceClaimDeadline } from "./progression.server";
import { DeliveryRepository, type EvidencePolicy } from "./repository";
import { repositoryPolicyStore } from "./repository-policy.server";
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
  epicModelTiers?: readonly { tier: string; model: string; effort: string }[];
  // Test/explicit controller composition only. Routes/config do not opt in.
  progressionProtocol?: 1;
  // Trusted constructor only; production defaults to the deployment guardian gate.
  guardianPolicy?: GuardianPolicy;
  epicPlanEncryptionKey?: string;
  /** Deployment-owned, reviewed workspace/PVC enrollment; never from the host. */
  epicIsolationPolicy?: unknown;
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
    task.conversationId !== host.binding.conversationId ||
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

  async execute(value: unknown, signal?: AbortSignal) {
    const input = managerEnvelopeSchema.parse(value);
    const wire = value as Record<string, unknown>;
    const registered = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      managerProofPayload(wire),
    );
    const ownerId = registered.ownerId;
    const productionClaimReplay = async (
      tx: Prisma.TransactionClient,
      managerBindingId: string,
    ) => {
      if (
        input.command.operation !== "claim_step" ||
        process.env.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED !== "true"
      )
        return false;
      const prior = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId, id: input.eventId } },
      });
      if (prior?.type !== "attempt_started" || !prior.attemptId) return false;
      const attempt = await tx.deliveryAttempt.findUnique({
        where: { ownerId_id: { ownerId, id: prior.attemptId } },
        include: { step: true },
      });
      if (attempt?.step.acceptancePhase !== "activation_production") return false;
      if (
        prior.taskId !== input.command.payload.taskId ||
        prior.stepId !== input.command.payload.stepId ||
        attempt.managerBindingId !== managerBindingId ||
        attempt.stepId !== prior.stepId
      )
        throw new DeliveryConflict("event_replay_conflict");
      return true;
    };
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
    const expected = await managerCheckoutReference(
      this.db,
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
    if (
      input.command.operation === "write_epic_plan" ||
      input.command.operation === "read_epic_context" ||
      input.command.operation === "plan_epic"
    ) {
      const command = input.command;
      const key = this.dependencies.epicPlanEncryptionKey;
      if (!key) throw new DeliveryConflict("epic_planning_disabled");
      return this.db.$transaction(
        async (tx) => {
          const host = await lockManagerCheckout(tx, input, registered, {
            guardianPolicy: this.dependencies.guardianPolicy,
          });
          if (host.binding.id !== expected.id) throw new RegistrationRejected();
          const task = await tx.deliveryTask.findUnique({
            where: { ownerId_id: { ownerId, id: command.payload.taskId } },
          });
          if (
            !task ||
            task.projectId !== host.thread.projectId ||
            task.conversationId !== host.binding.conversationId ||
            task.managerBindingId !== host.binding.id
          )
            throw new RegistrationRejected();
          await resolveTaskSource(tx, ownerId, task.id, input.sourceContext, true);
          await requireAppliedSourceForAction(tx, {
            ownerId,
            managerBindingId: host.binding.id,
            taskId: task.id,
            action: "execution",
            parentTurnId: input.nativeTurnId,
          });
          if (command.operation === "write_epic_plan") {
            const catalog =
              this.dependencies.epicModelTiers ??
              (this.dependencies.allowedModelEfforts ?? []).map((pair) => ({
                tier: "default",
                ...pair,
              }));
            if (
              !catalog.length ||
              command.payload.plan.tasks.some(
                (node) =>
                  !catalog.some(
                    (tier) =>
                      tier.tier === node.modelTier &&
                      tier.model === node.model &&
                      tier.effort === node.effort,
                  ),
              )
            )
              throw new DeliveryConflict("epic_model_policy_changed");
            const { taskId: _taskId, ...planInput } = command.payload;
            return writeEpicPlan(tx, ownerId, task.id, planInput, key);
          }
          if (!this.dependencies.epicIsolationPolicy)
            throw new DeliveryConflict("epic_isolation_unverified");
          const context = await managerEpicContext(
            tx,
            ownerId,
            task.id,
            this.dependencies.epicIsolationPolicy,
            this.dependencies.epicModelTiers ??
              (this.dependencies.allowedModelEfforts ?? []).map((pair) => ({
                tier: "default",
                ...pair,
              })),
            key,
            repositoryPolicyStore(this.db),
          );
          if (command.operation === "read_epic_context")
            return {
              schemaVersion: 1,
              replayed: false,
              taskId: task.id,
              epicId: context.task.epic?.id,
              projectId: context.task.projectId,
              outcome: context.task.epic?.outcome,
              criteria: context.acceptance.plan.requirements.map((r) => ({
                id: r.id,
                meaning: r.meaning,
                phase: r.phase,
              })),
              expectedPlanVersion: context.head?.version ?? 0,
              expectedPlanDigest: context.head?.plan_digest ?? null,
              currentPlan: context.head?.plan ?? null,
              currentTasks: context.currentTasks,
              workspaces: context.workspaces,
              modelTiers: context.catalog,
            };
          return writeEpicPlan(
            tx,
            ownerId,
            task.id,
            compileManagerEpicProposal(ownerId, context, command.payload),
            key,
          );
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 10000,
        },
      );
    }
    const resultCommand =
      input.command.operation === "complete_step" ||
      (input.command.operation === "fail_attempt" && input.command.payload.evidenceIds.length > 0)
        ? input.command
        : null;
    if (
      input.command.operation === "claim_step" &&
      process.env.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED === "true"
    ) {
      const command = input.command;
      const captured = await this.db.$transaction(
        async (tx) => {
          const host = await lockManagerCheckout(tx, input, registered, {
            guardianPolicy: this.dependencies.guardianPolicy,
            progressionProtocol: this.dependencies.progressionProtocol,
          });
          if (host.binding.id !== expected.id) throw new RegistrationRejected();
          const task = await tx.deliveryTask.findUnique({
            where: { ownerId_id: { ownerId, id: command.payload.taskId } },
          });
          const step = await tx.deliveryStep.findUnique({
            where: {
              ownerId_taskId_id: {
                ownerId,
                taskId: command.payload.taskId,
                id: command.payload.stepId,
              },
            },
          });
          if (
            !task ||
            !step ||
            task.projectId !== host.thread.projectId ||
            task.conversationId !== host.thread.conversationId ||
            task.managerBindingId !== host.binding.id
          )
            throw new RegistrationRejected();
          if (step.acceptancePhase !== "activation_production") return null;
          // This only skips a read-only freshness collection. The existing
          // progression/repository replay still compares the entire claim.
          if (await productionClaimReplay(tx, host.binding.id)) return null;
          if (task.pauseRequested || task.schedulingPaused)
            throw new DeliveryConflict("task_paused");
          if (step.version !== command.payload.expectedVersion)
            throw new DeliveryConflict("version_conflict");
          if (!["pending", "ready"].includes(step.state))
            throw new DeliveryConflict("step_not_ready");
          const source = await resolveTaskSource(tx, ownerId, task.id, input.sourceContext, true);
          if (!source.context) throw new DeliveryConflict("source_context_stale");
          await this.dependencies.authorizeTaskPolicy?.(tx, ownerId, task.id, "claim_step");
          await requireAppliedSourceForAction(tx, {
            ownerId,
            managerBindingId: host.binding.id,
            taskId: task.id,
            action: "execution",
            parentTurnId: input.nativeTurnId,
          });
          return {
            ownerId,
            taskId: task.id,
            sourceRevisionId: source.context.revisionId,
            sourceSha: source.headSha,
            step: {
              kind: step.kind,
              acceptancePhase: step.acceptancePhase,
              requiredEvidenceKinds: step.requiredEvidenceKinds,
            },
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 10000,
          maxWait: 5000,
        },
      );
      if (captured) await refreshProductionForClaim(this.db, captured, signal);
    }
    let selectedPolicy: ResolvedManagerEvidencePolicy | null = null;
    const resolvePolicy = this.dependencies.resolveEvidencePolicy;
    if (resultCommand && resolvePolicy) {
      for (let retry = 0; ; retry++) {
        try {
          selectedPolicy = await this.db.$transaction(
            async (tx) => {
              const host = await lockManagerCheckout(tx, input, registered, {
                guardianPolicy: this.dependencies.guardianPolicy,
                maintenanceObservation: true,
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
          maintenanceObservation: ["report_step", "complete_step", "fail_attempt"].includes(
            input.command.operation,
          ),
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
            task.conversationId !== scope.binding.conversationId ||
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
            // A server-matched historical claim receipt grants no execution.
            // Keep current repository/revocation checks, while the existing
            // progression/repository replay validates its full request digest.
            (await productionClaimReplay(tx, scope.binding.id))
              ? "claim_step_replay"
              : input.command.operation,
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
          const task = await tx.deliveryTask.findUniqueOrThrow({
            where: { ownerId_id: { ownerId, id: input.command.payload.taskId } },
          });
          if (task.epicId) {
            const heads = await tx.$queryRaw<{ authored_by_task_id: string }[]>`
              SELECT p.authored_by_task_id FROM delivery_epic_plan_heads h
              JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
              WHERE h.owner_id=${ownerId}::uuid AND h.epic_id=${task.epicId}::uuid`;
            if (heads.length && heads[0].authored_by_task_id !== task.id) {
              if (!this.dependencies.epicIsolationPolicy)
                throw new DeliveryConflict("epic_isolation_unverified");
              if (!input.command.payload.requestedModel || !input.command.payload.requestedEffort)
                throw new DeliveryConflict("epic_model_policy_changed");
              await authorizeEpicClaim(
                tx,
                ownerId,
                task,
                this.dependencies.epicIsolationPolicy,
                this.db,
                {
                  model: input.command.payload.requestedModel,
                  effort: input.command.payload.requestedEffort,
                },
              );
            }
          }
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
          } else if (input.continuation || input.maintenanceContinuation) {
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
            (progression.continuing && !input.continuation && !input.maintenanceContinuation)
          )
            throw new DeliveryConflict("invalid_continuation");
          const continuation = input.continuation;
          if ("repairId" in progression && progression.repairId)
            await tx.deliveryEvent.create({
              data: {
                id: randomUUID(),
                ownerId,
                taskId: input.command.payload.taskId,
                stepId: input.command.payload.stepId,
                attemptId: attempt.id,
                aggregateKey: `repair-consumed/${progression.repairId}`,
                aggregateVersion: 1,
                type: "acceptance_repair_consumed",
                policyVersion: "acceptance-repair-v1",
                requestDigest: githubSourceDigest({
                  repairId: progression.repairId,
                  claimEventId: input.eventId,
                }),
                payload: { repairId: progression.repairId, claimEventId: input.eventId },
              },
            });
          const changed = await tx.deliveryManagerBinding.updateMany({
            where: {
              ownerId,
              id: expected.id,
              progressionProtocol: 1,
              blockedReason: null,
              cursorVersion: progression.cursorVersion - 1,
              ...(progression.continuing
                ? {
                    currentAttemptId:
                      continuation?.priorAttemptId ??
                      ("priorAttemptId" in progression ? progression.priorAttemptId : undefined),
                  }
                : { activeAttemptId: null, currentAttemptId: null }),
            },
            data: {
              currentAttemptId: attempt.id,
              cursorVersion: progression.cursorVersion,
              ...(!progression.continuing ? { activeAttemptId: attempt.id } : {}),
            },
          });
          if (changed.count !== 1) throw new DeliveryConflict("checkout_writer_busy");
          if ("maintenanceResumeEventId" in progression && progression.maintenanceResumeEventId)
            await tx.deliveryEvent.create({
              data: {
                id: randomUUID(),
                ownerId,
                taskId: input.command.payload.taskId,
                stepId: input.command.payload.stepId,
                attemptId: attempt.id,
                aggregateKey: `maintenance-claim/${progression.maintenanceResumeEventId}`,
                aggregateVersion: 1,
                type: "account_maintenance_claim_consumed",
                policyVersion: "account-maintenance-v1",
                requestDigest: githubSourceDigest({
                  claimEventId: input.eventId,
                  maintenanceContinuation: input.maintenanceContinuation,
                }),
                payload: {
                  claimEventId: input.eventId,
                  maintenanceContinuation: input.maintenanceContinuation,
                },
              },
            });
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
          await recheckMaintenanceClaimDeadline(tx, ownerId, input);
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
          attempts.some((attempt) => attempt.managerBindingId !== expected.id)
        )
          throw new DeliveryConflict("native_reconciliation_required");
        for (const attempt of attempts)
          if (
            !["reported", "succeeded"].includes(attempt.outcome) &&
            !(
              attempt.outcome === "failed" &&
              (await repairWriterHeld(tx, ownerId, expected.id, attempt.id))
            )
          )
            throw new DeliveryConflict("native_reconciliation_required");
        if (input.command.operation !== "claim_step")
          throw new DeliveryConflict("invalid_continuation");
        for (const attempt of attempts)
          await resolveAttemptSource(tx, ownerId, input.command.payload.taskId, attempt.id, false);
      },
      async (tx, task) => {
        if (input.command.operation === "create_task" && input.command.payload.epicId) {
          const epicId = input.command.payload.epicId;
          const existing = await tx.deliveryTask.count({
            where: { ownerId, epicId, id: { not: task.id } },
          });
          if (input.command.payload.initialEpic) {
            if (existing !== 0) throw new DeliveryConflict("epic_author_unbound");
          } else {
            const heads = await tx.$queryRaw<
              { plan: unknown; plan_digest: string; authored_by_task_id: string }[]
            >`
              SELECT p.plan,p.plan_digest,p.authored_by_task_id FROM delivery_epic_plan_heads h
              JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
              WHERE h.owner_id=${ownerId}::uuid AND h.epic_id=${epicId}::uuid FOR UPDATE OF h`;
            if (heads.length !== 1 || epicDigest(heads[0].plan) !== heads[0].plan_digest)
              throw new DeliveryConflict("epic_plan_unavailable");
            const plan = epicPlanSchema.parse(heads[0].plan);
            const node = plan.tasks.find(
              (item) => item.intentId === input.checkoutBinding.preparationIntentId,
            );
            const starts = await tx.$queryRaw<{ phase: string; plan_digest: string }[]>`
              SELECT phase,plan_digest FROM delivery_epic_start_intents WHERE owner_id=${ownerId}::uuid
              AND epic_id=${epicId}::uuid AND intent_id=${input.checkoutBinding.preparationIntentId}::uuid`;
            if (!node || starts.length !== 1 || starts[0].phase !== "accepted")
              throw new DeliveryConflict("epic_task_unbound");
            const acceptance = await acceptancePlanForIntent(tx, ownerId, node.intentId);
            const author = await tx.deliveryTask.findUnique({
              where: { ownerId_id: { ownerId, id: heads[0].authored_by_task_id } },
              include: { managerBinding: true },
            });
            if (!acceptance || !author?.managerBinding || author.epicId !== epicId)
              throw new DeliveryConflict("epic_acceptance_unbound");
            const root = await acceptancePlanForIntent(
              tx,
              ownerId,
              author.managerBinding.preparationIntentId,
            );
            if (!root) throw new DeliveryConflict("epic_acceptance_unbound");
            const requirements = node.criteria.map((id) => {
              const matches = root.plan.requirements.filter((r) => r.id === id);
              if (matches.length !== 1) throw new DeliveryConflict("epic_acceptance_unbound");
              return { id, meaning: matches[0].meaning, phase: matches[0].phase };
            });
            const inherited = {
              epicPlanDigest: starts[0].plan_digest,
              ownerPlanDigest: root.row.planDigest,
              requirements,
            };
            const captured = await tx.deliveryAcceptanceIntent.findUnique({
              where: { ownerId_intentId: { ownerId, intentId: node.intentId } },
            });
            if (
              !captured ||
              !this.dependencies.epicPlanEncryptionKey ||
              captured.intentDigest !== node.textDigest
            )
              throw new DeliveryConflict("epic_acceptance_unbound");
            const sealed = JSON.parse(
              decrypt(
                {
                  ciphertext: Buffer.from(captured.ciphertext),
                  iv: Buffer.from(captured.iv),
                  authTag: Buffer.from(captured.authTag),
                },
                this.dependencies.epicPlanEncryptionKey,
              ),
            );
            const stored = inheritedAcceptanceCriteriaSchema.parse(sealed.inheritedCriteria);
            if (
              sealed.ownerId !== ownerId ||
              sealed.projectId !== plan.projectId ||
              sealed.intentId !== node.intentId ||
              epicDigest(stored) !== epicDigest(inherited)
            )
              throw new DeliveryConflict("epic_acceptance_unbound");
            const mapping = bindEpicAcceptance(inherited, acceptance.plan);
            const binding = {
              planDigest: heads[0].plan_digest,
              ownerPlanDigest: root.row.planDigest,
              childPlanDigest: acceptance.row.planDigest,
              mapping,
            };
            await tx.deliveryEvent.create({
              data: {
                id: randomUUID(),
                ownerId,
                taskId: task.id,
                aggregateKey: `epic-acceptance/${task.id}`,
                aggregateVersion: 1,
                type: "epic_acceptance_bound",
                policyVersion: "epic-acceptance-v1",
                requestDigest: epicDigest(binding),
                payload: binding,
              },
            });
          }
        }
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
                    ...(input.maintenanceContinuation
                      ? { maintenanceContinuation: input.maintenanceContinuation }
                      : {}),
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
