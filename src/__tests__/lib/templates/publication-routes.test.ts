import type { SessionData } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
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
