import { randomUUID, sign } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { GitHubSourceTransport } from "@/lib/delivery/github-transport.server";
import { githubTransportProofPayload } from "@/lib/delivery/github-transport-contracts";
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
async function fixture() {
  const f = await nativeFixture(db);
  await f.create();
  const data = githubFixture();
  data.snapshot.providerAccountId = f.project.providerAccountId;
  data.snapshot.repository = { id: f.project.providerRepositoryId, fullName: f.project.fullName };
  data.snapshot.pullRequest.baseRepositoryId = f.project.providerRepositoryId;
  data.snapshot.pullRequest.headRepositoryId = f.project.providerRepositoryId;
  data.snapshot.workflowRuns[0].jobs[0].checkRunUrl = `https://api.github.com/repos/${f.project.fullName}/check-runs/80`;
  const config = { pullNumber: 5, policy: data.policy },
    objects = new Map<string, string>();
  let artifactHook = async () => {};
  const service = new GitHubSourceTransport(
    db,
    {
      reauthorize: f.dependencies.reauthorize,
      resolveTargetPolicy: () => config,
    },
    {
      writeAndVerify: async (key, bytes, digest) => {
        expect(githubSourceDigest(JSON.parse(Buffer.from(bytes).toString("utf8")))).toBe(digest);
        objects.set(key, digest);
        await artifactHook();
        return { contentDigest: digest, size: bytes.length };
      },
    },
  );
  function envelope(phase: "challenge" | "snapshot", extra = {}) {
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
  const request = () => envelope("challenge", { requestId: randomUUID() });
  async function challenge() {
    return service.requestChallenge(request());
  }
  function snapshot(c: Awaited<ReturnType<typeof challenge>>, extra = {}) {
    return envelope("snapshot", {
      challengeId: c.id,
      nonce: c.nonce,
      policyDigest: c.policyDigest,
      snapshot: data.snapshot,
      ...extra,
    });
  }
  return {
    ...f,
    data,
    service,
    config,
    objects,
    envelope,
    request,
    challenge,
    snapshot,
    setArtifactHook: (hook: () => Promise<void>) => {
      artifactHook = hook;
    },
  };
}
describe.skipIf(!url)("challenge-bound GitHub source PostgreSQL authority", () => {
  it("derives target/policy, consumes nonce with evidence, and accepts exact signed replay once", async () => {
    const f = await fixture(),
      request = f.request(),
      c = await f.service.requestChallenge(request);
    expect(await f.service.requestChallenge(request)).toEqual(c);
    expect(c.target.providerRepositoryId).toBe(f.context.repositoryId);
    expect(c.policyDigest).toBe(githubSourceDigest(f.config.policy));
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    const input = f.snapshot(c);
    const results = await Promise.all([f.service.ingest(input), f.service.ingest(input)]);
    expect(results.map((x) => x.replayed).sort()).toEqual([false, true]);
    expect(results[0].evidenceIds).toHaveLength(2);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_consumed" },
      }),
    ).toBe(1);
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(2);
    expect(f.objects.size).toBe(1);
  });
  it("rejects unknown fields, manager signing domain and unauthorized target/task/thread", async () => {
    const f = await fixture();
    for (const extra of [
      { producer: "passed" },
      { policy: f.config.policy },
      { pullNumber: 5 },
      { passed: true },
    ])
      await expect(
        f.service.requestChallenge(f.envelope("challenge", { requestId: randomUUID(), ...extra })),
      ).rejects.toThrow();
    await expect(
      f.service.requestChallenge(f.managerEnvelope({ operation: "claim_step", payload: {} })),
    ).rejects.toThrow();
    await expect(
      f.service.requestChallenge(
        f.envelope("challenge", { requestId: randomUUID(), taskId: randomUUID() }),
      ),
    ).rejects.toThrow();
    await expect(
      f.service.requestChallenge(
        f.envelope("challenge", { requestId: randomUUID(), managerThreadId: randomUUID() }),
      ),
    ).rejects.toThrow();
    expect(f.objects.size).toBe(0);
  });
  it("rejects wrong owner/nonce/policy/currenthead before publishing acceptance", async () => {
    const f = await fixture(),
      other = await fixture(),
      c = await f.challenge();
    await expect(other.service.ingest(other.snapshot(c))).rejects.toThrow();
    await expect(f.service.ingest(f.snapshot(c, { nonce: "f".repeat(64) }))).rejects.toThrow();
    await expect(
      f.service.ingest(f.snapshot(c, { policyDigest: "f".repeat(64) })),
    ).rejects.toThrow();
    const changed = structuredClone(f.data.snapshot);
    changed.pullRequest.headSha = "b".repeat(40);
    await expect(f.service.ingest(f.snapshot(c, { snapshot: changed }))).rejects.toThrow(
      "github_source_binding_mismatch",
    );
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("a consumed nonce cannot publish changed bytes; original evidence and immutable object remain", async () => {
    const f = await fixture(),
      c = await f.challenge();
    await f.service.ingest(f.snapshot(c));
    const changed = structuredClone(f.data.snapshot);
    changed.checks[0].conclusion = "failure";
    await expect(f.service.ingest(f.snapshot(c, { snapshot: changed }))).rejects.toThrow(
      "github_challenge_already_consumed",
    );
    expect(f.objects.size).toBe(1); // known consumed conflicts cannot trigger another object write
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(2);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_consumed" },
      }),
    ).toBe(1);
  });
  it("policy changes under the same label and source changes invalidate outstanding challenge authority", async () => {
    const f = await fixture(),
      c = await f.challenge();
    f.config.policy.checks[0].criterionIds = ["C2"];
    await expect(f.service.ingest(f.snapshot(c))).rejects.toThrow();
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    f.config.policy.checks[0].criterionIds = ["C1"];
    await db.deliveryTask.update({ where: { id: f.taskId }, data: { sourceSha: "b".repeat(40) } });
    await expect(f.service.ingest(f.snapshot(c))).rejects.toThrow();
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_consumed" },
      }),
    ).toBe(0);
  });
  it("registration replacement and revocation during object upload leave no consumed nonce or evidence", async () => {
    const f = await fixture(),
      c = await f.challenge();
    f.setArtifactHook(async () => {
      await db.codexHostRegistration.update({
        where: { id: f.registration().id },
        data: { revokedAt: new Date() },
      });
    });
    await expect(f.service.ingest(f.snapshot(c))).rejects.toThrow();
    expect(f.objects.size).toBe(1);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_consumed" },
      }),
    ).toBe(0);
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    const g = await fixture(),
      old = await g.challenge();
    await g.register();
    await expect(g.service.ingest(g.snapshot(old))).rejects.toThrow();
  });
  it("lost artifact acknowledgement can retry, but failed integrity cannot consume a challenge", async () => {
    const f = await fixture(),
      c = await f.challenge();
    f.setArtifactHook(async () => {
      throw new Error("private storage failure");
    });
    await expect(f.service.ingest(f.snapshot(c))).rejects.toThrow();
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_consumed" },
      }),
    ).toBe(0);
    f.setArtifactHook(async () => {});
    expect((await f.service.ingest(f.snapshot(c))).replayed).toBe(false);
  });
  it("changed request replay and rapid refresh cannot create unbounded challenge rows", async () => {
    const f = await fixture(),
      requestId = randomUUID();
    await f.service.requestChallenge(f.envelope("challenge", { requestId }));
    await expect(
      f.service.requestChallenge(f.envelope("challenge", { requestId, stepId: randomUUID() })),
    ).rejects.toThrow();
    await expect(f.challenge()).rejects.toThrow("github_refresh_too_frequent");
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_source_challenge" },
      }),
    ).toBe(1);
  });
  it("expired or superseded challenges cannot write artifacts or be issued as an active replay", async () => {
    const f = await fixture(),
      request = f.request(),
      c = await f.service.requestChallenge(request);
    const original = await db.deliveryEvent.findUniqueOrThrow({ where: { id: c.id } }),
      id = randomUUID();
    const payload = original.payload as Prisma.InputJsonObject;
    await db.deliveryEvent.create({
      data: {
        id,
        ownerId: f.user.id,
        taskId: f.taskId,
        stepId: f.stepId,
        aggregateKey: original.aggregateKey,
        aggregateVersion: original.aggregateVersion + 1,
        type: "github_source_challenge",
        policyVersion: original.policyVersion,
        requestDigest: "f".repeat(64),
        payload: { ...payload, id, expiresAt: Date.now() - 1 },
      },
    });
    await expect(f.service.ingest(f.snapshot({ ...c, id }))).rejects.toThrow();
    await expect(f.service.ingest(f.snapshot(c))).rejects.toThrow();
    await expect(f.service.requestChallenge(request)).rejects.toThrow(
      "github_challenge_superseded",
    );
    expect(f.objects.size).toBe(0);
  });
});
