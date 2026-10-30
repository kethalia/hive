import { randomUUID } from "node:crypto";
import type { getDb } from "@hive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ create: vi.fn(), process: vi.fn() }));
vi.mock("@/lib/templates/publication-service", () => ({
  TemplatePublicationService: class {
    constructor(...args: unknown[]) {
      calls.create(...args);
    }
    processOne() {
      return calls.process();
    }
  },
}));

import {
  dispatchTemplatePublication,
  publicationAuthClient,
} from "../../../../deploy/cloudflare/jobs/template-publications";

const db = {} as ReturnType<typeof getDb>;
const auth = (fetch = vi.fn(async () => Response.json({}))) => ({
  AUTH_SERVICE: { fetch: fetch as typeof globalThis.fetch },
  AUTH_SERVICE_SECRET: "a".repeat(64),
});
beforeEach(() => vi.clearAllMocks());

describe("template publication jobs binding", () => {
  it("stays disabled and refuses missing explicit service or assets bindings", async () => {
    expect(await dispatchTemplatePublication(db, {})).toEqual({ enabled: false });
    expect(calls.create).not.toHaveBeenCalled();
    await expect(
      dispatchTemplatePublication(db, { HIVE_TEMPLATE_PUBLICATION_ENABLED: "true" }),
    ).rejects.toThrow("artifacts unavailable");
    await expect(
      dispatchTemplatePublication(db, {
        HIVE_TEMPLATE_PUBLICATION_ENABLED: "true",
        ASSETS: { fetch },
      }),
    ).rejects.toThrow("authentication binding unavailable");
    expect(calls.create).not.toHaveBeenCalled();
  });
  it("runs exactly one stage and removes job identity and reason from logged aggregates", async () => {
    calls.process.mockResolvedValue({
      claimed: true,
      jobId: randomUUID(),
      outcome: "held_or_deferred",
      reason: "activation_unknown",
    });
    const result = await dispatchTemplatePublication(db, {
      ...auth(),
      HIVE_TEMPLATE_PUBLICATION_ENABLED: "true",
      ASSETS: { fetch },
    });
    expect(result).toEqual({ enabled: true, claimed: 1, progressed: 0, heldOrDeferred: 1 });
    expect(calls.process).toHaveBeenCalledOnce();
    expect(calls.create.mock.calls[0][0]).toBe(db);
    expect(calls.create.mock.calls[0][1]).toMatchObject({
      enabled: true,
      authorizeActor: expect.any(Function),
      loadArtifact: expect.any(Function),
    });
  });
  it("requires an explicit auth secret even when an ambient secret exists", () => {
    vi.stubEnv("AUTH_SERVICE_SECRET", "b".repeat(64));
    try {
      expect(() => publicationAuthClient({ AUTH_SERVICE: { fetch } })).toThrow(
        "authentication secret unavailable",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("uses the fixed service binding for session and token reads without a global fetch", async () => {
    const session = randomUUID(),
      binding = vi.fn(async () => Response.json({ fixture: true }));
    const client = publicationAuthClient(auth(binding));
    await client.getSession(session);
    await client.getCoderToken(session);
    expect(binding.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      `https://hive-auth.internal/sessions/${session}`,
      `https://hive-auth.internal/sessions/${session}/token`,
    ]);
    const init = (binding.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual({ Authorization: `Bearer ${"a".repeat(64)}` });
  });
  it("cancels redirects and oversized auth replies without exposing their content", async () => {
    for (const response of [
      new Response("private credential", {
        status: 302,
        headers: { Location: "https://outside.invalid" },
      }),
      new Response("x".repeat(65537)),
    ]) {
      const client = publicationAuthClient(auth(vi.fn(async () => response)));
      await expect(client.getSession(randomUUID())).rejects.not.toThrow("private credential");
      expect(response.bodyUsed).toBe(true);
    }
  });
  it("bounds stalled response streams and cancels the stream at deadline", async () => {
    const cancel = vi.fn(),
      response = new Response(new ReadableStream({ cancel }));
    const client = publicationAuthClient(auth(vi.fn(async () => response)));
    const started = Date.now();
    const work = client.getSession(randomUUID());
    await expect(work).rejects.toThrow("provider_deadline");
    expect(Date.now() - started).toBeLessThan(12000);
    expect(cancel).toHaveBeenCalled();
  }, 15000);
});
