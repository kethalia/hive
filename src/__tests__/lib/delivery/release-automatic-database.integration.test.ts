import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  active: undefined as unknown,
  opened: 0,
  closed: 0,
  host: vi.fn(),
  factoryAvailable: true,
}));
vi.mock("@hive/db", async (original) => {
  const actual = await original<typeof import("@hive/db")>();
  return {
    ...actual,
    getDb: () => mocks.active ?? mocks.db,
    captureRequestDatabaseFactory: () =>
      mocks.factoryAvailable
        ? () => {
            const own = new actual.PrismaClient({
              datasourceUrl: process.env.HIVE_AUTOMATIC_DATABASE_TEST_DATABASE_URL,
            });
            mocks.opened++;
            return {
              async run<T>(operation: () => Promise<T>) {
                const old = mocks.active;
                mocks.active = own;
                try {
                  return await operation();
                } finally {
                  mocks.active = old;
                }
              },
              async close() {
                await own.$disconnect();
                mocks.closed++;
              },
            };
          }
        : undefined,
  };
});
vi.mock("@/lib/projects/host.server", () => ({ signedHostProjectRequest: mocks.host }));

import {
  readProductionAcceptanceAnchor,
  verifyProductionAcceptanceAnchor,
} from "@/lib/delivery/release-automatic-acceptance.server";
import { automaticPreparedSchema } from "@/lib/delivery/release-automatic-contracts";
import { automaticReleaseForTask } from "@/lib/delivery/release-automatic-host.server";
import { PostgresReleaseEffectJournal } from "@/lib/delivery/release-effect-journal.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import { repositoryPolicyStore } from "@/lib/delivery/repository-policy.server";
import { completeAutomaticDatabaseAcceptance } from "./automatic-database-acceptance-fixture";
import { automaticDatabaseFixture } from "./release-automatic-database-fixture";

const url = process.env.HIVE_AUTOMATIC_DATABASE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/hive_acceptance_test_automatic_database_[a-z0-9_]+$/.test(new URL(url).pathname))
)
  throw Error("Owned local fixture only");
const db = new PrismaClient({
  datasourceUrl:
    url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test_automatic_database_unused",
});
mocks.db = db;
afterAll(() => db.$disconnect());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mocks.host.mockReset();
  mocks.factoryAvailable = true;
  expect(mocks.opened).toBe(mocks.closed);
});
async function readyForMerge(options: { testedLifetimeMs?: number; grantMs?: number } = {}) {
  const f = await automaticDatabaseFixture(db, url!, mocks.host, options);
  await f.controller.lifecycle.advance(f.user.id, f.release.id);
  const approval = await db.deliveryReleaseAction.findFirstOrThrow({
    where: { releaseId: f.release.id, kind: "database_job", phase: "prepared" },
  });
  await f.controller.step(f.user.id, approval.id, f.signal);
  await f.runJob(f.jobs[0]);
  await f.controller.step(f.user.id, approval.id, f.signal);
  f.followups.length = 0;
  await f.controller.lifecycle.advance(f.user.id, f.release.id);
  const advance = await db.deliveryReleaseAction.findFirstOrThrow({
    where: { releaseId: f.release.id, kind: "database_job", phase: "prepared" },
  });
  await f.controller.step(f.user.id, advance.id, f.signal);
  await f.runJob(f.jobs[1]);
  await f.controller.step(f.user.id, advance.id, f.signal);
  f.followups.length = 0;
  const intent = (
    f.release.snapshot as { database: { mergeActionId: string; mergeRequestDigest: string } }
  ).database;
  return { ...f, intent };
}
describe.skipIf(!url)("controlled automatic source-build database delivery", () => {
  it("uses actual journal/workload/SQL receipts and a bounded new continuation grant after a slow build, keeping production acceptance pending", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host, { testedLifetimeMs: 5000 });
    expect(f.prepared.riskClass).toBe("database");
    expect(await f.controller.lifecycle.advance(f.user.id, f.release.id)).toBe("prepared");
    const actions = await db.deliveryReleaseAction.findMany({ where: { releaseId: f.release.id } });
    expect(actions.map((a) => a.kind).sort()).toEqual(["database_job"]);
    const approve = actions.find((a) => a.kind === "database_job")!;
    expect(await f.controller.step(f.user.id, approve.id, f.signal)).toBe("held");
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0].stage).toBe("approve");
    await db.$executeRaw`SELECT pg_sleep(5.2)`;
    await f.runJob(f.jobs[0]);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: approve.id } })).phase,
    ).toBe("held");
    // A protected job's own response is not its completed provider receipt.
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(0);
    expect(f.followups).toHaveLength(1);
    await f.followups.shift()!();
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: approve.id } })).phase,
    ).toBe("observed");
    const grant = await db.deliveryEvent.findFirstOrThrow({
      where: { taskId: f.taskId, type: "release_test_grant_renewed" },
    });
    expect(grant.payload).toMatchObject({
      originalAttestationDigest: f.testedDigest,
      catalogDigest: (f.release.snapshot as { database: { catalogDigest: string } }).database
        .catalogDigest,
    });
    expect(f.jobs).toHaveLength(2);
    expect(f.jobs[1].stage).toBe("advance");
    await f.runJob(f.jobs[1]);
    await f.followups.shift()!();
    expect(await db.$queryRawUnsafe(`SELECT migrated FROM "${f.table}" ORDER BY id`)).toEqual([
      { migrated: "one" },
      { migrated: "two" },
      { migrated: "three" },
    ]);
    expect(f.remote.writes).toBe(1);
    const merge = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, kind: "merge" },
    });
    expect(await f.controller.step(f.user.id, merge.id, f.signal)).toBe("observed");
    await f.controller.observe(f.user.id, f.release.id, f.signal);
    expect(await f.controller.lifecycle.advance(f.user.id, f.release.id)).toBe("prepared");
    const activate = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, kind: "database_job", phase: "prepared" },
    });
    expect(await f.controller.step(f.user.id, activate.id, f.signal)).toBe("held");
    expect(f.jobs).toHaveLength(3);
    expect(f.jobs[2].stage).toBe("activate");
    await f.runJob(f.jobs[2]);
    await f.followups.shift()!();
    await db.$executeRaw`SELECT pg_sleep(1.05)`;
    expect(await f.controller.observe(f.user.id, f.release.id, f.signal)).toBe("healthy");
    expect(
      (await db.deliveryRelease.findUniqueOrThrow({ where: { id: f.release.id } })).phase,
    ).toBe("healthy");
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.release.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(f.release.id);
    expect(
      await db.deliveryStep.count({
        where: {
          taskId: f.taskId,
          acceptancePhase: "activation_production",
          state: { not: "succeeded" },
        },
      }),
    ).toBeGreaterThan(0);
    expect(f.remote.writes).toBe(1);
    expect(f.jobs).toHaveLength(3);
    const anchor = await db.$transaction((tx) =>
      readProductionAcceptanceAnchor(tx, f.config, {
        ownerId: f.user.id,
        taskId: f.taskId,
        sourceRevisionId: f.source.id,
        sourceSha: f.source.headSha,
      }),
    );
    expect(anchor?.database).toMatchObject({
      kind: "controlled-source-build",
      planDigest: expect.any(String),
      coverage: "controlled-migration-activation-history",
      observation: { phase: "activated", integrity: { violations: "0" } },
    });
    if (!anchor) throw Error("Missing controlled DB production material");
    expect(
      await db.$transaction((tx) =>
        verifyProductionAcceptanceAnchor(
          tx,
          f.config,
          { ...anchor, database: undefined },
          { fresh: true },
        ),
      ),
    ).toBe(false);
  }, 120000);
  it("preserves one inflight action and denies missing or substituted reserved merge identities", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host),
      intent = (f.release.snapshot as { database: { mergeActionId: string } }).database;
    const journal = new PostgresReleaseEffectJournal(
      db,
      f.user.id,
      f.controller.lifecycle.authorize,
      f.controller.lifecycle.prepareReservedMerge,
    );
    expect(await journal.begin(randomUUID())).toBeNull();
    await expect(journal.begin(intent.mergeActionId)).rejects.toThrow();
    expect(await db.deliveryReleaseAction.count({ where: { releaseId: f.release.id } })).toBe(0);
    const data = {
      releaseId: f.release.id,
      targetDigest: f.release.targetDigest,
      kind: "merge",
      generation: 1,
      request: f.prepared.request,
      requestDigest: (f.release.snapshot as { database: { mergeRequestDigest: string } }).database
        .mergeRequestDigest,
    };
    await expect(
      db.deliveryReleaseAction.create({ data: { ...data, id: randomUUID() } }),
    ).rejects.toThrow("release_database_merge_reservation_required");
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    await expect(
      db.deliveryReleaseAction.create({ data: { ...data, id: intent.mergeActionId } }),
    ).rejects.toThrow();
    expect(f.remote.writes).toBe(0);
    expect(f.jobs).toHaveLength(0);
  }, 30000);
  it("atomically rolls back a crash before begin, wins concurrent begin once, and never redispatches after committed uncertainty", async () => {
    const f = await readyForMerge();
    const failed = new PostgresReleaseEffectJournal(
      db,
      f.user.id,
      async (tx, identity) => {
        expect(await f.controller.lifecycle.authorize(tx, identity)).toBe(true);
        throw Error("Explicit precommit crash");
      },
      f.controller.lifecycle.prepareReservedMerge,
    );
    await expect(failed.begin(f.intent.mergeActionId)).rejects.toThrow("precommit crash");
    expect(
      await db.deliveryReleaseAction.findUnique({ where: { id: f.intent.mergeActionId } }),
    ).toBeNull();
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "database_merge_authorized" },
      }),
    ).toBe(0);
    const journal = new PostgresReleaseEffectJournal(
      db,
      f.user.id,
      f.controller.lifecycle.authorize,
      f.controller.lifecycle.prepareReservedMerge,
    );
    const started = (
      await Promise.all([
        journal.begin(f.intent.mergeActionId),
        journal.begin(f.intent.mergeActionId),
      ])
    ).filter((item) => item !== null);
    expect(started).toHaveLength(1);
    expect(
      await db.deliveryReleaseAction.count({
        where: { releaseId: f.release.id, kind: "merge", phase: "effect_started" },
      }),
    ).toBe(1);
    await journal.hold(started[0]);
    expect(await journal.begin(f.intent.mergeActionId)).toBeNull();
    expect(await f.controller.dispatchReservedMerge(f.user.id, f.release.id, f.signal)).toBe(
      "held",
    );
    expect(f.remote.writes).toBe(0);
    expect(f.jobs).toHaveLength(2);
  }, 30000);
  it("rechecks expiry after a real release-lock wait and rolls back the reserved action completely", async () => {
    const f = await readyForMerge();
    const event = await db.deliveryEvent.findFirstOrThrow({
      where: { taskId: f.taskId, type: "database_job_observed" },
      orderBy: { createdAt: "desc" },
    });
    const expiresAt = (event.payload as { expiresAt: number }).expiresAt;
    const now = (
      await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - now - 1500)));
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = db
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT target_digest FROM delivery_release_targets WHERE target_digest=${f.release.targetDigest} FOR UPDATE`;
          locked();
          await tx.$executeRaw`SELECT pg_sleep(2.0)`;
        },
        { timeout: 5000 },
      )
      .then(() => undefined);
    await acquired;
    const journal = new PostgresReleaseEffectJournal(
      db,
      f.user.id,
      f.controller.lifecycle.authorize,
      f.controller.lifecycle.prepareReservedMerge,
    );
    await expect(journal.begin(f.intent.mergeActionId)).rejects.toThrow();
    await blocker;
    expect(
      await db.deliveryReleaseAction.findUnique({ where: { id: f.intent.mergeActionId } }),
    ).toBeNull();
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "database_merge_authorized" },
      }),
    ).toBe(0);
    expect(await f.controller.lifecycle.advance(f.user.id, f.release.id)).toBe("prepared");
    expect(f.remote.writes).toBe(0);
  }, 45000);
  it("does not renew an expired grant or accept a changed source/policy, and leaves no prepared merge behind", async () => {
    const f = await readyForMerge({ testedLifetimeMs: 5000, grantMs: 1000 });
    await db.$executeRaw`SELECT pg_sleep(5.2)`;
    const now = (
      await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const prepared = automaticPreparedSchema.parse(
      await automaticReleaseForTask(
        db,
        f.config,
        { ownerId: f.user.id, taskId: f.taskId },
        { operation: "prepare" },
        f.signal,
      ),
    );
    expect(
      await f.controller.lifecycle.renewDatabaseGrant(f.user.id, f.release.id, prepared, now),
    ).toBe(true);
    const grant = await db.deliveryEvent.findFirstOrThrow({
      where: { taskId: f.taskId, type: "release_test_grant_renewed" },
    });
    expect(
      await f.controller.lifecycle.renewDatabaseGrant(f.user.id, f.release.id, prepared, now),
    ).toBe(true);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(1);
    await db.$executeRaw`SELECT pg_sleep(1.05)`;
    expect(
      await f.controller.lifecycle.renewDatabaseGrant(f.user.id, f.release.id, prepared, now),
    ).toBe(false);
    const journal = new PostgresReleaseEffectJournal(
      db,
      f.user.id,
      f.controller.lifecycle.authorize,
      f.controller.lifecycle.prepareReservedMerge,
    );
    await expect(journal.begin(f.intent.mergeActionId)).rejects.toThrow();
    expect(
      await db.deliveryReleaseAction.findUnique({ where: { id: f.intent.mergeActionId } }),
    ).toBeNull();
    expect((await db.deliveryEvent.findUniqueOrThrow({ where: { id: grant.id } })).payload).toEqual(
      grant.payload,
    );
    expect(
      await f.controller.lifecycle
        .renewDatabaseGrant(
          f.user.id,
          f.release.id,
          { ...prepared, testedTreeSha: "0".repeat(40) },
          Date.now(),
        )
        .catch(() => false),
    ).toBe(false);
    await db.deliveryRepositoryPolicyVersion.updateMany({
      where: { ownerId: f.user.id, projectId: f.project.id },
      data: { revokedAt: new Date() },
    });
    expect(
      await f.controller.lifecycle
        .renewDatabaseGrant(f.user.id, f.release.id, prepared, Date.now())
        .catch(() => false),
    ).toBe(false);
    expect(f.remote.writes).toBe(0);
  }, 30000);
  it("holds its still-running or failed job callback and never treats a lost report acknowledgement as permission to retry", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host, { approvalHistoryMs: 300000 });
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approve = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, approve.id, f.signal);
    await f.runJob(f.jobs[0]);
    const followup = f.followups.shift()!;
    f.jobs[0].status = "in_progress";
    f.jobs[0].conclusion = null;
    f.jobs[0].protected = "in_progress";
    await followup();
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: approve.id } })).phase,
    ).toBe("held");
    expect(f.jobs).toHaveLength(1);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(0);
    f.jobs[0].status = "completed";
    f.jobs[0].conclusion = "success";
    f.jobs[0].protected = "success";
    await f.controller.scheduler.tick(f.signal);
    expect(f.jobs).toHaveLength(2);
    f.state.droppedReport = true;
    await expect(f.runJob(f.jobs[1])).rejects.toThrow("Lost report response");
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_job_observed" } }),
    ).toBe(1);
    await expect(f.followups.shift()!()).resolves.toBeUndefined();
    expect(await f.controller.lifecycle.advance(f.user.id, f.release.id)).toBe("waiting");
    expect(f.jobs).toHaveLength(2);
    expect(f.remote.writes).toBe(0);
  }, 30000);
  it("records only a pre-pause authorized SQL outcome and settles its exact completed job without granting new paused work", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approval = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, approval.id, f.signal);
    await f.runJob(f.jobs[0]);
    await f.controller.step(f.user.id, approval.id, f.signal);
    f.followups.length = 0;
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const advance = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, advance.id, f.signal);
    f.state.pauseBeforeReport = true;
    await f.runJob(f.jobs[1]);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "database_sql_authorized" },
      }),
    ).toBeGreaterThan(0);
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_job_observed" } }),
    ).toBe(1);
    expect(
      (await db.deliveryTask.findUniqueOrThrow({ where: { id: f.taskId } })).pauseRequested,
    ).toBe(true);
    const report = f.state.lastReport!;
    const unauthorized: Record<string, unknown> = {
      ...report,
      requestId: randomUUID(),
      operation: "authorize",
      action: "certificate",
    };
    delete unauthorized.observation;
    expect((await f.sendJobRequest(f.jobs[1], unauthorized)).status).not.toBe(200);
    const wrongDispatch = { ...report, requestId: randomUUID(), dispatchId: randomUUID() };
    expect((await f.sendJobRequest(f.jobs[1], wrongDispatch)).status).not.toBe(200);
    const wrongRun = { ...report, requestId: randomUUID(), githubRunAttempt: 2 };
    expect((await f.sendJobRequest(f.jobs[1], wrongRun)).status).not.toBe(200);
    const read = {
      ...unauthorized,
      requestId: randomUUID(),
      operation: "read_plan",
      action: "read",
    };
    expect((await f.sendJobRequest(f.jobs[1], read)).status).not.toBe(200);
    expect((await f.sendJobRequest(f.jobs[1], report)).status).toBe(200);
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_job_observed" } }),
    ).toBe(1);
    await f.followups.shift()!();
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: advance.id } })).phase,
    ).toBe("observed");
    expect(f.jobs).toHaveLength(2);
    expect(f.remote.writes).toBe(0);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(0);
    expect(
      await db.deliveryReleaseAction.count({ where: { releaseId: f.release.id, kind: "merge" } }),
    ).toBe(0);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, repositoryPolicyStore(db), {
          ownerId: f.user.id,
          taskId: f.taskId,
          sourceSha: f.source.headSha,
          milestone: "implementation_preview",
        }),
      ),
    ).toBe(false);
  }, 30000);
  it("keeps a paused workload with no original SQL authorization unknown despite a successful GitHub run", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approval = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, approval.id, f.signal);
    await f.runJob(f.jobs[0]);
    await f.controller.step(f.user.id, approval.id, f.signal);
    f.followups.length = 0;
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const advance = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, advance.id, f.signal);
    const job = f.jobs[1],
      base = {
        ...JSON.parse(job.inputs["database-job-json"]),
        schemaVersion: 1,
        purpose: "database_job",
        operation: "read_plan",
        action: "read",
        requestId: randomUUID(),
        githubRunId: String(job.id),
        githubRunAttempt: 1,
      };
    const response = await f.sendJobRequest(job, base);
    expect(response.status).toBe(200);
    const approved = (await response.json()).data;
    expect(
      await db.deliveryEvent.count({
        where: {
          taskId: f.taskId,
          type: "database_workload_bound",
          payload: { path: ["runId"], equals: String(job.id) },
        },
      }),
    ).toBe(1);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "database_sql_authorized" },
      }),
    ).toBe(0);
    let acquired!: () => void, releasePause!: () => void;
    const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      }),
      continuePause = new Promise<void>((resolve) => {
        releasePause = resolve;
      });
    let blockerPid = 0;
    const pause = db.$transaction(
      async (tx) => {
        blockerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        await tx.$queryRaw`SELECT id FROM delivery_tasks WHERE id=${f.taskId}::uuid FOR UPDATE`;
        acquired();
        await continuePause;
        await tx.deliveryTask.update({ where: { id: f.taskId }, data: { pauseRequested: true } });
      },
      { timeout: 10000 },
    );
    await locked;
    const competing = f.sendJobRequest(job, {
      ...base,
      requestId: randomUUID(),
      operation: "authorize",
      action: "begin",
    });
    let blocked = false;
    try {
      for (let poll = 0; poll < 100; poll++) {
        const rows = await db.$queryRaw<
          { blocked: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${blockerPid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
        if (rows[0].blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      releasePause();
    }
    await pause;
    expect((await competing).status).not.toBe(200);
    expect(blocked).toBe(true);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "database_sql_authorized" },
      }),
    ).toBe(0);
    const observation = {
      runId: base.planEventId,
      phase: "pending",
      version: 0,
      cursor: "0",
      highWater: "0",
      changedRows: "0",
      checkpointDigest: "0".repeat(64),
      planDigest: approved.planDigest,
      scopeDigest: "0".repeat(64),
      sourceSha: f.source.headSha,
      beforeSchemaDigest: f.plan.beforeSchemaDigest,
      afterSchemaDigest: f.plan.afterSchemaDigest,
      oldAppDigest: f.plan.oldAppDigest,
      newAppDigest: f.plan.newAppDigest,
      compatibilityDigest: f.plan.compatibilityDigest,
      compatibilityReceiptDigest: null,
      integrity: null,
      activationReceiptDigest: null,
      contractAuthorized: false,
      executionAuthorized: false,
    };
    expect(
      (
        await f.sendJobRequest(job, {
          ...base,
          requestId: randomUUID(),
          operation: "report",
          observation,
        })
      ).status,
    ).not.toBe(200);
    job.status = "completed";
    job.conclusion = "success";
    job.protected = "success";
    expect(await f.controller.step(f.user.id, advance.id, f.signal)).toBe("not_found");
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: advance.id } })).phase,
    ).toBe("held");
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_job_observed" } }),
    ).toBe(0);
    expect(f.remote.writes).toBe(0);
    expect(f.jobs).toHaveLength(2);
    await db.deliveryRepositoryPolicyVersion.updateMany({
      where: { ownerId: f.user.id, projectId: f.project.id },
      data: { revokedAt: new Date() },
    });
    expect(
      (
        await f.sendJobRequest(job, {
          ...base,
          requestId: randomUUID(),
          operation: "report",
          observation,
        })
      ).status,
    ).not.toBe(200);
  }, 30000);
  it("keeps authenticated report facts while absent request capability holds background advancement", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approval = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, approval.id, f.signal);
    await f.runJob(f.jobs[0]);
    await f.controller.step(f.user.id, approval.id, f.signal);
    f.followups.length = 0;
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const advance = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, advance.id, f.signal);
    mocks.factoryAvailable = false;
    await f.runJob(f.jobs[1]);
    const facts = await db.deliveryEvent.count({
      where: { taskId: f.taskId, type: "database_job_observed" },
    });
    expect(facts).toBeGreaterThan(0);
    const opened = mocks.opened;
    const priorPhase = (
      await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: advance.id } })
    ).phase;
    expect(["effect_started", "held"]).toContain(priorPhase);
    await f.followups.shift()!();
    expect(mocks.opened).toBe(opened);
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_job_observed" } }),
    ).toBe(facts);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: advance.id } })).phase,
    ).toBe(priorPhase);
    expect(f.jobs).toHaveLength(2);
    expect(f.remote.writes).toBe(0);
  });
  it("cancels a stalled callback provider within its work budget and closes its own SQL client", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approval = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, approval.id, f.signal);
    await f.runJob(f.jobs[0]);
    f.state.stallLookup = true;
    const began = Date.now(),
      opened = mocks.opened,
      closed = mocks.closed;
    await f.followups.shift()!();
    expect(Date.now() - began).toBeGreaterThanOrEqual(19000);
    expect(Date.now() - began).toBeLessThan(25000);
    expect(mocks.opened - opened).toBe(1);
    expect(mocks.closed - closed).toBe(1);
    expect(f.jobs).toHaveLength(1);
    expect(f.remote.writes).toBe(0);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(0);
  }, 30000);
  it("recovers a five-minute historical workflow on the scheduler, refreshes SQL proof, and waits for the exact serving build before its sole activation", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host, {
      testedLifetimeMs: 5000,
      approvalHistoryMs: 300000,
    });
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approval = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, kind: "database_job", phase: "prepared" },
    });
    await f.controller.step(f.user.id, approval.id, f.signal);
    await f.runJob(f.jobs[0]);
    const history = await db.deliveryEvent.findFirstOrThrow({
      where: { taskId: f.taskId, type: "database_plan_approved" },
    });
    expect(Date.now() - history.createdAt.getTime()).toBeGreaterThanOrEqual(300000);
    f.jobs[0].status = "in_progress";
    f.jobs[0].conclusion = null;
    f.jobs[0].protected = "in_progress";
    // Exactly one actual post-response hook. Later continuation is scheduled.
    await f.followups.shift()!();
    await db.$executeRaw`SELECT pg_sleep(5.2)`;
    f.jobs[0].status = "completed";
    f.jobs[0].conclusion = "success";
    f.jobs[0].protected = "success";
    f.state.droppedDispatch = true;
    await f.controller.scheduler.tick(f.signal);
    expect(
      (await db.deliveryReleaseAction.findUniqueOrThrow({ where: { id: approval.id } })).phase,
    ).toBe("observed");
    expect(f.jobs.map((job) => job.stage)).toEqual(["approve", "advance"]);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(0);
    expect(f.remote.writes).toBe(0);
    await f.controller.scheduler.tick(f.signal);
    expect(f.jobs).toHaveLength(2); // Lost dispatch ACK is lookup-only, never a second POST.
    f.state.servingBaseline = true;
    await f.runJob(f.jobs[1]);
    await f.followups.shift()!();
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "release_test_grant_renewed" },
      }),
    ).toBe(1);
    expect(f.remote.writes).toBe(1);
    await f.controller.scheduler.tick(f.signal);
    expect(f.jobs).toHaveLength(2);
    expect(
      await db.deliveryReleaseAction.count({
        where: {
          releaseId: f.release.id,
          kind: "database_job",
          request: { path: ["stage"], equals: "activate" },
        },
      }),
    ).toBe(0);
    f.state.servingBaseline = false;
    await f.controller.scheduler.tick(f.signal);
    await f.controller.scheduler.tick(f.signal); // Existing cursor wraps on an empty pass.
    expect(f.jobs.map((job) => job.stage)).toEqual(["approve", "advance", "activate"]);
    const activation = await db.deliveryReleaseAction.findFirstOrThrow({
      where: {
        releaseId: f.release.id,
        kind: "database_job",
        request: { path: ["stage"], equals: "activate" },
      },
    });
    expect(activation.request).toMatchObject({
      activationProof: {
        mergeSha: f.remote.mergeSha,
        treeSha: f.remote.treeSha,
        buildUuid: expect.any(String),
        observationId: expect.any(String),
      },
    });
    await f.controller.scheduler.tick(f.signal);
    expect(f.jobs).toHaveLength(3);
    expect(f.remote.writes).toBe(1);
  }, 45000);
  it("supplies the real controlled DB artifact to independent production acceptance and retains historical verification after only deployment-fence release", async () => {
    const f = await readyForMerge();
    expect(await f.controller.dispatchReservedMerge(f.user.id, f.release.id, f.signal)).toBe(
      "held",
    );
    const merge = await db.deliveryReleaseAction.findUniqueOrThrow({
      where: { id: f.intent.mergeActionId },
    });
    expect(await f.controller.step(f.user.id, merge.id, f.signal)).toBe("observed");
    await f.controller.observe(f.user.id, f.release.id, f.signal);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const activate = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, activate.id, f.signal);
    await f.runJob(f.jobs[2]);
    // The protected job can finish after the dispatch-time health sample expires.
    // Its exact immutable pin is history for lookup, never a new dispatch grant.
    await db.$executeRaw`SELECT pg_sleep(30.1)`;
    expect(await f.controller.step(f.user.id, activate.id, f.signal)).toBe("observed");
    await f.followups.shift()!();
    await db.$executeRaw`SELECT pg_sleep(1.05)`;
    expect(await f.controller.observe(f.user.id, f.release.id, f.signal)).toBe("healthy");
    const result = await completeAutomaticDatabaseAcceptance(db, f.base);
    expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: result.step.id } })).state).toBe(
      "succeeded",
    );
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.release.targetDigest },
        })
      ).activeReleaseId,
    ).toBeNull();
    expect(
      await db.$transaction((tx) =>
        verifyReleaseEvidence(tx, repositoryPolicyStore(db), {
          ownerId: f.user.id,
          taskId: f.taskId,
          sourceSha: f.source.headSha,
        }),
      ),
    ).toBe(true);
    const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
      where: { id: f.claim.managerBindingId },
    });
    expect(binding.activeAttemptId).toBe(f.claim.attemptId);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "production_acceptance_finalized" },
      }),
    ).toBe(1);
    expect(f.remote.writes).toBe(1);
    expect(f.jobs).toHaveLength(3);
  }, 65000);
  it("denies disabled catalogs and a valid-workload wrong dispatch scope before schema execution", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    vi.stubEnv(
      "HIVE_DELIVERY_DATABASE_CATALOGS_JSON",
      JSON.stringify([{ ...f.catalog, automaticExecutionEnabled: false }]),
    );
    expect(await f.controller.lifecycle.advance(f.user.id, f.release.id)).toBe("held");
    expect(await db.deliveryReleaseAction.count({ where: { releaseId: f.release.id } })).toBe(0);
    vi.stubEnv("HIVE_DELIVERY_DATABASE_CATALOGS_JSON", f.env.HIVE_DELIVERY_DATABASE_CATALOGS_JSON);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, action.id, f.signal);
    const approval = JSON.parse(f.jobs[0].inputs["database-approval-json"]);
    approval.dispatchId = randomUUID();
    f.jobs[0].inputs["database-approval-json"] = JSON.stringify(approval);
    await expect(f.runJob(f.jobs[0])).rejects.toThrow();
    expect(
      await db.deliveryEvent.count({ where: { taskId: f.taskId, type: "database_plan_approved" } }),
    ).toBe(0);
    expect(
      await db.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name='${f.table}' AND column_name='migrated'`,
      ),
    ).toEqual([]);
    expect(f.remote.writes).toBe(0);
    expect(f.jobs).toHaveLength(1);
  }, 30000);
  it("rejects a different serving database before activation and retains both production and writer fences", async () => {
    const f = await readyForMerge();
    await f.controller.dispatchReservedMerge(f.user.id, f.release.id, f.signal);
    await f.controller.step(f.user.id, f.intent.mergeActionId, f.signal);
    await f.controller.observe(f.user.id, f.release.id, f.signal);
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, action.id, f.signal);
    f.state.wrongDb = true;
    await expect(f.runJob(f.jobs[2])).rejects.toThrow();
    expect(
      (await db.deliveryRelease.findUniqueOrThrow({ where: { id: f.release.id } })).phase,
    ).toBe("held");
    const job = JSON.parse(f.jobs[2].inputs["database-job-json"]);
    expect(
      await db.$queryRawUnsafe(
        "SELECT phase FROM hive_delivery_db.runs WHERE id=$1::uuid",
        job.planEventId,
      ),
    ).toEqual([{ phase: "verified" }]);
    expect(
      (
        await db.deliveryReleaseTarget.findUniqueOrThrow({
          where: { targetDigest: f.release.targetDigest },
        })
      ).activeReleaseId,
    ).toBe(f.release.id);
    expect(
      (
        await db.deliveryManagerBinding.findUniqueOrThrow({
          where: { id: f.claim.managerBindingId },
        })
      ).activeAttemptId,
    ).toBe(f.claim.attemptId);
    expect(
      await db.deliveryEvent.count({
        where: { taskId: f.taskId, type: "production_acceptance_finalized" },
      }),
    ).toBe(0);
  }, 30000);
  it("replays concurrent source openers without changing the immutable future merge reservation", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    const snapshot = f.release.snapshot as {
      database: { baseline: unknown; mergeActionId: string };
    };
    const now = (
      await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    const opened = await Promise.all(
      [1, 2].map(() =>
        f.controller.lifecycle.open({
          id: randomUUID(),
          ownerId: f.user.id,
          taskId: f.taskId,
          prepared: f.prepared,
          testedAttestationDigest: f.testedDigest,
          databaseBaseline: snapshot.database.baseline,
          observedAt: now,
        }),
      ),
    );
    expect(opened).toEqual([
      { releaseId: f.release.id, replayed: true },
      { releaseId: f.release.id, replayed: true },
    ]);
    expect(await db.deliveryRelease.count({ where: { taskId: f.taskId } })).toBe(1);
    expect(
      (await db.deliveryRelease.findUniqueOrThrow({ where: { id: f.release.id } })).snapshot,
    ).toEqual(f.release.snapshot);
    expect(
      await db.deliveryReleaseAction.findUnique({ where: { id: snapshot.database.mergeActionId } }),
    ).toBeNull();
    expect(f.jobs).toHaveLength(0);
    expect(f.remote.writes).toBe(0);
  }, 30000);
  it("rejects a workload read crossing the production policy deadline while catalog and OIDC remain live", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host, { policyLifetimeMs: 6500 });
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const approve = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, approve.id, f.signal);
    await f.runJob(f.jobs[0]);
    await f.controller.step(f.user.id, approve.id, f.signal);
    f.followups.length = 0;
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const advance = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, advance.id, f.signal);
    const remaining = f.config.policy.expiresAt - Date.now();
    if (remaining > 1200) await db.$executeRaw`SELECT pg_sleep(${(remaining - 1200) / 1000})`;
    f.state.expireWorkloadRead = true;
    await expect(f.runJob(f.jobs[1])).rejects.toThrow();
    expect(f.state.crossedPolicy).toBe(true);
    const now = (
      await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    expect(now).toBeGreaterThanOrEqual(f.config.policy.expiresAt);
    expect(f.catalog.expiresAt).toBeGreaterThan(now + 30000);
    expect(
      await db.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name='${f.table}' AND column_name='migrated'`,
      ),
    ).toEqual([]);
    expect(f.remote.writes).toBe(0);
  }, 20000);
  it("rolls back a protected approval written before its final policy deadline check expires", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host, { policyLifetimeMs: 10000 });
    await f.controller.lifecycle.advance(f.user.id, f.release.id);
    const action = await db.deliveryReleaseAction.findFirstOrThrow({
      where: { releaseId: f.release.id, phase: "prepared" },
    });
    await f.controller.step(f.user.id, action.id, f.signal);
    const marker = `d10_expiry_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(`CREATE SEQUENCE ${marker}`);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION ${marker}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('${marker}'); PERFORM pg_sleep(3.0); RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${marker} AFTER INSERT ON delivery_events FOR EACH ROW WHEN (NEW.owner_id='${f.user.id}'::uuid AND NEW.type='database_plan_approved') EXECUTE FUNCTION ${marker}()`,
    );
    try {
      const remaining = f.config.policy.expiresAt - Date.now();
      if (remaining > 2000) await db.$executeRaw`SELECT pg_sleep(${(remaining - 2000) / 1000})`;
      await expect(f.runJob(f.jobs[0])).rejects.toThrow();
      expect(await db.$queryRawUnsafe(`SELECT is_called FROM ${marker}`)).toEqual([
        { is_called: true },
      ]);
      expect(
        await db.deliveryEvent.count({
          where: { taskId: f.taskId, type: "database_plan_approved" },
        }),
      ).toBe(0);
      const now = (
        await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      expect(now).toBeGreaterThanOrEqual(f.config.policy.expiresAt);
      expect(f.catalog.expiresAt).toBeGreaterThan(now + 30000);
      expect(f.remote.writes).toBe(0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${marker} ON delivery_events`);
      await db.$executeRawUnsafe(`DROP FUNCTION ${marker}()`);
      await db.$executeRawUnsafe(`DROP SEQUENCE ${marker}`);
    }
  }, 20000);
  it("bounds baseline collection by the actual DB start despite a delayed clock-read response", async () => {
    const f = await automaticDatabaseFixture(db, url!, mocks.host);
    const original = db.$queryRaw.bind(db);
    let captured = 0,
      armed = false;
    const originalScope = f.controller.lifecycle.databaseObservationScope.bind(
      f.controller.lifecycle,
    );
    const scopeSpy = vi
      .spyOn(f.controller.lifecycle, "databaseObservationScope")
      .mockImplementation(async (...args) => {
        const scope = await originalScope(...args);
        armed = true;
        return scope;
      });
    const spy = vi
      .spyOn(
        db as unknown as {
          $queryRaw: (
            query: Parameters<typeof db.$queryRaw>[0],
            ...values: unknown[]
          ) => Promise<unknown>;
        },
        "$queryRaw",
      )
      .mockImplementation(async (query, ...values) => {
        const result = await original(query, ...values);
        if (
          armed &&
          !captured &&
          Array.isArray(query) &&
          query.join("").trim() === "SELECT clock_timestamp() AS now"
        ) {
          captured = (result as { now: Date }[])[0].now.getTime();
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return result;
      });
    try {
      expect(
        await f.controller.observeDatabase(f.user.id, f.release.id, "compatible", f.signal),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      scopeSpy.mockRestore();
      Object.defineProperty(db, "$queryRaw", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
    expect(captured).toBeGreaterThan(0);
    const latest = await db.deliveryReleaseObservation.findFirstOrThrow({
      where: { releaseId: f.release.id, kind: "automatic_baseline" },
      orderBy: { createdAt: "desc" },
    });
    const proof = latest.evidence as { observedAt: number; expiresAt: number };
    expect(proof.observedAt).toBeGreaterThanOrEqual(captured + 20);
    expect(proof.expiresAt).toBeLessThanOrEqual(captured + 30000);
  }, 15000);
});
