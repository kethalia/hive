import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { SessionData } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import { templatePublicationRoutes } from "@/lib/templates/publication-routes";
import { type TemplateJob, TemplateJobStore } from "@/lib/templates/publication-store";

const id = "10000000-0000-4000-8000-000000000001";
const session = {
  user: {
    id,
    coderUserId: id,
    coderUrl: "https://coder.example",
    username: "owner",
    email: "owner@example.invalid",
  },
  session: { id, sessionId: id, expiresAt: new Date(Date.now() + 3600000) },
} satisfies SessionData;
const route = () =>
  templatePublicationRoutes({
    db: () => ({}) as PrismaClient,
    session: async () => session,
    assets: { fetch: vi.fn() },
    kick: vi.fn(),
  });
afterEach(() => vi.restoreAllMocks());
describe("legacy template route boundaries", () => {
  it("rejects cross-origin/raw body and invalid idempotency input before DB/provider work", async () => {
    const r = route();
    expect(
      (
        await r.push(
          new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
            method: "POST",
            headers: { Origin: "https://other.example" },
          }),
          "ai-dev-k8s",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await r.push(
          new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
            method: "POST",
            headers: { Origin: "https://hive.example" },
            body: "arbitrary",
          }),
          "ai-dev-k8s",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await r.push(
          new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
            method: "POST",
            headers: { Origin: "https://hive.example", "Idempotency-Key": "bad" },
          }),
          "ai-dev-k8s",
        )
      ).status,
    ).toBe(400);
  });
  it("admits the actual Next Node adapter's empty POST stream", async () => {
    const incoming = new IncomingMessage(new Socket());
    incoming.method = "POST";
    incoming.url = "https://hive.example/api/templates/ai-dev-k8s/push";
    incoming.headers = { origin: "https://hive.example", "content-length": "0" };
    incoming.push(null);
    const request = NextRequestAdapter.fromNodeNextRequest(
      new NodeNextRequest(incoming),
      new AbortController().signal,
    );
    expect(request.body).not.toBeNull();
    const authenticate = vi.fn(async () => null);
    const database = vi.fn();
    const response = await templatePublicationRoutes({
      db: database,
      session: authenticate,
      assets: { fetch: vi.fn() },
      kick: vi.fn(),
    }).push(request, "ai-dev-k8s");
    expect(response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(database).not.toHaveBeenCalled();
    incoming.destroy();
  });

  it.each([
    undefined,
    "0",
    "1",
    "invalid",
  ])("rejects nonempty input before session or provider work with declared length %s", async (length) => {
    const authenticate = vi.fn(async () => null);
    const database = vi.fn();
    const headers = new Headers({ Origin: "https://hive.example" });
    if (length !== undefined) headers.set("Content-Length", length);
    const response = await templatePublicationRoutes({
      db: database,
      session: authenticate,
      assets: { fetch: vi.fn() },
      kick: vi.fn(),
    }).push(
      new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
        method: "POST",
        headers,
        body: "x",
      }),
      "ai-dev-k8s",
    );
    expect(response.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  it("bounds and cancels an unfinished empty body before any session or provider call", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn();
    const authenticate = vi.fn(async () => null);
    const database = vi.fn();
    const request = new Request("https://hive.example/api/templates/ai-dev-k8s/push", {
      method: "POST",
      headers: { Origin: "https://hive.example" },
      body: new ReadableStream({ cancel }),
      duplex: "half",
    } as RequestInit);
    const pending = templatePublicationRoutes({
      db: database,
      session: authenticate,
      assets: { fetch: vi.fn() },
      kick: vi.fn(),
    }).push(request, "ai-dev-k8s");
    deadline.abort();
    expect((await pending).status).toBe(400);
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(authenticate).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  it("stream cancellation drains an already-started DB read without canceling publication", async () => {
    const job = { id, phase: "queued", state: { versionId: null } } as TemplateJob;
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const read = vi
      .spyOn(TemplateJobStore.prototype, "read")
      .mockResolvedValueOnce(job)
      .mockImplementationOnce(async () => {
        entered();
        await gate;
        return job;
      });
    const save = vi.spyOn(TemplateJobStore.prototype, "save");
    const response = await route().stream(
      new Request(`https://hive.example/api/templates/ai-dev-k8s/push/${id}/stream`),
      "ai-dev-k8s",
      id,
    );
    await reading;
    let closed = false;
    const cancel = response.body!.cancel().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await cancel;
    expect(read).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });
  it("emits the existing terminal SSE status shape without a provider call for unstarted failure", async () => {
    vi.spyOn(TemplateJobStore.prototype, "read").mockResolvedValue({
      id,
      phase: "failed",
      reason: "actor_revoked",
      state: { versionId: null },
    } as TemplateJob);
    const response = await route().stream(
      new Request(`https://hive.example/api/templates/ai-dev-k8s/push/${id}/stream`),
      "ai-dev-k8s",
      id,
    );
    const text = await response.text();
    expect(text).toContain('event: status\ndata: {"success":false,"error":"actor_revoked"}');
  });
});
