import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  sources: vi.fn(),
  coder: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => ({ notificationSource: { findMany: mocks.sources } }) }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mocks.coder }));

import { GET } from "@/app/api/settings/window/route";
import { getSettingsWindowAction } from "@/lib/actions/settings-window";
import { readSettingsWindow } from "@/lib/settings/window.server";
import { SETTINGS_UNAVAILABLE } from "@/lib/settings/window-contracts";

const user = {
  id: "hive-owner",
  coderUserId: "coder-owner",
  username: "owner",
  email: "owner@example.com",
  coderUrl: "https://coder.example.com",
};
const url = "https://hive.example/api/settings/window";
const privateText = "postgres://private-token@private-host/db";
const workspace = {
  id: "running-workspace",
  name: "Software",
  latest_build: { status: "running" },
  secret: privateText,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user });
  mocks.sources.mockResolvedValue([
    { workspaceId: "running-workspace", workspaceName: "Old name", pendingTokenHash: null },
    {
      workspaceId: "offline-workspace",
      workspaceName: "Saved workspace",
      pendingTokenHash: privateText,
    },
  ]);
  mocks.coder.mockResolvedValue({ listWorkspaces: mocks.list });
  mocks.list.mockResolvedValue({ workspaces: [workspace] });
});

describe("portable settings reads", () => {
  it("requires authentication before owner DB or Coder access", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(new Request(url));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.sources).not.toHaveBeenCalled();
    expect(mocks.coder).not.toHaveBeenCalled();
  });
  it.each([
    ["sec-fetch-site", "cross-site"],
    ["origin", "https://attacker.example"],
  ])("rejects foreign browser reads before session access: %s", async (key, value) => {
    expect((await GET(new Request(url, { headers: new Headers([[key, value]]) }))).status).toBe(
      403,
    );
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it.each([
    "userId=attacker",
    "workspaceId=foreign",
    "cursor=1",
  ])("rejects caller-selected query %s", async (query) => {
    expect((await GET(new Request(`${url}?${query}`))).status).toBe(400);
    expect(mocks.sources).not.toHaveBeenCalled();
  });
  it("uses only Hive owner identity, preserving pending state and offline fallback without secrets", async () => {
    const request = new Request(url);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mocks.sources).toHaveBeenCalledWith({
      where: { userId: user.id },
      select: { workspaceId: true, workspaceName: true, pendingTokenHash: true },
    });
    expect(mocks.coder).toHaveBeenCalledWith(user.id, { signal: request.signal });
    expect(mocks.list).toHaveBeenCalledWith({ owner: "me" });
    const payload = await response.json();
    expect(payload).toEqual({
      email: user.email,
      coderUrl: user.coderUrl,
      connectedWorkspaceIds: ["running-workspace", "offline-workspace"],
      pendingWorkspaceIds: ["offline-workspace"],
      workspaces: [
        { id: workspace.id, name: workspace.name, running: true },
        { id: "offline-workspace", name: "Saved workspace", running: false },
      ],
      workspaceError: false,
    });
    expect(JSON.stringify(payload)).not.toContain(privateText);
    expect(payload).not.toHaveProperty("pendingTokenHash");
  });
  it("changes both owner-bound clients with the authenticated principal", async () => {
    mocks.session.mockResolvedValue({ user: { ...user, id: "second-owner" } });
    await GET(new Request(url));
    expect(mocks.sources.mock.lastCall?.[0].where.userId).toBe("second-owner");
    expect(mocks.coder.mock.lastCall?.[0]).toBe("second-owner");
  });
  it("retains connected and pending workspace names when Coder is unavailable", async () => {
    mocks.coder.mockRejectedValue(new Error(privateText));
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.workspaceError).toBe(true);
    expect(payload.workspaces).toEqual([
      { id: "running-workspace", name: "Old name", running: false },
      { id: "offline-workspace", name: "Saved workspace", running: false },
    ]);
    expect(JSON.stringify(payload)).not.toContain(privateText);
  });
  it("redacts DB failures and session provider failures", async () => {
    mocks.sources.mockRejectedValue(new Error(privateText));
    let response = await GET(new Request(url));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "settings_unavailable" });
    mocks.session.mockRejectedValue(new Error(privateText));
    response = await GET(new Request(url));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(privateText);
  });
  it("sanitizes synchronous provider failures for existing action callers too", async () => {
    mocks.sources.mockImplementationOnce(() => {
      throw new Error(privateText);
    });
    await expect(readSettingsWindow(user)).rejects.toThrow(SETTINGS_UNAVAILABLE);
    expect(mocks.coder).not.toHaveBeenCalled();
  });
  it("rejects malformed output instead of reflecting upstream objects or unsafe links", async () => {
    mocks.list.mockResolvedValue({ workspaces: [{ ...workspace, name: { secret: privateText } }] });
    expect((await GET(new Request(url))).status).toBe(503);
    mocks.list.mockResolvedValue({ workspaces: [workspace] });
    await expect(readSettingsWindow({ ...user, coderUrl: "javascript:alert(1)" })).rejects.toThrow(
      SETTINGS_UNAVAILABLE,
    );
  });
  it("keeps the authenticated server action backward-compatible with the same DTO", async () => {
    const action = await getSettingsWindowAction();
    const route = await GET(new Request(url));
    expect(action?.data).toEqual(await route.json());
    mocks.session.mockResolvedValue(null);
    expect((await getSettingsWindowAction())?.serverError).toBe("Not authenticated");
  });
  it("does not start reads after cancellation or schedule Coder HTTP after a late client result", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readSettingsWindow(user, controller.signal)).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    expect(mocks.sources).not.toHaveBeenCalled();
    let resolve!: (client: { listWorkspaces: typeof mocks.list }) => void;
    mocks.coder.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const active = new AbortController();
    const result = readSettingsWindow(user, active.signal);
    active.abort();
    resolve({ listWorkspaces: mocks.list });
    await expect(result).rejects.toHaveProperty("name", "AbortError");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("drains the concurrent client read before returning a source DB error", async () => {
    let resolve!: (client: { listWorkspaces: typeof mocks.list }) => void;
    mocks.coder.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mocks.sources.mockRejectedValue(new Error(privateText));
    let completed = false;
    const result = readSettingsWindow(user).catch((error) => {
      completed = true;
      throw error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    resolve({ listWorkspaces: mocks.list });
    await expect(result).rejects.toThrow(SETTINGS_UNAVAILABLE);
  });
});
