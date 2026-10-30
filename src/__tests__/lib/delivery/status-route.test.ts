import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { DeliveryConflict } from "@/lib/delivery/state";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  service: vi.fn(),
  sessions: vi.fn(),
  db: vi.fn(),
  cloudflare: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: mocks.db }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mocks.cloudflare }));
vi.mock("@/lib/codex-session/route.server", async (original) => ({
  ...(await original<typeof import("@/lib/codex-session/route.server")>()),
  sessionService: mocks.sessions,
}));
vi.mock("@/lib/delivery/status.server", () => ({
  DeliveryStatusService: class {
    constructor(...args: unknown[]) {
      mocks.service(...args);
    }
    read = mocks.read;
  },
}));

import { POST } from "@/app/api/delivery/host/status/route";

const request = (body = "{}", headers = {}) =>
  new Request("https://hive.example/api/delivery/host/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_EXECUTION_ENABLED", "true");
  mocks.db.mockReturnValue({});
  mocks.sessions.mockReturnValue({ authority: { reauthorize: vi.fn() } });
  mocks.read.mockResolvedValue({
    cleanupAuthorized: false,
    publicationAuthorized: false,
    executionAuthorized: false,
  });
  mocks.cloudflare.mockRejectedValue(new Error("No R2 binding"));
});
afterEach(() => vi.unstubAllEnvs());
describe("default-off fresh delivery status route", () => {
  it("checks both execution flags before parsing or account access", async () => {
    for (const key of ["HIVE_DELIVERY_MANAGER_ENABLED", "HIVE_DELIVERY_EXECUTION_ENABLED"]) {
      vi.stubEnv(key, "");
      expect((await POST(request())).status).toBe(404);
      vi.stubEnv(key, "true");
    }
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.sessions).not.toHaveBeenCalled();
  });
  it("reads factual state without R2/policy configuration or new permissions", async () => {
    const body = { signed: "fixture" },
      response = await POST(request(JSON.stringify(body)));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      cleanupAuthorized: false,
      publicationAuthorized: false,
      executionAuthorized: false,
    });
    expect(mocks.read).toHaveBeenCalledWith(body);
    expect(mocks.cloudflare).not.toHaveBeenCalled();
  });
  it("rejects browser/query/compressed/overlarge payloads before DB", async () => {
    expect((await POST(request("{}", { Origin: "https://hive.example" }))).status).toBe(403);
    expect(
      (
        await POST(
          new Request("https://hive.example/api/delivery/host/status?revision=caller", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(400);
    for (const r of [
      request("bad"),
      request("{}", { "Content-Encoding": "gzip" }),
      request("x".repeat(16385)),
    ])
      expect((await POST(r)).status).toBe(400);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("bounds stalled cancellation before authentication", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const stream = new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
        incoming = new Request("https://hive.example/api/delivery/host/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: stream,
          duplex: "half",
        } as RequestInit),
        pending = POST(incoming);
      await vi.advanceTimersByTimeAsync(5101);
      expect((await pending).status).toBe(400);
      expect(cancelled).toBe(true);
      expect(mocks.db).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("sanitizes private failures and preserves scoped not-found/auth distinction", async () => {
    mocks.read.mockRejectedValueOnce(new RegistrationRejected());
    expect((await POST(request())).status).toBe(403);
    mocks.read.mockRejectedValueOnce(new DeliveryConflict("status_not_found"));
    expect((await POST(request())).status).toBe(409);
    mocks.read.mockRejectedValueOnce(new Error("private token secret"));
    const failed = await POST(request());
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("secret");
  });
});
