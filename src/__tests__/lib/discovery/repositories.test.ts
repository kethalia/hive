import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: vi.fn(),
}));

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

import { cookies } from "next/headers";
import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { getRequestSession, getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { PROJECTS_ROOT_ENV_KEY } from "@/lib/git/clone-actions-contract";
import { execInWorkspace } from "@/lib/workspace/exec";

const mockedCookies = vi.mocked(cookies);
const mockedGetRequestSession = vi.mocked(getRequestSession);
const mockedGetSession = vi.mocked(getSession);
const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
const mockedExecInWorkspace = vi.mocked(execInWorkspace);

const MOCK_SESSION = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "coder-user-123",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "session-row-123",
    sessionId: "session-cookie-123",
    expiresAt: new Date(Date.now() + 86_400_000),
  },
};

const PRIVATE_ROOT = "/tmp/private-projects/SUPER_SECRET_TOKEN";
const WORKSPACE_ID = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const AGENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const _OTHER_AGENT_ID = "e5f6a7b8-c9d0-1234-ef12-345678901234";
const COOKIE_SECRET = "test-cookie-secret";
const WORKSPACE_NAME = "dev-box";
const AGENT_NAME = "main";
const AGENT_TARGET = `${WORKSPACE_NAME}.${AGENT_NAME}`;

function makeCoderClient() {
  return {
    getBaseUrl: vi.fn(() => "https://coder.example.com"),
    getSessionToken: vi.fn(() => "coder-token"),
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: WORKSPACE_NAME,
          latest_build: { id: "build-1", status: "running" },
        },
      ],
    }),
    getWorkspace: vi.fn().mockResolvedValue({
      id: WORKSPACE_ID,
      name: WORKSPACE_NAME,
      latest_build: { id: "build-1", status: "running" },
    }),
    getWorkspaceAgentName: vi.fn().mockResolvedValue(AGENT_TARGET),
    getWorkspaceResources: vi.fn().mockResolvedValue([
      {
        id: "resource-1",
        name: "workspace-resource",
        type: "docker_container",
        agents: [{ id: AGENT_ID, name: AGENT_NAME, status: "connected" }],
      },
    ]),
  };
}

describe("cached repository discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv(PROJECTS_ROOT_ENV_KEY, PRIVATE_ROOT);
    vi.stubEnv("COOKIE_SECRET", COOKIE_SECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockedCookies.mockResolvedValue({
      get: () => ({ value: "session-cookie-value" }),
    } as never);
    mockedGetRequestSession.mockResolvedValue(MOCK_SESSION);
    mockedGetSession.mockResolvedValue(MOCK_SESSION);
    mockedGetCoderClientForUser.mockResolvedValue(makeCoderClient() as never);
    mockedExecInWorkspace.mockResolvedValue({
      stdout: "kethalia/hive\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("reuses scans, authorizes each read, refreshes on builds, and never caches terminal proofs", async () => {
    const client = makeCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(client as never);
    const first = await listGitClonesAction({ workspaceId: WORKSPACE_ID });
    expect(first?.data?.ok).toBe(true);
    await listGitClonesAction({ workspaceId: WORKSPACE_ID });
    expect(mockedExecInWorkspace).toHaveBeenCalledTimes(1);
    expect(client.getWorkspace).toHaveBeenCalledTimes(2);
    client.getWorkspace.mockRejectedValueOnce(new Error("[coder] Request failed: 403 Forbidden"));
    const denied = await listGitClonesAction({ workspaceId: WORKSPACE_ID });
    expect(denied?.data).toBeUndefined();
    expect(denied?.serverError).toContain("403");
    await listGitClonesAction({ workspaceId: WORKSPACE_ID, refresh: true });
    expect(mockedExecInWorkspace).toHaveBeenCalledTimes(2);
    await resolveGitCloneTerminalAction({
      workspaceId: WORKSPACE_ID,
      cloneSessionKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
    });
    expect(mockedExecInWorkspace).toHaveBeenCalledTimes(3);
    client.getWorkspace.mockResolvedValue({
      id: WORKSPACE_ID,
      name: WORKSPACE_NAME,
      latest_build: { id: "build-2", status: "running" },
    });
    await listGitClonesAction({ workspaceId: WORKSPACE_ID });
    expect(mockedExecInWorkspace).toHaveBeenCalledTimes(4);
  });
});
