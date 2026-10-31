import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ session: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/codex-session/route.server", async (original) => ({
  ...(await original()),
  authorizeSessionOwner: mock.session,
}));
vi.mock("@/lib/projects/open.server", () => ({ openProject: mock.open }));

import { POST } from "@/app/api/projects/open/route";

const user = { id: "owner", coderUserId: "coder-owner" };
function request(body = "{}", path = "/api/projects/open") {
  return new Request(`https://hive.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  mock.session.mockResolvedValue({ user });
  mock.open.mockResolvedValue({ phase: "awaitingTask" });
});
afterEach(() => vi.unstubAllEnvs());
describe("project enrollment route", () => {
  it("allows authenticated metadata enrollment while task execution remains disabled", async () => {
    vi.stubEnv("HIVE_PROJECT_TASKS_ENABLED", "false");
    expect((await POST(request())).status).toBe(200);
    expect(mock.open).toHaveBeenCalledWith(user, {});
  });
  it("does not enroll when discovery is disabled or owner authorization rejects", async () => {
    vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "false");
    expect((await POST(request())).status).toBe(404);
    expect(mock.session).not.toHaveBeenCalled();
    vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
    mock.session.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(request())).status).toBe(403);
    expect(mock.open).not.toHaveBeenCalled();
  });
  it.each([
    ["{", "/api/projects/open"],
    ["x".repeat(4097), "/api/projects/open"],
    ["{}", "/api/projects/open?url=other"],
  ])("rejects malformed, oversized or query-routed enrollment", async (body, path) => {
    expect((await POST(request(body, path))).status).toBe(400);
    expect(mock.open).not.toHaveBeenCalled();
  });
  it("binds the operation to the authenticated user and marks metadata private", async () => {
    const response = await POST(request('{"requestId":"fixture"}'));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mock.open).toHaveBeenCalledWith(user, { requestId: "fixture" });
  });
  it("never exposes raw credentials or helper exceptions", async () => {
    mock.open.mockRejectedValue(new Error("private upstream credential"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("credential");
  });
});
