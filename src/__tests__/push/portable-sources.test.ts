import { createHash, randomUUID } from "node:crypto";
import type { SessionData } from "@hive/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBridgeError } from "@/lib/agents/portable-client.server";
import {
  type PortableNotificationSourceDependencies,
  portableNotificationSourceRoutes,
} from "@/lib/push/portable-sources.server";

const ownerId = randomUUID(),
  coderUserId = randomUUID(),
  workspaceId = randomUUID(),
  sourceId = randomUUID();
const token = "a".repeat(64),
  origin = "https://hive.fixture.invalid";
const source = {
  id: sourceId,
  userId: ownerId,
  workspaceId,
  workspaceName: "fixture",
  tokenHash: "old",
  pendingTokenHash: "pending",
  credentialGeneration: 1,
  createdAt: new Date("2026-11-06T00:00:00.000Z"),
};
const user = { id: ownerId, coderUserId } as SessionData["user"];
const mocks = {
  session: vi.fn(),
  prepare: vi.fn(),
  install: vi.fn(),
  stage: vi.fn(),
  confirm: vi.fn(),
  current: vi.fn(),
  revoke: vi.fn(),
};
const deps: PortableNotificationSourceDependencies = {
  enabled: () => true,
  origin: () => origin,
  session: mocks.session,
  prepare: mocks.prepare,
  stage: mocks.stage,
  confirm: mocks.confirm,
  isCurrent: mocks.current,
  revoke: mocks.revoke,
};
const route = portableNotificationSourceRoutes(deps);
const request = (method = "POST", extra = {}, signal?: AbortSignal) =>
  new Request(`${origin}/api/notifications/sources`, {
    method,
    headers: { Origin: origin },
    body: JSON.stringify({ workspaceId, ...extra }),
    signal,
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user });
  mocks.prepare.mockResolvedValue({ workspaceName: "fixture", install: mocks.install });
  mocks.stage.mockResolvedValue({ source, token });
  mocks.confirm.mockResolvedValue(true);
  mocks.current.mockResolvedValue(false);
  mocks.revoke.mockResolvedValue(undefined);
  mocks.install.mockImplementation(async (op) => ({
    sourceId: op.sourceId,
    generation: op.generation,
    createdAt: op.createdAt,
    credentialHash: createHash("sha256").update(op.token).digest("hex"),
    callbackOrigin: origin,
  }));
});
describe("portable source HTTP orchestration", () => {
  it("gates before all side effects and rejects caller URLs/extra fields and cross-origin requests", async () => {
    expect(
      (await portableNotificationSourceRoutes({ ...deps, enabled: () => false })(request())).status,
    ).toBe(404);
    expect((await route(request("POST", { url: "https://arbitrary.invalid" }))).status).toBe(400);
    const cross = new Request(`${origin}/api/notifications/sources`, {
      method: "POST",
      headers: { Origin: "https://foreign.invalid" },
      body: JSON.stringify({ workspaceId }),
    });
    expect((await route(cross)).status).toBe(403);
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("verifies bridge readiness before staging and confirms only an exact private receipt", async () => {
    const response = await route(request());
    expect(response.status).toBe(200);
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stage.mock.invocationCallOrder[0],
    );
    expect(mocks.stage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0],
    );
    expect(mocks.install.mock.calls[0][0]).toEqual({
      operation: "install-notifications",
      sourceId,
      generation: 1,
      createdAt: source.createdAt.toISOString(),
      token,
    });
    expect(await response.json()).toEqual({ success: true });
  });
  it("does not stage credentials for an unavailable/unpinned bridge", async () => {
    mocks.prepare.mockRejectedValue(new AgentBridgeError("unavailable"));
    expect((await route(request())).status).toBe(503);
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it("unknown installation or mismatched receipt never confirms or leaks private metadata", async () => {
    mocks.install.mockRejectedValueOnce(new AgentBridgeError("outcome_unknown"));
    expect((await route(request())).status).toBe(409);
    mocks.install.mockResolvedValueOnce({
      sourceId,
      generation: 2,
      createdAt: source.createdAt.toISOString(),
      credentialHash: "b".repeat(64),
      callbackOrigin: origin,
    });
    const response = await route(request());
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(token);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("an aborted installer response remains uncertain without confirmation", async () => {
    const controller = new AbortController(),
      original = mocks.install.getMockImplementation()!;
    mocks.install.mockImplementationOnce(async (...args) => {
      const receipt = await original(...args);
      controller.abort();
      return receipt;
    });
    expect((await route(request("POST", {}, controller.signal))).status).toBe(409);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("accepts an already-confirmed identical generation and refuses a superseded/revoked one", async () => {
    mocks.confirm.mockResolvedValue(false);
    mocks.current.mockResolvedValueOnce(true);
    expect((await route(request())).status).toBe(200);
    expect((await route(request())).status).toBe(409);
  });
  it("disconnect requires only signed-in source ownership, not a live bridge or workspace", async () => {
    mocks.prepare.mockRejectedValue(new Error("workspace deleted"));
    expect((await route(request("DELETE"))).status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(user, workspaceId);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });
});
