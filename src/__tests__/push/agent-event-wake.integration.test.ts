import { createHash, randomUUID } from "node:crypto";
import { type Prisma, PrismaClient } from "@hive/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withAgentWakeEnvironment } from "@/lib/push/agent-event-wake.server";
import {
  type AgentWakeIdentity,
  type AgentWakeReceipt,
  agentWakeName,
} from "@/lib/push/agent-event-wake-contracts";
import { acceptAgentEvent, dispatchAgentEvents } from "@/lib/push/agent-events";
import { claimDurablePush } from "@/lib/push/durable-outbox";

const url = process.env.HIVE_AGENT_WAKE_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    !/^\/hive_f07_agent_wake_[a-z0-9_]+$/.test(new URL(url).pathname))
)
  throw Error("Owned local agent wake database required");
const db = new PrismaClient({ datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/unused" });
const origin = "https://coder.agent-wake.invalid";
const token = "a".repeat(64),
  hash = createHash("sha256").update(token).digest("hex");
const event = (eventId = "exact-event") => ({
  eventId,
  kind: "question" as const,
  agent: "claude" as const,
  sessionName: "native-main",
  projectName: "owner/repo",
});
beforeAll(() => vi.stubEnv("CODER_URL", origin));
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
beforeEach(async () => {
  if (url) await db.$executeRawUnsafe("TRUNCATE users CASCADE");
});
async function fixture() {
  const identity = { ownerId: randomUUID(), sourceId: randomUUID(), eventKey: "exact-event" };
  await db.user.create({
    data: {
      id: identity.ownerId,
      coderUserId: randomUUID(),
      coderUrl: origin,
      username: "local-wake",
      email: `${identity.ownerId}@example.invalid`,
    },
  });
  await db.notificationSource.create({
    data: {
      id: identity.sourceId,
      userId: identity.ownerId,
      workspaceId: randomUUID(),
      workspaceName: "local-software",
      tokenHash: hash,
    },
  });
  return identity;
}
function wake(identity: AgentWakeIdentity) {
  const now = Date.now();
  const state: AgentWakeReceipt = {
    schemaVersion: 1,
    ...identity,
    createdAt: now,
    deadline: now + 1800000,
    requests: 1,
    attempts: 0,
    phase: "active",
    nextWake: now + 1000,
    inFlightUntil: 0,
  };
  let reserve = async () => structuredClone(state),
    inspect = async () => structuredClone(state);
  const calls = { reserve: 0, inspect: 0 };
  const env = {
    HIVE_NATIVE_MODE: "preview",
    HIVE_NATIVE_PREVIEW_ENABLED: "true",
    HIVE_AGENT_NOTIFICATION_WAKE_ENABLED: "true",
    HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON: JSON.stringify(identity),
    HIVE_AGENT_NOTIFICATION_WAKE: {
      getByName(name: string) {
        expect(name).toBe(agentWakeName(identity));
        return {
          reserve: async () => {
            calls.reserve++;
            return reserve();
          },
          inspect: async () => {
            calls.inspect++;
            return inspect();
          },
        };
      },
    },
  };
  return {
    state,
    calls,
    env,
    run: <T>(fn: () => T) => withAgentWakeEnvironment(env, fn),
    reserve: (fn: () => Promise<AgentWakeReceipt>) => {
      reserve = fn;
    },
    inspect: (fn: () => Promise<AgentWakeReceipt>) => {
      inspect = fn;
    },
  };
}
async function rows() {
  return db.$queryRaw<
    {
      id: string;
      sourceId: string;
      eventKey: string;
      status: string;
      attempts: number;
      tag: string;
    }[]
  >`SELECT id,source_id AS "sourceId",event_key AS "eventKey",status,attempts,payload->>'tag' AS tag FROM agent_notification_events ORDER BY event_key`;
}
// Fixture-admin time control applies only to this newly owned local database.
async function due(id?: string, attempts?: number) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "ALTER TABLE agent_notification_events DISABLE TRIGGER agent_notification_immutable",
    );
    await tx.$executeRawUnsafe(
      "UPDATE agent_notification_events SET next_attempt_at=clock_timestamp()-interval '1 second',attempts=COALESCE($2,attempts) WHERE ($1::uuid IS NULL OR id=$1::uuid)",
      id ?? null,
      attempts ?? null,
    );
    await tx.$executeRawUnsafe(
      "ALTER TABLE agent_notification_events ENABLE TRIGGER agent_notification_immutable",
    );
  });
}
describe.skipIf(!url)("exact notification wake / actual PostgreSQL", () => {
  it("default-off and valid nonpilot events perform zero DO I/O", async () => {
    const id = await fixture(),
      f = wake({ ...id, ownerId: randomUUID() });
    await withAgentWakeEnvironment({}, () => acceptAgentEvent(db, hash, event("baseline")));
    await f.run(() => acceptAgentEvent(db, hash, event()));
    await f.run(() => dispatchAgentEvents(db, async () => "delivered", { enabled: true }));
    expect(f.calls).toEqual({ reserve: 0, inspect: 0 });
    expect(await rows()).toHaveLength(2);
  });
  it("authenticates before reservation and failed reservation inserts neither outbox nor rate", async () => {
    const f = wake(await fixture());
    await expect(f.run(() => acceptAgentEvent(db, "f".repeat(64), event()))).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(f.calls.reserve).toBe(0);
    f.reserve(async () => {
      throw Error("unknown_reservation");
    });
    await expect(f.run(() => acceptAgentEvent(db, hash, event()))).rejects.toThrow();
    expect(await rows()).toEqual([]);
    expect(await db.$queryRaw`SELECT * FROM agent_notification_rate_windows`).toEqual([]);
  });
  it("does not hold the source lock during RPC and revalidates revocation afterward", async () => {
    const id = await fixture(),
      f = wake(id);
    f.reserve(async () => {
      await db.notificationSource.update({
        where: { id: id.sourceId },
        data: { tokenHash: "b".repeat(64), pendingTokenHash: null },
      });
      return f.state;
    });
    await expect(f.run(() => acceptAgentEvent(db, hash, event()))).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(await rows()).toEqual([]);
  });
  it("concurrent replay and unknown commit retain the first reservation and exactly one admission", async () => {
    const f = wake(await fixture()),
      deadline = f.state.deadline;
    const unknown = {
      ...db,
      $transaction: async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: unknown,
      ) => {
        await db.$transaction(fn, options as { timeout: number; maxWait: number });
        throw Error("unknown_commit");
      },
    } as unknown as PrismaClient;
    // Preserve prototype methods while simulating a lost committed acknowledgement.
    unknown.$queryRawUnsafe = db.$queryRawUnsafe.bind(db);
    await expect(f.run(() => acceptAgentEvent(unknown, hash, event()))).rejects.toThrow(
      "unknown_commit",
    );
    await Promise.all(
      Array.from({ length: 5 }, () => f.run(() => acceptAgentEvent(db, hash, event()))),
    );
    expect(await rows()).toHaveLength(1);
    expect(f.state.deadline).toBe(deadline);
    const [rate] = await db.$queryRaw<
      { accepted: number }[]
    >`SELECT accepted FROM agent_notification_rate_windows`;
    expect(rate.accepted).toBe(1);
    await expect(
      f.run(() => acceptAgentEvent(db, hash, { ...event(), kind: "ready" })),
    ).rejects.toMatchObject({ code: "event_conflict" });
  });
  it("expired reservations never insert and delayed commit remains fenced by the retained selector", async () => {
    const f = wake(await fixture());
    f.state.createdAt = Date.now() - 1800001;
    f.state.deadline = f.state.createdAt + 1800000;
    await expect(f.run(() => acceptAgentEvent(db, hash, event()))).rejects.toThrow(
      "agent_wake_unavailable",
    );
    expect(await rows()).toEqual([]);
    const g = wake({
      ownerId: f.state.ownerId,
      sourceId: f.state.sourceId,
      eventKey: f.state.eventKey,
    });
    const late = {
      ...db,
      $queryRawUnsafe: db.$queryRawUnsafe.bind(db),
      $transaction: async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: unknown,
      ) =>
        db.$transaction(
          async (tx) => {
            const result = await fn(tx);
            g.state.phase = "held";
            return result;
          },
          options as { timeout: number; maxWait: number },
        ),
    } as unknown as PrismaClient;
    await g.run(() => acceptAgentEvent(late, hash, event()));
    g.env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED = "false";
    const send = vi.fn(async () => "delivered" as const);
    const result = await g.run(() => dispatchAgentEvents(db, send, { enabled: true }));
    expect(send).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect((await rows())[0].status).toBe("failed");
    expect((await g.run(() => acceptAgentEvent(db, hash, event()))).accepted).toBe(true);
    const calls = { ...g.calls };
    await g.run(() => acceptAgentEvent(db, hash, event("unrelated-after-disable")));
    expect((await g.run(() => dispatchAgentEvents(db, send, { enabled: true }))).delivered).toBe(1);
    expect(g.calls).toEqual(calls);
  });
  it("post-insert expiry rolls back the outbox and rate in the original transaction", async () => {
    const f = wake(await fixture());
    const deadline = Date.now() + 200;
    f.state.createdAt = deadline - 1800000;
    f.state.deadline = deadline;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION wake_fixture_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER wake_fixture_delay BEFORE INSERT ON agent_notification_events FOR EACH ROW EXECUTE FUNCTION wake_fixture_delay()",
    );
    try {
      await expect(f.run(() => acceptAgentEvent(db, hash, event()))).rejects.toThrow(
        "agent_wake_unavailable",
      );
      expect(await rows()).toEqual([]);
      expect(await db.$queryRaw`SELECT * FROM agent_notification_rate_windows`).toEqual([]);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER wake_fixture_delay ON agent_notification_events");
      await db.$executeRawUnsafe("DROP FUNCTION wake_fixture_delay()");
    }
  });
  it("exact claims scope both exhaustion and candidates to the exact row and owner", async () => {
    const id = await fixture();
    for (const key of ["exact-event", "unrelated-exhausted", "unrelated-pending"])
      await acceptAgentEvent(db, hash, event(key));
    const all = await rows(),
      target = all.find((r) => r.eventKey === "exact-event")!,
      other = all.find((r) => r.eventKey === "unrelated-exhausted")!;
    await due(target.id, 5);
    await due(other.id, 5);
    expect(
      await claimDurablePush(db, "agent_notification_events", id.ownerId, 1, 120000, target.id),
    ).toEqual([]);
    const after = await rows();
    expect(after.find((r) => r.id === target.id)?.status).toBe("failed");
    expect(after.find((r) => r.id === other.id)?.status).toBe("pending");
    expect(after.find((r) => r.eventKey === "unrelated-pending")?.attempts).toBe(0);
    expect(
      await claimDurablePush(db, "agent_notification_events", randomUUID(), 1, 120000, other.id),
    ).toEqual([]);
    expect((await rows()).find((r) => r.id === other.id)?.status).toBe("pending");
  });
  it("exact dispatcher uses existing stable tag, five attempts and never claims a sibling", async () => {
    const id = await fixture(),
      f = wake(id);
    await f.run(() => acceptAgentEvent(db, hash, event()));
    await acceptAgentEvent(db, hash, event("sibling"));
    const tags: string[] = [];
    for (let n = 0; n < 5; n++) {
      await due((await rows()).find((r) => r.eventKey === id.eventKey)!.id);
      await f.run(() =>
        dispatchAgentEvents(
          db,
          async (_, payload) => {
            tags.push(payload.tag!);
            return "retry";
          },
          { enabled: true, exact: id },
        ),
      );
    }
    expect(new Set(tags)).toEqual(new Set([`hive-${id.sourceId}-${id.eventKey}`]));
    expect((await rows()).find((r) => r.eventKey === id.eventKey)).toMatchObject({
      status: "failed",
      attempts: 5,
    });
    expect((await rows()).find((r) => r.eventKey === "sibling")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
  it("unknown wake inspection never sends and hold settlement never replaces an active lease", async () => {
    const id = await fixture(),
      f = wake(id);
    await f.run(() => acceptAgentEvent(db, hash, event()));
    const [claim] = await claimDurablePush(db, "agent_notification_events", id.ownerId);
    await f.run(() =>
      dispatchAgentEvents(db, async () => "delivered", { enabled: true, exact: id }),
    );
    expect((await rows())[0]).toMatchObject({ status: "processing", attempts: claim.attempt });
    await due(claim.id);
    f.inspect(async () => {
      throw Error("unknown_inspection");
    });
    const send = vi.fn(async () => "delivered" as const);
    const result = await f.run(() => dispatchAgentEvents(db, send, { enabled: true }));
    expect(send).not.toHaveBeenCalled();
    expect(result.retry).toBe(1);
    await due(claim.id);
    f.state.phase = "held";
    f.inspect(async () => f.state);
    await f.run(() =>
      dispatchAgentEvents(db, async () => "delivered", { enabled: true, exact: id }),
    );
    expect((await rows())[0].status).toBe("failed");
  });
});
