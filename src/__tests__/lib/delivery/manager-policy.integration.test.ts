import { randomUUID, sign } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { githubEvidenceProducer } from "@/lib/delivery/github-persistence.server";
import {
  resolveControllerGitHubManagerPolicy,
  resolveControllerGitHubTargetPolicy,
} from "@/lib/delivery/github-policy.server";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
import { DeliveryManagerService, type ManagerPolicyScope } from "@/lib/delivery/manager.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { githubFixture } from "./github-fixture";
import { nativeFixture } from "./native-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const report = {
  summary: "Synthetic external-source result",
  difficulty: "low",
  difficultyReason: "Bounded policy fixture",
  issues: [],
  remainingUncertainty: "No live account or production proof",
  nextAction: "Review",
};
function afterTransaction(hook: () => Promise<void>) {
  let called = false;
  return new Proxy(db, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: {
          maxWait?: number;
          timeout?: number;
          isolationLevel?: Prisma.TransactionIsolationLevel;
        },
      ) => {
        const value = await target.$transaction(fn, options);
        if (!called) {
          called = true;
          await hook();
        }
        return value;
      };
    },
  });
}
async function fixture(informational = false) {
  const f = await nativeFixture(db),
    data = githubFixture();
  await f.create(
    informational
      ? {
          ...f.definition,
          steps: [
            { ...f.definition.steps[0], kind: "understand", requiredEvidenceKinds: ["analysis"] },
          ],
        }
      : f.definition,
  );
  const attempt = await f.claim();
  await f.native.ingest(
    f.sourceEnvelope(
      attempt,
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
    f.sourceEnvelope(attempt, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
  );
  data.snapshot.providerAccountId = f.project.providerAccountId;
  data.snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
  data.snapshot.pullRequest.baseRepositoryId = f.project.providerRepositoryId;
  data.snapshot.pullRequest.headRepositoryId = f.project.providerRepositoryId;
  data.snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
  const config = { pullNumber: 5, policy: data.policy },
    read = () => JSON.stringify({ [f.taskId]: config });
  const resolve = vi.fn((scope: ManagerPolicyScope) =>
    resolveControllerGitHubManagerPolicy(scope, read),
  );
  const service = (client = db, resolver = resolve) =>
    new DeliveryManagerService(client, { ...f.dependencies, resolveEvidencePolicy: resolver });
  const source = new GitHubSourceTransport(
    db,
    {
      reauthorize: f.dependencies.reauthorize,
      resolveTargetPolicy: ({ taskId }) => resolveControllerGitHubTargetPolicy(taskId, read),
    },
    {
      writeAndVerify: async (_key, content, digest) => ({
        contentDigest: digest,
        size: content.length,
      }),
    },
  );
  function envelope(phase: "challenge" | "snapshot", extra: Record<string, unknown>) {
    const value = {
      schemaVersion: 1,
      action: "collect_github_evidence",
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      taskId: f.taskId,
      stepId: f.stepId,
      issuedAt: Date.now() - 100,
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
  async function publish() {
    const challenge = await source.requestChallenge(
      envelope("challenge", { requestId: randomUUID() }),
    );
    return source.ingest(
      envelope("snapshot", {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        policyDigest: challenge.policyDigest,
        snapshot: data.snapshot,
      }),
    );
  }
  const completion = (evidenceIds: string[]) =>
    f.managerEnvelope({
      operation: "complete_step",
      payload: {
        taskId: f.taskId,
        stepId: f.stepId,
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        leaseGeneration: attempt.leaseGeneration,
        sourceSha: f.context.revision,
        evidenceIds,
        report,
      },
    });
  return { ...f, data, config, read, resolve, service, attempt, publish, completion };
}
describe.skipIf(!url)("manager completion with independently sourced controller policy", () => {
  it("accepts only the configured source chain, replays one report, and never frees the native writer", async () => {
    const f = await fixture(),
      evidence = await f.publish(),
      input = f.completion(evidence.evidenceIds),
      manager = f.service();
    const result = await manager.execute(input);
    expect(result).toMatchObject({ replayed: false });
    expect(await manager.execute(input)).toMatchObject({ replayed: true });
    expect(f.resolve).toHaveBeenCalledTimes(4);
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(1);
    const attempt = await db.deliveryAttempt.findUniqueOrThrow({
      where: { id: f.attempt.attemptId },
    });
    expect(attempt.quiescedAt).toBeNull();
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.attempt.managerBindingId },
        })
      ).activeAttemptId,
    ).toBe(attempt.id);
    expect((await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).releaseMode).toBe(
      "disabled",
    );
  });
  it("a manager cannot omit configured review by declaring a check-only step or selecting only passed checks", async () => {
    const f = await fixture(),
      evidence = await f.publish();
    const checks = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, id: { in: evidence.evidenceIds }, kind: "check" },
    });
    await expect(f.service().execute(f.completion(checks.map((row) => row.id)))).rejects.toThrow(
      "github_policy_evidence_missing",
    );
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("failed CI cannot be converted into a successful structured report", async () => {
    const f = await fixture();
    f.data.snapshot.checks[0].conclusion = "failure";
    f.data.snapshot.workflowRuns[0].jobs[0].conclusion = "failure";
    const evidence = await f.publish();
    await expect(f.service().execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "invalid_evidence",
    );
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("two required checks sharing C1 produce no passing subset when one check is missing", async () => {
    const f = await fixture();
    f.config.policy.checks.push({
      ...f.config.policy.checks[0],
      name: "Required lint",
      workflowId: "999",
    });
    const evidence = await f.publish();
    const checks = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, kind: "check" },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).not.toBe("passed");
    await expect(f.service().execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "invalid_evidence",
    );
    const passed = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, status: "passed" },
    });
    await expect(f.service().execute(f.completion(passed.map((row) => row.id)))).rejects.toThrow(
      "github_policy_evidence_missing",
    );
  });
  it("two required reviewers sharing C1 produce no passing subset when one review is missing", async () => {
    const f = await fixture();
    f.config.policy.codexReview = null;
    f.config.policy.formalReviewers = [
      { userId: "9", criterionIds: ["C1"] },
      { userId: "999", criterionIds: ["C1"] },
    ];
    const evidence = await f.publish();
    const reviews = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, kind: "review" },
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).not.toBe("passed");
    await expect(f.service().execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "invalid_evidence",
    );
    const passed = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, status: "passed" },
    });
    await expect(f.service().execute(f.completion(passed.map((row) => row.id)))).rejects.toThrow(
      "github_policy_evidence_missing",
    );
  });
  it("a producer label without an authenticated challenge/receipt/publication chain is insufficient", async () => {
    const f = await fixture(),
      producer = githubEvidenceProducer(f.context.repositoryId, f.config.policy);
    const repository = new DeliveryRepository(db, {
      version: f.config.policy.version,
      trustedProducers: [producer],
      maxAgeMs: 60000,
    });
    const id = randomUUID();
    await repository.recordEvidence(f.user.id, producer, {
      id,
      stepId: f.stepId,
      remoteId: "self-asserted-fixture",
      kind: "check",
      status: "passed",
      sourceSha: f.context.revision,
      verificationMode: "integration",
      environment: "synthetic-fixture",
      criterionIds: ["C1"],
      objectKey: `delivery/${f.user.id}/fixture/untrusted.json`,
      contentDigest: "e".repeat(64),
      observedAt: new Date(Date.now() - 100),
    });
    await expect(f.service().execute(f.completion([id]))).rejects.toThrow(
      "github_evidence_provenance_missing",
    );
  });
  it("same-head PR target changes cannot reuse the earlier PR's evidence", async () => {
    const f = await fixture(),
      evidence = await f.publish();
    f.config.pullNumber++;
    await expect(f.service().execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "github_evidence_target_mismatch",
    );
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("changed policy under a reused version label or removed task policy cannot trust old references", async () => {
    const f = await fixture(),
      evidence = await f.publish();
    f.config.policy.checks[0].events = ["push"];
    await expect(f.service().execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "github_evidence_scope_mismatch",
    );
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      resolveEvidencePolicy: (scope) => resolveControllerGitHubManagerPolicy(scope, () => "{}"),
    });
    await expect(manager.execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "github_task_policy_missing",
    );
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("policy drift between selection and result transaction rejects all report/event/outbox writes", async () => {
    const f = await fixture(),
      evidence = await f.publish();
    const client = afterTransaction(async () => {
      f.config.policy.maxAgeMs++;
    });
    await expect(f.service(client).execute(f.completion(evidence.evidenceIds))).rejects.toThrow(
      "manager_policy_changed",
    );
    expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
    expect(
      await db.deliveryEvent.count({ where: { ownerId: f.user.id, type: "step_completed" } }),
    ).toBe(0);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("registration revocation or source changes after policy selection cannot commit a report", async () => {
    for (const changed of ["registration", "source"] as const) {
      const f = await fixture(),
        evidence = await f.publish();
      const client = afterTransaction(async () => {
        if (changed === "registration")
          await db.codexHostRegistration.update({
            where: { id: f.registration().id },
            data: { revokedAt: new Date() },
          });
        else
          await db.deliveryTask.update({
            where: { id: f.taskId },
            data: { sourceSha: "b".repeat(40) },
          });
      });
      await expect(f.service(client).execute(f.completion(evidence.evidenceIds))).rejects.toThrow();
      expect(await db.deliveryStepReport.count({ where: { ownerId: f.user.id } })).toBe(0);
    }
  });
  it("policy resolution cannot run before host authentication or outside the persisted owner task scope", async () => {
    const f = await fixture(),
      other = await fixture();
    const input = f.completion([randomUUID()]);
    input.proof = "a".repeat(86);
    await expect(f.service().execute(input)).rejects.toThrow();
    await expect(
      f.service().execute(
        f.managerEnvelope({
          operation: "complete_step",
          payload: {
            ...(f.completion([randomUUID()]).command as { payload: Record<string, unknown> })
              .payload,
            taskId: other.taskId,
          },
        }),
      ),
    ).rejects.toThrow();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("an early informational failure needs no GitHub config and grants no acceptance or quiescence", async () => {
    const f = await fixture(true);
    const manager = new DeliveryManagerService(db, {
      ...f.dependencies,
      resolveEvidencePolicy: () => {
        throw new Error("No PR exists yet");
      },
    });
    await manager.execute(
      f.managerEnvelope({
        operation: "fail_attempt",
        payload: {
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: f.attempt.attemptId,
          expectedVersion: f.attempt.version,
          leaseGeneration: f.attempt.leaseGeneration,
          sourceSha: f.context.revision,
          disposition: "blocked",
          reason: "Analysis requires an independently trusted informational adapter",
          evidenceIds: [],
          report,
        },
      }),
    );
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } })).state).toBe(
      "blocked",
    );
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.attempt.attemptId } }))
        .quiescedAt,
    ).toBeNull();
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
});
