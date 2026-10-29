import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  ProjectTaskIntents,
  reconcileTaskIntents,
  type TaskIntentPayload,
  taskRequestDigest,
} from "@/lib/projects/task-intents.server";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
const key = "a".repeat(64);
const store = new ProjectTaskIntents(db, key);
const owners: string[] = [];
afterAll(async () => {
  if (url)
    for (const ownerId of owners) {
      await db.projectTaskIntent.deleteMany({ where: { ownerId } });
      await db.deliveryProject.deleteMany({ where: { ownerId } });
      await db.user.delete({ where: { id: ownerId } });
    }
  await db.$disconnect();
});
async function fixture() {
  const user = await db.user.create({
    data: {
      coderUrl: "https://fixture.invalid",
      coderUserId: randomUUID(),
      username: "intent-fixture",
      email: "fixture@example.invalid",
    },
  });
  owners.push(user.id);
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/intent",
    },
  });
  const taskId = randomUUID(),
    requestId = randomUUID(),
    workspaceId = randomUUID();
  const payload: TaskIntentPayload = {
    ownerId: user.id,
    projectId: project.id,
    workspaceId,
    taskId,
    requestId,
    requestDigest: taskRequestDigest([
      user.id,
      project.id,
      workspaceId,
      requestId,
      "private task text",
    ]),
    hostRequest: {
      schemaVersion: 1,
      projectId: project.id,
      repositoryId: "123",
      expectedAccountId: "456",
      taskId,
      requestId,
      revision: "a".repeat(40),
      model: "fixture",
      effort: "high",
      text: "private task text",
    },
  };
  return { user, project, payload, target: { ownerId: user.id, taskId } };
}
function status(
  p: Pick<TaskIntentPayload, "projectId" | "taskId">,
  phase: "preparing" | "running" = "preparing",
) {
  return {
    schemaVersion: 1 as const,
    projectId: p.projectId,
    taskId: p.taskId,
    phase,
    nativeThreadId: phase === "running" ? "thread" : null,
    terminalSessionName: null,
    reason: null,
  };
}
describe.skipIf(!url)("durable project preparation", () => {
  it("atomically deduplicates concurrent accepted intents and encrypts their prompts", async () => {
    const f = await fixture();
    const rows = await Promise.all([store.enqueue(f.payload), store.enqueue(f.payload)]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(await db.projectTaskIntent.count({ where: { ownerId: f.user.id } })).toBe(1);
    expect(Buffer.from(rows[0].ciphertext!).includes(Buffer.from("private task text"))).toBe(false);
    expect(store.payload(rows[0])).toEqual(f.payload);
    await expect(store.enqueue({ ...f.payload, requestDigest: "b".repeat(64) })).rejects.toThrow(
      "task_identity_conflict",
    );
    await expect(
      store.get(randomUUID(), f.project.id, f.payload.taskId, f.payload.workspaceId),
    ).rejects.toThrow("task_not_found");
    await expect(
      store.get(f.user.id, f.project.id, f.payload.taskId, randomUUID()),
    ).rejects.toThrow("task_not_found");
  });
  it("isolates simultaneous claims and fences an expired worker acknowledgement", async () => {
    const f = await fixture();
    await store.enqueue(f.payload);
    const claims = await Promise.all([store.claim(f.target), store.claim(f.target)]);
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await db.projectTaskIntent.update({
      where: { id: first.id },
      data: { leaseUntil: new Date(0) },
    });
    const replacement = await store.claim(f.target);
    expect(replacement).not.toBeNull();
    expect(await store.finish(first, status(f.payload, "running"))).toBe(false);
    expect(await store.finish(replacement!, status(f.payload))).toBe(true);
    expect((await store.get(f.user.id, f.project.id, first.id, f.payload.workspaceId)).phase).toBe(
      "preparing",
    );
  });
  it("resumes an accepted request after process/browser loss and removes payload after the host is running", async () => {
    const f = await fixture();
    await store.enqueue(f.payload);
    const restarted = new ProjectTaskIntents(db, key);
    const calls: string[] = [];
    await reconcileTaskIntents(
      restarted,
      async (payload, phase) => {
        calls.push(phase);
        expect(payload.hostRequest?.text).toBe("private task text");
        return status(payload);
      },
      f.target,
      1,
    );
    await db.projectTaskIntent.update({
      where: { id: f.payload.taskId },
      data: { nextAttemptAt: new Date(0) },
    });
    await reconcileTaskIntents(
      restarted,
      async (payload, phase) => {
        calls.push(phase);
        return status(payload, "running");
      },
      f.target,
      1,
    );
    expect(calls).toEqual(["queued", "preparing"]);
    const row = await restarted.get(
      f.user.id,
      f.project.id,
      f.payload.taskId,
      f.payload.workspaceId,
    );
    expect(row.phase).toBe("running");
    expect(row.ciphertext).toBeNull();
    expect(row.iv).toBeNull();
    expect(row.authTag).toBeNull();
    expect(await restarted.claim(f.target)).toBeNull();
    await db.projectTaskIntent.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await reconcileTaskIntents(
      restarted,
      async (payload, phase) => {
        expect(phase).toBe("running");
        expect(payload.hostRequest).toBeUndefined();
        expect(payload.sourceSha).toBe("a".repeat(40));
        return status(payload);
      },
      f.target,
      1,
    );
    await db.projectTaskIntent.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await reconcileTaskIntents(
      restarted,
      async (payload, phase) => {
        expect(phase).toBe("preparing");
        expect(payload.hostRequest).toBeUndefined();
        return status(payload, "running");
      },
      f.target,
      1,
    );
  });
  it("fails boundedly without recording credential-bearing errors or replacing task identity", async () => {
    const f = await fixture();
    await store.enqueue(f.payload);
    for (let index = 0; index < 5; index++) {
      await db.projectTaskIntent.update({
        where: { id: f.payload.taskId },
        data: { nextAttemptAt: new Date(0) },
      });
      await reconcileTaskIntents(
        store,
        async (payload) => {
          expect(payload.taskId).toBe(f.payload.taskId);
          throw new Error("secret bearer fixture");
        },
        f.target,
        1,
      );
    }
    const row = await store.get(f.user.id, f.project.id, f.payload.taskId, f.payload.workspaceId);
    expect(row.phase).toBe("blocked");
    expect(row.failureCount).toBe(5);
    expect(JSON.stringify(row.status)).not.toContain("secret");
    expect(await store.claim(f.target)).toBeNull();
  });
  it("counts abandoned leases against the retry budget before another external action", async () => {
    const f = await fixture();
    await store.enqueue(f.payload);
    for (let index = 0; index < 5; index++) {
      const claim = await store.claim(f.target);
      expect(claim?.phase).toBe("queued");
      await db.projectTaskIntent.update({
        where: { id: f.payload.taskId },
        data: { leaseUntil: new Date(0) },
      });
    }
    let executions = 0;
    await reconcileTaskIntents(
      store,
      async (p) => {
        executions++;
        return status(p);
      },
      f.target,
      1,
    );
    expect(executions).toBe(0);
    const row = await store.get(f.user.id, f.project.id, f.payload.taskId, f.payload.workspaceId);
    expect(row.phase).toBe("blocked");
    expect(row.failureCount).toBe(5);
  });
  it("bounds unchanged preparation polling without timing out a running native task", async () => {
    const f = await fixture();
    await store.enqueue(f.payload);
    const first = await store.claim(f.target);
    await store.finish(first!, status(f.payload));
    const past = new Date(Date.now() - 31 * 60_000);
    await db.projectTaskIntent.update({
      where: { id: f.payload.taskId },
      data: { progressAt: past, nextAttemptAt: new Date(0) },
    });
    let calls = 0;
    await reconcileTaskIntents(
      store,
      async (p) => {
        calls++;
        return status(p);
      },
      f.target,
      1,
    );
    expect(calls).toBe(0);
    const blocked = await store.get(
      f.user.id,
      f.project.id,
      f.payload.taskId,
      f.payload.workspaceId,
    );
    expect(blocked.phase).toBe("blocked");
    expect(blocked.status).toMatchObject({ reason: "preparation_timeout" });

    const running = await fixture();
    await store.enqueue(running.payload);
    const claim = await store.claim(running.target);
    await store.finish(claim!, status(running.payload, "running"));
    await db.projectTaskIntent.update({
      where: { id: running.payload.taskId },
      data: { progressAt: past, nextAttemptAt: new Date(0) },
    });
    const next = await store.claim(running.target);
    expect(next?.phase).toBe("running");
    await store.finish(next!, status(running.payload, "running"));
    const unchanged = await store.get(
      running.user.id,
      running.project.id,
      running.payload.taskId,
      running.payload.workspaceId,
    );
    expect(unchanged.progressAt.getTime()).toBe(past.getTime());
  });
  it("rejects cross-row ciphertext substitution and partial encrypted payload columns", async () => {
    const a = await fixture(),
      b = await fixture();
    const [one, two] = await Promise.all([store.enqueue(a.payload), store.enqueue(b.payload)]);
    expect(() =>
      store.payload({ ...one, ciphertext: two.ciphertext, iv: two.iv, authTag: two.authTag }),
    ).toThrow("binding mismatch");
    await expect(
      db.projectTaskIntent.update({ where: { id: one.id }, data: { iv: null } }),
    ).rejects.toThrow();
  });
});
