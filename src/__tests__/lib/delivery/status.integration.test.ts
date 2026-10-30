import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resolveControllerGitHubManagerPolicy } from "@/lib/delivery/github-policy.server";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
import { DeliveryManagerService, type ManagerDependencies } from "@/lib/delivery/manager.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { DeliveryStatusService } from "@/lib/delivery/status.server";
import { deliveryStatusProofPayload } from "@/lib/delivery/status-contracts";
import { guardianApplicationFixture } from "../codex-session/guardian-application-fixture";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { githubFixture } from "./github-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Isolated local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
function enable(policy: Awaited<ReturnType<typeof guardianFixture>>["guardian"]["policy"]) {
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_APPROVED_PACKAGES_JSON", JSON.stringify(policy.packages));
}
type Fixture = Awaited<ReturnType<typeof guardianFixture>>;
type Claim = { attemptId: string; managerBindingId: string; leaseGeneration: number };
function envelope(f: Omit<Fixture, "claim">, claim: Claim, patch = {}) {
  const value = {
    schemaVersion: 1,
    action: "read_delivery_status",
    requestId: randomUUID(),
    registrationId: f.registration().id,
    serverInstanceId: f.serverInstanceId,
    managerThreadId: f.managerThreadId,
    checkoutBinding: f.context,
    managerBindingId: claim.managerBindingId,
    taskId: f.taskId,
    stepId: f.stepId,
    attemptId: claim.attemptId,
    attemptLeaseGeneration: claim.leaseGeneration,
    inputSourceSha: f.context.revision,
    inputSourceContext: null,
    issuedAt: Date.now() - 1,
    expiresAt: Date.now() + 20000,
    ...patch,
  };
  return {
    ...value,
    proof: sign(null, Buffer.from(deliveryStatusProofPayload(value)), f.keys.privateKey).toString(
      "base64url",
    ),
  };
}
async function fixture() {
  const f = await guardianFixture(db);
  enable(f.guardian.policy);
  const manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
  await manager.execute(f.managerEnvelope({ operation: "create_task", payload: f.definition }));
  const claim = z
    .object({ attemptId: z.string(), managerBindingId: z.string(), leaseGeneration: z.number() })
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
  const read = (patch = {}, dependencies: Partial<ManagerDependencies> = {}) =>
    new DeliveryStatusService(db, { ...f.dependencies, ...dependencies }).read(
      envelope(f, claim, patch),
    );
  return { ...f, claim, read };
}
describe.skipIf(!url)("current-claim factual delivery status with real guardian locks", () => {
  it("uses actual challenge/publication watermarks and independently scoped GitHub policy", async () => {
    const f = await fixture(),
      data = githubFixture();
    data.snapshot.providerAccountId = f.project.providerAccountId;
    data.snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
    data.snapshot.pullRequest.baseRepositoryId = f.project.providerRepositoryId;
    data.snapshot.pullRequest.headRepositoryId = f.project.providerRepositoryId;
    data.snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
    const config = { pullNumber: 5, policy: data.policy };
    const service = new GitHubSourceTransport(
      db,
      { reauthorize: f.dependencies.reauthorize, resolveTargetPolicy: () => config },
      {
        writeAndVerify: async (_key, bytes, digest) => ({
          contentDigest: digest,
          size: bytes.length,
        }),
      },
    );
    const wire = (phase: "challenge" | "snapshot", extra: Record<string, unknown>) => {
      const value = {
        schemaVersion: 1,
        action: "collect_github_evidence",
        registrationId: f.registration().id,
        serverInstanceId: f.serverInstanceId,
        managerThreadId: f.managerThreadId,
        checkoutBinding: f.context,
        taskId: f.taskId,
        stepId: f.stepId,
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
    };
    const resolver = (scope: Parameters<typeof resolveControllerGitHubManagerPolicy>[0]) =>
      resolveControllerGitHubManagerPolicy(scope, () => JSON.stringify({ [f.taskId]: config }));
    expect((await f.read({}, { resolveEvidencePolicy: resolver })).evidence.requirementStatus).toBe(
      "missing",
    );
    const challenge = await service.requestChallenge(
      wire("challenge", { requestId: randomUUID() }),
    );
    await service.ingest(
      wire("snapshot", {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        policyDigest: challenge.policyDigest,
        snapshot: data.snapshot,
      }),
    );
    const ready = await f.read({}, { resolveEvidencePolicy: resolver });
    expect(ready.evidence.requirementStatus).toBe("satisfied");
    expect(ready.evidence.referenceIds).toHaveLength(2);
    expect(ready.executionAuthorized).toBe(false);
    const wrong = (scope: Parameters<typeof resolveControllerGitHubManagerPolicy>[0]) =>
      resolveControllerGitHubManagerPolicy(scope, () =>
        JSON.stringify({ [f.taskId]: { ...config, pullNumber: 6 } }),
      );
    const rejected = await f.read({}, { resolveEvidencePolicy: wrong });
    expect(rejected.evidence.requirementStatus).not.toBe("satisfied");
    expect(rejected.blockers).toContain("evidence_provenance_unavailable");
  });
  it("reads immutable physical scope without mutating task/events or granting permissions", async () => {
    const f = await fixture(),
      before = await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } }),
      events = await db.deliveryEvent.count({ where: { ownerId: f.user.id } });
    const value = await f.read();
    expect(value.scope).toMatchObject({
      ownerId: f.user.id,
      attemptId: f.claim.attemptId,
      checkoutBinding: f.context,
    });
    expect(value.source).toMatchObject({
      physicalBase: f.context.revision,
      headSha: f.context.revision,
      applicationPhase: "base",
    });
    expect(value.blockers).toContain("policy_unavailable");
    expect(value).toMatchObject({
      executionAuthorized: false,
      publicationAuthorized: false,
      cleanupAuthorized: false,
    });
    expect(await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).toEqual(before);
    expect(await db.deliveryEvent.count({ where: { ownerId: f.user.id } })).toBe(events);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(32768);
  });
  it("rejects correctly signed foreign claim, thread, lifetime, lease and source fields", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const patch of [
      { taskId: other.taskId },
      { attemptId: other.claim.attemptId },
      { managerBindingId: other.claim.managerBindingId },
      { stepId: other.stepId },
      { managerThreadId: other.managerThreadId },
      { serverInstanceId: other.serverInstanceId },
      { checkoutBinding: { ...f.context, leaseId: randomUUID() } },
      { attemptLeaseGeneration: 2 },
      { inputSourceSha: "b".repeat(40) },
      { inputSourceContext: { revisionId: randomUUID(), version: 1, headSha: "b".repeat(40) } },
    ])
      await expect(f.read(patch)).rejects.toThrow();
    const forged = envelope(f, f.claim);
    forged.proof = sign(
      null,
      Buffer.from(deliveryStatusProofPayload(forged)),
      other.keys.privateKey,
    ).toString("base64url");
    await expect(new DeliveryStatusService(db, f.dependencies).read(forged)).rejects.toThrow();
  });
  it("reports pause/held/expired attempt facts without clearing writer fences", async () => {
    const f = await fixture();
    await db.deliveryTask.update({
      where: { id: f.taskId },
      data: { pauseRequested: true, schedulingPaused: true },
    });
    await db.deliveryManagerBinding.update({
      where: { id: f.claim.managerBindingId },
      data: { blockedReason: "fixture_hold" },
    });
    await db.deliveryAttempt.update({
      where: { id: f.claim.attemptId },
      data: { leaseExpiresAt: new Date(Date.now() - 100) },
    });
    const value = await f.read();
    expect(value.blockers).toEqual(
      expect.arrayContaining([
        "task_paused",
        "native_reconciliation_required",
        "attempt_lease_expired",
      ]),
    );
    expect(
      (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } })).quiescedAt,
    ).toBeNull();
  });
  it("reads accepted and pending application facts without requiring metadata application", async () => {
    const f = await guardianApplicationFixture(db, (p) =>
      enable(p as Fixture["guardian"]["policy"]),
    );
    const service = new DeliveryStatusService(db, f.dependencies);
    const accepted = await service.read(envelope(f, f.claim));
    expect(accepted.source.applicationPhase).toBe("accepted");
    expect(accepted.source.headSha).toBe(f.accepted.sourceContext.headSha);
    const request = f.reservation();
    await f.store.reserve(f.guardian.scope, request);
    const pending = await service.read(envelope(f, f.claim));
    expect(pending.source.applicationPhase).toBe("pending");
    expect(pending.blockers).toContain("source_application_pending");
    expect(
      (
        await db.deliverySourceApplication.findUniqueOrThrow({
          where: { id: request.applicationId },
        })
      ).phase,
    ).toBe("pending");
  });
  it("checks trusted coverage and expiry instead of accepting cached/forged evidence success", async () => {
    const f = await fixture(),
      evidenceId = randomUUID();
    await new DeliveryRepository(db, f.policy).recordEvidence(f.user.id, "fixture-ci", {
      id: evidenceId,
      stepId: f.stepId,
      remoteId: randomUUID(),
      kind: "check",
      status: "passed",
      verificationMode: "simulated",
      environment: "local-status-fixture",
      sourceSha: f.context.revision,
      criterionIds: ["C1"],
      objectKey: `delivery/${f.user.id}/fixture/check.json`,
      contentDigest: "d".repeat(64),
      observedAt: new Date(Date.now() - 100),
    });
    // Explicit fixture authority exercises coverage; production uses the real
    // GitHub publication/challenge/provenance resolver, tested separately below.
    const policy = {
      policy: f.policy,
      authorityDigest: "a".repeat(64),
      authorizeReferences: async () => {},
    };
    const valid = await f.read({}, { resolveEvidencePolicy: () => policy });
    expect(valid.evidence.requirementStatus).toBe("satisfied");
    expect(valid.evidence.referenceIds).toEqual([evidenceId]);
    // A stricter policy makes immutable success stale before invalidation.
    policy.policy = { ...f.policy, maxAgeMs: 1 };
    expect(
      (await f.read({}, { resolveEvidencePolicy: () => policy })).evidence.requirementStatus,
    ).toBe("missing");
    policy.policy = f.policy;
    await db.deliveryEvidence.update({
      where: { id: evidenceId },
      data: { invalidatedAt: new Date() },
    });
    expect(
      (await f.read({}, { resolveEvidencePolicy: () => policy })).evidence.requirementStatus,
    ).toBe("missing");
    expect(
      (await f.read({}, { resolveEvidencePolicy: resolveControllerGitHubManagerPolicy })).blockers,
    ).toContain("policy_unavailable");
  });
  it("rejects registration revocation and authority expiry during a read", async () => {
    const f = await fixture();
    await db.codexHostRegistration.update({
      where: { id: f.registration().id },
      data: { revokedAt: new Date() },
    });
    await expect(f.read()).rejects.toThrow();
    const g = await fixture();
    await db.codexGuardianRuntime.update({
      where: { id: g.guardian.runtime.id },
      data: { authorityUntil: new Date(Date.now() - 1) },
    });
    await expect(g.read()).rejects.toThrow();
  });
  it("rechecks revocation after authentication and rejects policy/TTL changes across awaited reads", async () => {
    const f = await fixture();
    await expect(
      f.read(
        {},
        {
          reauthorize: async (binding) => {
            await db.codexHostRegistration.update({
              where: { id: f.registration().id },
              data: { revokedAt: new Date() },
            });
            return binding;
          },
        },
      ),
    ).rejects.toThrow();
    const g = await fixture();
    let reads = 0;
    await expect(
      g.read(
        {},
        {
          resolveEvidencePolicy: () =>
            ++reads === 1
              ? {
                  policy: g.policy,
                  authorityDigest: "a".repeat(64),
                  authorizeReferences: async () => {},
                }
              : null,
        },
      ),
    ).rejects.toThrow("status_policy_changed");
    await expect(
      g.read(
        { expiresAt: Date.now() + 30 },
        {
          resolveEvidencePolicy: async () => {
            await new Promise((r) => setTimeout(r, 40));
            return null;
          },
        },
      ),
    ).rejects.toThrow();
  });
});
