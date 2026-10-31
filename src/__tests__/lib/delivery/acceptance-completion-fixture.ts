import { randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { AcceptanceSuccessController } from "@/lib/delivery/acceptance-completion.server";
import { AcceptanceMaterialResolver } from "@/lib/delivery/acceptance-material.server";
import { AcceptanceRepairController } from "@/lib/delivery/acceptance-repair.server";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { AcceptanceStore } from "@/lib/delivery/acceptance-store.server";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import type { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import { acceptanceFixtureKey } from "./acceptance-fixture";
import { githubFixture } from "./github-fixture";

type Fixture = Awaited<ReturnType<typeof acceptanceCandidateFixture>>;
/** Real policy and signed evidence transport; provider snapshot and object-storage
 * bytes are explicit local doubles. No network/provider writes. */
export function completionServices(db: PrismaClient, f: Fixture) {
  const adapters = repositoryPolicyAdapters(f.policies),
    material = new AcceptanceMaterialResolver(
      f.policies,
      repositoryPolicyAdapters(f.policies, { independentAcceptance: false }).resolveEvidencePolicy,
    ),
    store = new AcceptanceStore({
      enabled: true,
      encryptionKey: acceptanceFixtureKey,
      producer: f.store.producer,
      materializeReview: (tx, scope, value) => material.material(tx, scope, value),
    });
  const service = new DeliveryAcceptanceService(db, store, {
    policies: f.policies,
    reauthorize: f.dependencies.reauthorize,
    guardianPolicy: f.guardian.policy,
    repair: new AcceptanceRepairController(material, store),
    success: new AcceptanceSuccessController(material, adapters.resolveEvidencePolicy),
    prepareReview: (tx, host, candidate) =>
      material.prepare(tx, store, host.binding.ownerId, host.binding.id, candidate),
  });
  return { service, material, store };
}
export async function collectCompletionProviderFacts(
  db: PrismaClient,
  f: Fixture,
  operationId: string,
  options: { review?: boolean } = {},
) {
  const revision = await db.deliverySourceRevision.findFirstOrThrow({
      where: { ownerId: f.user.id, operationId },
    }),
    sourceContext = {
      revisionId: revision.id,
      version: revision.version,
      headSha: revision.headSha,
    },
    adapters = repositoryPolicyAdapters(f.policies),
    transport = new GitHubSourceTransport(
      db,
      {
        reauthorize: f.dependencies.reauthorize,
        resolveTargetPolicy: adapters.resolveTargetPolicy,
      },
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
      sourceContext,
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
  const snapshot = githubFixture().snapshot;
  snapshot.providerAccountId = f.project.providerAccountId;
  snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
  Object.assign(snapshot.pullRequest, {
    id: revision.pullRequestId,
    number: revision.pullNumber,
    headSha: revision.headSha,
    headRepositoryId: f.project.providerRepositoryId,
    baseRepositoryId: f.project.providerRepositoryId,
  });
  snapshot.workflowRuns[0].headSha = revision.headSha;
  snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
  snapshot.checks[0].headSha = revision.headSha;
  snapshot.reviews[0].commitId = revision.headSha;
  if (snapshot.reviewSummaries[0].marker)
    snapshot.reviewSummaries[0].marker.code_review.commit_sha = revision.headSha;
  if (options.review === false) snapshot.reviewSummaries = [];
  const grant = await transport.requestChallenge(wire("challenge", { requestId: randomUUID() }));
  await transport.ingest(
    wire("snapshot", {
      challengeId: grant.id,
      nonce: grant.nonce,
      policyDigest: grant.policyDigest,
      snapshot,
    }),
  );
  return db.deliveryEvidence.findMany({
    where: {
      ownerId: f.user.id,
      stepId: f.stepId,
      sourceSha: revision.headSha,
      status: "passed",
      invalidatedAt: null,
    },
  });
}
