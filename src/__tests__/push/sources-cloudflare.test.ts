import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  prepare: vi.fn(),
  install: vi.fn(),
  stage: vi.fn(),
  confirm: vi.fn(),
  current: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/push/install", () => ({
  prepareNotificationWorkspace: mocks.prepare,
  installNotificationHooks: mocks.install,
}));
vi.mock("@/lib/push/source-credentials", () => ({
  stageNotificationCredential: mocks.stage,
  confirmNotificationCredential: mocks.confirm,
  callbackTokenHash: () => "fixture-hash",
}));
vi.mock("@hive/db", () => ({
  getDb: () => ({ notificationSource: { findFirst: mocks.current, deleteMany: mocks.remove } }),
}));

import { cloudflareNotificationSourcesRoute as route } from "@/lib/push/sources.server";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const source = {
  id: "source",
  credentialGeneration: 2,
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
};
function request(
  method = "POST",
  origin = "https://hive.invalid",
  input: unknown = { workspaceId },
) {
  return new Request("https://hive.invalid/api/notifications/sources", {
    method,
    headers: { Origin: origin },
    body: JSON.stringify(input),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.invalid");
  mocks.session.mockResolvedValue({ user: { id: "owner" } });
  mocks.prepare.mockResolvedValue({ workspaceName: "dev" });
  mocks.stage.mockResolvedValue({ source, token: "candidate" });
  mocks.install.mockResolvedValue("dev");
  mocks.confirm.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe("Worker notification source boundary", () => {
  it("checks same-origin, session and bounded strict input before workspace mutation", async () => {
    expect((await route(request("POST", "https://foreign.invalid"))).status).toBe(403);
    mocks.session.mockResolvedValueOnce(null);
    expect((await route(request())).status).toBe(401);
    expect(
      (await route(request("POST", undefined, { workspaceId, command: "injected" }))).status,
    ).toBe(400);
    expect(
      (await route(request("POST", undefined, { workspaceId, text: "a".repeat(1100) }))).status,
    ).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it("persists the candidate before installation and confirms only the verified completed operation", async () => {
    expect((await route(request())).status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith("owner", workspaceId, expect.any(AbortSignal));
    expect(mocks.stage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0],
    );
    expect(mocks.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.confirm.mock.invocationCallOrder[0],
    );
    expect(mocks.install).toHaveBeenCalledWith(
      { workspaceName: "dev" },
      "https://hive.invalid/api/notifications/events",
      "candidate",
      { sourceId: "source", generation: 2, createdAt: source.createdAt.toISOString() },
      expect.any(AbortSignal),
    );
  });
  it("does not stage on failed ownership and retains uncertainty when remote acknowledgement is lost", async () => {
    mocks.prepare.mockRejectedValueOnce(Error("private-coder-detail"));
    const denied = await route(request());
    expect(denied.status).toBe(503);
    expect(await denied.text()).not.toContain("private-coder-detail");
    expect(mocks.stage).not.toHaveBeenCalled();
    mocks.install.mockRejectedValueOnce(Error("private-token"));
    const unknown = await route(request());
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: "setup_outcome_unknown" });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("accepts an already-confirmed exact candidate but cannot resurrect a revoked source", async () => {
    mocks.confirm.mockResolvedValue(false);
    mocks.current.mockResolvedValueOnce({ id: "source" }).mockResolvedValueOnce(null);
    expect((await route(request())).status).toBe(200);
    expect(mocks.current).toHaveBeenCalledWith({
      where: {
        id: "source",
        userId: "owner",
        workspaceId,
        credentialGeneration: 2,
        tokenHash: "fixture-hash",
        pendingTokenHash: null,
      },
    });
    expect((await route(request())).status).toBe(409);
  });
  it("revokes using owner scope even with stopped/unavailable workspace", async () => {
    mocks.prepare.mockRejectedValue(Error("stopped"));
    expect((await route(request("DELETE"))).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ where: { userId: "owner", workspaceId } });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
