import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), pause: vi.fn(), db: {} }));
vi.mock("@hive/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/delivery/repository", () => ({
  DeliveryRepository: class {
    setPaused = mocks.pause;
  },
}));

import { POST } from "@/app/api/delivery/tasks/[taskId]/pause/route";
import { DeliveryConflict } from "@/lib/delivery/state";

const owner = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const origin = "https://hive.example";
const context = { params: Promise.resolve({ taskId }) };
const input = {
  schemaVersion: 1,
  eventId: "33333333-3333-4333-8333-333333333333",
  expectedVersion: 2,
  paused: true,
};
function request(body: unknown = input, headers: Record<string, string> = {}, query = "") {
  return new Request(`${origin}/api/delivery/tasks/${taskId}/pause${query}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_ENABLED", "true");
  mocks.session.mockResolvedValue({ user: { id: owner } });
  mocks.pause.mockResolvedValue({ version: 3, replayed: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("owner scheduling control", () => {
  it("is disabled before authentication or storage", async () => {
    vi.stubEnv("HIVE_DELIVERY_ENABLED", "false");
    expect((await POST(request(), context)).status).toBe(404);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([
    { Origin: "" },
    { Origin: "null" },
    { Origin: "https://other.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ])("rejects invalid origins %j before authentication", async (headers) => {
    expect((await POST(request(input, headers), context)).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("requires a current session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await POST(request(), context)).status).toBe(401);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, ownerId: owner },
    { ...input, taskId },
    { ...input, paused: "true" },
    { ...input, expectedVersion: -1 },
    { ...input, eventId: "not-a-uuid" },
    { ...input, extra: "x".repeat(2048) },
  ])("rejects invalid or caller-selected authority %j", async (body) => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("rejects query selectors, encoded bodies and non-JSON requests", async () => {
    for (const req of [
      request(input, {}, "?owner=other"),
      request(input, { "Content-Encoding": "gzip" }),
      request(input, { "Content-Type": "text/plain" }),
    ]) {
      expect((await POST(req, context)).status).toBe(400);
    }
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("binds the mutation to session owner and path, with replay identity preserved", async () => {
    mocks.pause.mockResolvedValue({ version: 3, replayed: true });
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.pause).toHaveBeenCalledWith(owner, { ...input, taskId });
    expect(await response.json()).toEqual({ version: 3, replayed: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });
  it.each([
    ["task_not_found", 404, "not_found"],
    ["version_conflict", 409, "task_changed"],
    ["event_replay_conflict", 409, "task_changed"],
  ] as const)("maps %s without disclosing task ownership", async (code, status, error) => {
    mocks.pause.mockRejectedValue(new DeliveryConflict(code));
    const response = await POST(request(), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });
  it("redacts authentication and database failures", async () => {
    for (const fn of [mocks.session, mocks.pause]) {
      fn.mockRejectedValueOnce(new Error("private connection data"));
      const response = await POST(request(), context);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private");
    }
  });
});
