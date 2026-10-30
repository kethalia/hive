import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { expect, vi } from "vitest";
import { z } from "zod";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { AcceptanceMaterialResolver } from "@/lib/delivery/acceptance-material.server";
import { AcceptanceRepairController } from "@/lib/delivery/acceptance-repair.server";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import type { acceptanceFixtureProducer } from "./acceptance-fixture";
import { acceptanceGuardianFixture } from "./acceptance-guardian-fixture";
export async function acceptanceCandidateFixture(
  db: PrismaClient,
  text = "export const behavior = true;\n",
  options: {
    producer?: typeof acceptanceFixtureProducer;
    native?: { managerThreadId?: string; parentTurnId?: string };
  } = {},
) {
  let material: AcceptanceMaterialResolver;
  const f = await acceptanceGuardianFixture(
    db,
    (tx, scope, stored) => material.material(tx, scope, stored),
    options.producer,
    options.native,
  );
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_APPROVED_PACKAGES_JSON", JSON.stringify(f.guardian.policy.packages));
  const service = f.service;
  const plan = {
    schemaVersion: 1,
    kind: "plan",
    intentDigest: requireIntentDigest(f.originalIntent),
    outcome: "ready",
    requirements: [
      {
        id: "acceptance:behavior",
        meaning: "Add the requested fixture behavior",
        phase: "implementation_preview",
        intentRanges: [{ start: 0, end: Buffer.byteLength(f.originalIntent) }],
        verification: "Inspect sealed exact source and independently observed checks",
      },
    ],
    unresolved: [],
    rationale: "Synthetic independent output; no account inference",
  };
  async function claimAndFinish(
    s: DeliveryAcceptanceService,
    output: (job: Record<string, unknown>) => unknown,
  ) {
    const claimed = await s.dispatch(f.envelope({ action: "claim_acceptance" }));
    const job = z
      .object({
        phase: z.literal("leased"),
        jobId: z.string(),
        leaseId: z.string(),
        leaseGeneration: z.number(),
        inputDigest: z.string(),
        producer: z.object({
          model: z.string(),
          effort: z.string(),
          permissionsDigest: z.string(),
        }),
      })
      .passthrough()
      .parse(claimed.result);
    const threadId = `evaluator-${randomUUID()}`;
    await s.dispatch(
      f.envelope({
        action: "start_acceptance",
        jobId: job.jobId,
        leaseId: job.leaseId,
        leaseGeneration: job.leaseGeneration,
        threadId,
      }),
    );
    const text = JSON.stringify(output(job)),
      now = Date.now();
    const finish = {
      action: "finish_acceptance",
      jobId: job.jobId,
      leaseId: job.leaseId,
      leaseGeneration: job.leaseGeneration,
      output: text,
      receipt: {
        threadId,
        turnId: `turn-${randomUUID()}`,
        runtimeVersion: "0.165.0",
        requestedModel: job.producer.model,
        effectiveModel: job.producer.model,
        requestedEffort: job.producer.effort,
        effectiveEffort: job.producer.effort,
        inputDigest: job.inputDigest,
        outputDigest: requireIntentDigest(text),
        configDigest: job.producer.permissionsDigest,
        startedAt: now - 1,
        completedAt: now,
        terminal: true,
        controllerCreated: true,
        unexpectedTools: 0,
        unexpectedChildren: 0,
      },
    };
    await s.dispatch(f.envelope(finish));
    return { job, finish };
  }
  await claimAndFinish(service, () => plan);
  const manager = new DeliveryManagerService(db, {
    ...f.dependencies,
    progressionProtocol: 1,
    authorizeTaskPolicy: repositoryPolicyAdapters(f.policies).authorizeTaskPolicy,
  });
  await manager.execute(
    f.managerEnvelope({
      operation: "create_task",
      payload: {
        ...f.definition,
        steps: [
          {
            id: f.stepId,
            kind: "implement",
            criterionIds: ["acceptance:behavior"],
            requiredEvidenceKinds: ["review"],
          },
        ],
      },
    }),
  );
  await db.$transaction((tx) =>
    f.policies.bindCreatedTask(tx, f.user.id, f.taskId, f.context.preparationIntentId),
  );
  const claim = z
    .object({
      attemptId: z.string(),
      managerBindingId: z.string(),
      leaseGeneration: z.number(),
      version: z.number(),
      nativeSequence: z.number(),
    })
    .parse(
      await manager.execute(
        f.managerEnvelope({
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            expectedVersion: 0,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        }),
      ),
    );
  await f.native.ingest(
    f.sourceEnvelope(
      claim,
      {
        ...f.source,
        kind: "started",
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
      1,
    ),
  );
  await f.native.ingest(
    f.sourceEnvelope(claim, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
  );
  const blobSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
  const candidate = {
    manifest: {
      files: [
        {
          path: "src/behavior.ts",
          contentDigest: requireIntentDigest(text),
          size: Buffer.byteLength(text),
          mode: "100644",
          blobSha,
        },
      ],
      deletions: [],
    },
    contents: [{ path: "src/behavior.ts", text }],
  };
  const operationId = randomUUID();
  const publication = {
    schemaVersion: 1,
    operationId,
    ownerId: f.user.id,
    taskId: f.taskId,
    stepId: f.stepId,
    attemptId: claim.attemptId,
    registrationId: f.registration().id,
    serverInstanceId: f.serverInstanceId,
    managerThreadId: f.managerThreadId,
    checkoutBinding: f.context,
    expectedSourceVersion: 0,
    expectedRevisionId: null as string | null,
    expectedCursorVersion: 1,
    expectedNativeSequence: 2,
    leaseGeneration: claim.leaseGeneration,
    parentSha: f.context.revision,
    headSha: "b".repeat(40),
    treeSha: "c".repeat(40),
    manifestDigest: acceptanceDigest(candidate.manifest),
    repositoryId: f.project.providerRepositoryId,
    providerAccountId: f.project.providerAccountId,
    fullName: f.project.fullName,
    branch: `codex/delivery/${f.taskId}/${operationId}`,
    baseBranch: "main",
    pullRequestId: "900",
    pullNumber: 7,
    issuedAt: Date.now() - 100,
    expiresAt: Date.now() + 30000,
  };
  const publisher = new DeliverySourcePublicationService(db, {
    reauthorize: f.dependencies.reauthorize,
    authority: {
      verify: async () => ({ publication, proofDigest: acceptanceDigest(publication) }),
      authorizeTransaction: async () => {},
    },
  });
  await publisher.accept({ explicitTrustedFixture: true });
  material = new AcceptanceMaterialResolver(f.policies, async () => ({
    policy: { ...f.policy, version: "acceptance-fixture-policy", trustedProducers: [] },
    authorityDigest: "f".repeat(64),
    authorizeReferences: async (_tx, ids) => {
      expect(ids).toEqual([]);
    },
  }));
  const reviewer = new DeliveryAcceptanceService(db, f.store, {
    policies: f.policies,
    reauthorize: async (b) => b,
    guardianPolicy: f.guardian.policy,
    repair: new AcceptanceRepairController(material, f.store),
    prepareReview: (tx, host, value) =>
      material.prepare(tx, f.store, host.binding.ownerId, host.binding.id, value),
  });
  return { ...f, manager, reviewer, claimAndFinish, candidate, plan, publication, claim, material };
}
