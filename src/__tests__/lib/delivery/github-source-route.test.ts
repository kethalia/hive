import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { githubFixture } from "./github-fixture";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  ingest: vi.fn(),
  challenge: vi.fn(),
  service: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => ({}),
}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mocks.context }));
vi.mock("@/lib/codex-session/route.server", async (original) => ({
  ...(await original<typeof import("@/lib/codex-session/route.server")>()),
  sessionService: mocks.session,
}));
vi.mock("@/lib/delivery/github-transport.server", () => ({
  GitHubSourceTransport: class {
    constructor(...args: unknown[]) {
      mocks.service(...args);
    }
    requestChallenge = mocks.challenge;
    ingest = mocks.ingest;
  },
}));

import { POST as challenge } from "@/app/api/delivery/github-source/challenge/route";
import { POST as snapshot } from "@/app/api/delivery/github-source/route";

const taskId = randomUUID();
const configured = { pullNumber: 5, policy: githubFixture().policy };
const request = (body = "{}", headers = {}) =>
  new Request("https://hive.example/api/delivery/github-source", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_GITHUB_SOURCE_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_GITHUB_TARGETS_JSON", JSON.stringify({ [taskId]: configured }));
  mocks.context.mockResolvedValue({ env: { HIVE_DELIVERY_EVIDENCE: {} } });
  mocks.session.mockReturnValue({ authority: { reauthorize: vi.fn() } });
  mocks.ingest.mockResolvedValue({ evidenceIds: [] });
  mocks.challenge.mockResolvedValue({ id: "challenge" });
});
afterEach(() => vi.unstubAllEnvs());
describe("default-off source-only route", () => {
  it("requires both independent flags before parsing or touching account bindings", async () => {
    for (const name of ["HIVE_DELIVERY_GITHUB_SOURCE_ENABLED", "HIVE_DELIVERY_MANAGER_ENABLED"]) {
      vi.stubEnv(name, "");
      expect((await snapshot(request())).status).toBe(404);
      vi.stubEnv(name, "true");
    }
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("browser credentials, query selectors, compression and excess bodies grant no source authority", async () => {
    expect(
      (await snapshot(request("{}", { Origin: "https://hive.example", Cookie: "owner=fixture" })))
        .status,
    ).toBe(403);
    expect(
      (
        await snapshot(
          new Request("https://hive.example/api/delivery/github-source?producer=trusted", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(400);
    for (const value of [
      request("bad"),
      request("{}", { "Content-Encoding": "gzip" }),
      request("x".repeat(1152 * 1024 + 1)),
    ])
      expect((await snapshot(value)).status).toBe(400);
    expect((await challenge(request("x".repeat(65537)))).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("no policy or no R2 binding fails closed with no local-memory fallback", async () => {
    mocks.ingest.mockImplementation(async () =>
      mocks.service.mock.calls
        .at(-1)?.[1]
        .resolveTargetPolicy(
          { taskId },
          { $queryRaw: async () => [], deliveryTask: { findUnique: async () => null } },
        ),
    );
    vi.stubEnv("HIVE_DELIVERY_GITHUB_TARGETS_JSON", "");
    expect((await snapshot(request())).status).toBe(503);
    vi.stubEnv("HIVE_DELIVERY_GITHUB_TARGETS_JSON", "{}");
    mocks.ingest.mockClear();
    mocks.context.mockResolvedValue({ env: {} });
    expect((await snapshot(request())).status).toBe(503);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("phase dispatch uses only server-owned task policy and returns uncached results", async () => {
    const body = { signed: "fixture" },
      response = await challenge(request(JSON.stringify(body)));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.challenge).toHaveBeenCalledWith(body);
    expect(mocks.ingest).not.toHaveBeenCalled();
    const resolve = mocks.service.mock.calls[0][1].resolveTargetPolicy;
    expect(
      await resolve(
        { taskId },
        { $queryRaw: async () => [], deliveryTask: { findUnique: async () => null } },
      ),
    ).toEqual(configured);
    await expect(resolve({ taskId })).rejects.toThrow("repository_policy_transaction_required");
    await expect(
      resolve(
        { taskId: randomUUID() },
        { $queryRaw: async () => [], deliveryTask: { findUnique: async () => null } },
      ),
    ).rejects.toThrow("github_task_policy_missing");
  });
  it("auth and internal failures never return raw credentials or snapshot details", async () => {
    mocks.ingest.mockRejectedValueOnce(new RegistrationRejected());
    expect((await snapshot(request())).status).toBe(403);
    mocks.ingest.mockRejectedValueOnce(new Error("private token fixture-secret"));
    const failure = await snapshot(request());
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("fixture-secret");
  });
  it("a stalled body and stalled cancellation finish at the parser deadline before authority access", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream({
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      });
      const incoming = new Request("https://hive.example/api/delivery/github-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit);
      const pending = snapshot(incoming);
      await vi.advanceTimersByTimeAsync(5101);
      expect((await pending).status).toBe(400);
      expect(cancelled).toBe(true);
      expect(mocks.context).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
