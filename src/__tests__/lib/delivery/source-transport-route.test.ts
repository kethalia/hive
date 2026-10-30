import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  policy: vi.fn(),
  issue: vi.fn(),
  publish: vi.fn(),
  service: vi.fn(),
  sessions: vi.fn(),
  admission: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => ({}) }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mocks.context }));
vi.mock("@/lib/codex-session/guardian-store.server", () => ({
  lockProducerAdmission: mocks.admission,
}));
vi.mock("@/lib/codex-session/route.server", async (original) => ({
  ...(await original<typeof import("@/lib/codex-session/route.server")>()),
  sessionService: mocks.sessions,
}));
vi.mock("@/lib/delivery/source-transport.server", () => ({
  SourcePublicationTransport: class {
    constructor(...args: unknown[]) {
      mocks.service(...args);
    }
    policy = mocks.policy;
    issue = mocks.issue;
    publish = mocks.publish;
  },
}));

import { POST as challenge } from "@/app/api/delivery/source-publication/challenge/route";
import { POST as policy } from "@/app/api/delivery/source-publication/policy/route";
import { POST as publish } from "@/app/api/delivery/source-publication/route";

const taskId = randomUUID(),
  ownerId = randomUUID(),
  configured = {
    ownerId,
    repositoryId: "123",
    policy: {
      version: "fixed-v1",
      authorName: "Hive",
      authorEmail: "codex@kethalia.com",
      baseBranch: "main",
      allowedPrefixes: ["src"],
      maxFiles: 5,
      maxFileBytes: 1024,
      maxBytes: 4096,
    },
  };
const request = (body = "{}", headers = {}) =>
  new Request("https://hive.example/api/delivery/source-publication", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_SOURCE_POLICIES_JSON", JSON.stringify({ [taskId]: configured }));
  mocks.context.mockResolvedValue({ env: { HIVE_DELIVERY_EVIDENCE: {} } });
  mocks.sessions.mockReturnValue({ authority: { reauthorize: vi.fn() } });
  mocks.policy.mockResolvedValue({ policyDigest: "fixture" });
  mocks.issue.mockResolvedValue({ id: "fixture" });
  mocks.publish.mockResolvedValue({ executionAuthorized: false });
});
afterEach(() => vi.unstubAllEnvs());
describe("default-off protected source publication routes", () => {
  it("requires both flags without parsing or bindings", async () => {
    for (const name of [
      "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED",
      "HIVE_DELIVERY_MANAGER_ENABLED",
    ]) {
      vi.stubEnv(name, "");
      for (const route of [policy, challenge, publish])
        expect((await route(request())).status).toBe(404);
      vi.stubEnv(name, "true");
    }
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("rejects browser, query, compression and over-bound bodies before account access", async () => {
    expect((await publish(request("{}", { Origin: "https://hive.example" }))).status).toBe(403);
    expect(
      (
        await publish(
          new Request("https://hive.example/api/delivery/source-publication?producer=trusted", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(400);
    for (const incoming of [
      request("broken"),
      request("{}", { "Content-Encoding": "gzip" }),
      request("x".repeat(65537)),
    ])
      expect((await challenge(incoming)).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("pins controller policy to exact persisted owner/repository and uses the real guardian seam", async () => {
    const response = await policy(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const dependencies = mocks.service.mock.calls[0][1];
    expect(dependencies.resolvePolicy({ taskId, ownerId, repositoryId: "123" })).toEqual(
      configured.policy,
    );
    for (const scope of [
      { taskId, ownerId: randomUUID(), repositoryId: "123" },
      { taskId, ownerId, repositoryId: "999" },
      { taskId: randomUUID(), ownerId, repositoryId: "123" },
    ])
      expect(() => dependencies.resolvePolicy(scope)).toThrow("source_task_policy_missing");
    mocks.admission.mockRejectedValue(new RegistrationRejected());
    await expect(dependencies.lockProducerAdmission({}, {})).rejects.toThrow();
    expect(mocks.admission).toHaveBeenCalledOnce();
  });
  it("dispatches each phase, with no R2 or policy fallback", async () => {
    await policy(request());
    await challenge(request());
    await publish(request());
    expect(mocks.policy).toHaveBeenCalledOnce();
    expect(mocks.issue).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    mocks.context.mockResolvedValue({ env: {} });
    expect((await challenge(request())).status).toBe(503);
    expect(mocks.issue).toHaveBeenCalledOnce();
    mocks.context.mockResolvedValue({ env: { HIVE_DELIVERY_EVIDENCE: {} } });
    vi.stubEnv("HIVE_DELIVERY_SOURCE_POLICIES_JSON", "");
    mocks.issue.mockImplementation(() =>
      mocks.service.mock.calls.at(-1)?.[1].resolvePolicy({ taskId, ownerId, repositoryId: "123" }),
    );
    expect((await challenge(request())).status).toBe(503);
  });
  it("sanitizes internal errors and authority rejections", async () => {
    mocks.publish.mockRejectedValueOnce(new RegistrationRejected());
    expect((await publish(request())).status).toBe(403);
    mocks.publish.mockRejectedValueOnce(new Error("private-token-secret"));
    const failure = await publish(request());
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("secret");
  });
  it("bounds a stalled body and stalled cancellation before authority", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream({
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      });
      const incoming = new Request("https://hive.example/api/delivery/source-publication", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit);
      const pending = publish(incoming);
      await vi.advanceTimersByTimeAsync(5101);
      expect((await pending).status).toBe(400);
      expect(cancelled).toBe(true);
      expect(mocks.context).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
