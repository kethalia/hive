import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: vi.fn(),
}));

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
const mockedGetSession = vi.mocked(getSession);
const mockedCookies = vi.mocked(cookies);
const mockedExec = vi.mocked(execInWorkspace);

const MOCK_SESSION = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "",
    sessionId: "sess-id-1",
    expiresAt: new Date(Date.now() + 86400000),
  },
};

describe("session server actions", () => {
  const mockGetWorkspaceAgentName = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockedGetSession.mockResolvedValue(MOCK_SESSION);
    mockedCookies.mockResolvedValue({
      get: () => ({ value: "session-cookie-value" }),
    } as never);

    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspaceAgentName: mockGetWorkspaceAgentName,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createSessionAction", () => {
    it("returns a session with a provided name (no tmux call — PTY creates on connect)", async () => {
      const { createSessionAction } = await import("@/lib/actions/workspaces");
      const result = await createSessionAction({
        workspaceId: "ws-1",
        sessionName: "my-session",
      });

      expect(mockGetWorkspaceAgentName).not.toHaveBeenCalled();
      expect(mockedExec).not.toHaveBeenCalled();
      expect(result?.data).toEqual({ name: "my-session" });
    });

    it("generates a session name when none provided", async () => {
      const { createSessionAction } = await import("@/lib/actions/workspaces");
      const result = await createSessionAction({ workspaceId: "ws-1" });

      expect(result?.data?.name).toMatch(/^session-\d+$/);
    });

    it("rejects invalid session names", async () => {
      const { createSessionAction } = await import("@/lib/actions/workspaces");

      const result = await createSessionAction({
        workspaceId: "ws-1",
        sessionName: "bad name; rm -rf /",
      });

      expect(result?.serverError).toContain("Invalid session name");
    });
  });

  describe("renameSessionAction", () => {
    it("renames a session", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const { renameSessionAction } = await import("@/lib/actions/workspaces");
      const result = await renameSessionAction({
        workspaceId: "ws-1",
        oldName: "old-name",
        newName: "new-name",
      });

      expect(mockedExec).toHaveBeenCalledWith(
        "dev.main",
        "tmux -L web rename-session -t old-name new-name",
      );
      expect(result?.data).toEqual({ oldName: "old-name", newName: "new-name" });
    });

    it("rejects invalid old name", async () => {
      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      const result = await renameSessionAction({
        workspaceId: "ws-1",
        oldName: "bad name!",
        newName: "good-name",
      });

      expect(result?.serverError).toContain("Invalid session name: bad name!");
    });

    it("rejects invalid new name", async () => {
      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      const result = await renameSessionAction({
        workspaceId: "ws-1",
        oldName: "good-name",
        newName: "bad name!",
      });

      expect(result?.serverError).toContain("Invalid session name: bad name!");
    });

    it("returns error when tmux rename fails", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "session not found: old-name",
        exitCode: 1,
      });

      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      const result = await renameSessionAction({
        workspaceId: "ws-1",
        oldName: "old-name",
        newName: "new-name",
      });

      expect(result?.serverError).toContain('Failed to rename session "old-name" to "new-name"');
    });

    it("returns error when no agent found", async () => {
      mockGetWorkspaceAgentName.mockRejectedValueOnce(new Error("No agents found"));

      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      const result = await renameSessionAction({
        workspaceId: "ws-1",
        oldName: "old",
        newName: "new",
      });

      expect(result?.serverError).toContain("No agents found");
    });
  });

  describe("killSessionAction", () => {
    it("kills a session", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const { killSessionAction } = await import("@/lib/actions/workspaces");
      const result = await killSessionAction({
        workspaceId: "ws-1",
        sessionName: "my-session",
      });

      expect(mockedExec).toHaveBeenCalledWith("dev.main", "tmux -L web kill-session -t my-session");
      expect(result?.data).toEqual({ name: "my-session" });
    });

    it("rejects invalid session name", async () => {
      const { killSessionAction } = await import("@/lib/actions/workspaces");

      const result = await killSessionAction({
        workspaceId: "ws-1",
        sessionName: "$(evil)",
      });

      expect(result?.serverError).toContain("Invalid session name");
    });

    it("returns error when tmux kill fails", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "session not found: my-session",
        exitCode: 1,
      });

      const { killSessionAction } = await import("@/lib/actions/workspaces");

      const result = await killSessionAction({
        workspaceId: "ws-1",
        sessionName: "my-session",
      });

      expect(result?.serverError).toContain('Failed to kill session "my-session"');
    });

    it("returns error when no agent found", async () => {
      mockGetWorkspaceAgentName.mockRejectedValueOnce(new Error("No agents found"));

      const { killSessionAction } = await import("@/lib/actions/workspaces");

      const result = await killSessionAction({
        workspaceId: "ws-1",
        sessionName: "test",
      });

      expect(result?.serverError).toContain("No agents found");
    });
  });
});
