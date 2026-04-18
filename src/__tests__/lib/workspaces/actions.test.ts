import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { getCoderClientForUser } from "@/lib/coder/user-client";
import { getSession } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
const mockedGetSession = vi.mocked(getSession);
const mockedCookies = vi.mocked(cookies);
const mockedExec = vi.mocked(execInWorkspace);

const MOCK_SESSION = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "coder-user-1",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "sess-1",
    sessionId: "sess-id-1",
    expiresAt: new Date(Date.now() + 86400000),
  },
};

describe("workspace server actions", () => {
  const mockListWorkspaces = vi.fn();
  const mockGetWorkspaceAgentName = vi.fn();
  const mockGetWorkspace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockedGetSession.mockResolvedValue(MOCK_SESSION);
    mockedCookies.mockResolvedValue({
      get: () => ({ value: "session-cookie-value" }),
    } as never);

    mockedGetCoderClientForUser.mockResolvedValue({
      listWorkspaces: mockListWorkspaces,
      getWorkspaceAgentName: mockGetWorkspaceAgentName,
      getWorkspace: mockGetWorkspace,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listWorkspacesAction returns workspace list", async () => {
    const workspaces = [
      { id: "ws-1", name: "dev", owner_name: "alice" },
      { id: "ws-2", name: "prod", owner_name: "alice" },
    ];
    mockListWorkspaces.mockResolvedValueOnce({ workspaces, count: 2 });

    const { listWorkspacesAction } = await import("@/lib/actions/workspaces");
    const result = await listWorkspacesAction();

    expect(mockListWorkspaces).toHaveBeenCalledWith({ owner: "me" });
    expect(result?.data).toEqual(workspaces);
  });

  it("getWorkspaceSessionsAction returns parsed sessions for running workspace", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "main:1712345678:3\ndev:1712345700:1",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(mockGetWorkspaceAgentName).toHaveBeenCalledWith("ws-1");
    expect(mockedExec).toHaveBeenCalledWith(
      "dev.main",
      "tmux -L web list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'",
    );
  });

  it("getWorkspaceSessionsAction returns empty array when no agents found", async () => {
    mockGetWorkspaceAgentName.mockRejectedValueOnce(
      new Error("No agents found"),
    );

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-no-agents" });

    expect(result?.data).toEqual([]);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("getWorkspaceAction returns workspace by ID", async () => {
    const workspace = {
      id: "ws-1",
      name: "dev",
      template_id: "tpl-1",
      owner_name: "alice",
      latest_build: {
        id: "build-1",
        status: "running",
        job: { status: "succeeded", error: "" },
      },
    };
    mockGetWorkspace.mockResolvedValueOnce(workspace);

    const { getWorkspaceAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceAction({ workspaceId: "ws-1" });

    expect(mockGetWorkspace).toHaveBeenCalledWith("ws-1");
    expect(result?.data).toEqual(workspace);
  });

  it("getWorkspaceAction propagates client errors", async () => {
    mockGetWorkspace.mockRejectedValueOnce(new Error("Not found"));

    const { getWorkspaceAction } = await import("@/lib/actions/workspaces");

    const result = await getWorkspaceAction({ workspaceId: "ws-missing" });
    expect(result?.serverError).toContain("Not found");
  });

  it("getWorkspaceSessionsAction returns empty array when tmux exits non-zero", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "no server running on /tmp/tmux-1000/default",
      exitCode: 1,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toEqual([]);
  });
});
