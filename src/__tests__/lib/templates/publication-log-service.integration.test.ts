import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TemplatePublicationLogService } from "@/lib/templates/publication-log-service";
import { TemplatePublicationStore } from "@/lib/templates/publication-store";

const url = process.env.HIVE_TEMPLATE_NOTICE_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hive_template_test")
)
  throw new Error("Requires isolated schema29 fixture");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_template_test",
});
const origin = "https://coder.logs-proof.invalid";
beforeAll(() => vi.stubEnv("CODER_URL", origin));
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
});
afterEach(async () => {
  if (url)
    await db.templatePublicationJob.updateMany({
      where: { stage: { notIn: ["succeeded", "failed", "held"] } },
      data: { nextAttemptAt: new Date("2100-01-01") },
    });
});
async function fixture() {
  const who = { ownerId: randomUUID(), coderUserId: randomUUID(), sessionId: randomUUID() };
  await db.user.create({
    data: {
      id: who.ownerId,
      coderUserId: who.coderUserId,
      coderUrl: origin,
      username: "log-fixture",
      email: "log@example.invalid",
    },
  });
  await db.session.create({
    data: {
      userId: who.ownerId,
      sessionId: who.sessionId,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const actor = {
    ...who,
    origin,
    token: "synthetic-only",
    sessionExpiresAt: new Date(Date.now() + 3600000),
    tokenExpiresAt: null,
  };
  const store = new TemplatePublicationStore(db),
    target = {
      organizationId: randomUUID(),
      organizationName: "default",
      name: "ai-dev-k8s",
      templateId: randomUUID(),
      activeVersionId: randomUUID(),
    };
  const job = await store.enqueue(
      who,
      target,
      {
        name: target.name,
        archiveDigest: "a".repeat(64),
        contentHash: "b".repeat(64),
        manifestDigest: "c".repeat(64),
        archiveBytes: 1024,
      },
      randomUUID(),
    ),
    claim = await store.claim();
  expect(claim?.id).toBe(job.id);
  await store.begin(claim!, "uploading");
  const fileId = randomUUID();
  await store.uploaded(claim!, fileId);
  await store.begin(claim!, "creating_version");
  const versionId = randomUUID(),
    importJobId = randomUUID(),
    message = `hive-publication:${job.id}:${job.archiveDigest}`;
  await store.versioned(claim!, {
    id: versionId,
    name: job.versionName,
    message,
    fileId,
    importJobId,
    organizationId: target.organizationId,
    templateId: target.templateId,
    creatorId: who.coderUserId,
    initiatorId: who.coderUserId,
    status: "running",
    errorCode: null,
    logsOverflowed: false,
  });
  await store.release(claim!);
  let output = "PRIVATE_HUMAN_OUTPUT";
  let revoke = false;
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/users/me")) return Response.json({ id: who.coderUserId });
    if (path.includes("/logs?")) {
      if (revoke)
        await db.user.update({ where: { id: who.ownerId }, data: { coderUserId: randomUUID() } });
      return Response.json([{ id: 1, output }]);
    }
    return Response.json({
      id: versionId,
      template_id: target.templateId,
      organization_id: target.organizationId,
      name: job.versionName,
      message,
      created_by: { id: who.coderUserId },
      job: {
        id: importJobId,
        file_id: fileId,
        organization_id: target.organizationId,
        initiator_id: who.coderUserId,
        type: "template_version_import",
      },
    });
  });
  const service = new TemplatePublicationLogService(db, async () => actor, transport);
  return {
    who,
    actor,
    job,
    service,
    transport,
    setOversized: () => {
      output = "x".repeat(40000);
    },
    revoke: () => {
      revoke = true;
    },
  };
}
describe.skipIf(!url)("owner-scoped human log reads / real PostgreSQL", () => {
  it("reads exact stored IDs without mutating event/job/notice or persisting raw output", async () => {
    const f = await fixture();
    const before = await db.templatePublicationEvent.count({ where: { jobId: f.job.id } }),
      page = await f.service.read(f.who, "ai-dev-k8s", f.job.id, "0", AbortSignal.timeout(15000));
    expect(page.records[0]?.output).toBe("PRIVATE_HUMAN_OUTPUT");
    expect(page.coderUrl).toContain(`/versions/${f.job.versionName}`);
    expect(await db.templatePublicationEvent.count({ where: { jobId: f.job.id } })).toBe(before);
    const stored = await db.templatePublicationJob.findUniqueOrThrow({
      where: { id: f.job.id },
      include: { events: true },
    });
    expect(
      JSON.stringify(stored, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain("PRIVATE_HUMAN_OUTPUT");
    expect(f.transport).toHaveBeenCalledTimes(4);
  });
  it("foreign owner/task cannot select a provider version and does not fetch raw logs", async () => {
    const f = await fixture();
    await expect(
      f.service.read(
        { ...f.who, ownerId: randomUUID() },
        "ai-dev-k8s",
        f.job.id,
        "0",
        AbortSignal.timeout(15000),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.service.read(f.who, "browser-testing", f.job.id, "0", AbortSignal.timeout(15000)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("oversized first row keeps cursor and returns only a fixed validated Coder fallback", async () => {
    const f = await fixture();
    f.setOversized();
    const page = await f.service.read(
      f.who,
      "ai-dev-k8s",
      f.job.id,
      "0",
      AbortSignal.timeout(15000),
    );
    expect(page.records).toEqual([]);
    expect(page.nextAfter).toBe("0");
    expect(page.fallback).toBe("row_too_large");
    expect(page.coderUrl).toBe(
      `${origin}/templates/default/ai-dev-k8s/versions/${f.job.versionName}`,
    );
  });
  it("owner account switch while reading discards buffered output", async () => {
    const f = await fixture();
    f.revoke();
    await expect(
      f.service.read(f.who, "ai-dev-k8s", f.job.id, "0", AbortSignal.timeout(15000)),
    ).rejects.toMatchObject({ code: "actor_revoked" });
  });
  it("a fresh valid session may read the original owner's historical import", async () => {
    const f = await fixture();
    await db.session.delete({ where: { sessionId: f.who.sessionId } });
    const fresh = randomUUID();
    await db.session.create({
      data: { userId: f.who.ownerId, sessionId: fresh, expiresAt: new Date(Date.now() + 3600000) },
    });
    f.actor.sessionId = fresh;
    expect(
      (
        await f.service.read(
          { ...f.who, sessionId: fresh },
          "ai-dev-k8s",
          f.job.id,
          "0",
          AbortSignal.timeout(15000),
        )
      ).records,
    ).toHaveLength(1);
  });
});
