import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptAgentEvent, dispatchAgentEvents } from "@/lib/push/agent-events";
import { agentEventsRoute } from "@/lib/push/agent-events-route";
import { claimDurablePush, settleDurablePush } from "@/lib/push/durable-outbox";

const url = process.env.HIVE_AGENT_NOTIFICATION_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).pathname !== "/hive_agent_notification_test")
)
  throw new Error("Dedicated local notification database required");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_agent_notification_test",
});
const origin = "https://coder.agent-notification.invalid";
const token = "a".repeat(64),
  hash = (value: string) => createHash("sha256").update(value).digest("hex");
const event = (id = "event_1") => ({
  eventId: id,
  kind: "approval" as const,
  agent: "codex" as const,
  sessionName: `git-clone-${"c".repeat(32)}`,
  projectName: "owner/repo",
});
beforeAll(() => vi.stubEnv("CODER_URL", origin));
afterAll(async () => {
  if (url) await db.notificationSource.deleteMany();
  vi.unstubAllEnvs();
  await db.$disconnect();
});
beforeEach(async () => {
  if (url) {
    await db.$executeRawUnsafe(
      "TRUNCATE agent_notification_events,agent_notification_rate_windows",
    );
    await db.notificationSource.deleteMany();
  }
});
async function fixture() {
  const ownerId = randomUUID(),
    coderUserId = randomUUID(),
    sourceId = randomUUID(),
    workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId,
      coderUrl: origin,
      username: "agent-notice",
      email: `${ownerId}@example.invalid`,
    },
  });
  await db.notificationSource.create({
    data: {
      id: sourceId,
      userId: ownerId,
      workspaceId,
      workspaceName: "dedicated-software",
      tokenHash: hash(token),
    },
  });
  return { ownerId, coderUserId, sourceId, workspaceId };
}
// Test-admin clock control on this dedicated local fixture only. All normal
// claim/settlement calls below run with the production integrity trigger enabled.
async function forceDue(milliseconds = -1000) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "ALTER TABLE agent_notification_events DISABLE TRIGGER agent_notification_immutable",
    );
    await tx.$executeRaw`UPDATE agent_notification_events SET next_attempt_at=clock_timestamp()+${milliseconds}*interval '1 millisecond'`;
    await tx.$executeRawUnsafe(
      "ALTER TABLE agent_notification_events ENABLE TRIGGER agent_notification_immutable",
    );
  });
}
async function rows() {
  return db.$queryRaw<
    {
      id: string;
      ownerId: string;
      status: string;
      attempts: number;
      payload: { body: string; tag: string; url: string };
    }[]
  >`SELECT id,owner_id AS "ownerId",status,attempts,payload FROM agent_notification_events`;
}
function request(input: unknown = event(), credential = token) {
  return new Request("https://hive.fixture.invalid/api/notifications/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}` },
    body: JSON.stringify(input),
  });
}
describe.skipIf(!url)("portable agent callbacks / actual PostgreSQL", () => {
  it("returns 202 only after committed owner/source-bound event and retains legacy label/link parity", async () => {
    const f = await fixture(),
      route = agentEventsRoute({ enabled: () => true, database: () => db });
    const response = await route(
      request({ ...event(), userId: randomUUID(), workspaceId: randomUUID() }),
    );
    expect(response.status).toBe(202);
    const [row] = await rows();
    expect(row.ownerId).toBe(f.ownerId);
    expect(row.status).toBe("pending");
    expect(row.payload.body).toContain(
      "Codex is waiting for your approval in owner/repo on dedicated-software",
    );
    expect(row.payload.body).not.toContain("git-clone-");
    expect(row.payload.tag).toBe(`hive-${f.sourceId}-event_1`);
    expect(row.payload.url).toContain(`workspace=${f.workspaceId}`);
    expect(row.payload.url).toContain(`session=${event().sessionName}`);
  });
  it("serializes concurrent replay into one event and one rate admission; changed payload conflicts", async () => {
    await fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => acceptAgentEvent(db, hash(token), event())),
    );
    expect(results.every((r) => r.accepted)).toBe(true);
    expect(await rows()).toHaveLength(1);
    const [rate] = await db.$queryRaw<
      { accepted: number }[]
    >`SELECT accepted FROM agent_notification_rate_windows`;
    expect(rate.accepted).toBe(1);
    await expect(
      acceptAgentEvent(db, hash(token), { ...event(), kind: "ready" }),
    ).rejects.toMatchObject({ code: "event_conflict" });
  });
  it("rolls back rate and outbox together when the transaction cannot commit", async () => {
    await fixture();
    const rejecting = {
      $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        db.$transaction(async (tx) => {
          await callback(tx);
          throw new Error("forced_rollback");
        }),
    } as unknown as PrismaClient;
    await expect(acceptAgentEvent(rejecting, hash(token), event())).rejects.toThrow(
      "forced_rollback",
    );
    expect(await rows()).toHaveLength(0);
    expect(await db.$queryRaw`SELECT * FROM agent_notification_rate_windows`).toHaveLength(0);
  });
  it("bounds concurrent new admissions to sixty per database minute and replays accepted events", async () => {
    await fixture();
    // Keep this concurrency assertion inside one database minute rather than
    // introducing a boundary-dependent sixty-first success.
    const [clock] = await db.$queryRaw<
      { second: number }[]
    >`SELECT extract(second FROM clock_timestamp()) AS second`;
    if (Number(clock.second) > 58)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.ceil((60 - Number(clock.second)) * 1000) + 50),
      );
    const accepted = await Promise.allSettled(
      Array.from({ length: 61 }, (_, i) => acceptAgentEvent(db, hash(token), event(`rate_${i}`))),
    );
    expect(accepted.filter((r) => r.status === "fulfilled")).toHaveLength(60);
    expect(accepted.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await rows()).toHaveLength(60);
    await expect(acceptAgentEvent(db, hash(token), event("rate_0"))).resolves.toEqual({
      accepted: true,
    });
  });
  it("preserves active/pending credential overlap and revocation cascades callbacks without resurrection", async () => {
    const f = await fixture(),
      pending = "b".repeat(64);
    await db.notificationSource.update({
      where: { id: f.sourceId },
      data: { pendingTokenHash: hash(pending), credentialGeneration: 1 },
    });
    await acceptAgentEvent(db, hash(token), event("old"));
    await acceptAgentEvent(db, hash(pending), event("pending"));
    await db.notificationSource.delete({ where: { id: f.sourceId } });
    expect(await rows()).toHaveLength(0);
    await expect(acceptAgentEvent(db, hash(token), event())).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(acceptAgentEvent(db, hash(pending), event())).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
  it("reuses D06 claim fences, stable tags and bounded retries with concurrent workers", async () => {
    await fixture();
    await acceptAgentEvent(db, hash(token), event());
    const send = vi.fn(async () => "delivered" as const);
    const results = await Promise.all([
      dispatchAgentEvents(db, send, { enabled: true }),
      dispatchAgentEvents(db, send, { enabled: true }),
    ]);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows())[0].status).toBe("delivered");
  });
  it("exhausts exactly five attempts and cannot acknowledge an expired/replaced claim", async () => {
    const f = await fixture();
    await acceptAgentEvent(db, hash(token), event());
    const [first] = await claimDurablePush(db, "agent_notification_events", f.ownerId);
    await forceDue();
    const [second] = await claimDurablePush(db, "agent_notification_events", f.ownerId);
    expect(await settleDurablePush(db, "agent_notification_events", first, "delivered")).toBe(
      false,
    );
    expect(await settleDurablePush(db, "agent_notification_events", second, "retry")).toBe(true);
    const send = vi.fn(async () => "retry" as const);
    for (let i = 0; i < 3; i++) {
      await forceDue();
      await dispatchAgentEvents(db, send, { enabled: true });
    }
    expect((await rows())[0]).toMatchObject({ status: "failed", attempts: 5 });
    await dispatchAgentEvents(db, send, { enabled: true });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("suppresses events when the current owner Coder identity changes before dispatch", async () => {
    const f = await fixture();
    await acceptAgentEvent(db, hash(token), event());
    await db.user.update({ where: { id: f.ownerId }, data: { coderUserId: randomUUID() } });
    const send = vi.fn(async () => "delivered" as const);
    expect((await dispatchAgentEvents(db, send, { enabled: true })).failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps the database lifetime held through a timed-out sender's late work", async () => {
    await fixture();
    await acceptAgentEvent(db, hash(token), event());
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const sendEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let settled = false;
    const dispatch = dispatchAgentEvents(
      db,
      async (_ownerId, _payload, signal) => {
        entered();
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
        await pending;
        await db.$queryRaw`SELECT 1`;
        return "delivered";
      },
      { enabled: true, sendMs: 5 },
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await sendEntered;
      await abortObserved;
      expect(settled).toBe(false);
    } finally {
      finish();
    }
    expect((await dispatch).retry).toBe(1);
    expect((await rows())[0].status).toBe("pending");
  });
  it("keeps the source backlog bounded while existing identical callbacks remain replayable", async () => {
    await fixture();
    await acceptAgentEvent(db, hash(token), event());
    await db.$executeRaw`INSERT INTO agent_notification_events(id,owner_id,source_id,event_id,event_key,payload,payload_digest,coder_user_id,coder_origin)
      SELECT gen_random_uuid(),owner_id,source_id,gen_random_uuid(),'backlog_'||n,payload,payload_digest,coder_user_id,coder_origin
      FROM agent_notification_events CROSS JOIN generate_series(1,599) n`;
    await expect(acceptAgentEvent(db, hash(token), event("new_event"))).rejects.toMatchObject({
      code: "backlog",
    });
    await expect(acceptAgentEvent(db, hash(token), event())).resolves.toEqual({ accepted: true });
    expect(await rows()).toHaveLength(600);
  });
  it("rolls back settlement that expires while an UPDATE trigger holds the physical row", async () => {
    const f = await fixture();
    await acceptAgentEvent(db, hash(token), event());
    const [claim] = await claimDurablePush(db, "agent_notification_events", f.ownerId);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION agent_notice_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER agent_notice_test_delay AFTER UPDATE ON agent_notification_events FOR EACH ROW WHEN (NEW.status='delivered') EXECUTE FUNCTION agent_notice_test_delay()",
    );
    try {
      await forceDue(80);
      await expect(
        settleDurablePush(db, "agent_notification_events", claim, "delivered"),
      ).rejects.toThrow("push_outbox_lease_expired");
      expect((await rows())[0].status).toBe("processing");
    } finally {
      await db.$executeRawUnsafe(
        "DROP TRIGGER agent_notice_test_delay ON agent_notification_events",
      );
      await db.$executeRawUnsafe("DROP FUNCTION agent_notice_test_delay()");
    }
  });
  it("revocation during an already-started sender cannot acknowledge or resurrect the deleted source", async () => {
    const f = await fixture();
    await acceptAgentEvent(db, hash(token), event());
    const result = await dispatchAgentEvents(
      db,
      async () => {
        await db.notificationSource.delete({ where: { id: f.sourceId } });
        return "delivered";
      },
      { enabled: true },
    );
    expect(result.stale).toBe(1);
    expect(await rows()).toHaveLength(0);
  });
});
