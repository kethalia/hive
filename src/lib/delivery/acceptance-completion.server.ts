import { randomUUID } from "node:crypto";
import type { Prisma } from "@hive/db";
import { requireAppliedSourceForAction } from "@/lib/codex-session/guardian-application-gate.server";
import {
  type AcceptanceTerminal,
  acceptanceTerminalSchema,
} from "./acceptance-completion-contracts";
import { acceptanceDeploymentConfig } from "./acceptance-config.server";
import { acceptanceDigest } from "./acceptance-contracts";
import type { AcceptanceMaterialResolver } from "./acceptance-material.server";
import {
  acceptanceEvidenceProducer,
  authorizeAcceptanceEvidence,
} from "./acceptance-policy.server";
import type { AcceptanceAuthority } from "./acceptance-store.server";
import { completeStepInTransaction } from "./completion-transaction.server";
import { nativeRuntimeBindingSchema } from "./contracts";
import type { ManagerPolicyScope, ResolvedManagerEvidencePolicy } from "./manager.server";
import { NATIVE_OBSERVER_PRODUCER } from "./native-contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
function check(value: unknown, reason = "acceptance_completion_scope_changed"): asserts value {
  if (!value) throw new DeliveryConflict(reason);
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const terminalIdentity = ({ observedAt: _time, ...v }: AcceptanceTerminal) => v;
/** Installed controller only. This is a factual completion of independently
 * verified work; it never authors a model narrative or marks a writer quiescent. */
export class AcceptanceSuccessController {
  constructor(
    private readonly material: AcceptanceMaterialResolver,
    private readonly resolvePolicy: (
      scope: ManagerPolicyScope,
      tx: Tx,
    ) => Promise<ResolvedManagerEvidencePolicy | null>,
  ) {}
  async complete(tx: Tx, authority: AcceptanceAuthority, managerBindingId: string, raw: unknown) {
    const terminal = acceptanceTerminalSchema.parse(raw),
      configured = acceptanceDeploymentConfig();
    check(configured, "acceptance_completion_disabled");
    const current = await this.material.current(tx, authority.ownerId, managerBindingId),
      { binding, attempt, bound, revision, plan } = current;
    await tx.$queryRaw`SELECT id FROM delivery_tasks WHERE owner_id=${authority.ownerId}::uuid AND id=${bound.task.id}::uuid FOR UPDATE`;
    const clock = async () =>
      (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    const fresh = (now: Date) =>
      check(
        Date.parse(terminal.observedAt) <= now.getTime() &&
          now.getTime() - Date.parse(terminal.observedAt) <= 30000,
        "acceptance_completion_terminal_stale",
      );
    const now = await clock();
    fresh(now);
    check(
      binding.id === terminal.managerBindingId &&
        binding.currentAttemptId === terminal.attemptId &&
        binding.nativeThreadId === terminal.managerThreadId &&
        binding.nativeThreadId === authority.managerThreadId &&
        binding.serverInstanceId === authority.serverInstanceId &&
        !binding.blockedReason &&
        binding.cursorVersion === terminal.cursorVersion &&
        binding.nativeSequence === terminal.nativeSequence &&
        binding.preparationIntentId === authority.preparationIntentId &&
        bound.task.id === terminal.taskId &&
        bound.task.projectId === authority.projectId &&
        attempt.stepId === terminal.stepId &&
        attempt.outputRevisionId === revision.id &&
        revision.id === terminal.sourceContext.revisionId &&
        revision.version === terminal.sourceContext.version &&
        revision.headSha === terminal.sourceContext.headSha &&
        plan.producerDigest === acceptanceDigest(configured) &&
        !bound.task.pauseRequested &&
        !bound.task.schedulingPaused &&
        attempt.leaseExpiresAt > now &&
        ["implement", "review", "validate"].includes(attempt.step.kind) &&
        attempt.step.acceptancePhase === "implementation_preview" &&
        !attempt.step.requiredEvidenceKinds.some((k) => ["change", "migration"].includes(k)),
    );
    const claim = await tx.deliveryEvent.findFirstOrThrow({
      where: { ownerId: authority.ownerId, attemptId: attempt.id, type: "attempt_started" },
    });
    const nativeClaim = (
      claim.payload as {
        nativeClaim: { parentTurnId: string; managerThreadId: string; cursorVersion: number };
      }
    ).nativeClaim;
    check(
      nativeClaim.parentTurnId === terminal.parentTurnId &&
        nativeClaim.managerThreadId === terminal.managerThreadId &&
        nativeClaim.cursorVersion === terminal.cursorVersion,
    );
    // Compare every recorded child in this native lifetime, not merely the most
    // recent attempted step. Background process state remains unknown/held.
    const cohort = await tx.deliveryAttempt.findMany({
      where: {
        ownerId: authority.ownerId,
        managerBindingId: binding.id,
        runtimeBindingDigest: { not: null },
      },
      take: 21,
    });
    check(
      cohort.length <= 20 &&
        cohort.length === terminal.cohort.length &&
        new Set(terminal.cohort.map((c) => c.childThreadId)).size === terminal.cohort.length,
    );
    for (const member of cohort) {
      const runtime = nativeRuntimeBindingSchema.parse(member.runtimeBinding),
        observed = await tx.deliveryEvent.findFirst({
          where: {
            ownerId: authority.ownerId,
            attemptId: member.id,
            type: {
              in: [
                "native_attempt_observed",
                "native_source_conflict",
                "native_command_observed",
                "native_runtime_started",
              ],
            },
          },
          orderBy: { aggregateVersion: "desc" },
        });
      const fact = observed?.payload as {
        producer?: string;
        nativeSourceKind?: string;
        turnStatus?: string;
        source?: { parentTurnId: string };
      } | null;
      check(
        runtime.serverInstanceId === authority.serverInstanceId &&
          runtime.managerThreadId === authority.managerThreadId &&
          observed?.type === "native_attempt_observed" &&
          fact?.producer === NATIVE_OBSERVER_PRODUCER &&
          fact.nativeSourceKind === "turn_completed" &&
          fact.turnStatus === "completed" &&
          terminal.cohort.some(
            (c) =>
              c.parentTurnId === fact.source?.parentTurnId &&
              c.spawnCallId === runtime.operationId &&
              c.childThreadId === runtime.nativeThreadId &&
              c.childTurnId === runtime.nativeTurnId &&
              c.effectiveModel === member.effectiveModel &&
              c.effectiveEffort === member.effectiveEffort,
          ),
        "acceptance_completion_cohort_unfinished",
      );
    }
    check(
      cohort.some((c) => c.id === attempt.id),
      "acceptance_completion_execution_unverified",
    );
    await requireAppliedSourceForAction(tx, {
      ownerId: authority.ownerId,
      managerBindingId: binding.id,
      taskId: bound.task.id,
      action: "completion",
      attemptId: attempt.id,
      parentTurnId: terminal.parentTurnId,
    });
    const project = await tx.deliveryProject.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: authority.ownerId, id: bound.task.projectId } },
    });
    const scope: ManagerPolicyScope = {
      ownerId: authority.ownerId,
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
    };
    const policy = await this.resolvePolicy(scope, tx);
    check(
      policy?.mandatoryRepositoryGates && !policy.pendingRequirements?.length,
      "acceptance_completion_policy_unavailable",
    );
    const evidence = await tx.deliveryEvidence.findMany({
      where: {
        ownerId: authority.ownerId,
        stepId: attempt.stepId,
        sourceSha: revision.headSha,
        status: "passed",
        invalidatedAt: null,
        producer: { in: [...policy.policy.trustedProducers] },
        policyVersion: policy.policy.version,
        observedAt: { gte: new Date(now.getTime() - policy.policy.maxAgeMs), lte: now },
      },
      orderBy: { id: "asc" },
      take: 41,
    });
    check(evidence.length <= 40, "acceptance_completion_evidence_limit");
    const ids = evidence.map((e) => e.id);
    await policy.authorizeReferences(tx, ids, true);
    const semantic = ids.filter(
      (id) =>
        evidence.find((e) => e.id === id)?.producer ===
        acceptanceEvidenceProducer(acceptanceDigest(configured)),
    );
    check(semantic.length > 0, "acceptance_completion_semantics_missing");
    await authorizeAcceptanceEvidence(tx, scope, authority.preparationIntentId, semantic, true);
    const aggregateKey = `acceptance-success/${attempt.id}`,
      identity = {
        ownerId: authority.ownerId,
        registrationId: authority.registrationId,
        serverInstanceId: authority.serverInstanceId,
        managerBindingId,
        sourceContext: terminal.sourceContext,
        policyDigest: bound.binding.policyDigest,
        planDigest: plan.planDigest,
        producerDigest: plan.producerDigest,
        terminal: terminalIdentity(terminal),
      };
    const previous = await tx.deliveryEvent.findUnique({
      where: {
        ownerId_aggregateKey_aggregateVersion: {
          ownerId: authority.ownerId,
          aggregateKey,
          aggregateVersion: 1,
        },
      },
    });
    if (previous) {
      const saved = previous.payload as {
        identity: unknown;
        receipt: { eventId: string; reportId: string; version: number };
      };
      check(
        previous.type === "acceptance_success_completed" &&
          previous.taskId === terminal.taskId &&
          previous.stepId === terminal.stepId &&
          previous.attemptId === terminal.attemptId &&
          previous.requestDigest === acceptanceDigest(identity) &&
          acceptanceDigest(saved.identity) === acceptanceDigest(identity) &&
          attempt.outcome === "succeeded" &&
          attempt.step.state === "succeeded" &&
          attempt.step.version === saved.receipt.version,
        "acceptance_completion_replay_changed",
      );
      fresh(await clock());
      return {
        phase: "completed",
        scope: terminalIdentity(terminal),
        receipt: saved.receipt,
        sourceContext: terminal.sourceContext,
        writerHeld: true,
        executionAuthorized: false,
        publicationAuthorized: false,
        cleanupAuthorized: false,
      };
    }
    check(
      attempt.outcome === "running" && attempt.step.state === "running",
      "acceptance_completion_attempt_not_running",
    );
    fresh(await clock());
    const receipt = await completeStepInTransaction(
      tx,
      authority.ownerId,
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        taskId: bound.task.id,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        expectedVersion: attempt.step.version,
        leaseGeneration: attempt.leaseGeneration,
        sourceSha: revision.headSha,
        evidenceIds: ids,
        report: {
          summary: `Controller recorded independent verification of accepted source ${revision.headSha}.`,
          difficulty: "unknown",
          difficultyReason:
            "No manager difficulty assessment was received; this report contains controller-observed facts only.",
          issues: [],
          remainingUncertainty:
            "Independent checks and scoped semantic review passed. This is not a correctness guarantee or a physical-writer quiescence claim.",
          nextAction:
            "Apply accepted metadata through the existing protected source/input barrier; retain the physical writer until separately authorized.",
        },
      },
      policy.policy,
      async () => {},
    );
    await tx.deliveryEvent.create({
      data: {
        id: randomUUID(),
        ownerId: authority.ownerId,
        taskId: bound.task.id,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        aggregateKey,
        aggregateVersion: 1,
        type: "acceptance_success_completed",
        policyVersion: policy.policy.version,
        requestDigest: acceptanceDigest(identity),
        payload: json({ identity, receipt, evidenceIds: ids }),
      },
    });
    return {
      phase: "completed",
      scope: terminalIdentity(terminal),
      receipt,
      sourceContext: terminal.sourceContext,
      writerHeld: true,
      executionAuthorized: false,
      publicationAuthorized: false,
      cleanupAuthorized: false,
    };
  }
}
