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
  getRequestSession: vi.fn(),
  getSession: vi.fn(),
}));

import { cookies } from "next/headers";
import { getRequestSession, getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
const mockedGetRequestSession = vi.mocked(getRequestSession);
const mockedGetSession = vi.mocked(getSession);
const mockedCookies = vi.mocked(cookies);
const mockedExec = vi.mocked(execInWorkspace);
const mockCookieSet = vi.fn();

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
  const mockCreateWorkspace = vi.fn();
  const mockListTemplates = vi.fn();
  const mockListWorkspaces = vi.fn();
  const mockGetWorkspaceAgentName = vi.fn();
  const mockGetWorkspace = vi.fn();
  const mockGetWorkspaceResources = vi.fn();
  const mockStopWorkspace = vi.fn();
  const mockStartWorkspace = vi.fn();
  const mockWaitForBuild = vi.fn();
  const mockGetApplicationsHost = vi.fn();
  const mockGetApplicationAuthRedirect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockedGetRequestSession.mockResolvedValue(MOCK_SESSION);
    mockedGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetApplicationAuthRedirect.mockImplementation(async (url: string) => url);
    mockedCookies.mockResolvedValue({
      get: (name: string) => ({
        value:
          name === "hive-coder-host"
            ? "coder.example.com~coder.example.com"
            : "session-cookie-value",
      }),
      set: mockCookieSet,
    } as never);

    mockedGetCoderClientForUser.mockResolvedValue({
      createWorkspace: mockCreateWorkspace,
      listTemplates: mockListTemplates,
      listWorkspaces: mockListWorkspaces,
      getWorkspaceAgentName: mockGetWorkspaceAgentName,
      getWorkspace: mockGetWorkspace,
      getWorkspaceResources: mockGetWorkspaceResources,
      stopWorkspace: mockStopWorkspace,
      startWorkspace: mockStartWorkspace,
      waitForBuild: mockWaitForBuild,
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
      getApplicationsHost: mockGetApplicationsHost.mockResolvedValue("*.coder.example.com"),
      getApplicationAuthRedirect: mockGetApplicationAuthRedirect,
    } as never);
    mockGetWorkspaceResources.mockResolvedValue([
      {
        id: "resource-1",
        name: "workspace",
        type: "docker",
        agents: [{ id: "agent-1", name: "main", status: "connected" }],
      },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("listWorkspaceTemplatesAction returns Coder templates", async () => {
    const templates = [
      {
        id: "template-1",
        name: "hive-template",
        activeVersionId: "version-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockListTemplates.mockResolvedValueOnce(templates);

    const { listWorkspaceTemplatesAction } = await import("@/lib/actions/workspaces");
    const result = await listWorkspaceTemplatesAction();

    expect(mockListTemplates).toHaveBeenCalledTimes(1);
    expect(result?.data).toEqual(templates);
  });

  it("createWorkspaceAction creates a workspace from a selected template", async () => {
    const workspace = {
      id: "ws-new",
      name: "new-dev",
      template_id: "template-1",
      owner_name: "alice",
      latest_build: {
        id: "build-1",
        status: "pending",
        job: { status: "pending", error: "" },
      },
    };
    mockCreateWorkspace.mockResolvedValueOnce(workspace);

    const { createWorkspaceAction } = await import("@/lib/actions/workspaces");
    const result = await createWorkspaceAction({ templateId: "template-1", name: "new-dev" });

    expect(mockCreateWorkspace).toHaveBeenCalledWith("template-1", "new-dev");
    expect(result?.data).toEqual(workspace);
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
    mockGetWorkspaceResources.mockResolvedValueOnce([]);

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-no-agents" });

    expect(result?.data).toEqual([]);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("getWorkspaceSessionsAction fails fast when the workspace agent is disconnected", async () => {
    mockGetWorkspaceResources.mockResolvedValueOnce([
      {
        id: "resource-1",
        name: "workspace",
        type: "docker",
        agents: [{ id: "agent-1", name: "main", status: "disconnected" }],
      },
    ]);

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.serverError).toMatch(/agent is disconnected/i);
    expect(mockGetWorkspaceAgentName).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("restartWorkspaceAction stops, starts, and waits for a running workspace", async () => {
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      latest_build: { status: "running" },
    });

    const { restartWorkspaceAction } = await import("@/lib/actions/workspaces");
    const result = await restartWorkspaceAction({ workspaceId: "ws-1" });

    expect(mockStopWorkspace).toHaveBeenCalledWith("ws-1");
    expect(mockWaitForBuild).toHaveBeenNthCalledWith(1, "ws-1", "stopped");
    expect(mockStartWorkspace).toHaveBeenCalledWith("ws-1");
    expect(mockWaitForBuild).toHaveBeenNthCalledWith(2, "ws-1", "running");
    expect(result?.data).toEqual({ workspaceId: "ws-1", status: "running" });
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

  it("resolves embedded VS Code and File Browser URLs from the tmux pane directory", async () => {
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({
      stdout: "/home/coder/projects/kethalia/hive\n",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "code",
    });

    expect(mockedExec).toHaveBeenCalledWith(
      "dev-box.main",
      "tmux -L web display-message -p -t git-hive: '#{pane_current_path}'",
      {
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-session-token",
        timeoutMs: 5_000,
      },
    );
    expect(result?.data).toEqual({
      codeUrl:
        "https://code-server--main--dev-box--alice.coder.example.com/?folder=%2Fhome%2Fcoder%2Fprojects%2Fkethalia%2Fhive",
      filesUrl:
        "https://filebrowser--main--dev-box--alice.coder.example.com/files/projects/kethalia/hive",
      folderPath: "/home/coder/projects/kethalia/hive",
      reloadRequired: false,
      source: "tmux",
    });
  });

  it("keeps VS Code on Coder's isolated app subdomain when Hive uses a private CA", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({
      stdout: "/home/coder/projects/kethalia/hive\n",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "code",
    });

    const expectedUrl =
      "https://code-server--main--dev-box--alice.coder.example.com/?folder=%2Fhome%2Fcoder%2Fprojects%2Fkethalia%2Fhive";
    expect(result?.data?.codeUrl).toBe(expectedUrl);
    expect(mockGetApplicationAuthRedirect).toHaveBeenCalledWith(expectedUrl);
  });

  it("uses a trusted absolute fallback directory when the tmux pane is unavailable", async () => {
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "missing session", exitCode: 1 });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      fallbackPath: "/home/coder/projects/kethalia/hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "code",
    });

    expect(result?.data?.folderPath).toBe("/home/coder/projects/kethalia/hive");
    expect(result?.data?.source).toBe("fallback");
  });

  it("resolves a repository-relative fallback beneath the configured projects root", async () => {
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "missing session", exitCode: 1 });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      fallbackPath: "projects/kethalia/hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "files",
    });

    expect(result?.data?.folderPath).toBe("/home/coder/projects/kethalia/hive");
    expect(result?.data?.source).toBe("fallback");
  });

  it("resolves a repository-relative fallback when the configured projects root is slash", async () => {
    vi.stubEnv("HIVE_PROJECTS_ROOT", "/");
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "missing session", exitCode: 1 });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      fallbackPath: "workspace/repo",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "files",
    });

    expect(result?.data?.folderPath).toBe("/workspace/repo");
    expect(result?.data?.filesUrl).toBe(
      "https://filebrowser--main--dev-box--alice.coder.example.com/files/workspace/repo",
    );
    expect(result?.data?.source).toBe("fallback");
  });

  it("opens File Browser relative to a non-default configured projects root", async () => {
    vi.stubEnv("HIVE_PROJECTS_ROOT", "/tmp/repos");
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({
      stdout: "/tmp/repos/kethalia/hive\n",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "files",
    });

    expect(result?.data?.filesUrl).toBe(
      "https://filebrowser--main--dev-box--alice.coder.example.com/files/kethalia/hive",
    );
    expect(result?.data?.folderPath).toBe("/tmp/repos/kethalia/hive");
  });

  it("uses the requesting document policy when another tab already updated the cookie", async () => {
    mockGetApplicationsHost.mockResolvedValueOnce("*.apps.example.com");
    mockedCookies.mockResolvedValueOnce({
      get: () => ({ value: "https://coder.example.com~https://apps.example.com" }),
      set: mockCookieSet,
    } as never);
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({ stdout: "/home/coder\n", stderr: "", exitCode: 0 });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "files",
    });
    const client = await mockedGetCoderClientForUser.mock.results.at(-1)?.value;

    const expectedUrl = "https://filebrowser--main--dev-box--alice.apps.example.com/files/";
    expect(result?.data?.filesUrl).toBe(expectedUrl);
    expect(result?.data?.reloadRequired).toBe(true);
    expect(client?.getApplicationAuthRedirect).toHaveBeenCalledWith(expectedUrl);
    expect(mockCookieSet).toHaveBeenCalledWith(
      "hive-coder-host",
      "https://coder.example.com~https://apps.example.com",
      expect.objectContaining({ httpOnly: true, maxAge: expect.any(Number), path: "/" }),
    );
  });

  it("requires a reload when the document lacks the primary Coder frame origin", async () => {
    mockGetApplicationsHost.mockResolvedValueOnce("");
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({ stdout: "/home/coder\n", stderr: "", exitCode: 0 });

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      documentFrameHosts: [],
      tool: "files",
    });

    expect(result?.data?.reloadRequired).toBe(true);
    expect(mockCookieSet).toHaveBeenCalledWith(
      "hive-coder-host",
      "https://coder.example.com",
      expect.objectContaining({ httpOnly: true, maxAge: expect.any(Number), path: "/" }),
    );
  });

  it("does not update the frame-host cookie when application authentication fails", async () => {
    mockGetApplicationsHost.mockResolvedValueOnce("*.apps.example.com");
    mockGetWorkspace.mockResolvedValueOnce({
      id: "ws-1",
      name: "dev-box",
      owner_name: "alice",
      template_id: "tpl-1",
      latest_build: { id: "build-1", status: "running", job: { status: "succeeded" } },
    });
    mockedExec.mockResolvedValueOnce({ stdout: "/home/coder\n", stderr: "", exitCode: 0 });
    mockGetApplicationAuthRedirect.mockRejectedValueOnce(new Error("application auth failed"));

    const { getWorkspaceSessionToolsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionToolsAction({
      workspaceId: "ws-1",
      sessionName: "git-hive",
      documentFrameHosts: ["https://coder.example.com"],
      tool: "code",
    });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toMatch(/application auth failed/i);
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});
