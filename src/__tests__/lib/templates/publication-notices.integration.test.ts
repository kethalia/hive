import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTemplatePublicationNotices,
  TemplatePublicationNotices,
} from "@/lib/templates/publication-notices";
import { TemplatePublicationStore } from "@/lib/templates/publication-store";

const url = process.env.HIVE_TEMPLATE_NOTICE_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hive_template_test")
)
  throw new Error("Requires task-owned local schema29 fixture");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_template_test",
});
const origin = "https://coder.notice-proof.invalid";
beforeAll(() => vi.stubEnv("CODER_URL", origin));
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
beforeEach(async () => {
  if (url) await db.$executeRawUnsafe("TRUNCATE template_publication_notices");
});
async function fixture(settle = true) {
  const ownerId = randomUUID(),
    coderUserId = randomUUID(),
    sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId,
      coderUrl: origin,
      username: "notice-fixture",
      email: "notice@example.invalid",
    },
  });
  await db.session.create({
    data: { userId: ownerId, sessionId, expiresAt: new Date(Date.now() + 3600000) },
  });
  const store = new TemplatePublicationStore(db),
    job = await store.enqueue(
      { ownerId, coderUserId, sessionId },
      {
        organizationId: randomUUID(),
        organizationName: "default",
        name: "ai-dev-k8s",
        templateId: randomUUID(),
        activeVersionId: randomUUID(),
      },
      {
        name: "ai-dev-k8s",
        archiveDigest: "a".repeat(64),
        contentHash: "b".repeat(64),
        manifestDigest: "c".repeat(64),
        archiveBytes: 1024,
      },
      randomUUID(),
    );
  const claim = await store.claim();
  expect(claim?.id).toBe(job.id);
  if (settle) await store.settle(claim!, "held", "provider_unavailable");
  return { ownerId, coderUserId, sessionId, store, job, claim: claim! };
}
describe.skipIf(!url)("publication terminal notices / real PostgreSQL", () => {
  it("commits exactly one owner/job terminal event notice with generic metadata and stable deep link", async () => {
    const f = await fixture();
    const notice = await db.templatePublicationNotice.findUniqueOrThrow({
      where: { jobId: f.job.id },
      include: { event: true },
    });
    expect(notice.event.key).toBe("terminal:held");
    expect(notice.ownerId).toBe(f.ownerId);
    await expect(f.store.settle(f.claim, "held", "provider_unavailable")).rejects.toMatchObject({
      code: "lease_lost",
    });
    expect(await db.templatePublicationNotice.count({ where: { jobId: f.job.id } })).toBe(1);
    const send = vi.fn(async () => "delivered" as const);
    const result = await dispatchTemplatePublicationNotices(db, send, { enabled: true });
    expect(result.delivered).toBe(1);
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
      f.ownerId,
      {
        kind: "template",
        title: "Template publication needs review",
        body: "ai-dev-k8s: open Hive to review the result",
        tag: `hive-template-${f.job.id}`,
        url: `/templates/ai-dev-k8s?publication=${f.job.id}`,
      },
    ]);
  });
  it("failed notice insert rolls back event/job/target settlement atomically", async () => {
    const f = await fixture(false);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION notice_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture reject'; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER notice_test_reject BEFORE INSERT ON template_publication_notices FOR EACH ROW EXECUTE FUNCTION notice_test_reject()",
    );
    try {
      await expect(f.store.settle(f.claim, "held", "provider_unavailable")).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER notice_test_reject ON template_publication_notices");
      await db.$executeRawUnsafe("DROP FUNCTION notice_test_reject()");
    }
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).stage,
    ).toBe("queued");
    expect(await db.templatePublicationEvent.count({ where: { jobId: f.job.id } })).toBe(1);
    expect(await db.templatePublicationNotice.count({ where: { jobId: f.job.id } })).toBe(0);
    await f.store.settle(f.claim, "held", "provider_unavailable");
  });
  it("concurrent consumers claim once; restart reclaims expired holder and rejects stale acknowledgements", async () => {
    await fixture();
    const a = new TemplatePublicationNotices(db, { leaseMs: 100 }),
      claims = await Promise.all([a.claim(), a.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const current = await new TemplatePublicationNotices(db).claim();
    expect(current?.attempt).toBe(2);
    expect(current?.holder).not.toBe(old.holder);
    expect(await a.acknowledge(old, "delivered", "delivered")).toBe(false);
    expect(await a.acknowledge(current!, "delivered", "delivered")).toBe(true);
  });
  it("binding current Coder account/origin suppresses stale notices, while expired original session does not", async () => {
    const f = await fixture();
    await db.session.delete({ where: { sessionId: f.sessionId } });
    const send = vi.fn(async () => "delivered" as const);
    expect((await dispatchTemplatePublicationNotices(db, send, { enabled: true })).delivered).toBe(
      1,
    );
    const g = await fixture();
    await db.user.update({ where: { id: g.ownerId }, data: { coderUserId: randomUUID() } });
    expect((await dispatchTemplatePublicationNotices(db, send, { enabled: true })).skipped).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("unknown sender outcome retries with stable tag then permanently exhausts at5 bounded attempts", async () => {
    const f = await fixture(),
      send = vi.fn(async () => {
        throw new Error("private provider detail");
      });
    for (let n = 0; n < 5; n++) {
      const result = await dispatchTemplatePublicationNotices(db, send, {
        enabled: true,
        timing: { retryMs: 1 },
      });
      expect(n === 4 ? result.failed : result.retry).toBe(1);
      if (n < 4) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      (await db.templatePublicationNotice.findUniqueOrThrow({ where: { jobId: f.job.id } }))
        .attempts,
    ).toBe(5);
    expect(send).toHaveBeenCalledTimes(5);
    expect((await dispatchTemplatePublicationNotices(db, send, { enabled: true })).failed).toBe(0);
  });
  it("foreign claim and cross-owner event references are rejected; terminal notice deletion and mutation are forbidden", async () => {
    const f = await fixture(),
      store = new TemplatePublicationNotices(db),
      claim = await store.claim();
    expect(await store.notification({ ...claim!, ownerId: randomUUID() })).toBeNull();
    const other = await fixture();
    const event = await db.templatePublicationEvent.findFirstOrThrow({
      where: { jobId: other.job.id, key: "terminal:held" },
    });
    await expect(
      db.templatePublicationNotice.create({
        data: { ownerId: f.ownerId, jobId: other.job.id, eventId: event.id },
      }),
    ).rejects.toThrow();
    await store.acknowledge(claim!, "delivered", "delivered");
    await expect(
      db.templatePublicationNotice.delete({ where: { id: claim!.id } }),
    ).rejects.toThrow();
    await expect(
      db.templatePublicationNotice.update({
        where: { id: claim!.id },
        data: { status: "pending" },
      }),
    ).rejects.toThrow();
  });
  it("runtime role receives only SELECT/INSERT/UPDATE on new ledger, no history deletion or truncation", async () => {
    const [row] = await db.$queryRaw<
      { read: boolean; insert: boolean; update: boolean; del: boolean; truncate: boolean }[]
    >`SELECT has_table_privilege('hive_app_runtime','template_publication_notices','SELECT') AS read,has_table_privilege('hive_app_runtime','template_publication_notices','INSERT') AS insert,has_table_privilege('hive_app_runtime','template_publication_notices','UPDATE') AS update,has_table_privilege('hive_app_runtime','template_publication_notices','DELETE') AS del,has_table_privilege('hive_app_runtime','template_publication_notices','TRUNCATE') AS truncate`;
    expect(row).toEqual({ read: true, insert: true, update: true, del: false, truncate: false });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE hive_app_runtime");
      await expect(
        tx.$queryRaw`SELECT count(*) FROM template_publication_notices`,
      ).resolves.toBeDefined();
    });
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE hive_app_runtime");
        await tx.$executeRawUnsafe("TRUNCATE template_publication_notices");
      }),
    ).rejects.toThrow();
  });
  it("flag off does not claim or invoke sender", async () => {
    await fixture();
    const send = vi.fn();
    expect((await dispatchTemplatePublicationNotices(db, send, { enabled: false })).enabled).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
    expect((await db.templatePublicationNotice.findFirstOrThrow()).attempts).toBe(0);
  });
  it("late SQL acknowledgement rolls back after real lease expiry", async () => {
    await fixture();
    const store = new TemplatePublicationNotices(db, { leaseMs: 100 }),
      claim = await store.claim();
    await db.$executeRawUnsafe(
      "CREATE FUNCTION notice_ack_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER notice_ack_delay BEFORE UPDATE ON template_publication_notices FOR EACH ROW EXECUTE FUNCTION notice_ack_delay()",
    );
    try {
      await expect(store.acknowledge(claim!, "delivered", "delivered")).rejects.toThrow(
        "template_notice_lease_expired",
      );
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER notice_ack_delay ON template_publication_notices");
      await db.$executeRawUnsafe("DROP FUNCTION notice_ack_delay()");
    }
    const row = await db.templatePublicationNotice.findUniqueOrThrow({ where: { id: claim!.id } });
    expect(row.status).toBe("processing");
    expect(row.leaseHolder).toBe(claim!.holder);
  });
  it("account change during sending cannot ACK delivery or authorize another send", async () => {
    const f = await fixture();
    const send = vi.fn(async () => {
      await db.user.update({ where: { id: f.ownerId }, data: { coderUserId: randomUUID() } });
      return "delivered" as const;
    });
    expect(
      (
        await dispatchTemplatePublicationNotices(db, send, {
          enabled: true,
          timing: { leaseMs: 100 },
        })
      ).stale,
    ).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await dispatchTemplatePublicationNotices(db, send, { enabled: true })).skipped).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });
  it("deadline aborts sender but drains actual late DB work before ACK and caller lifetime closure", async () => {
    const f = await fixture();
    let finish!: () => void,
      aborted = false,
      closed = false,
      lateDBFinished = false;
    const send = async (_owner: string, _payload: unknown, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(closed).toBe(false);
      await db.templatePublicationNotice.count({ where: { jobId: f.job.id } });
      lateDBFinished = true;
      return "delivered" as const;
    };
    const pending = dispatchTemplatePublicationNotices(db, send, {
      enabled: true,
      timing: { sendMs: 20 },
    }).finally(() => {
      closed = true;
    });
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
    expect(
      (await db.templatePublicationNotice.findUniqueOrThrow({ where: { jobId: f.job.id } })).status,
    ).toBe("processing");
    finish();
    expect((await pending).retry).toBe(1);
    expect(lateDBFinished).toBe(true);
    expect(closed).toBe(true);
    expect(
      (await db.templatePublicationNotice.findUniqueOrThrow({ where: { jobId: f.job.id } })).status,
    ).toBe("pending");
  });
});
