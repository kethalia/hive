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
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
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
      {
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-session-token",
      },
    );
    expect(result?.data).toEqual([
      { name: "main", created: 1712345678, windows: 3 },
      { name: "dev", created: 1712345700, windows: 1 },
    ]);
  });

  it("getWorkspaceSessionsAction filters reserved clone terminal sessions from mixed tmux output", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "main:1712345678:3\ngit-clone-abc123:1712345700:1\nbuild:1712345800:2",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toEqual([
      { name: "main", created: 1712345678, windows: 3 },
      { name: "build", created: 1712345800, windows: 2 },
    ]);
  });

  it("getWorkspaceSessionsAction returns an empty list when tmux output contains only clone sessions", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "git-clone-abc123:1712345678:1\ngit-clone-def456:1712345700:2",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toEqual([]);
  });

  it("getWorkspaceSessionsAction returns empty array when no agents found", async () => {
    mockGetWorkspaceAgentName.mockRejectedValueOnce(new Error("No agents found"));

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

  it("getWorkspaceSessionsAction returns empty array when tmux server is not running", async () => {
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

  it("getWorkspaceSessionsAction recognizes no-server tmux output from stdout", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "no server running on /tmp/tmux-1000/default",
      stderr: "",
      exitCode: 1,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toEqual([]);
  });

  it("getWorkspaceSessionsAction does not collapse blank command failures into unknown error", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 1,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toMatch(/Failed to list tmux sessions/i);
    expect(result?.serverError).toMatch(/no diagnostics returned by workspace command/i);
    expect(result?.serverError).not.toMatch(/unknown error/i);
  });

  it("getWorkspaceSessionsAction propagates agent lookup failures that are not no-agent cases", async () => {
    mockGetWorkspaceAgentName.mockRejectedValueOnce(new Error("Coder API unreachable"));

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toMatch(/Failed to resolve workspace agent/i);
    expect(result?.serverError).toMatch(/Coder API unreachable/i);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("getWorkspaceSessionsAction surfaces serverError on ssh/transient failures (not empty)", async () => {
    // Critical regression guard: a transient ssh failure on browser refresh
    // must NOT look like "user has zero sessions" to the client — that caused
    // TerminalTabManager to auto-create a phantom session and hide the real
    // tmux sessions still running on the workspace.
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "ssh: connect to host dev.main port 22: Connection refused",
      exitCode: 255,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toMatch(/Failed to list tmux sessions/i);
    expect(result?.serverError).toMatch(/Connection refused/);
  });

  it("getWorkspaceSessionsAction surfaces missing Coder CLI diagnostics instead of creating an empty list", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "spawn coder ENOENT",
      exitCode: 1,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toMatch(/Failed to list tmux sessions/i);
    expect(result?.serverError).toMatch(/spawn coder ENOENT/i);
  });

  it("getWorkspaceSessionsAction surfaces serverError on timeout (not empty)", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "Command timed out after 10000ms",
      exitCode: 124,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toMatch(/timed out/i);
  });
});
