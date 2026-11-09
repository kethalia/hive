import type { PrismaClient } from "@hive/db";
import { vi } from "vitest";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import {
  collectCompletionProviderFacts,
  completionServices,
} from "./acceptance-completion-fixture";

/** Actual signed source/native/semantic/repository/controller transitions.
 * Provider readbacks and model output remain explicit local fixture doubles. */
export async function verifiedEpicPreviewFixture(
  db: PrismaClient,
  options: NonNullable<Parameters<typeof acceptanceCandidateFixture>[2]> = {},
) {
  const f = await acceptanceCandidateFixture(db, undefined, options);
  for (const flag of [
    "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
    "HIVE_DELIVERY_EXECUTION_ENABLED",
    "HIVE_DELIVERY_MANAGER_ENABLED",
    "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
  ])
    vi.stubEnv(flag, "true");
  vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(f.store.producer));
  const service = completionServices(db, f).service;
  await service.dispatch(f.envelope({ action: "prepare_review", candidate: f.candidate }));
  const reviewed = await f.claimAndFinish(service, (job) => ({
    schemaVersion: 1,
    kind: "review",
    intentDigest: f.plan.intentDigest,
    planDigest: acceptanceDigest(f.plan),
    sourceSha: f.publication.headSha,
    inputDigest: job.inputDigest,
    outcome: "pass",
    requirements: f.plan.requirements.map((requirement) => ({
      id: requirement.id,
      meaningDigest: requireIntentDigest(requirement.meaning),
      outcome: requirement.phase === "implementation_preview" ? "pass" : "outside_step_scope",
      rationale: "Explicit fixture independent review of exact implementation source",
      citations:
        requirement.phase === "implementation_preview"
          ? [
              {
                entryId: "source:0",
                artifactDigest: f.candidate.manifest.files[0].contentDigest,
                start: 0,
                end: 10,
              },
            ]
          : [],
    })),
    unresolved: [],
    rationale: "Explicit independent model-output double",
  }));
  await collectCompletionProviderFacts(db, f, f.publication.operationId);
  const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } });
  const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
    where: { id: f.claim.managerBindingId },
  });
  const terminal = {
    schemaVersion: 1,
    managerBindingId: binding.id,
    taskId: f.taskId,
    stepId: f.stepId,
    attemptId: f.claim.attemptId,
    managerThreadId: f.managerThreadId,
    parentTurnId: f.parentTurnId,
    cursorVersion: binding.cursorVersion,
    nativeSequence: binding.nativeSequence,
    sourceContext: {
      revisionId: task.sourceRevisionId,
      version: task.sourceVersion,
      headSha: task.sourceSha,
    },
    observedAt: new Date().toISOString(),
    historyDigest: "1".repeat(64),
    loadedInventoryDigest: "2".repeat(64),
    sourceJournalDigest: "3".repeat(64),
    rootCompleted: true,
    pendingHandlers: 0,
    pendingObservers: 0,
    unknownInputs: 0,
    cohort: [
      {
        parentTurnId: f.source.parentTurnId,
        spawnCallId: f.source.spawnCallId,
        childThreadId: f.source.childThreadId,
        childTurnId: f.source.childTurnId,
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
    ],
  };
  const completion = await service.dispatch(f.envelope({ action: "complete_verified", terminal }));
  return { ...f, service, terminal, completion, semanticEvidenceId: reviewed.job.jobId };
}
