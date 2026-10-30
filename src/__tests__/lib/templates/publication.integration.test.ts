import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  TemplatePublicationError,
  type TemplateRemoteTarget,
  type TemplateRemoteVersion,
} from "@/lib/templates/publication-contracts";
import type { TemplatePublicationProvider } from "@/lib/templates/publication-provider";
import { templatePublicationRoutes } from "@/lib/templates/publication-routes";
import { TemplatePublicationService } from "@/lib/templates/publication-service";

const url = process.env.HIVE_TEMPLATE_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/hive_template_test")
)
  throw new Error("Requires isolated local template fixture");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_template_test",
});
afterAll(() => db.$disconnect());
afterEach(async () => {
  if (url)
    await db.templatePublicationJob.updateMany({
      where: { stage: { notIn: ["held", "succeeded", "failed"] } },
      data: { nextAttemptAt: new Date("2100-01-01") },
    });
});
const bytes = new TextEncoder().encode("canonical fixture artifact");
const artifact = {
  name: "ai-dev-k8s",
  archiveDigest: createHash("sha256").update(bytes).digest("hex"),
  archiveBytes: bytes.length,
  contentHash: "c".repeat(64),
  manifestDigest: "d".repeat(64),
};
async function fixture(
  options: { create?: boolean; legacy?: boolean; tags?: Record<string, string> } = {},
) {
  const ownerId = randomUUID(),
    coderUserId = randomUUID(),
    sessionId = randomUUID();
  const origin = "https://coder.kethalia.com";
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId,
      coderUrl: origin,
      username: "fixture",
      email: "fixture@example.invalid",
    },
  });
  await db.session.create({
    data: { userId: ownerId, sessionId, expiresAt: new Date(Date.now() + 3600000) },
  });
  const actor = {
    ownerId,
    coderUserId,
    sessionId,
    origin,
    token: "PRIVATE_NEVER_PERSIST",
    sessionExpiresAt: new Date(Date.now() + 3600000),
    tokenExpiresAt: null,
  };
  const target: TemplateRemoteTarget = {
    organizationId: randomUUID(),
    organizationName: "default",
    templateId: options.create ? null : randomUUID(),
    name: artifact.name,
    activeVersionId: options.create ? null : String(randomUUID()),
  };
  const counts = { upload: 0, create: 0, activate: 0 };
  let version: TemplateRemoteVersion | null = null,
    lostCreate = false,
    lostActivation = false,
    changedArtifact = false;
  let templateCreates = 0,
    lostTemplate = false;
  const inheritedTags: Record<string, string> = options.tags ?? {
    pool: "private-provisioner-tag",
    scope: "organization",
    owner: "",
  };
  let sentTags: Record<string, string> | undefined;
  const provider: TemplatePublicationProvider = {
    actor,
    locate: async () => ({ ...target }),
    current: async () => ({ ...target }),
    absent: async () => {
      if (target.templateId !== null) throw new TemplatePublicationError("external_drift");
    },
    tags: async () => ({ ...inheritedTags }),
    createTemplate: async (_scope, versionId) => {
      templateCreates++;
      target.templateId = randomUUID();
      target.activeVersionId = versionId;
      target.createdById = coderUserId;
      if (version) version.templateId = target.templateId;
      if (lostTemplate) throw new Error("synthetic lost creation ACK");
      return { ...target };
    },
    upload: async () => {
      counts.upload++;
      return fileId;
    },
    verifyFile: async () => {},
    createVersion: async (_target, input) => {
      counts.create++;
      sentTags = input.provisionerTags ? { ...input.provisionerTags } : undefined;
      version = {
        id: randomUUID(),
        name: input.name,
        message: input.message,
        organizationId: target.organizationId,
        templateId: target.templateId,
        fileId,
        importJobId: randomUUID(),
        creatorId: coderUserId,
        initiatorId: coderUserId,
        status: "succeeded",
        errorCode: null,
        logsOverflowed: false,
        provisionerTags: input.provisionerTags
          ? {
              ...input.provisionerTags,
              owner: input.provisionerTags.scope === "user" ? coderUserId : "",
            }
          : undefined,
      };
      if (lostCreate) throw new Error("secret provider response");
      return version;
    },
    versionByName: async () => version,
    versionById: async () => {
      if (!version) throw new Error();
      return version;
    },
    logs: async () => ({ after: "1", records: 1, overflowed: false }),
    activate: async (_target, id) => {
      counts.activate++;
      target.activeVersionId = id;
      if (lostActivation) throw new Error("secret activation response");
    },
  };
  const fileId = randomUUID();
  const service = new TemplatePublicationService(db, {
    enabled: true,
    authorizeActor: async () => actor,
    loadArtifact: async () => bytes,
    currentArtifact: () =>
      changedArtifact ? { ...artifact, manifestDigest: "e".repeat(64) } : artifact,
    provider: async () => provider,
  });
  const job = options.legacy
    ? await service.store.enqueue(actor, target, artifact, randomUUID())
    : await service.enqueue(actor, artifact.name, randomUUID());
  const due = () =>
    db.templatePublicationJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(0) },
    });
  const run = async () => {
    await due();
    return service.processOne();
  };
  return {
    actor,
    target,
    counts,
    provider,
    service,
    job,
    run,
    inheritedTags,
    getSentTags: () => sentTags,
    templateCreates: () => templateCreates,
    setLostTemplate: () => {
      lostTemplate = true;
    },
    setLostCreate: () => {
      lostCreate = true;
    },
    setLostActivation: () => {
      lostActivation = true;
    },
    changeArtifact: () => {
      changedArtifact = true;
    },
    getVersion: () => version,
  };
}
describe.skipIf(!url)("durable template publisher / real PostgreSQL", () => {
  it("uploads verified immutable bytes, imports and activates once; safe events contain no provider output or token", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.run();
    const job = await f.service.store.read(f.actor.ownerId, artifact.name, f.job.id);
    expect(job?.stage).toBe("succeeded");
    expect(f.counts).toEqual({ upload: 1, create: 1, activate: 1 });
    expect(
      JSON.stringify(job, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toContain("PRIVATE_NEVER_PERSIST");
    expect(job?.events.map((e) => e.code)).toContain("activation_verified");
    expect(await f.service.store.read(randomUUID(), artifact.name, f.job.id)).toBeNull();
  });
  it("reconciles lost version ACK by stable identity without another POST", async () => {
    const f = await fixture();
    await f.run();
    f.setLostCreate();
    await f.run();
    expect(f.counts.create).toBe(1);
    await f.run();
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).stage,
    ).toBe("importing");
    expect(f.counts.create).toBe(1);
  });
  it("holds unknown activation even when remote readback matches desired version; no replay PATCH or other owner takeover", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await f.run();
    f.setLostActivation();
    await f.run();
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("activation_unknown");
    await expect(f.service.enqueue(f.actor, artifact.name, randomUUID())).rejects.toMatchObject({
      code: "publication_busy",
    });
    expect(f.counts.activate).toBe(1);
  });
  it("actor logout before effects holds; no upload", async () => {
    const f = await fixture();
    await db.session.delete({ where: { sessionId: f.actor.sessionId } });
    await f.run();
    expect(f.counts.upload).toBe(0);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("actor_revoked");
  });
  it("artifact drift never uploads different source", async () => {
    const f = await fixture();
    f.changeArtifact();
    await f.run();
    expect(f.counts.upload).toBe(0);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("artifact_changed");
  });
  it("concurrent claims serialize globally; expired old holder cannot acknowledge", async () => {
    const f = await fixture();
    const claims = await Promise.all([f.service.store.claim(), f.service.store.claim()]);
    const c = claims.find((v) => v?.id === f.job.id);
    expect(c).toBeTruthy();
    expect(claims.filter((v) => v?.id === f.job.id)).toHaveLength(1);
    await db.templatePublicationJob.update({
      where: { id: f.job.id },
      data: { leaseUntil: new Date(0) },
    });
    const replacement = await f.service.store.claim();
    expect(replacement?.id).toBe(f.job.id);
    await expect(f.service.store.uploaded(c!, randomUUID())).rejects.toMatchObject({
      code: "lease_lost",
    });
    await f.service.store.settle(replacement!, "held", "provider_unavailable");
  });
  it("exact request replay retains job; changed digest conflicts; persisted identities and append-only events reject SQL mutation", async () => {
    const f = await fixture();
    expect((await f.service.enqueue(f.actor, artifact.name, f.job.requestId)).id).toBe(f.job.id);
    await expect(
      f.service.store.enqueue(
        f.actor,
        f.target,
        { ...artifact, archiveDigest: "f".repeat(64) },
        f.job.requestId,
      ),
    ).rejects.toMatchObject({ code: "request_conflict" });
    await expect(
      db.templatePublicationJob.update({
        where: { id: f.job.id },
        data: { archiveDigest: "f".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      db.templatePublicationEvent.updateMany({
        where: { jobId: f.job.id },
        data: { code: "activation_verified" },
      }),
    ).rejects.toThrow();
    const claim = await f.service.store.claim();
    if (claim) await f.service.store.settle(claim, "held", "provider_unavailable");
  });
  it("rejects a late database acknowledgement and rolls back its event after lease expiry during SQL", async () => {
    const f = await fixture(),
      claim = await f.service.store.claim();
    expect(claim?.id).toBe(f.job.id);
    await db.templatePublicationJob.update({
      where: { id: f.job.id },
      data: { leaseUntil: new Date(Date.now() + 400) },
    });
    await db.$executeRawUnsafe(
      `CREATE FUNCTION template_test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.job.id}'::uuid THEN PERFORM pg_sleep(0.6); END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      "CREATE TRIGGER template_test_delay BEFORE UPDATE ON template_publication_jobs FOR EACH ROW EXECUTE FUNCTION template_test_delay()",
    );
    try {
      await expect(f.service.store.begin(claim!, "uploading")).rejects.toMatchObject({
        code: "lease_lost",
      });
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER template_test_delay ON template_publication_jobs");
      await db.$executeRawUnsafe("DROP FUNCTION template_test_delay()");
    }
    const stored = await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(stored.stage).toBe("queued");
    expect(await db.templatePublicationEvent.count({ where: { jobId: f.job.id } })).toBe(1);
  });
  it("a stable version name with changed artifact/import identity is held without activation", async () => {
    const f = await fixture();
    await f.run();
    await f.run();
    const version = f.getVersion()!;
    version.fileId = randomUUID();
    await f.run();
    expect(f.counts.activate).toBe(0);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("provider_identity_mismatch");
  });
  it("external active-version drift prevents activation rather than overwriting a newer publisher", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await f.run();
    f.target.activeVersionId = randomUUID();
    await f.run();
    expect(f.counts.activate).toBe(0);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("external_drift");
  });
  it("owner-bound SSE replays identical safe journal and verified Coder link; foreign owner gets 404", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.run();
    const session = {
      user: {
        id: f.actor.ownerId,
        coderUserId: f.actor.coderUserId,
        coderUrl: f.actor.origin,
        username: "fixture",
        email: "fixture@example.invalid",
      },
      session: {
        id: f.actor.sessionId,
        sessionId: f.actor.sessionId,
        expiresAt: f.actor.sessionExpiresAt,
      },
    };
    const routes = templatePublicationRoutes({
      enabled: () => true,
      session: async () => session,
      service: () => f.service,
    });
    const request = () =>
      new Request(`https://hive.invalid/api/templates/${artifact.name}/push/${f.job.id}/stream`);
    const a = await (await routes.stream(request(), artifact.name, f.job.id)).text(),
      b = await (await routes.stream(request(), artifact.name, f.job.id)).text();
    expect(a).toBe(b);
    expect(a).toContain('"success":true');
    expect(a).toContain(`/templates/default/${artifact.name}/versions/${f.job.versionName}`);
    expect(a).not.toContain("PRIVATE_NEVER_PERSIST");
    expect(a).not.toContain("secret provider response");
    const foreign = templatePublicationRoutes({
      enabled: () => true,
      session: async () => ({ ...session, user: { ...session.user, id: randomUUID() } }),
      service: () => f.service,
    });
    expect((await foreign.stream(request(), artifact.name, f.job.id)).status).toBe(404);
  });
  it("remote failed import remains failed without activation and target can schedule a new job", async () => {
    const f = await fixture();
    await f.run();
    await f.run();
    f.getVersion()!.status = "failed";
    await f.run();
    expect(f.counts.activate).toBe(0);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).stage,
    ).toBe("failed");
    expect((await f.service.enqueue(f.actor, artifact.name, randomUUID())).id).not.toBe(f.job.id);
  });
  it("two Hive owners with same remote template cannot race publications", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      other.service.store.enqueue(other.actor, f.target, artifact, randomUUID()),
    ).rejects.toMatchObject({ code: "publication_busy" });
  });
  it("missing lost-ACK version stays held and cannot issue a second create", async () => {
    const f = await fixture();
    await f.run();
    f.setLostCreate();
    await f.run();
    f.provider.versionByName = async () => null;
    await f.run();
    expect(f.counts.create).toBe(1);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("version_unknown");
  });
  it("logout during an in-flight file upload cannot accept its late result or create a version", async () => {
    const f = await fixture();
    const upload = f.provider.upload;
    f.provider.upload = async (bytes) => {
      const id = await upload(bytes);
      await db.session.delete({ where: { sessionId: f.actor.sessionId } });
      return id;
    };
    await f.run();
    const stored = await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(stored.heldReason).toBe("actor_revoked");
    expect(stored.fileId).toBeNull();
    expect(f.counts).toEqual({ upload: 1, create: 0, activate: 0 });
  });
  it("concurrent owner identity change cannot accept a stale local actor snapshot", async () => {
    const f = await fixture(),
      claim = await f.service.store.claim();
    expect(claim?.id).toBe(f.job.id);
    let result!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${f.actor.ownerId}::uuid FOR UPDATE`;
      result = f.service.store.begin(claim!, "uploading").then(
        () => ({ accepted: true }),
        (error) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tx.user.update({ where: { id: f.actor.ownerId }, data: { coderUserId: randomUUID() } });
    });
    expect(await result).toMatchObject({ code: "actor_revoked" });
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).stage,
    ).toBe("queued");
    expect(await db.templatePublicationEvent.count({ where: { jobId: f.job.id } })).toBe(1);
  });
  it("first creation imports an unattached version, creates once with automatic activation, and binds UUID only once", async () => {
    const f = await fixture({ create: true });
    for (let i = 0; i < 4; i++) await f.run();
    const stored = await f.service.store.read(f.actor.ownerId, artifact.name, f.job.id);
    expect(stored?.stage).toBe("succeeded");
    expect(stored?.operationMode).toBe("create");
    expect(stored?.expectedActiveVersionId).toBeNull();
    expect(stored?.target.templateId).toBe(f.target.templateId);
    expect(f.templateCreates()).toBe(1);
    expect(f.counts).toEqual({ upload: 1, create: 1, activate: 0 });
    expect(stored?.events.map((e) => e.code)).toContain("template_created");
    await expect(
      db.templatePublicationTarget.update({
        where: { id: f.job.targetId },
        data: { templateId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      db.templatePublicationTarget.update({
        where: { id: f.job.targetId },
        data: { templateId: null },
      }),
    ).rejects.toThrow();
  });
  it("unknown unattached version creation holds without a name lookup or a second POST", async () => {
    const f = await fixture({ create: true });
    await f.run();
    f.setLostCreate();
    f.provider.versionByName = async () => {
      throw new Error("no scoped name lookup exists before template creation");
    };
    await f.run();
    const stored = await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(stored.heldReason).toBe("version_unknown");
    expect(stored.versionId).toBeNull();
    expect(f.counts.create).toBe(1);
    expect(f.templateCreates()).toBe(0);
    expect((await f.service.processOne()).claimed).toBe(false);
  });
  it("unknown template creation stays held even when provider created it; exact retry is only a historical receipt", async () => {
    const f = await fixture({ create: true });
    for (let i = 0; i < 3; i++) await f.run();
    f.setLostTemplate();
    await f.run();
    expect(f.templateCreates()).toBe(1);
    expect(f.target.templateId).not.toBeNull();
    const stored = await f.service.store.read(f.actor.ownerId, artifact.name, f.job.id);
    expect(stored?.heldReason).toBe("template_creation_unknown");
    expect(stored?.target.templateId).toBeNull();
    const locate = f.provider.locate;
    f.provider.locate = async () => {
      throw new Error("historical receipt must precede mode preflight");
    };
    expect((await f.service.enqueue(f.actor, artifact.name, f.job.requestId)).id).toBe(f.job.id);
    f.provider.locate = locate;
    await expect(f.service.enqueue(f.actor, artifact.name, randomUUID())).rejects.toThrow();
    expect(f.templateCreates()).toBe(1);
    await expect(
      db.templatePublicationTarget.update({
        where: { id: f.job.targetId },
        data: { templateId: f.target.templateId },
      }),
    ).rejects.toThrow();
  });
  it("the fixed organization/name reservation rejects another actor and substituted remote creation identity", async () => {
    const f = await fixture({ create: true }),
      other = await fixture({ create: true });
    await expect(
      other.service.store.enqueue(other.actor, f.target, artifact, randomUUID()),
    ).rejects.toMatchObject({ code: "publication_busy" });
    const create = f.provider.createTemplate;
    f.provider.createTemplate = async (t, id) => ({
      ...(await create(t, id)),
      organizationId: randomUUID(),
    });
    for (let i = 0; i < 4; i++) await f.run();
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("template_creation_unknown");
    expect(f.templateCreates()).toBe(1);
    await expect(
      db.templatePublicationTarget.create({
        data: {
          configuredOrigin: f.actor.origin,
          organizationId: f.target.organizationId,
          organizationName: "default",
          templateId: randomUUID(),
          templateName: artifact.name,
        },
      }),
    ).rejects.toThrow();
  });
  it("retains inherited tags only as canonical digest and honors Coder's current-user owner override", async () => {
    const f = await fixture({
      tags: { pool: "private-provisioner-tag", scope: "user", owner: randomUUID() },
    });
    for (let i = 0; i < 4; i++) await f.run();
    expect(f.getSentTags()).toEqual(f.inheritedTags);
    expect(f.getVersion()?.provisionerTags?.owner).toBe(f.actor.coderUserId);
    const stored = await f.service.store.read(f.actor.ownerId, artifact.name, f.job.id);
    expect(stored?.stage).toBe("succeeded");
    expect(stored?.provisionerTagsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(stored, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toContain("private-provisioner-tag");
    await expect(
      db.templatePublicationJob.update({
        where: { id: f.job.id },
        data: { provisionerTagsDigest: "f".repeat(64) },
      }),
    ).rejects.toThrow();
  });
  it("changed active-version tag material cannot silently repin or create an import", async () => {
    const f = await fixture();
    f.inheritedTags.pool = "changed-pool";
    await f.run();
    await f.run();
    expect(f.counts.create).toBe(0);
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).heldReason,
    ).toBe("provisioner_tags_changed");
  });
  it("schema27 update requests retain original no-tag semantics after the additive upgrade", async () => {
    const f = await fixture({ legacy: true });
    f.provider.tags = async () => {
      throw new Error("legacy request must not gain new API inputs");
    };
    for (let i = 0; i < 4; i++) await f.run();
    expect(f.getSentTags()).toBeUndefined();
    expect(
      (await db.templatePublicationJob.findUniqueOrThrow({ where: { id: f.job.id } })).stage,
    ).toBe("succeeded");
  });
  it("concurrent duplicate first-create requests after a failed import converge to one new job", async () => {
    const f = await fixture({ create: true });
    await f.run();
    await f.run();
    f.getVersion()!.status = "failed";
    await f.run();
    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      f.service.enqueue(f.actor, artifact.name, requestId),
      f.service.enqueue(f.actor, artifact.name, requestId),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(f.job.id);
    expect(
      await db.templatePublicationEvent.count({ where: { jobId: a.id, code: "queued" } }),
    ).toBe(1);
    expect(
      (await db.templatePublicationTarget.findUniqueOrThrow({ where: { id: f.job.targetId } }))
        .generation,
    ).toBe(2);
  });
  it("first-create SSE keeps the already-emitted prefix stable when its template link becomes available", async () => {
    const f = await fixture({ create: true });
    for (let i = 0; i < 3; i++) await f.run();
    const session = {
      user: {
        id: f.actor.ownerId,
        coderUserId: f.actor.coderUserId,
        coderUrl: f.actor.origin,
        username: "fixture",
        email: "fixture@example.invalid",
      },
      session: {
        id: f.actor.sessionId,
        sessionId: f.actor.sessionId,
        expiresAt: f.actor.sessionExpiresAt,
      },
    };
    const routes = templatePublicationRoutes({
      enabled: () => true,
      session: async () => session,
      service: () => f.service,
      streamMs: 5,
      pollMs: 5,
    });
    const request = () => new Request("https://hive.invalid/path");
    const data = (s: string) =>
      s.split("\n").filter((line) => line.startsWith("data: ") && !line.startsWith("data: {"));
    const before = data(await (await routes.stream(request(), artifact.name, f.job.id)).text());
    expect(before.length).toBeGreaterThan(0);
    expect(before.join("\n")).not.toContain("Detailed output:");
    await f.run();
    const after = data(await (await routes.stream(request(), artifact.name, f.job.id)).text());
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.filter((line) => line.includes("Detailed output:"))).toHaveLength(1);
  });
  it("mode and target constraints prevent a fabricated update claim for an unbound reserved name", async () => {
    const f = await fixture({ create: true });
    await expect(
      db.templatePublicationJob.create({
        data: {
          id: randomUUID(),
          ownerId: f.actor.ownerId,
          actorSessionId: f.actor.sessionId,
          actorCoderUserId: f.actor.coderUserId,
          targetId: f.job.targetId,
          targetGeneration: 2,
          requestId: randomUUID(),
          requestDigest: "f".repeat(64),
          templateName: artifact.name,
          contentHash: artifact.contentHash,
          archiveDigest: artifact.archiveDigest,
          archiveBytes: artifact.archiveBytes,
          manifestDigest: artifact.manifestDigest,
          versionName: "invalid-mode",
          expectedActiveVersionId: randomUUID(),
          operationMode: "update",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.templatePublicationTarget.update({
        where: { id: f.job.targetId },
        data: { templateId: randomUUID() },
      }),
    ).rejects.toThrow();
  });
});
