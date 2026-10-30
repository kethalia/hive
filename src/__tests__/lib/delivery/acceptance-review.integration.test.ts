import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { AcceptanceMaterialResolver } from "@/lib/delivery/acceptance-material.server";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import { acceptanceGuardianFixture } from "./acceptance-guardian-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !(
      new URL(url).pathname.startsWith("/hive_acceptance_test") ||
      new URL(url).pathname === "/hive_delivery_test"
    ))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function fixture(text = "export const behavior = true;\n") {
  let material: AcceptanceMaterialResolver;
  const f = await acceptanceGuardianFixture(db, (tx, scope, stored) =>
    material.material(tx, scope, stored),
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
  const manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
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
    expectedRevisionId: null,
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
    prepareReview: (tx, host, value) =>
      material.prepare(tx, f.store, host.binding.ownerId, host.binding.id, value),
  });
  return { ...f, reviewer, claimAndFinish, candidate, plan, publication, claim, material };
}
describe.skipIf(!url)("independent acceptance candidate review", () => {
  it("binds exact accepted blob bytes and records only independent review evidence", async () => {
    const f = await fixture();
    const prepared = await f.reviewer.dispatch(
      f.envelope({ action: "prepare_review", candidate: f.candidate }),
    );
    expect(prepared.result).toMatchObject({ phase: "queued" });
    const completed = await f.claimAndFinish(f.reviewer, (job) => ({
      schemaVersion: 1,
      kind: "review",
      intentDigest: f.plan.intentDigest,
      planDigest: acceptanceDigest(f.plan),
      sourceSha: f.publication.headSha,
      inputDigest: job.inputDigest,
      outcome: "pass",
      requirements: [
        {
          id: "acceptance:behavior",
          meaningDigest: requireIntentDigest(f.plan.requirements[0].meaning),
          outcome: "pass",
          rationale: "Exact fixture source defines the requested behavior",
          citations: [
            {
              entryId: "source:0",
              artifactDigest: f.candidate.manifest.files[0].contentDigest,
              start: 0,
              end: 10,
            },
          ],
        },
      ],
      unresolved: [],
      rationale: "Synthetic evaluator result exercises trusted result plumbing only",
    }));
    const evidence = await db.deliveryEvidence.findUniqueOrThrow({
      where: { id: completed.job.jobId },
    });
    expect(evidence).toMatchObject({
      kind: "review",
      status: "passed",
      sourceSha: f.publication.headSha,
      criterionIds: ["acceptance:behavior"],
      environment: "codex-independent-readonly",
    });
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id, kind: "check" } })).toBe(
      0,
    );
    vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_EXECUTION_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(f.store.producer));
    const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } }),
      binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.claim.managerBindingId },
      });
    await db.$transaction(async (tx) => {
      const policy = await repositoryPolicyAdapters(f.policies).resolveEvidencePolicy(
        {
          ownerId: f.user.id,
          projectId: f.project.id,
          taskId: f.taskId,
          stepId: f.stepId,
          repositoryId: f.project.providerRepositoryId,
          providerAccountId: f.project.providerAccountId,
          fullName: f.project.fullName,
          sourceSha: f.publication.headSha,
          branch: task.branch,
          managerBindingId: binding.id,
          checkoutBindingDigest: binding.bindingDigest,
          stepKind: "implement",
          criterionIds: ["acceptance:behavior"],
          requiredEvidenceKinds: ["review"],
          acceptancePhase: "implementation_preview",
          sourceRevisionId: task.sourceRevisionId ?? undefined,
          sourceVersion: task.sourceVersion,
          sourcePullNumber: 7,
        },
        tx,
      );
      expect(policy?.policy.trustedProducers).toContain(evidence.producer);
      expect(policy?.pendingRequirements).toEqual([]);
      // Independent semantics cannot replace mandatory repository CI/review.
      await expect(policy?.authorizeReferences(tx, [evidence.id], true)).rejects.toThrow();
    });
    const first = evidence.observedAt;
    await f.reviewer.dispatch(f.envelope(completed.finish));
    expect(
      (await db.deliveryEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).observedAt,
    ).toEqual(first);
    expect(
      (
        await db.deliveryAttempt.findUniqueOrThrow({
          where: { id: f.claim.attemptId },
        })
      ).quiescedAt,
    ).toBeNull();
  });
  it("prepares a real accepted zero-byte blob without inventing source content", async () => {
    const f = await fixture("");
    expect(f.candidate.manifest.files[0]).toMatchObject({
      size: 0,
      blobSha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    });
    const prepared = await f.reviewer.dispatch(
      f.envelope({ action: "prepare_review", candidate: f.candidate }),
    );
    expect(prepared.result).toMatchObject({ phase: "queued" });
    expect(
      await db.deliveryAcceptanceJob.count({ where: { ownerId: f.user.id, kind: "review" } }),
    ).toBe(1);
  });
  it("rejects modified content, omitted files and host-selected replacement manifest", async () => {
    const f = await fixture();
    for (const candidate of [
      { ...f.candidate, contents: [] },
      { ...f.candidate, contents: [{ path: "src/behavior.ts", text: "return true" }] },
      { manifest: { files: [], deletions: [] }, contents: [] },
    ])
      await expect(
        f.reviewer.dispatch(f.envelope({ action: "prepare_review", candidate })),
      ).rejects.toThrow();
    expect(
      await db.deliveryAcceptanceJob.count({ where: { ownerId: f.user.id, kind: "review" } }),
    ).toBe(0);
  });
});
