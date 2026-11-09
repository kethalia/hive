import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  coder: vi.fn(),
  workspaces: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@hive/db", () => ({ getDb: () => ({ notificationSource: { findMany: mocks.sources } }) }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mocks.coder }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));

import { GET } from "@/app/api/settings/window/route";
import { readSettingsWindow } from "@/lib/settings/window.server";
import { fetchSettingsWindow } from "@/lib/settings/window-client";
import { SETTINGS_UNAVAILABLE } from "@/lib/settings/window-contracts";

const user = {
  id: "owner-a",
  email: "a@example.invalid",
  username: "a",
  coderUrl: "https://coder.invalid",
  coderUserId: "coder-a",
};
const source = {
  workspaceId: "retained",
  workspaceName: "Retained",
  pendingTokenHash: "private-value",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sources.mockResolvedValue([source]);
  mocks.coder.mockResolvedValue({ listWorkspaces: mocks.workspaces });
  mocks.workspaces.mockResolvedValue({
    workspaces: [
      {
        id: "live",
        name: "Live",
        latest_build: { status: "running", resources: [{ secret: "private" }] },
      },
    ],
  });
  mocks.session.mockResolvedValue({ user });
});
afterEach(() => vi.unstubAllGlobals());
describe("portable schema-7 settings", () => {
  it("projects only the authenticated owner's baseline settings and preserves retained sources", async () => {
    const result = await readSettingsWindow(user);
    expect(mocks.sources).toHaveBeenCalledWith({
      where: { userId: user.id },
      select: { workspaceId: true, workspaceName: true, pendingTokenHash: true },
    });
    expect(mocks.coder).toHaveBeenCalledWith(user.id, { signal: expect.any(AbortSignal) });
    expect(mocks.workspaces).toHaveBeenCalledWith({ owner: "me" });
    expect(result).toEqual({
      email: user.email,
      coderUrl: user.coderUrl,
      connectedWorkspaceIds: ["retained"],
      pendingWorkspaceIds: ["retained"],
      workspaces: [
        { id: "live", name: "Live", running: true },
        { id: "retained", name: "Retained", running: false },
      ],
      workspaceError: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("keeps baseline partial settings when Coder is unavailable without exposing errors", async () => {
    mocks.workspaces.mockRejectedValue(new Error("private upstream response"));
    expect(await readSettingsWindow(user)).toMatchObject({
      workspaceError: true,
      workspaces: [{ id: "retained", name: "Retained", running: false }],
    });
  });
  it("drains credential work after the source query fails before returning its sanitized failure", async () => {
    const late = deferred<{ listWorkspaces: typeof mocks.workspaces }>();
    mocks.sources.mockRejectedValue(new Error("private database detail"));
    mocks.coder.mockReturnValue(late.promise);
    let settled = false;
    const result = readSettingsWindow(user).catch((error) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    late.resolve({ listWorkspaces: mocks.workspaces });
    expect((await result).message).toBe(SETTINGS_UNAVAILABLE);
  });
  it("drains the source query after cancellation and never starts provider work", async () => {
    const late = deferred<(typeof source)[]>(),
      controller = new AbortController();
    mocks.sources.mockReturnValue(late.promise);
    let settled = false;
    const result = readSettingsWindow(user, controller.signal).catch((error) => {
      settled = true;
      return error;
    });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    late.resolve([source]);
    expect((await result).name).toBe("AbortError");
    expect(mocks.workspaces).not.toHaveBeenCalled();
  });
  it("requires session/origin and rejects request-selected settings scope", async () => {
    expect(
      (
        await GET(
          new Request("https://hive.invalid/api/settings/window", {
            headers: { origin: "https://other.invalid" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    mocks.session.mockResolvedValueOnce(null);
    expect((await GET(new Request("https://hive.invalid/api/settings/window"))).status).toBe(401);
    expect(
      (await GET(new Request("https://hive.invalid/api/settings/window?userId=other"))).status,
    ).toBe(400);
    expect(mocks.sources).not.toHaveBeenCalled();
    const response = await GET(new Request("https://hive.invalid/api/settings/window"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it("sanitizes route and client failures and passes browser cancellation to the GET", async () => {
    mocks.sources.mockRejectedValue(new Error("private db failure"));
    const response = await GET(new Request("https://hive.invalid/api/settings/window"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "settings_unavailable" });
    const fetch = vi.fn(async () => new Response("private provider failure", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await expect(fetchSettingsWindow(controller.signal)).rejects.toThrow(SETTINGS_UNAVAILABLE);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/window");
    expect(options).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
  });
});
