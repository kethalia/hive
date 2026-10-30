import { randomUUID } from "node:crypto";
import type { AuthServiceClient } from "@hive/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationActorAuthorizer } from "@/lib/templates/publication-actor";
import {
  templateAssetsLoader,
  templatePublicationArtifact,
} from "@/lib/templates/publication-artifact";
import { publicationBody, publicationFetch } from "@/lib/templates/publication-io";
import { CoderTemplatePublicationProvider } from "@/lib/templates/publication-provider";
import { templatePublicationRoutes } from "@/lib/templates/publication-routes";
import type { TemplatePublicationService } from "@/lib/templates/publication-service";
import { canonicalProvisionerTags, provisionerTagsDigest } from "@/lib/templates/publication-tags";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const origin = "https://coder.kethalia.com";
function actor() {
  return {
    ownerId: randomUUID(),
    coderUserId: randomUUID(),
    sessionId: randomUUID(),
    origin,
    token: "private-secret",
    sessionExpiresAt: new Date(Date.now() + 60000),
    tokenExpiresAt: null,
  };
}
describe("template publisher bounded provider", () => {
  it("first-create scope omits template UUID and metadata/variables choices; server-created identity is verified", async () => {
    vi.stubEnv("CODER_URL", origin);
    const a = actor(),
      org = randomUUID(),
      versionId = randomUUID(),
      templateId = randomUUID(),
      fileId = randomUUID(),
      requests: { url: string; body: Record<string, unknown> | null }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/users/me")) return Response.json({ id: a.coderUserId });
      if (url.endsWith("/organizations/default"))
        return Response.json({ id: org, name: "default" });
      if (url.endsWith("/templates/ai-dev-k8s")) return new Response(null, { status: 404 });
      if (url.endsWith("/authcheck")) return Response.json({ publish: true });
      if (url.endsWith("/templateversions"))
        return Response.json({
          id: versionId,
          name: "fixed-initial",
          message: "fixed-marker",
          organization_id: org,
          created_by: { id: a.coderUserId },
          archived: false,
          job: {
            id: randomUUID(),
            organization_id: org,
            initiator_id: a.coderUserId,
            file_id: fileId,
            type: "template_version_import",
            status: "succeeded",
            tags: { scope: "organization", owner: "" },
          },
        });
      return Response.json({
        id: templateId,
        name: "ai-dev-k8s",
        organization_id: org,
        organization_name: "default",
        active_version_id: versionId,
        created_by_id: a.coderUserId,
        deleted: false,
      });
    });
    const provider = await CoderTemplatePublicationProvider.create(a, fetcher),
      missing = await provider.locate("ai-dev-k8s");
    expect(missing.templateId).toBeNull();
    expect(requests.find((v) => v.url.endsWith("/authcheck"))?.body).toEqual({
      checks: {
        publish: { action: "create", object: { resource_type: "template", organization_id: org } },
      },
    });
    expect(
      (
        await provider.createVersion(missing, {
          name: "fixed-initial",
          message: "fixed-marker",
          fileId,
        })
      ).templateId,
    ).toBeNull();
    expect(requests.at(-1)?.body).toEqual({
      name: "fixed-initial",
      message: "fixed-marker",
      storage_method: "file",
      file_id: fileId,
      provisioner: "terraform",
      user_variable_values: [],
    });
    expect((await provider.createTemplate(missing, versionId)).templateId).toBe(templateId);
    expect(requests.at(-1)?.body).toEqual({ name: "ai-dev-k8s", template_version_id: versionId });
  });
  it("active-version tags are scoped to exact prior template/version, and variables stay an empty server-reuse input", async () => {
    vi.stubEnv("CODER_URL", origin);
    const a = actor(),
      org = randomUUID(),
      templateId = randomUUID(),
      prior = randomUUID(),
      fileId = randomUUID(),
      tags = { pool: "trusted-label", scope: "user", owner: randomUUID() },
      target = {
        organizationId: org,
        organizationName: "default",
        name: "ai-dev-k8s",
        templateId,
        activeVersionId: prior,
      };
    let input: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/users/me")) return Response.json({ id: a.coderUserId });
      if (!init?.body)
        return Response.json({
          id: prior,
          template_id: templateId,
          organization_id: org,
          job: { organization_id: org, tags },
        });
      input = JSON.parse(String(init.body));
      return Response.json({
        id: randomUUID(),
        name: "fixed",
        message: "marker",
        template_id: templateId,
        organization_id: org,
        created_by: { id: a.coderUserId },
        archived: false,
        job: {
          id: randomUUID(),
          organization_id: org,
          initiator_id: a.coderUserId,
          file_id: fileId,
          type: "template_version_import",
          status: "running",
          tags: { ...tags, owner: a.coderUserId },
        },
      });
    });
    const provider = await CoderTemplatePublicationProvider.create(a, fetcher);
    expect(await provider.tags(target, prior)).toEqual(tags);
    await provider.createVersion(target, {
      name: "fixed",
      message: "marker",
      fileId,
      provisionerTags: tags,
    });
    expect(input).toMatchObject({
      template_id: templateId,
      provisioner_tags: tags,
      user_variable_values: [],
    });
    await expect(
      provider.tags({ ...target, templateId: randomUUID() }, prior),
    ).rejects.toMatchObject({ code: "provider_identity_mismatch" });
  });
  it("tag canonicalization is bounded and stable without persisting raw tag values", () => {
    expect(provisionerTagsDigest({ z: "value", a: "other" })).toBe(
      provisionerTagsDigest({ a: "other", z: "value" }),
    );
    expect(() => canonicalProvisionerTags({ x: "control\nvalue" })).toThrow();
    expect(() =>
      canonicalProvisionerTags(
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), "v"])),
      ),
    ).toThrow();
    expect(() => canonicalProvisionerTags({ x: 4 })).toThrow();
  });
  it("rejects credential-bearing redirects without following and uses exact configured origin", async () => {
    vi.stubEnv("CODER_URL", origin);
    const a = actor(),
      fetcher = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 302, headers: { Location: "https://attacker.invalid" } }),
      );
    await expect(CoderTemplatePublicationProvider.create(a, fetcher)).rejects.toMatchObject({
      code: "provider_redirect",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${origin}/api/v2/users/me`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", credentials: "omit" });
    await expect(
      CoderTemplatePublicationProvider.create(
        { ...a, origin: "https://attacker.invalid" },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "actor_revoked" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("binds current user, organization, template and update permission before effects", async () => {
    vi.stubEnv("CODER_URL", origin);
    const a = actor(),
      org = randomUUID(),
      template = randomUUID(),
      calls: { url: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/users/me")) return Response.json({ id: a.coderUserId });
      if (url.endsWith("/organizations/default"))
        return Response.json({ id: org, name: "default" });
      if (url.includes("/templates/ai-dev-k8s"))
        return Response.json({
          id: template,
          name: "ai-dev-k8s",
          organization_id: org,
          organization_name: "default",
          active_version_id: randomUUID(),
          deleted: false,
        });
      return Response.json({ publish: false });
    });
    const p = await CoderTemplatePublicationProvider.create(a, fetcher);
    await expect(p.locate("ai-dev-k8s")).rejects.toMatchObject({ code: "actor_revoked" });
    expect(calls.at(-1)?.body).toEqual({
      checks: {
        publish: {
          action: "update",
          object: { resource_type: "template", resource_id: template, organization_id: org },
        },
      },
    });
  });
  it("bounded body cancels stalled reads even if cancel itself never resolves", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(),
      cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel,
      }),
    );
    const pending = publicationBody(response, 10, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "provider_deadline" });
    controller.abort();
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("injected fetch cannot ignore deadline; late response is canceled", async () => {
    const controller = new AbortController();
    let resolve!: (r: Response) => void;
    const pending = publicationFetch(
      new Promise((r) => {
        resolve = r;
      }),
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "provider_deadline" });
    controller.abort();
    await assertion;
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("empty-chunk floods and size overruns are bounded", async () => {
    const response = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array());
        },
      }),
    );
    await expect(publicationBody(response, 10, new AbortController().signal)).rejects.toMatchObject(
      { code: "provider_response_limit" },
    );
    await expect(
      publicationBody(new Response("1234"), 3, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_response_limit" });
  });
  it("fixed ASSETS artifact loader rejects caller-selected identity before fetching", async () => {
    const fetcher = vi.fn();
    const load = templateAssetsLoader({ fetch: fetcher });
    const artifact = templatePublicationArtifact("ai-dev-k8s");
    await expect(load({ ...artifact, archiveDigest: "f".repeat(64) })).rejects.toMatchObject({
      code: "artifact_changed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("ASSETS uses Workers-compatible manual redirects and rejects redirected responses with bounded cancellation", async () => {
    const artifact = templatePublicationArtifact("ai-dev-k8s"),
      cancel = vi.fn();
    let redirected = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect((input as Request).redirect).toBe("manual");
      const response = new Response(new ReadableStream({ cancel }), {
        status: redirected ? 200 : 302,
      });
      if (redirected) Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    const loader = templateAssetsLoader({ fetch: fetcher });
    await expect(loader(artifact)).rejects.toMatchObject({ code: "artifact_unavailable" });
    redirected = true;
    await expect(loader(artifact)).rejects.toMatchObject({ code: "artifact_unavailable" });
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("parses official scoped version identity and strips raw log output before returning progress", async () => {
    vi.stubEnv("CODER_URL", origin);
    const a = actor(),
      org = randomUUID(),
      template = randomUUID(),
      id = randomUUID(),
      file = randomUUID(),
      importId = randomUUID();
    const remote = {
      organizationId: org,
      organizationName: "default",
      templateId: template,
      name: "ai-dev-k8s",
      activeVersionId: randomUUID(),
    };
    const raw = {
      id,
      name: `hive-${randomUUID()}`,
      organization_id: org,
      template_id: template,
      message: "fixed-marker",
      created_by: { id: a.coderUserId },
      archived: false,
      job: {
        id: importId,
        organization_id: org,
        initiator_id: a.coderUserId,
        file_id: file,
        type: "template_version_import",
        status: "running",
        logs_overflowed: false,
      },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/users/me")
        ? Response.json({ id: a.coderUserId })
        : String(input).includes("/logs?")
          ? Response.json([{ id: 1, output: "sensitive terraform secret" }])
          : Response.json(raw),
    );
    const provider = await CoderTemplatePublicationProvider.create(a, fetcher);
    expect(await provider.versionById(remote, id)).toMatchObject({
      id,
      importJobId: importId,
      fileId: file,
      status: "running",
    });
    expect(await provider.logs(id, "0")).toEqual({ after: "1", records: 1, overflowed: false });
    raw.job.initiator_id = randomUUID();
    await expect(provider.versionById(remote, id)).rejects.toMatchObject({
      code: "provider_identity_mismatch",
    });
  });
  it("auth service rejects invalid dates, nonstring credentials and switched subject", async () => {
    vi.stubEnv("CODER_URL", origin);
    const a = actor();
    let expiresAt = "invalid";
    let token: unknown = "good";
    const client = {
      getSession: async () => ({
        sessionId: a.sessionId,
        userId: a.ownerId,
        coderUserId: a.coderUserId,
        coderUrl: origin,
        expiresAt,
      }),
      getCoderToken: async () => ({ token, coderUrl: origin, expiresAt: null }),
    } as unknown as Pick<AuthServiceClient, "getSession" | "getCoderToken">;
    const authorize = publicationActorAuthorizer(client),
      signal = new AbortController().signal;
    await expect(authorize(a, signal)).rejects.toMatchObject({ code: "actor_revoked" });
    expiresAt = new Date(Date.now() + 60000).toISOString();
    token = { length: 5 };
    await expect(authorize(a, signal)).rejects.toMatchObject({ code: "actor_revoked" });
    token = "good";
    await expect(authorize({ ...a, coderUserId: randomUUID() }, signal)).rejects.toMatchObject({
      code: "actor_revoked",
    });
  });
});
describe("portable publication browser route", () => {
  function fixture(enabled = true) {
    const a = actor(),
      enqueue = vi.fn(async (..._args: Parameters<TemplatePublicationService["enqueue"]>) => ({
        id: randomUUID(),
      }));
    const service = { enqueue } as unknown as TemplatePublicationService;
    const session = vi.fn(async () => ({
      user: {
        id: a.ownerId,
        coderUserId: a.coderUserId,
        coderUrl: origin,
        username: "fixture",
        email: "fixture@example.invalid",
      },
      session: { id: a.sessionId, sessionId: a.sessionId, expiresAt: a.sessionExpiresAt },
    }));
    return {
      enqueue,
      session,
      routes: templatePublicationRoutes({
        enabled: () => enabled,
        service: () => service,
        session,
      }),
    };
  }
  it("default off blocks before auth/provider; cross-origin/body/arbitrary catalog are rejected", async () => {
    const f = fixture(false);
    expect(
      (
        await f.routes.push(
          new Request("https://hive.invalid/api/templates/ai-dev-k8s/push", { method: "POST" }),
          "ai-dev-k8s",
        )
      ).status,
    ).toBe(404);
    expect(f.session).not.toHaveBeenCalled();
    const g = fixture();
    expect(
      (
        await g.routes.push(
          new Request("https://hive.invalid/path", {
            method: "POST",
            headers: { Origin: "https://attacker.invalid" },
          }),
          "ai-dev-k8s",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await g.routes.push(
          new Request("https://hive.invalid/path", {
            method: "POST",
            headers: { Origin: "https://hive.invalid" },
            body: '{"archive":"https://attacker.invalid"}',
          }),
          "ai-dev-k8s",
        )
      ).status,
    ).toBe(400);
    expect(g.enqueue).not.toHaveBeenCalled();
  });
  it("owner/session derive from authenticated cookie; only optional canonical request UUID is caller-controlled", async () => {
    const f = fixture(),
      key = randomUUID(),
      response = await f.routes.push(
        new Request("https://hive.invalid/path", {
          method: "POST",
          headers: { Origin: "https://hive.invalid", "Idempotency-Key": key },
        }),
        "ai-dev-k8s",
      );
    expect(response.status).toBe(200);
    expect(f.enqueue.mock.calls[0]?.[2]).toBe(key);
  });
  it("deadline-races initial auth and read, retaining the underlying task until it settles", async () => {
    for (const stalled of ["auth", "read"]) {
      const f = fixture(),
        abort = new AbortController(),
        timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal),
        retained: Promise<unknown>[] = [];
      let release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      const session = await f.session();
      const routes = templatePublicationRoutes({
        enabled: () => true,
        session: () =>
          stalled === "auth" ? pending.then(() => session) : Promise.resolve(session),
        service: () =>
          ({
            store: { read: () => pending.then(() => null) },
          }) as unknown as TemplatePublicationService,
        retain: (task) => {
          retained.push(task);
        },
      });
      const result = routes.stream(
        new Request("https://hive.invalid/path"),
        "ai-dev-k8s",
        randomUUID(),
      );
      await Promise.resolve();
      await Promise.resolve();
      abort.abort();
      expect((await result).status).toBe(503);
      expect(timeout).toHaveBeenCalledWith(10000);
      expect(retained.length).toBeGreaterThan(0);
      release();
      await Promise.all(retained);
      timeout.mockRestore();
    }
  });
  it("closes streamed body on auth deadline and request abort without losing in-flight lifetime tasks", async () => {
    for (const useAbort of [false, true]) {
      const f = fixture(),
        session = await f.session(),
        requestAbort = new AbortController(),
        streamAbort = new AbortController(),
        retained: Promise<unknown>[] = [];
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) =>
          ms === 10000 ? new AbortController().signal : streamAbort.signal,
        );
      let calls = 0,
        release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      const routes = templatePublicationRoutes({
        enabled: () => true,
        session: () => (++calls === 1 ? Promise.resolve(session) : pending.then(() => session)),
        service: () =>
          ({
            store: { read: async () => ({ events: [], stage: "queued" }) },
          }) as unknown as TemplatePublicationService,
        retain: (task) => {
          retained.push(task);
        },
      });
      const response = await routes.stream(
        new Request("https://hive.invalid/path", { signal: requestAbort.signal }),
        "ai-dev-k8s",
        randomUUID(),
      );
      const text = response.text();
      if (useAbort) requestAbort.abort();
      else streamAbort.abort();
      expect(await text).toBe("");
      expect(retained).toHaveLength(3);
      release();
      await Promise.all(retained);
      timeout.mockRestore();
    }
  });
});
