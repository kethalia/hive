import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import {
  repositoryGateDescriptors,
  repositoryPolicyTextDigest,
} from "@/lib/delivery/repository-policy-contracts";
import { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { githubFixture } from "./github-fixture";

const url = process.env.HIVE_REPOSITORY_POLICY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Private local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());

async function fixture(semantic = true) {
  let policyStore: RepositoryPolicyStore | undefined;
  const data = githubFixture();
  data.policy.checks[0].criterionIds = ["repo:ci"];
  if (data.policy.codexReview) data.policy.codexReview.criterionIds = ["repo:review"];
  const policy = {
    schemaVersion: 1,
    source: {
      version: "fixture-source-v1",
      authorName: "Hive",
      authorEmail: "fixture@example.invalid",
      baseBranch: "main",
      allowedPrefixes: ["src"],
      maxFiles: 5,
      maxFileBytes: 1024,
      maxBytes: 4096,
    },
    evidenceGates: data.policy,
    acceptanceContracts: semantic
      ? [
          {
            id: "narrow-fixture",
            intentTextDigest: repositoryPolicyTextDigest(
              "Guardian storage synthetic task; no account inference",
            ),
            taskOutcomeDigest: repositoryPolicyTextDigest("Native observer synthetic fixture"),
            criteria: [
              {
                id: "C1",
                meaning: "Only the reviewed synthetic fixture outcome is evaluated.",
                kind: "check",
                evaluatorGateKeys: [
                  repositoryGateDescriptors(data.policy).find((g) => g.kind === "check")?.key,
                ],
              },
            ],
          },
        ]
      : [],
  };
  const f = await guardianFixture(db, {
    beforeIntent: async ({ user, project, context }) => {
      policyStore = new RepositoryPolicyStore(db, {
        enabled: true,
        readCatalog: () => [
          {
            ownerId: user.id,
            repositoryId: project.providerRepositoryId,
            providerAccountId: project.providerAccountId,
            fullName: project.fullName,
            policy,
          },
        ],
        verifyRepository: async () => ({
          repositoryId: project.providerRepositoryId,
          providerAccountId: project.providerAccountId,
          fullName: project.fullName,
          defaultBranch: "main",
          defaultRevision: context.revision,
          archived: false,
          permissions: { pull: true, push: true },
        }),
      });
      const selected = await policyStore.enroll(user.id, project.id),
        store = policyStore;
      return db.$transaction((tx) =>
        store.pinIntent(
          tx,
          {
            ownerId: user.id,
            projectId: project.id,
            repositoryId: context.repositoryId,
            providerAccountId: project.providerAccountId,
            sourceSha: context.revision,
            text: "Guardian storage synthetic task; no account inference",
          },
          selected,
        ),
      );
    },
  });
  if (!policyStore) throw new Error("Fixture policy missing");
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_APPROVED_PACKAGES_JSON", JSON.stringify(f.guardian.policy.packages));
  const adapters = repositoryPolicyAdapters(policyStore);
  const manager = new DeliveryManagerService(db, {
    ...f.dependencies,
    progressionProtocol: 1,
    resolveEvidencePolicy: adapters.resolveEvidencePolicy,
    bindTaskPolicy: adapters.bindCreatedTask,
    authorizeTaskPolicy: adapters.authorizeTaskPolicy,
  });
  const definition = {
    ...f.definition,
    steps: [
      { id: f.stepId, kind: "implement", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
    ],
  };
  await manager.execute(f.managerEnvelope({ operation: "create_task", payload: definition }));
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
  const operationId = randomUUID(),
    publication = {
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
      treeSha: "d".repeat(40),
      manifestDigest: "e".repeat(64),
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
      // Explicit local publication authority; no provider/network mutation. The
      // production transport separately requires the actual protected broker proof.
      verify: async () => ({ publication, proofDigest: guardianDigest(publication) }),
      authorizeTransaction: async (tx) => {
        await adapters.resolvePolicy(
          { ownerId: f.user.id, taskId: f.taskId, repositoryId: f.project.providerRepositoryId },
          tx,
        );
      },
    },
  });
  const accepted = z
    .object({
      sourceContext: z.object({ revisionId: z.string(), version: z.number(), headSha: z.string() }),
    })
    .parse(await publisher.accept({ localFixtureAuthority: true }));
  const transport = new GitHubSourceTransport(
    db,
    { reauthorize: f.dependencies.reauthorize, resolveTargetPolicy: adapters.resolveTargetPolicy },
    {
      writeAndVerify: async (_key, bytes, digest) => ({
        contentDigest: digest,
        size: bytes.length,
      }),
    },
  );
  function wire(phase: "challenge" | "snapshot", extra: object) {
    const value = {
      schemaVersion: 1,
      action: "collect_github_evidence",
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      taskId: f.taskId,
      stepId: f.stepId,
      sourceContext: accepted.sourceContext,
      issuedAt: Date.now() - 1,
      expiresAt: Date.now() + 30000,
      ...extra,
    };
    return {
      ...value,
      proof: sign(
        null,
        Buffer.from(githubTransportProofPayload(phase, value)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
  }
  async function collect(review = true) {
    const snapshot = githubFixture().snapshot;
    snapshot.providerAccountId = f.project.providerAccountId;
    snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
    Object.assign(snapshot.pullRequest, {
      id: "900",
      number: 7,
      headSha: publication.headSha,
      headRepositoryId: f.project.providerRepositoryId,
      baseRepositoryId: f.project.providerRepositoryId,
    });
    snapshot.workflowRuns[0].headSha = publication.headSha;
    snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
    snapshot.checks[0].headSha = publication.headSha;
    snapshot.reviews[0].commitId = publication.headSha;
    if (snapshot.reviewSummaries[0].marker)
      snapshot.reviewSummaries[0].marker.code_review.commit_sha = publication.headSha;
    if (!review) snapshot.reviewSummaries = [];
    const grant = await transport.requestChallenge(wire("challenge", { requestId: randomUUID() }));
    expect(grant.target.pullNumber).toBe(7);
    await transport.ingest(
      wire("snapshot", {
        challengeId: grant.id,
        nonce: grant.nonce,
        policyDigest: grant.policyDigest,
        snapshot,
      }),
    );
    return (
      await db.deliveryEvidence.findMany({
        where: {
          ownerId: f.user.id,
          stepId: f.stepId,
          sourceSha: publication.headSha,
          status: "passed",
          invalidatedAt: null,
        },
      })
    ).map((v) => v.id);
  }
  const complete = (evidenceIds: string[]) =>
    manager.execute(
      f.managerEnvelope(
        {
          operation: "complete_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            attemptId: claim.attemptId,
            leaseGeneration: claim.leaseGeneration,
            expectedVersion: claim.version,
            sourceSha: publication.headSha,
            evidenceIds,
            report: {
              summary: "Specific synthetic fixture",
              difficulty: "low",
              difficultyReason: "Fixture",
              issues: [],
              remainingUncertainty: "No provider writes",
              nextAction: "Retain physical writer",
            },
          },
        },
        { sourceContext: accepted.sourceContext },
      ),
    );
  const claimAgain = () =>
    manager.execute(
      f.managerEnvelope(
        {
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            expectedVersion: claim.version,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        },
        { sourceContext: accepted.sourceContext },
      ),
    );
  return { f, adapters, policyStore, claim, accepted, collect, complete, claimAgain };
}

describe.skipIf(!url)("repository policy in signed manager/source/evidence lifecycle", () => {
  it("automatically binds policy before publication and derives exact accepted PR; omitted independent review blocks completion", async () => {
    const x = await fixture();
    const incomplete = await x.collect(false);
    await expect(x.complete(incomplete)).rejects.toThrow("github_policy_evidence_missing");
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: x.f.stepId } })).state).toBe(
      "running",
    );
    // A separate positive fixture preserves the real 60-second collection rate
    // fence; this test does not rewrite source event clocks to force a refresh.
    const ready = await fixture();
    const complete = await ready.collect(true);
    await expect(ready.complete(complete)).rejects.toThrow(
      "acceptance_evaluator_provenance_pending",
    );
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: ready.f.stepId } })).state).toBe(
      "running",
    );
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: ready.claim.attemptId } }))
        .quiescedAt,
    ).toBeNull();
  });
  it("actual signed next-claim path cannot pass repository subsets or pending semantic acceptance after source advance", async () => {
    const partial = await fixture();
    await partial.collect(false);
    await expect(partial.claimAgain()).rejects.toThrow("github_policy_evidence_missing");
    const reviewed = await fixture();
    await reviewed.collect(true);
    const before = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: reviewed.claim.managerBindingId },
    });
    await expect(reviewed.claimAgain()).rejects.toThrow("acceptance_evaluator_provenance_pending");
    const after = await db.deliveryManagerBinding.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.cursorVersion).toBe(before.cursorVersion);
    expect(after.currentAttemptId).toBe(before.currentAttemptId);
    expect(await db.deliveryAttempt.count({ where: { ownerId: reviewed.f.user.id } })).toBe(1);
    // Local source application is independently still pending; no fake completed
    // step, source-application receipt, root boundary or physical drain is seeded.
  });
  it("generic CI plus Codex review never certifies unmatched task meaning", async () => {
    const x = await fixture(false),
      evidence = await x.collect();
    await expect(x.complete(evidence)).rejects.toThrow("acceptance_evaluator_unavailable");
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: x.f.stepId } })).state).toBe(
      "running",
    );
  });
  it("revoked pinned version rejects a current signed manager request even with passing evidence", async () => {
    const x = await fixture(),
      evidence = await x.collect();
    const binding = await db.deliveryTaskPolicyBinding.findUniqueOrThrow({
      where: { ownerId_taskId: { ownerId: x.f.user.id, taskId: x.f.taskId } },
    });
    await x.policyStore.revokeVersion(x.f.user.id, x.f.project.id, binding.policyVersionId);
    await expect(x.complete(evidence)).rejects.toThrow("repository_policy_revoked");
  });
});
