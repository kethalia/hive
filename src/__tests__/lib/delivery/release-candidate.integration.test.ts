import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { ReleaseCandidateResolver } from "@/lib/delivery/release-candidate.server";
import type { ReleaseRemoteObservation } from "@/lib/delivery/release-candidate-contracts";
import { repositoryPolicyAdapters } from "@/lib/delivery/repository-policy.server";
import {
  repositoryGateDescriptors,
  repositoryPolicyTextDigest,
} from "@/lib/delivery/repository-policy-contracts";
import { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { githubFixture } from "./github-fixture";

const url = process.env.HIVE_RELEASE_CANDIDATE_TEST_DATABASE_URL;
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
  return { f, adapters, policyStore, claim, accepted, collect, data };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function observation(x: Fixture): ReleaseRemoteObservation {
  const check = x.data.policy.checks[0];
  return {
    repositoryId: x.f.project.providerRepositoryId,
    pullRequestId: "900",
    pullNumber: 7,
    headRepositoryId: x.f.project.providerRepositoryId,
    baseRepositoryId: x.f.project.providerRepositoryId,
    headSha: x.accepted.sourceContext.headSha,
    baseRef: "main",
    baseSha: "c".repeat(40),
    state: "open",
    draft: false,
    observedAt: Date.now() - 100,
    expiresAt: Date.now() + 20000,
    rules: {
      repositoryId: x.f.project.providerRepositoryId,
      baseRef: "main",
      contentDigest: "f".repeat(64),
      complete: true,
      pullRequestRequired: true,
      requiredCheckSelectors: repositoryGateDescriptors(x.data.policy)
        .filter((g) => g.kind === "check")
        .map((g) => g.key),
      requireUpToDate: true,
      mergeQueueRequired: false,
      actorCanBypass: false,
    },
    testedMerge: {
      headSha: x.accepted.sourceContext.headSha,
      baseSha: "c".repeat(40),
      mergeSha: "d".repeat(40),
      workflowId: check.workflowId,
      workflowRevision: "e".repeat(40),
      appId: check.appId,
      event: "pull_request",
      runId: "12345",
      runAttempt: 1,
      succeeded: true,
    },
  };
}
const read = (x: Fixture) => ({
  ownerId: x.f.user.id,
  taskId: x.f.taskId,
  expectedSource: x.accepted.sourceContext,
});
async function snapshot(x: Fixture) {
  const where = { ownerId: x.f.user.id };
  // Hash full own rows rather than leaking private lease/proof material in output.
  return guardianDigest(
    await Promise.all([
      db.deliveryTask.findMany({ where }),
      db.deliveryStep.findMany({ where }),
      db.deliveryAttempt.findMany({ where }),
      db.deliveryEvent.findMany({ where, orderBy: { id: "asc" } }),
      db.deliveryEvidence.findMany({ where, orderBy: { id: "asc" } }),
      db.deliveryOutbox.findMany({ where }),
      db.deliveryManagerBinding.findMany({ where }),
      db.deliverySourceRevision.findMany({ where }),
      db.deliveryTaskPolicyBinding.findMany({ where }),
    ]),
  );
}

describe.skipIf(!url)("read-only release candidate assembled persistence", () => {
  it("reuses real policy/source/GitHub provenance but never promotes pending semantic acceptance", async () => {
    const x = await fixture();
    await x.collect(true);
    const before = await snapshot(x);
    const observer = vi.fn(async (_scope: unknown, _signal: AbortSignal) => observation(x));
    const result = await new ReleaseCandidateResolver(db, x.policyStore, {
      observe: observer,
    }).read(read(x));
    expect(result).toMatchObject({
      mode: "observation",
      target: "cloudflare_workers_after_owner_cutover",
      eligible: false,
      mergeAuthorized: false,
      deploymentAuthorized: false,
      source: x.accepted.sourceContext,
      pullRequest: { providerId: "900", number: 7, headSha: "b".repeat(40), baseRef: "main" },
      steps: [{ stepId: x.f.stepId, status: "blocked", evidenceIds: [] }],
    });
    expect(result?.blockers).toContainEqual({
      code: "acceptance_evaluator_provenance_pending",
      stepId: x.f.stepId,
    });
    expect(result?.blockers).not.toContainEqual({ code: "current_base_test_evidence_missing" });
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0][0]).toMatchObject({
      repositoryId: x.f.project.providerRepositoryId,
      headSha: x.accepted.sourceContext.headSha,
      providerId: "900",
    });
    expect(await snapshot(x)).toBe(before);
  });
  it("missing independent review and absent provider factory remain explicit blockers", async () => {
    const x = await fixture();
    await x.collect(false);
    const result = await new ReleaseCandidateResolver(db, x.policyStore).read(read(x));
    expect(result?.blockers).toContainEqual({ code: "remote_release_observer_unavailable" });
    expect(result?.blockers).toContainEqual({
      code: "github_policy_evidence_missing",
      stepId: x.f.stepId,
    });
    expect(result?.eligible).toBe(false);
  });
  it("rejects wrong head/base/rules/tested-run evidence without changing the source", async () => {
    const x = await fixture();
    await x.collect();
    const before = await snapshot(x);
    const cases: [string, (o: ReleaseRemoteObservation) => void][] = [
      [
        "remote_pull_request_changed",
        (o) => {
          o.headSha = "0".repeat(40);
        },
      ],
      [
        "remote_pull_request_changed",
        (o) => {
          o.baseRef = "another";
        },
      ],
      [
        "remote_pull_request_changed",
        (o) => {
          o.pullRequestId = "901";
        },
      ],
      [
        "effective_branch_rules_insufficient",
        (o) => {
          o.rules.requireUpToDate = false;
        },
      ],
      [
        "effective_branch_rules_insufficient",
        (o) => {
          o.rules.actorCanBypass = true;
        },
      ],
      [
        "required_repository_checks_not_enforced",
        (o) => {
          o.rules.requiredCheckSelectors = [];
        },
      ],
      [
        "current_base_test_evidence_missing",
        (o) => {
          o.baseSha = "0".repeat(40);
        },
      ],
      [
        "current_base_test_evidence_missing",
        (o) => {
          if (o.testedMerge) o.testedMerge.workflowId = "999";
        },
      ],
      [
        "remote_release_observation_stale",
        (o) => {
          o.expiresAt = Date.now() - 1;
        },
      ],
    ];
    for (const [code, change] of cases) {
      const value = observation(x);
      change(value);
      const result = await new ReleaseCandidateResolver(db, x.policyStore, {
        observe: async () => value,
      }).read(read(x));
      expect(result?.blockers).toContainEqual({ code });
      expect(result?.mergeAuthorized).toBe(false);
    }
    expect(await snapshot(x)).toBe(before);
  });
  it("foreign owners, stale caller source, disabled and revoked policies cannot become candidates", async () => {
    const x = await fixture();
    const resolver = new ReleaseCandidateResolver(db, x.policyStore);
    expect(await resolver.read({ ...read(x), ownerId: randomUUID() })).toBeNull();
    const stale = await resolver.read({
      ...read(x),
      expectedSource: { ...x.accepted.sourceContext, headSha: "0".repeat(40) },
    });
    expect(stale?.blockers).toContainEqual({ code: "source_context_stale" });
    const disabled = new RepositoryPolicyStore(db, {
      enabled: false,
      readCatalog: () => [],
      verifyRepository: async () => {
        throw new Error("No enrollment from a read");
      },
    });
    expect(
      (await new ReleaseCandidateResolver(db, disabled).read(read(x)))?.blockers,
    ).toContainEqual({
      code: "repository_policy_disabled",
    });
    const pin = await db.deliveryTaskPolicyBinding.findUniqueOrThrow({
      where: { ownerId_taskId: { ownerId: x.f.user.id, taskId: x.f.taskId } },
    });
    await x.policyStore.revokeVersion(x.f.user.id, x.f.project.id, pin.policyVersionId);
    expect((await resolver.read(read(x)))?.blockers).toContainEqual({
      code: "repository_policy_revoked",
    });
  });
  it("revalidates concurrent revocation after the remote read rather than using the initial policy", async () => {
    const x = await fixture();
    await x.collect();
    let enter!: () => void;
    let finish!: (value: ReleaseRemoteObservation) => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const observed = new Promise<ReleaseRemoteObservation>((r) => {
      finish = r;
    });
    const result = new ReleaseCandidateResolver(db, x.policyStore, {
      observe: async () => {
        enter();
        return observed;
      },
    }).read(read(x));
    await entered;
    const pin = await db.deliveryTaskPolicyBinding.findUniqueOrThrow({
      where: { ownerId_taskId: { ownerId: x.f.user.id, taskId: x.f.taskId } },
    });
    await x.policyStore.revokeVersion(x.f.user.id, x.f.project.id, pin.policyVersionId);
    finish(observation(x));
    expect((await result)?.blockers).toEqual(
      expect.arrayContaining([
        { code: "repository_policy_revoked" },
        { code: "release_snapshot_changed" },
      ]),
    );
  });
  it("bounds a stalled remote read, aborts its signal and returns no raw failure data", async () => {
    const x = await fixture();
    let aborted = false;
    const before = await snapshot(x);
    const result = await new ReleaseCandidateResolver(db, x.policyStore, {
      observe: async (_scope, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("synthetic-private-provider-detail"));
            },
            { once: true },
          );
        }),
    }).read(read(x));
    expect(aborted).toBe(true);
    expect(result?.blockers).toContainEqual({ code: "remote_release_observation_unavailable" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-detail");
    expect(await snapshot(x)).toBe(before);
  });
  it("incomplete effective rules are unknown rather than inferred from passing checks", async () => {
    const x = await fixture();
    await x.collect();
    const value = observation(x);
    const result = await new ReleaseCandidateResolver(db, x.policyStore, {
      observe: async () => ({ ...value, rules: { ...value.rules, complete: false } }),
    }).read(read(x));
    expect(result?.blockers).toContainEqual({ code: "remote_release_observation_unavailable" });
    expect(result?.remote).toBeNull();
    expect(result?.eligible).toBe(false);
  });
});
