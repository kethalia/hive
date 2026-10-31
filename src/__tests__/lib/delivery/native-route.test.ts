import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { DeliveryConflict } from "@/lib/delivery/state";

const mocks = vi.hoisted(() => ({ ingest: vi.fn(), service: vi.fn(), db: {} }));
vi.mock("@hive/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: vi.fn() }));
vi.mock("@/lib/codex-session/route.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-session/route.server")>()),
  sessionService: mocks.service,
}));
vi.mock("@/lib/delivery/native.server", () => ({
  DeliveryNativeSourceService: class {
    ingest = mocks.ingest;
  },
}));

import { POST } from "@/app/api/delivery/native/route";

const url = "https://hive.example/api/delivery/native";
const request = (body = "{}", headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "true");
  vi.stubEnv("HIVE_DELIVERY_NATIVE_ENABLED", "true");
  mocks.service.mockReturnValue({ authority: { reauthorize: vi.fn() } });
  mocks.ingest.mockResolvedValue({ taskId: "fixture" });
});
afterEach(() => vi.unstubAllEnvs());
describe("bounded native observer API", () => {
  it("defaults off before parsing input or accessing authority", async () => {
    vi.stubEnv("HIVE_DELIVERY_NATIVE_ENABLED", "");
    expect((await POST(request())).status).toBe(404);
    vi.stubEnv("HIVE_DELIVERY_NATIVE_ENABLED", "true");
    vi.stubEnv("HIVE_DELIVERY_MANAGER_ENABLED", "");
    expect((await POST(request())).status).toBe(404);
    expect(mocks.ingest).not.toHaveBeenCalled();
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
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("passes only the bounded signed body to the service and never caches replies", async () => {
    const value = { signed: "body" };
    const result = await POST(request(JSON.stringify(value)));
    expect(result.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(value);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("returns bounded conflict/auth codes and redacts internal failures", async () => {
    mocks.ingest.mockRejectedValueOnce(new RegistrationRejected());
    expect((await POST(request())).status).toBe(403);
    mocks.ingest.mockRejectedValueOnce(new DeliveryConflict("version_conflict"));
    const conflict = await POST(request());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "version_conflict" });
    mocks.ingest.mockRejectedValueOnce(new Error("private token fixture-secret"));
    const failure = await POST(request());
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("fixture-secret");
  });
});
