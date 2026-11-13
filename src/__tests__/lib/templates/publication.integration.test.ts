import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { sendBoundedPush } from "@/lib/push/bounded-send";
import * as publicationActor from "@/lib/templates/publication-actor";
import { templatePublicationArtifact } from "@/lib/templates/publication-artifact";
import {
  TemplatePublicationError,
  type TemplateRemoteTarget,
  type TemplateRemoteVersion,
} from "@/lib/templates/publication-contracts";
import { dispatchTemplateNotices } from "@/lib/templates/publication-notices";
import { CoderTemplatePublicationProvider } from "@/lib/templates/publication-provider";
import { templatePublicationRoutes } from "@/lib/templates/publication-routes";
import {
  dispatchTemplateJobs,
  processTemplateJob,
  type TemplateJobDependencies,
} from "@/lib/templates/publication-service";
import { TemplateJobStore } from "@/lib/templates/publication-store";
import { provisionerTagsDigest } from "@/lib/templates/publication-tags";
import { pendingTemplatePush } from "@/lib/templates/push-request";

const url = process.env.HIVE_TEMPLATE_JOBS_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).port !== "55439" ||
    new URL(url).pathname !== "/hive_template_jobs_20261113")
)
  throw new Error("Dedicated local template database required");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_template_jobs_20261113",
});
beforeAll(() => vi.stubEnv("CODER_URL", "https://coder.template.invalid"));
beforeEach(async () => {
  if (url) await db.$executeRawUnsafe("TRUNCATE template_notices,template_jobs");
});
afterAll(async () => {
  await db.$disconnect();
  vi.unstubAllEnvs();
});
const suite = url ? describe : describe.skip;
async function fixture(
  absent = false,
  identity: { ownerId: string; requestId: string } = {
    ownerId: randomUUID(),
    requestId: randomUUID(),
  },
) {
  const { ownerId, requestId } = identity;
  const coderUserId = randomUUID(),
    sessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId,
      coderUrl: "https://coder.template.invalid",
      username: "fixture",
      email: `${ownerId}@example.invalid`,
    },
  });
  const actor = {
    ownerId,
    coderUserId,
    sessionId,
    origin: "https://coder.template.invalid",
    token: "fixture",
    sessionExpiresAt: new Date(Date.now() + 3600000),
    tokenExpiresAt: null,
  };
  const target: TemplateRemoteTarget = {
    organizationId: randomUUID(),
    organizationName: "default",
    templateId: absent ? null : randomUUID(),
    name: "ai-dev-k8s",
    activeVersionId: absent ? null : randomUUID(),
  };
  const artifact = templatePublicationArtifact(target.name),
    tags = { owner: "", scope: "organization", cluster: "existing" };
  let current = { ...target },
    version: TemplateRemoteVersion | null = null;
  const fileId = randomUUID(),
    store = new TemplateJobStore(db);
  const provider = {
    actor,
    locate: vi.fn(async () => ({ ...current })),
    current: vi.fn(async () => ({ ...current })),
    absent: vi.fn(async () => {
      if (current.templateId) throw new TemplatePublicationError("external_drift");
    }),
    tags: vi.fn(async () => tags),
    upload: vi.fn(async () => fileId),
    verifyFile: vi.fn(async () => {}),
    versionByName: vi.fn(async () => version),
    versionById: vi.fn(async () => {
      if (!version) throw new Error("missing");
      return version;
    }),
    createVersion: vi.fn(async (_target, input) => {
      version = {
        id: randomUUID(),
        name: input.name,
        organizationId: target.organizationId,
        templateId: target.templateId,
        fileId,
        importJobId: randomUUID(),
        creatorId: coderUserId,
        initiatorId: coderUserId,
        message: input.message,
        status: "succeeded",
        errorCode: null,
        logsOverflowed: false,
        ...(absent ? {} : { provisionerTags: tags }),
      };
      return version;
    }),
    createTemplate: vi.fn(async (_target, id) => {
      current = {
        ...target,
        templateId: randomUUID(),
        activeVersionId: id,
        createdById: coderUserId,
      };
      return current;
    }),
    activate: vi.fn(async (_target, id) => {
      current = { ...current, activeVersionId: id };
    }),
    logs: vi.fn(async () => ({ after: "0", records: 0, overflowed: false })),
  } satisfies Awaited<ReturnType<TemplateJobDependencies["provider"]>>;
  const deps: TemplateJobDependencies = {
    authorize: vi.fn(async () => ({ ...actor })),
    provider: vi.fn(async () => provider),
    load: vi.fn(async () => new Uint8Array([1])),
  };
  const job = await store.enqueue(
    actor,
    artifact,
    target,
    absent ? null : provisionerTagsDigest(tags),
    requestId,
  );
  const read = () => store.read(ownerId, target.name, job.id);
  const due = () =>
    db.$executeRaw`UPDATE template_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE phase NOT IN ('succeeded','failed','held')`;
  const step = async () => {
    await due();
    return processTemplateJob(store, deps);
  };
  return {
    actor,
    target,
    artifact,
    store,
    deps,
    provider,
    requestId,
    job,
    read,
    step,
    due,
    setCurrent: (value: TemplateRemoteTarget) => {
      current = value;
    },
    setVersion: (value: TemplateRemoteVersion) => {
      version = value;
    },
  };
}
suite("durable legacy template publication (owned PostgreSQL)", () => {
  it("commits before dispatch, survives browser absence, preserves tags and produces one notice", async () => {
    const f = await fixture();
    expect(f.provider.upload).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) await f.step();
    expect((await f.read())?.phase).toBe("succeeded");
    expect(f.provider.createVersion).toHaveBeenCalledOnce();
    expect(f.provider.createVersion.mock.calls[0][1].provisionerTags).toEqual({
      owner: "",
      scope: "organization",
      cluster: "existing",
    });
    expect(f.provider.activate).toHaveBeenCalledOnce();
    expect(await db.$queryRaw`SELECT status FROM template_notices`).toEqual([
      { status: "pending" },
    ]);
  });
  it("supports the existing UI's missing-template creation after successful import", async () => {
    const f = await fixture(true);
    for (let i = 0; i < 4; i++) await f.step();
    expect((await f.read())?.phase).toBe("succeeded");
    expect(f.provider.createTemplate).toHaveBeenCalledOnce();
    expect(f.provider.activate).not.toHaveBeenCalled();
  });
  it("deduplicates enqueue ACK retry and fences concurrent actors on the same target", async () => {
    const f = await fixture();
    const replay = await f.store.enqueue(
      f.actor,
      f.artifact,
      f.target,
      provisionerTagsDigest({}),
      f.requestId,
    );
    expect(replay.id).toBe(f.job.id);
    const results = await Promise.all([
      f.store.enqueue(f.actor, f.artifact, f.target, null, randomUUID()),
      f.store.enqueue(f.actor, f.artifact, f.target, null, randomUUID()),
    ]);
    expect(results.map((v) => v.id)).toEqual([f.job.id, f.job.id]);
    const other = { ...f.actor, ownerId: randomUUID() };
    await expect(
      f.store.enqueue(other, f.artifact, f.target, null, randomUUID()),
    ).rejects.toHaveProperty("code", "publication_busy");
  });
  it("normal no-header retry reattaches the exact accepted job and retries its lost wake", async () => {
    const f = await fixture();
    await db.templateJob.delete({ where: { id: f.job.id } });
    const auth = vi.spyOn(publicationActor, "authorizeTemplateActor").mockResolvedValue(f.actor);
    const provider = vi
      .spyOn(CoderTemplatePublicationProvider, "create")
      .mockResolvedValue(f.provider as never);
    const kick = vi.fn().mockRejectedValueOnce(Error("lost wake ACK")).mockResolvedValue(undefined);
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
      db: () => db,
      session: async () => session,
      assets: { fetch: vi.fn() },
      kick,
    });
    const request = () =>
      new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
        method: "POST",
        headers: { Origin: "https://hive.example", "Content-Length": "0" },
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
    try {
      expect((await routes.push(request(), f.target.name)).status).toBe(503);
      const [accepted] = await db.templateJob.findMany({ where: { ownerId: f.actor.ownerId } });
      expect(accepted.phase).toBe("queued");
      const retry = await routes.push(request(), f.target.name);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ jobId: accepted.id });
      expect(kick).toHaveBeenCalledTimes(2);
      expect(await db.templateJob.count({ where: { ownerId: f.actor.ownerId } })).toBe(1);
      for (let i = 0; i < 4; i++) await f.step();
      expect((await db.templateJob.findUniqueOrThrow({ where: { id: accepted.id } })).phase).toBe(
        "succeeded",
      );
      expect(f.provider.createVersion).toHaveBeenCalledOnce();
    } finally {
      auth.mockRestore();
      provider.mockRestore();
    }
  });
  it("normal UI retained request identity recovers an ACK lost before completed-job observation", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const ownerId = randomUUID();
    const requestId = pendingTemplatePush(ownerId, "ai-dev-k8s");
    const f = await fixture(false, { ownerId, requestId });
    const auth = vi.spyOn(publicationActor, "authorizeTemplateActor").mockResolvedValue(f.actor);
    const provider = vi
      .spyOn(CoderTemplatePublicationProvider, "create")
      .mockResolvedValue(f.provider as never);
    const kick = vi.fn().mockRejectedValueOnce(Error("lost wake ACK")).mockResolvedValue(undefined);
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
      db: () => db,
      session: async () => session,
      assets: { fetch: vi.fn() },
      kick,
    });
    const request = () =>
      new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
        method: "POST",
        headers: {
          Origin: "https://hive.example",
          "Idempotency-Key": pendingTemplatePush(ownerId, "ai-dev-k8s"),
        },
      });
    try {
      expect((await routes.push(request(), f.target.name)).status).toBe(503);
      for (let i = 0; i < 4; i++) await f.step();
      expect((await f.read())?.phase).toBe("succeeded");
      const retry = await routes.push(request(), f.target.name);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ jobId: f.job.id });
      expect(await db.templateJob.count({ where: { ownerId } })).toBe(1);
      expect(f.provider.createVersion).toHaveBeenCalledOnce();
      expect(pendingTemplatePush(ownerId, "ai-dev-k8s")).toBe(requestId);
    } finally {
      auth.mockRestore();
      provider.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("active recovery requires the complete artifact and same Coder principal, retaining the original actor", async () => {
    const f = await fixture();
    for (const artifact of [
      { ...f.artifact, manifestDigest: "b".repeat(64) },
      { ...f.artifact, contentHash: "c".repeat(64) },
      { ...f.artifact, archiveBytes: f.artifact.archiveBytes + 1 },
    ]) {
      await expect(
        f.store.enqueue(f.actor, artifact, f.target, null, randomUUID()),
      ).rejects.toHaveProperty("code", "publication_busy");
    }
    await expect(
      f.store.enqueue(
        { ...f.actor, coderUserId: randomUUID() },
        f.artifact,
        f.target,
        null,
        randomUUID(),
      ),
    ).rejects.toHaveProperty("code", "publication_busy");
    const replay = await f.store.enqueue(
      { ...f.actor, sessionId: randomUUID() },
      f.artifact,
      f.target,
      null,
      randomUUID(),
    );
    expect(replay.sessionId).toBe(f.actor.sessionId);
    expect(replay.id).toBe(f.job.id);
  });
  it("only one concurrent claim issues the upload", async () => {
    const f = await fixture();
    await Promise.all([processTemplateJob(f.store, f.deps), processTemplateJob(f.store, f.deps)]);
    expect(f.provider.upload).toHaveBeenCalledOnce();
  });
  it("rejects a stale holder after lease recovery before any effect admission", async () => {
    const f = await fixture();
    const stale = await f.store.claim();
    if (!stale) throw new Error("Missing fixture claim");
    await db.$executeRaw`UPDATE template_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${stale.id}::uuid`;
    const current = await f.store.claim();
    expect(current?.holder).not.toBe(stale.holder);
    await expect(f.store.markEffect(stale, "uploading")).rejects.toHaveProperty(
      "code",
      "lease_lost",
    );
    expect(f.provider.upload).not.toHaveBeenCalled();
  });
  it("treats Coder import cancellation as terminal without activation", async () => {
    const f = await fixture();
    await f.step();
    await f.step();
    const version = await f.provider.versionById();
    f.setVersion({ ...version, status: "canceled" });
    await f.step();
    expect((await f.read())?.phase).toBe("failed");
    expect(f.provider.activate).not.toHaveBeenCalled();
  });
  it("recovers a lost version ACK from exact deterministic version identity without another POST", async () => {
    const f = await fixture();
    await f.step();
    const original = f.provider.createVersion.getMockImplementation()!;
    f.provider.createVersion.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new TemplatePublicationError("provider_unavailable");
    });
    await f.step();
    expect((await f.read())?.state.effectIssued).toBe(true);
    await f.step();
    expect((await f.read())?.phase).toBe("importing");
    expect(f.provider.createVersion).toHaveBeenCalledOnce();
  });
  it("does not fabricate evidence or replay an unknown initial-template version mutation", async () => {
    const f = await fixture(true);
    await f.step();
    f.provider.createVersion.mockRejectedValueOnce(
      new TemplatePublicationError("provider_unavailable"),
    );
    await f.step();
    await f.step();
    expect((await f.read())?.phase).toBe("held");
    expect(f.provider.createVersion).toHaveBeenCalledOnce();
    await expect(
      f.store.enqueue(f.actor, f.artifact, f.target, null, randomUUID()),
    ).rejects.toHaveProperty("code", "publication_busy");
  });
  it("recovers activation after a lost ACK without activating twice", async () => {
    const f = await fixture();
    await f.step();
    await f.step();
    await f.step();
    const original = f.provider.activate.getMockImplementation()!;
    f.provider.activate.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new TemplatePublicationError("provider_unavailable");
    });
    await f.step();
    await f.step();
    expect((await f.read())?.phase).toBe("succeeded");
    expect(f.provider.activate).toHaveBeenCalledOnce();
  });
  it("holds changed active versions and revoked actors without remote mutation", async () => {
    const f = await fixture();
    f.setCurrent({ ...f.target, activeVersionId: randomUUID() });
    await f.step();
    expect((await f.read())?.phase).toBe("held");
    expect(f.provider.upload).not.toHaveBeenCalled();
  });
  it.each([
    ["authorize", "Error"],
    ["provider", "TypeError"],
    ["current", "ZodError"],
    ["tags", "Error"],
    ["load", "TypeError"],
  ] as const)("logs only fixed diagnostics for a %s failure and preserves pre-effect retry", async (stage, errorClass) => {
    const f = await fixture();
    const shape = z.object({ id: z.string() }).safeParse({});
    const error =
      errorClass === "ZodError"
        ? shape.error
        : errorClass === "TypeError"
          ? new TypeError("private credential payload")
          : new Error("private credential payload");
    if (stage === "authorize") vi.mocked(f.deps.authorize).mockRejectedValue(error);
    if (stage === "provider") vi.mocked(f.deps.provider).mockRejectedValue(error);
    if (stage === "current") f.provider.current.mockRejectedValue(error);
    if (stage === "tags") f.provider.tags.mockRejectedValue(error);
    if (stage === "load") vi.mocked(f.deps.load).mockRejectedValue(error);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.step();
      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.parse(warning.mock.calls[0][0])).toEqual({
        event: "template_publication_failure",
        phase: "queued",
        stage,
        errorClass,
      });
      const saved = await f.read();
      expect(saved).toMatchObject({ phase: "queued", reason: "provider_unavailable", attempts: 1 });
      expect(saved?.state).toMatchObject({ effectIssued: false, fileId: null, versionId: null });
      expect(f.provider.upload).not.toHaveBeenCalled();
      expect(f.provider.createVersion).not.toHaveBeenCalled();
      expect(f.provider.activate).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps terminal job identity immutable and wrong owners cannot read it", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.step();
    expect(await f.store.read(randomUUID(), f.target.name, f.job.id)).toBeNull();
    await expect(
      db.$executeRaw`UPDATE template_jobs SET phase='queued' WHERE id=${f.job.id}::uuid`,
    ).rejects.toThrow();
  });
  it("claims notices once concurrently and retains retry after an unknown send result", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.step();
    const send = vi.fn<typeof sendBoundedPush>(async () => "retry" as const);
    await Promise.all([
      dispatchTemplateNotices(db, "https://hive.example", { send }),
      dispatchTemplateNotices(db, "https://hive.example", { send }),
    ]);
    expect(send).toHaveBeenCalledOnce();
    expect(await db.$queryRaw`SELECT status,attempts FROM template_notices`).toEqual([
      { status: "pending", attempts: 1 },
    ]);
    expect(send.mock.calls[0][2]).toMatchObject({ kind: "template", tag: `template-${f.job.id}` });
  });
  it("owner-scoped exported dispatch leaves another owner's queued job untouched", async () => {
    const a = await fixture(),
      b = await fixture();
    // No session was created: actual authorization terminates only A's claimed
    // job before any provider call, proving the exported dispatch selection.
    const assets = { fetch: vi.fn() };
    expect(await dispatchTemplateJobs(db, assets, { ownerId: a.actor.ownerId })).toEqual({
      processed: 1,
    });
    expect((await a.read())?.phase).toBe("failed");
    expect((await b.read())?.phase).toBe("queued");
    expect((await b.read())?.attempts).toBe(0);
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(await dispatchTemplateJobs(db, assets)).toEqual({ processed: 1 });
    expect((await b.read())?.phase).toBe("failed");
  });
  it("owner notice filter applies to both due claims and exhausted settlement", async () => {
    const a = await fixture();
    for (let i = 0; i < 4; i++) await a.step();
    const b = await fixture();
    for (let i = 0; i < 4; i++) await b.step();
    const c = await fixture();
    for (let i = 0; i < 4; i++) await c.step();
    await db.$executeRaw`UPDATE template_notices SET status='processing',attempts=5,next_attempt_at=clock_timestamp()-interval '1 second' WHERE owner_id=${b.actor.ownerId}::uuid`;
    const send = vi.fn<typeof sendBoundedPush>(async () => "delivered");
    await dispatchTemplateNotices(db, "https://hive.example", { ownerId: a.actor.ownerId, send });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toBe(a.actor.ownerId);
    expect(
      await db.$queryRaw`SELECT status FROM template_notices WHERE owner_id=${b.actor.ownerId}::uuid`,
    ).toEqual([{ status: "processing" }]);
    expect(
      await db.$queryRaw`SELECT status,attempts FROM template_notices WHERE owner_id=${c.actor.ownerId}::uuid`,
    ).toEqual([{ status: "pending", attempts: 0 }]);
    await dispatchTemplateNotices(db, "https://hive.example", { send });
    expect(
      await db.$queryRaw`SELECT status FROM template_notices WHERE owner_id=${b.actor.ownerId}::uuid`,
    ).toEqual([{ status: "failed" }]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toBe(c.actor.ownerId);
  });
});
