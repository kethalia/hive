import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), detail: vi.fn(), db: {} }));
vi.mock("@hive/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/delivery/reads", () => ({
  listDeliveryTasks: mocks.list,
  readDeliveryTask: mocks.detail,
}));

import { GET as detail } from "@/app/api/delivery/tasks/[taskId]/route";
import { GET as list } from "@/app/api/delivery/tasks/route";

const owner = "11111111-1111-4111-8111-111111111111";
const task = "22222222-2222-4222-8222-222222222222";
const url = "https://hive.example/api/delivery/tasks";
const context = { params: Promise.resolve({ taskId: task }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HIVE_DELIVERY_ENABLED", "true");
  mocks.session.mockResolvedValue({ user: { id: owner, coderUserId: "different-coder-identity" } });
  mocks.list.mockResolvedValue({ tasks: [], nextCursor: null });
  mocks.detail.mockResolvedValue({ id: task });
});
afterEach(() => vi.unstubAllEnvs());
describe("delivery read API", () => {
  it("is disabled before session or database access", async () => {
    vi.stubEnv("HIVE_DELIVERY_ENABLED", "false");
    expect((await list(new Request(url))).status).toBe(404);
    expect((await detail(new Request(`${url}/${task}`), context)).status).toBe(404);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("requires a current session for both endpoints", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await list(new Request(url))).status).toBe(401);
    expect((await detail(new Request(`${url}/${task}`), context)).status).toBe(401);
    expect(mocks.detail).not.toHaveBeenCalled();
  });
  it.each([
    "ownerId=attacker",
    "cursor=invalid",
    `cursor=${task}&cursor=${task}`,
  ])("rejects ambiguous or owner-selected query %s", async (query) => {
    expect((await list(new Request(`${url}?${query}`))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("binds both reads to Hive owner UUID and disables caching", async () => {
    const page = await list(new Request(`${url}?cursor=${task}`));
    const item = await detail(new Request(`${url}/${task}`), context);
    expect(mocks.list).toHaveBeenCalledWith(mocks.db, owner, task);
    expect(mocks.detail).toHaveBeenCalledWith(mocks.db, owner, task, undefined);
    for (const response of [page, item]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });
  it("does not distinguish missing and unauthorized task IDs", async () => {
    mocks.detail.mockResolvedValue(null);
    const response = await detail(new Request(`${url}/${task}`), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
  it("rejects cross-site reads before accessing session or storage", async () => {
    expect(
      (await list(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }))).status,
    ).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("redacts storage failures", async () => {
    mocks.detail.mockRejectedValue(new Error("postgres://private-secret"));
    const response = await detail(new Request(`${url}/${task}`), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-secret");
  });
});

it("binds deep-linked report selection to the authenticated task read", async () => {
  const report = "33333333-3333-4333-8333-333333333333";
  const response = await detail(new Request(`${url}/${task}?report=${report}`), context);
  expect(response.status).toBe(200);
  expect(mocks.detail).toHaveBeenCalledWith(mocks.db, owner, task, report);
});
