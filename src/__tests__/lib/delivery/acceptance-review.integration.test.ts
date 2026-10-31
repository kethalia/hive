import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";

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
const fixture = (text?: string) => acceptanceCandidateFixture(db, text);
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
