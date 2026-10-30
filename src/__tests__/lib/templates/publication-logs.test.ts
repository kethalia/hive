import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PublicationLogBinding,
  readPublicationLogPage,
} from "@/lib/templates/publication-log-provider";
import { templateLogRoute } from "@/lib/templates/publication-log-routes";
import type { TemplatePublicationLogService } from "@/lib/templates/publication-log-service";

const origin = "https://coder.logs-proof.invalid";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  vi.stubEnv("CODER_URL", origin);
  const coderUserId = randomUUID(),
    actor = {
      ownerId: randomUUID(),
      coderUserId,
      sessionId: randomUUID(),
      origin,
      token: "synthetic-not-real",
      sessionExpiresAt: new Date(Date.now() + 60000),
      tokenExpiresAt: null,
    };
  const binding: PublicationLogBinding = {
    organizationId: randomUUID(),
    templateId: randomUUID(),
    operationMode: "update",
    stage: "succeeded",
    versionId: randomUUID(),
    fileId: randomUUID(),
    importJobId: randomUUID(),
    versionName: "fixed-name",
    message: "fixed-marker",
    actorCoderUserId: coderUserId,
  };
  const metadata = {
    id: binding.versionId,
    template_id: binding.templateId,
    organization_id: binding.organizationId,
    name: binding.versionName,
    message: binding.message,
    created_by: { id: coderUserId },
    job: {
      id: binding.importJobId,
      file_id: binding.fileId,
      organization_id: binding.organizationId,
      initiator_id: coderUserId,
      type: "template_version_import",
    },
  };
  let checks = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(String(input).startsWith(`${origin}/api/v2/`)).toBe(true);
    if (String(input).endsWith("/users/me")) return Response.json({ id: coderUserId });
    if (String(input).includes("/logs?"))
      return Response.json([{ id: 1, output: "private human output" }]);
    checks++;
    return Response.json(metadata);
  });
  return { actor, binding, metadata, fetcher, checks: () => checks };
}
describe("fixed authenticated publication log provider", () => {
  it("verifies immutable remote identity before/after a GET-only read with one captured credential", async () => {
    const f = fixture(),
      page = await readPublicationLogPage(
        f.actor,
        f.binding,
        "0",
        new AbortController().signal,
        f.fetcher,
      );
    expect(page.records).toEqual([{ id: "1", output: "private human output" }]);
    expect(f.checks()).toBe(2);
    expect(f.fetcher.mock.calls).toHaveLength(4);
    for (const [, init] of f.fetcher.mock.calls)
      expect(init?.headers).toMatchObject({ "Coder-Session-Token": "synthetic-not-real" });
  });
  it("substituted file/org/job/creator/template identities never return raw output", async () => {
    for (const field of ["file", "org", "job", "creator", "template"]) {
      const f = fixture();
      if (field === "file") f.metadata.job.file_id = randomUUID();
      if (field === "org") f.metadata.organization_id = randomUUID();
      if (field === "job") f.metadata.job.id = randomUUID();
      if (field === "creator") f.metadata.created_by.id = randomUUID();
      if (field === "template") f.metadata.template_id = randomUUID();
      await expect(
        readPublicationLogPage(f.actor, f.binding, "0", new AbortController().signal, f.fetcher),
      ).rejects.toMatchObject({ code: "identity_changed" });
      expect(f.fetcher.mock.calls).toHaveLength(2);
    }
  });
  it("revocation during the buffered read discards its rows", async () => {
    const f = fixture();
    let metadata = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (
        !String(input).includes("/logs?") &&
        !String(input).endsWith("/users/me") &&
        ++metadata === 2
      )
        return new Response(null, { status: 403 });
      return f.fetcher(input, init);
    };
    await expect(
      readPublicationLogPage(f.actor, f.binding, "0", new AbortController().signal, fetcher),
    ).rejects.toMatchObject({ code: "actor_revoked" });
  });
  it("historical initial import attachment remains a factual exact-ID read only", async () => {
    const f = fixture();
    f.binding.operationMode = "create";
    f.binding.stage = "held";
    f.binding.templateId = null;
    f.metadata.template_id = randomUUID();
    expect(
      (
        await readPublicationLogPage(
          f.actor,
          f.binding,
          "0",
          new AbortController().signal,
          f.fetcher,
        )
      ).records,
    ).toHaveLength(1);
    expect(f.binding.templateId).toBeNull();
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("redirected log body is canceled, not followed or returned", async () => {
    const f = fixture(),
      cancel = vi.fn();
    const fetcher: typeof fetch = (input, init) =>
      String(input).includes("/logs?")
        ? Promise.resolve(
            new Response(new ReadableStream({ cancel }), {
              status: 302,
              headers: { Location: "https://attacker.invalid" },
            }),
          )
        : f.fetcher(input, init);
    const result = await readPublicationLogPage(
      f.actor,
      f.binding,
      "0",
      new AbortController().signal,
      fetcher,
    );
    expect(result.records).toEqual([]);
    expect(result.fallback).toBe("provider_unavailable");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
describe("detailed log browser route", () => {
  it("disabled and invalid origin/query requests never authenticate", async () => {
    const session = vi.fn(),
      service = vi.fn(),
      disabled = templateLogRoute({ enabled: () => false, session, service });
    expect(
      (await disabled(new Request("https://hive.invalid/path"), "ai-dev-k8s", randomUUID())).status,
    ).toBe(404);
    const route = templateLogRoute({ enabled: () => true, session, service });
    for (const url of [
      "https://hive.invalid/path?after=1&after=2",
      "https://hive.invalid/path?versionId=arbitrary",
      "https://hive.invalid/path?after=-1",
    ])
      expect((await route(new Request(url), "ai-dev-k8s", randomUUID())).status).toBe(400);
    expect(
      (
        await route(
          new Request("https://hive.invalid/path", {
            headers: { Origin: "https://attacker.invalid" },
          }),
          "ai-dev-k8s",
          randomUUID(),
        )
      ).status,
    ).toBe(403);
    expect(session).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });
  it("deadline/abort races setup and retains the unfinished underlying auth task", async () => {
    const abort = new AbortController(),
      retain = vi.fn();
    let finish!: (v: null) => void;
    const pending = new Promise<null>((r) => {
      finish = r;
    });
    const route = templateLogRoute({
      enabled: () => true,
      session: () => pending,
      service: () => ({}) as TemplatePublicationLogService,
      retain,
    });
    const response = route(
      new Request("https://hive.invalid/path", { signal: abort.signal }),
      "ai-dev-k8s",
      randomUUID(),
    );
    abort.abort();
    expect((await response).status).toBe(503);
    expect(retain).toHaveBeenCalledOnce();
    finish(null);
    await Promise.all(retain.mock.calls.map((v) => v[0]));
  });
});
