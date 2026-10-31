import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { DeliveryConflict } from "@/lib/delivery/state";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), service: vi.fn(), db: {} }));
vi.mock("@hive/db", async (original) => ({
  ...(await original<typeof import("@hive/db")>()),
  getDb: () => mocks.db,
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: vi.fn() }));
vi.mock("@/lib/codex-session/route.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-session/route.server")>()),
  sessionService: mocks.service,
}));
vi.mock("@/lib/delivery/manager.server", () => ({
  DeliveryManagerService: class {
    execute = mocks.execute;
  },
}));

import { POST } from "@/app/api/delivery/host/route";

const url = "https://hive.example/api/delivery/host";
const request = (body = "{}", headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
  mocks.service.mockReturnValue({ authority: { reauthorize: vi.fn() } });
  mocks.execute.mockResolvedValue({ taskId: "fixture" });
});
afterEach(() => vi.unstubAllEnvs());
describe("bounded host result API", () => {
  it("defaults off before parsing input or accessing authority", async () => {
    vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "");
    expect((await POST(request())).status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("rejects browser origin, unbound query, malformed/compressed and oversized bodies before authority access", async () => {
    expect(
      (await POST(request("{}", { Origin: "https://hive.example", Cookie: "owner=session" })))
        .status,
    ).toBe(403);
    expect(
      (await POST(new Request(`${url}?operation=create_task`, { method: "POST" }))).status,
    ).toBe(400);
    for (const value of [
      request("not-json"),
      request("{}", { "Content-Encoding": "gzip" }),
      request("x".repeat(65537)),
      request("{}", { "Content-Type": "text/plain" }),
    ])
      expect((await POST(value)).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("passes only the bounded signed body to the service and never caches replies", async () => {
    const value = { signed: "body" };
    const result = await POST(request(JSON.stringify(value)));
    expect(result.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(value);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("returns bounded conflict/auth codes and redacts internal failures", async () => {
    mocks.execute.mockRejectedValueOnce(new RegistrationRejected());
    expect((await POST(request())).status).toBe(403);
    mocks.execute.mockRejectedValueOnce(new DeliveryConflict("version_conflict"));
    const conflict = await POST(request());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "version_conflict" });
    mocks.execute.mockRejectedValueOnce(new Error("private token fixture-secret"));
    const failure = await POST(request());
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("fixture-secret");
  });
});
