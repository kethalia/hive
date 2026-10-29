import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  type AuthorizedGitHubSource,
  GitHubEvidencePublisher,
  githubEvidenceProducer,
  type ImmutableGitHubArtifactStore,
} from "@/lib/delivery/github-persistence.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { githubFixture } from "./github-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local delivery fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());

async function fixture() {
  const data = githubFixture(),
    user = await db.user.create({
      data: {
        coderUrl: "https://fixture.invalid",
        coderUserId: randomUUID(),
        username: "github-source-fixture",
        email: "fixture@example.invalid",
      },
    });
  const producer = githubEvidenceProducer("42", data.policy),
    repository = new DeliveryRepository(db, {
      version: data.policy.version,
      trustedProducers: [producer],
      maxAgeMs: data.policy.maxAgeMs,
    });
  const project = await repository.bindProject(user.id, {
    provider: "github",
    providerRepositoryId: "42",
    providerAccountId: "7",
    fullName: "owner/repo",
  });
  const taskId = randomUUID(),
    stepId = randomUUID();
  await repository.createTask(user.id, {
    schemaVersion: 1,
    eventId: randomUUID(),
    id: taskId,
    projectId: project.id,
    outcome: "Synthetic source-authority fixture",
    branch: "fixture",
    sourceSha: data.target.expectedHeadSha,
    steps: [
      {
        id: stepId,
        kind: "validate",
        criterionIds: ["C1"],
        requiredEvidenceKinds: ["check", "review"],
      },
    ],
  });
  let current = structuredClone(data.snapshot),
    deny = false;
  const source: AuthorizedGitHubSource = {
    collect: vi.fn(async (target) => {
      expect(target).toEqual(data.target);
      return structuredClone(current);
    }),
    authorizeTransaction: vi.fn(async (_tx, binding) => {
      if (
        deny ||
        binding.ownerId !== user.id ||
        binding.taskId !== taskId ||
        binding.stepId !== stepId ||
        binding.snapshotDigest !== githubSourceDigest(current)
      )
        throw new Error("fixture authority rejected");
    }),
  };
  const objects = new Map<string, string>();
  const artifacts: ImmutableGitHubArtifactStore = {
    writeAndVerify: vi.fn(async (key, content, digest) => {
      const text = Buffer.from(content).toString();
      expect(githubSourceDigest(JSON.parse(text))).toBe(digest);
      if (objects.has(key)) expect(objects.get(key)).toBe(text);
      objects.set(key, text);
      return { contentDigest: digest, size: content.length };
    }),
  };
  const publisher = new GitHubEvidencePublisher(db, source, artifacts);
  const publish = () => publisher.publish(user.id, taskId, stepId, 5, data.policy);
  const update = (change: (snapshot: typeof data.snapshot) => void) => {
    current = structuredClone(current);
    current.observedAt = new Date(Date.parse(current.observedAt) + 1).toISOString();
    change(current);
  };
  const pending = () =>
    update((snapshot) => {
      snapshot.workflowRuns.push({
        ...snapshot.workflowRuns[0],
        id: "100",
        checkSuiteId: "101",
        runNumber: 10,
        runAttempt: 1,
        status: "queued",
        conclusion: null,
        updatedAt: new Date(Date.now() - 100).toISOString(),
        jobs: [],
      });
    });
  return {
    ...data,
    user,
    producer,
    repository,
    taskId,
    stepId,
    source,
    artifacts,
    objects,
    publisher,
    publish,
    update,
    pending,
    set: (snapshot: typeof data.snapshot) => {
      current = structuredClone(snapshot);
    },
    deny: () => {
      deny = true;
    },
    current: () => structuredClone(current),
  };
}

describe.skipIf(!url)("GitHub source evidence PostgreSQL supersession", () => {
  it("records immutable verified source objects and concurrent exact replay creates one evidence batch/event", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.publish(), f.publish()]);
    expect(a.evidenceIds).toEqual(b.evidenceIds);
    expect(a.replayed !== b.replayed).toBe(true);
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(2);
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_evidence_observed" },
      }),
    ).toBe(1);
    expect(f.source.authorizeTransaction).toHaveBeenCalled();
    const rows = await db.deliveryEvidence.findMany({ where: { ownerId: f.user.id } });
    expect(
      rows.every(
        (row) =>
          row.status === "passed" &&
          row.producer === f.producer &&
          row.verificationMode === "integration" &&
          row.environment === "github.com",
      ),
    ).toBe(true);
    for (const row of rows)
      expect(githubSourceDigest(JSON.parse(f.objects.get(row.objectKey)!))).toBe(row.contentDigest);
  });
  it("newer same-SHA pending run invalidates prior pass atomically and delayed old success cannot restore it", async () => {
    const f = await fixture(),
      old = f.current(),
      accepted = await f.publish();
    f.pending();
    const next = await f.publish();
    expect(next.eligibility.eligible).toBe(false);
    expect(
      await db.deliveryEvidence.count({
        where: {
          ownerId: f.user.id,
          id: { in: accepted.evidenceIds },
          invalidatedAt: { not: null },
        },
      }),
    ).toBe(2);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    old.observedAt = new Date(Date.now() - 50).toISOString();
    f.set(old);
    await expect(f.publish()).rejects.toThrow("github_observation_stale");
    const active = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, kind: "check", invalidatedAt: null },
    });
    expect(active.every((row) => row.status !== "passed")).toBe(true);
  });
  it("same-version contradictory source status is persisted unknown; old replay stays historical", async () => {
    const f = await fixture(),
      old = f.current(),
      accepted = await f.publish();
    f.update((snapshot) => {
      snapshot.workflowRuns[0].jobs[0].conclusion = "failure";
      snapshot.checks[0].conclusion = "failure";
    });
    const conflict = await f.publish();
    expect(conflict.eligibility.eligible).toBe(false);
    expect(
      (
        await db.deliveryEvidence.findFirstOrThrow({
          where: { ownerId: f.user.id, kind: "check", invalidatedAt: null },
        })
      ).status,
    ).toBe("unknown");
    f.set(old);
    const replay = await f.publish();
    expect(replay.replayed).toBe(true);
    expect(replay.evidenceIds).toEqual(accepted.evidenceIds);
    expect(replay.eligibility.eligible).toBe(false);
  });
  it("later failure/pending after success pauses the task while preserving accepted report/outbox and invalidating its authority", async () => {
    const f = await fixture(),
      evidence = await f.publish();
    const attempt = await f.repository.claimStep(f.user.id, {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: f.taskId,
      stepId: f.stepId,
      expectedVersion: 0,
      leaseHolder: "synthetic bookkeeping, no native execution",
    });
    const completion = {
      schemaVersion: 1,
      eventId: randomUUID(),
      taskId: f.taskId,
      stepId: f.stepId,
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      leaseGeneration: attempt.leaseGeneration,
      sourceSha: f.target.expectedHeadSha,
      evidenceIds: evidence.evidenceIds,
      report: {
        summary: "Synthetic accepted report",
        difficulty: "low",
        difficultyReason: "Fixture only",
        issues: [],
        remainingUncertainty: "No real source transport, R2 or production effects",
        nextAction: "Inspect supersession",
      },
    };
    const report = await f.repository.completeStep(f.user.id, completion),
      before = await db.deliveryStepReport.findUniqueOrThrow({ where: { id: report.reportId } });
    f.pending();
    const latest = await f.publish();
    expect(latest.eligibility.eligible).toBe(false);
    expect(
      await db.deliveryStepReport.findUniqueOrThrow({ where: { id: report.reportId } }),
    ).toEqual(before);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } })).state).toBe(
      "succeeded",
    );
    expect(
      await db.deliveryEvidence.count({
        where: {
          ownerId: f.user.id,
          id: { in: evidence.evidenceIds },
          invalidatedAt: { not: null },
        },
      }),
    ).toBe(2);
    expect(await db.deliveryOutbox.count({ where: { ownerId: f.user.id } })).toBe(2);
    expect(await f.repository.completeStep(f.user.id, completion)).toMatchObject({
      reportId: report.reportId,
      replayed: true,
    });
  });
  it("aggregates every configured required job for a criterion so one passed job cannot cover another failure", async () => {
    const f = await fixture();
    f.policy.checks.push({ ...f.policy.checks[0], name: "Lint" });
    f.update((snapshot) => {
      snapshot.workflowRuns[0].jobs.push({
        ...snapshot.workflowRuns[0].jobs[0],
        id: "71",
        name: "Lint",
        conclusion: "failure",
        checkRunUrl: "https://api.github.com/repos/owner/repo/check-runs/82",
      });
      snapshot.checks.push({
        ...snapshot.checks[0],
        id: "82",
        name: "Lint",
        conclusion: "failure",
      });
    });
    const result = await f.publish();
    expect(result.eligibility.eligible).toBe(false);
    const records = await db.deliveryEvidence.findMany({
      where: { ownerId: f.user.id, kind: "check" },
    });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("failed");
  });
  it("requires owner-bound same-transaction authority and verified object bytes before creating evidence", async () => {
    const f = await fixture();
    f.deny();
    await expect(f.publish()).rejects.toThrow("authority rejected");
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
    const other = await fixture();
    await expect(
      f.publisher.publish(other.user.id, other.taskId, other.stepId, 5, other.policy),
    ).rejects.toThrow("authority rejected");
    expect(await db.deliveryEvidence.count({ where: { ownerId: other.user.id } })).toBe(0);
    const bad = new GitHubEvidencePublisher(db, other.source, {
      writeAndVerify: async () => ({ contentDigest: "0".repeat(64), size: 0 }),
    });
    await expect(
      bad.publish(other.user.id, other.taskId, other.stepId, 5, other.policy),
    ).rejects.toThrow("github_artifact_unverified");
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: other.user.id, type: "github_evidence_observed" },
      }),
    ).toBe(0);
  });
  it("rolls invalidation and state back if the append-only observation event cannot be written", async () => {
    const f = await fixture(),
      first = await f.publish();
    f.pending();
    const suffix = randomUUID().replaceAll("-", "");
    await db.$executeRawUnsafe(
      `CREATE FUNCTION fixture_source_fail_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id = '${f.user.id}'::uuid AND NEW.type = 'github_evidence_observed' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER fixture_source_fail_${suffix} BEFORE INSERT ON delivery_events FOR EACH ROW EXECUTE FUNCTION fixture_source_fail_${suffix}()`,
    );
    try {
      await expect(f.publish()).rejects.toThrow("fixture rollback");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER fixture_source_fail_${suffix} ON delivery_events`);
      await db.$executeRawUnsafe(`DROP FUNCTION fixture_source_fail_${suffix}()`);
    }
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(2);
    expect(
      await db.deliveryEvidence.count({
        where: { ownerId: f.user.id, id: { in: first.evidenceIds }, invalidatedAt: null },
      }),
    ).toBe(2);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(false);
  });
  it("rejects source changes that occur during source-object preservation", async () => {
    const f = await fixture();
    const artifacts: ImmutableGitHubArtifactStore = {
      writeAndVerify: async (key, content, digest) => {
        await f.repository.changeSource(f.user.id, {
          schemaVersion: 1,
          eventId: randomUUID(),
          taskId: f.taskId,
          expectedVersion: 0,
          sourceSha: "b".repeat(40),
          reason: "Synthetic source change during object write",
        });
        return f.artifacts.writeAndVerify(key, content, digest);
      },
    };
    const publisher = new GitHubEvidencePublisher(db, f.source, artifacts);
    await expect(publisher.publish(f.user.id, f.taskId, f.stepId, 5, f.policy)).rejects.toThrow(
      "github_source_binding_mismatch",
    );
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("a fresh identical source observation preserves accepted evidence validity while adding fresh immutable receipts", async () => {
    const f = await fixture(),
      first = await f.publish();
    f.update(() => {});
    await f.publish();
    expect(
      await db.deliveryEvidence.count({
        where: { ownerId: f.user.id, id: { in: first.evidenceIds }, invalidatedAt: null },
      }),
    ).toBe(2);
    expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(4);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(false);
  });
  it("same-SHA PR admission changes invalidate old passed references even when workflow runs are unchanged", async () => {
    const f = await fixture(),
      first = await f.publish();
    f.update((snapshot) => {
      snapshot.pullRequest.draft = true;
      snapshot.pullRequest.updatedAt = new Date(
        Date.parse(snapshot.pullRequest.updatedAt) + 1,
      ).toISOString();
    });
    const result = await f.publish();
    expect(result.eligibility.eligible).toBe(false);
    expect(
      await db.deliveryEvidence.count({
        where: { ownerId: f.user.id, id: { in: first.evidenceIds }, invalidatedAt: { not: null } },
      }),
    ).toBe(2);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    expect(
      await db.deliveryEvidence.count({
        where: { ownerId: f.user.id, invalidatedAt: null, status: "passed" },
      }),
    ).toBe(0);
  });
  it("reused policy version with a removed required group has a new producer and invalidates older policy passes", async () => {
    const f = await fixture();
    f.policy.checks.push({ ...f.policy.checks[0], name: "Lint" });
    f.update((snapshot) => {
      snapshot.workflowRuns[0].jobs.push({
        ...snapshot.workflowRuns[0].jobs[0],
        id: "71",
        name: "Lint",
        checkRunUrl: "https://api.github.com/repos/owner/repo/check-runs/82",
      });
      snapshot.checks.push({ ...snapshot.checks[0], id: "82", name: "Lint" });
    });
    const first = await f.publish(),
      oldProducer = (
        await db.deliveryEvidence.findUniqueOrThrow({ where: { id: first.evidenceIds[0] } })
      ).producer;
    f.policy.checks.pop();
    f.update(() => {});
    const second = await f.publish();
    expect(second.eligibility.eligible).toBe(false);
    expect(
      await db.deliveryEvidence.count({
        where: { ownerId: f.user.id, id: { in: first.evidenceIds }, invalidatedAt: { not: null } },
      }),
    ).toBe(2);
    expect(
      (await db.deliveryEvidence.findUniqueOrThrow({ where: { id: second.evidenceIds[0] } }))
        .producer,
    ).not.toBe(oldProducer);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    f.update(() => {});
    await f.publish();
    expect(
      await db.deliveryEvidence.count({
        where: { ownerId: f.user.id, id: { in: first.evidenceIds }, invalidatedAt: null },
      }),
    ).toBe(0);
    const event = await db.deliveryEvent.findUniqueOrThrow({ where: { id: second.eventId } });
    expect(event.payload).toMatchObject({ policyDigest: githubSourceDigest(f.policy) });
  });
  it("exact source replay fails closed if any persisted evidence reference is missing", async () => {
    const f = await fixture(),
      first = await f.publish();
    await db.deliveryEvidence.delete({ where: { id: first.evidenceIds[0] } });
    await expect(f.publish()).rejects.toThrow("github_evidence_incomplete");
    expect(
      await db.deliveryEvent.count({
        where: { ownerId: f.user.id, type: "github_evidence_observed" },
      }),
    ).toBe(1);
  });
});
