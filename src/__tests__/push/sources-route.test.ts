import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  install: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/push/install", () => ({ installNotificationHooks: mocks.install }));
vi.mock("@hive/db", () => ({
  getDb: () => ({ notificationSource: { upsert: mocks.upsert, deleteMany: mocks.remove } }),
}));

import { DELETE, POST } from "@/app/api/notifications/sources/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const request = (origin = "https://hive.test", method = "POST") =>
  new Request("https://hive.test/api/notifications/sources", {
    method,
    headers: { origin },
    body: JSON.stringify({ workspaceId }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "owner" } });
  mocks.install.mockResolvedValue("dev");
});
describe("workspace notification setup", () => {
  it("rejects cross-origin and unauthenticated setup", async () => {
    expect((await POST(request("https://evil.test"))).status).toBe(403);
    mocks.session.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("keeps the raw token in the installer and stores only its hash", async () => {
    expect((await POST(request())).status).toBe(200);
    const [user, workspace, callback, token] = mocks.install.mock.calls[0];
    expect([user, workspace, callback]).toEqual([
      "owner",
      workspaceId,
      "https://hive.test/api/notifications/events",
    ]);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const saved = mocks.upsert.mock.calls[0][0];
    expect(saved.create.tokenHash).not.toBe(token);
    expect(saved.where).toEqual({ userId_workspaceId: { userId: "owner", workspaceId } });
    expect(JSON.stringify(saved)).not.toContain(token);
  });
  it("leaves the old callback valid if installation fails", async () => {
    mocks.install.mockRejectedValue(new Error("Workspace unavailable"));
    expect((await POST(request())).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("only revokes the current user's source", async () => {
    expect((await DELETE(request("https://hive.test", "DELETE"))).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ where: { userId: "owner", workspaceId } });
  });
});
