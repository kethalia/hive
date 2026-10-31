import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/workspaces/read-service.server", () => ({
  createWorkspaceReadService: () => ({ read }),
}));

import {
  usesWorkspaceReadTransport,
  workspaceReadActions,
} from "@/lib/workspaces/read-actions.server";

const user = { id: "owner", coderUserId: "coder-owner" };
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());
describe("workspace read action compatibility", () => {
  it("requires the portable path in Cloudflare even when disabled, preventing shell fallback", () => {
    vi.stubEnv("HIVE_WORKSPACE_READ_ENABLED", "false");
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    expect(usesWorkspaceReadTransport()).toBe(true);
    vi.stubEnv("HIVE_RUNTIME_TARGET", "node");
    expect(usesWorkspaceReadTransport()).toBe(false);
    vi.stubEnv("HIVE_WORKSPACE_READ_ENABLED", "true");
    expect(usesWorkspaceReadTransport()).toBe(true);
  });
  it("collects bounded pages using authenticated identity and filters managed clone terminals", async () => {
    read
      .mockResolvedValueOnce({
        sessions: [{ name: "git-clone-hidden", created: 1, windows: 1 }],
        nextCursor: "page2",
      })
      .mockResolvedValueOnce({
        sessions: [{ name: "shell", created: 2, windows: 1 }],
        nextCursor: null,
      });
    expect(await workspaceReadActions(user).sessions("workspace")).toEqual([
      { name: "shell", created: 2, windows: 1 },
    ]);
    expect(read).toHaveBeenNthCalledWith(
      2,
      { hiveUserId: "owner", coderUserId: "coder-owner" },
      "workspace",
      { operation: "sessions", cursor: "page2" },
      expect.any(AbortSignal),
    );
  });
  it("rejects repeated cursors and later page failures without returning partial sessions", async () => {
    read.mockResolvedValue({
      sessions: [{ name: "shell", created: 1, windows: 1 }],
      nextCursor: "same",
    });
    await expect(workspaceReadActions(user).sessions("workspace")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(read).toHaveBeenCalledTimes(2);
    read
      .mockReset()
      .mockResolvedValueOnce({ sessions: [], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(workspaceReadActions(user).sessions("workspace")).rejects.toThrow("unavailable");
  });
  it("caps aggregate pagination", async () => {
    let n = 0;
    read.mockImplementation(async () => ({ sessions: [], nextCursor: String(++n) }));
    await expect(workspaceReadActions(user).sessions("workspace")).rejects.toMatchObject({
      code: "too_many_sessions",
    });
    expect(read).toHaveBeenCalledTimes(16);
  });
  it("retains original path strings and includes only verified files/directories", async () => {
    read.mockResolvedValue({
      candidates: [
        { index: 0, status: "file" },
        { index: 1, status: "missing" },
        { index: 2, status: "directory" },
      ],
    });
    expect(
      await workspaceReadActions(user).paths({
        workspaceId: "workspace",
        sessionName: "shell",
        paths: ["a.ts", "missing", "./dir"],
      }),
    ).toEqual(["a.ts", "./dir"]);
  });
  it.each([
    "outside_supported_root",
    "cwd_unavailable",
    "unavailable",
  ])("does not misreport %s as missing", async (status) => {
    read.mockResolvedValue({ candidates: [{ index: 0, status }] });
    await expect(
      workspaceReadActions(user).paths({
        workspaceId: "workspace",
        sessionName: "shell",
        paths: ["file"],
      }),
    ).rejects.toMatchObject({ code: "read_unavailable" });
  });
  it("keeps absent sessions distinct from failed directory reads", async () => {
    read.mockResolvedValueOnce({ cwd: null, state: "missing_session" });
    expect(await workspaceReadActions(user).directory("workspace", "shell")).toBeNull();
    read.mockRejectedValueOnce(new Error("tmux unavailable"));
    await expect(workspaceReadActions(user).directory("workspace", "shell")).rejects.toThrow(
      "tmux unavailable",
    );
  });
});
