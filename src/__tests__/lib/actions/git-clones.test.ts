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

import { verifyCloneTerminalProof } from "@hive/auth";
import { cookies } from "next/headers";
import {
  closeGitCloneTerminalAction,
  listGitClonesAction,
  resolveGitCloneTerminalAction,
} from "@/lib/actions/git-clones";
import { getRequestSession, getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import {
  DEFAULT_PROJECTS_ROOT_PATH,
  PROJECTS_ROOT_ENV_KEY,
  resolveConfiguredProjectsRoot,
} from "@/lib/git/clone-actions-contract";
import { CLONE_TERMINAL_SESSION_PREFIX, type CloneTreeNode } from "@/lib/git/clone-tree";
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
const OTHER_AGENT_ID = "e5f6a7b8-c9d0-1234-ef12-345678901234";
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

describe("listGitClonesAction", () => {
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

  it("returns a sanitized clone tree with diagnostics for an authenticated user", async () => {
    const result = await listGitClonesAction({ workspaceId: WORKSPACE_ID });

    expect(mockedGetCoderClientForUser).toHaveBeenCalledWith(MOCK_SESSION.user.id);
    expect(mockedExecInWorkspace).toHaveBeenCalledWith(
      AGENT_TARGET,
      expect.stringContaining(PRIVATE_ROOT),
      expect.objectContaining({
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-token",
      }),
    );
    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toMatchObject({
      ok: true,
      status: "success",
      message: "Git clones discovered.",
      diagnostics: {
        rootLabel: "Git",
        repoCount: 1,
        directoryCount: 1,
        skippedPaths: [],
        truncated: false,
        durationMs: expect.any(Number),
      },
      error: null,
    });
    expect(result?.data?.tree?.root).toEqual({
      id: "git-directory:Git/home",
      label: "Git",
      projectsLabel: "home",
      displaySegments: ["Git", "home"],
    });
    expect(result?.data?.tree?.nodes).toEqual([directoryNode]);
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("distinguishes an empty home root from scan failures", async () => {
    mockedExecInWorkspace.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await listGitClonesAction({ workspaceId: WORKSPACE_ID });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toMatchObject({
      ok: true,
      status: "empty",
      message: "No Git clones found under the configured home root.",
      tree: {
        nodes: [],
      },
      diagnostics: {
        repoCount: 0,
        skippedPaths: [],
      },
      error: null,
    });
  });

  it("returns a safe missing-root response when the configured root is unavailable", async () => {
    mockedExecInWorkspace.mockResolvedValue({
      stdout: "__HIVE_PROJECTS_ROOT_MISSING__\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await listGitClonesAction({ workspaceId: WORKSPACE_ID });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      ok: false,
      status: "missing-root",
      message: "Configured home folder is not available. Mount the home root, then refresh.",
      tree: null,
      diagnostics: {
        rootLabel: "Git",
        repoCount: 0,
        directoryCount: 0,
        skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
        truncated: false,
        durationMs: expect.any(Number),
      },
      error: {
        code: "missing-root",
        message: "Configured home folder is not available. Mount the home root, then refresh.",
      },
    });
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("returns a sanitized scan-failed response when the workspace scan fails", async () => {
    mockedExecInWorkspace.mockResolvedValue({
      stdout: "",
      stderr: `scan exploded at ${PRIVATE_ROOT} with SUPER_SECRET_TOKEN`,
      exitCode: 1,
    });

    const result = await listGitClonesAction({ workspaceId: WORKSPACE_ID });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      ok: false,
      status: "scan-failed",
      message: "We couldn't scan the home folder for Git clones. Refresh and try again.",
      tree: null,
      diagnostics: null,
      error: {
        code: "scan-failed",
        message: "We couldn't scan the home folder for Git clones. Refresh and try again.",
      },
    });
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("returns a sanitized scan-failed response without scanning when the configured root is relative", async () => {
    vi.stubEnv(PROJECTS_ROOT_ENV_KEY, "relative/projects");

    const result = await listGitClonesAction({ workspaceId: WORKSPACE_ID });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      ok: false,
      status: "scan-failed",
      message: "We couldn't scan the home folder for Git clones. Refresh and try again.",
      tree: null,
      diagnostics: null,
      error: {
        code: "scan-failed",
        message: "We couldn't scan the home folder for Git clones. Refresh and try again.",
      },
    });
    expect(mockedExecInWorkspace).not.toHaveBeenCalled();
  });

  it("requires authentication before invoking the scanner", async () => {
    mockedGetRequestSession.mockResolvedValueOnce(null);
    mockedGetSession.mockResolvedValueOnce(null);

    const result = await listGitClonesAction({ workspaceId: WORKSPACE_ID });

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockedExecInWorkspace).not.toHaveBeenCalled();
  });
});

describe("resolveGitCloneTerminalAction", () => {
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

  it("exports home-root configuration helpers without changing list behavior", () => {
    expect(resolveConfiguredProjectsRoot()).toBe(PRIVATE_ROOT);

    vi.stubEnv(PROJECTS_ROOT_ENV_KEY, "/tmp/private-projects/../repos/");
    expect(resolveConfiguredProjectsRoot()).toBe("/tmp/repos");

    vi.stubEnv(PROJECTS_ROOT_ENV_KEY, "relative/repos");
    expect(() => resolveConfiguredProjectsRoot()).toThrow(
      `${PROJECTS_ROOT_ENV_KEY} must be an absolute POSIX path`,
    );

    vi.unstubAllEnvs();
    expect(resolveConfiguredProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT_PATH);
  });

  it("revalidates a selected repository inside the workspace and returns only safe route-ready terminal identity", async () => {
    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(mockedGetCoderClientForUser).toHaveBeenCalledWith(MOCK_SESSION.user.id);
    expect(mockedExecInWorkspace).toHaveBeenCalledWith(
      AGENT_TARGET,
      expect.stringContaining(PRIVATE_ROOT),
      expect.objectContaining({
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-token",
      }),
    );
    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      sessionName: expect.any(String),
      clonePath: "kethalia/hive",
      cloneSessionKey: "git-clone:kethalia/hive",
      cloneProof: expect.any(String),
    });
    expect(result?.data?.sessionName).toMatch(SAFE_IDENTIFIER_RE);
    expect(result?.data?.sessionName).toMatch(new RegExp(`^${CLONE_TERMINAL_SESSION_PREFIX}`));
    expect(result?.data?.sessionName).not.toContain(":");
    expect(result?.data?.sessionName).not.toContain("/");
    expect(
      verifyCloneTerminalProof(
        result?.data?.cloneProof,
        {
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          sessionId: MOCK_SESSION.session.sessionId,
          sessionName: result?.data?.sessionName ?? "",
          clonePath: "kethalia/hive",
        },
        COOKIE_SECRET,
      ),
    ).toMatchObject({ ok: true });
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("refuses to mint a proof for an agent that is not in the authenticated user's workspace resources", async () => {
    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: OTHER_AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "We couldn't verify that workspace terminal. Refresh and try again.",
    );
    expect(mockedGetCoderClientForUser).toHaveBeenCalledWith(MOCK_SESSION.user.id);
    expect(mockedExecInWorkspace).not.toHaveBeenCalled();
  });

  it("closes a verified reserved clone terminal session without exposing generic kill controls", async () => {
    const result = await closeGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data?.sessionName).toMatch(new RegExp(`^${CLONE_TERMINAL_SESSION_PREFIX}`));
    expect(mockedExecInWorkspace).toHaveBeenCalledTimes(2);
    expect(mockedExecInWorkspace).toHaveBeenLastCalledWith(
      AGENT_TARGET,
      expect.stringMatching(/tmux -L web kill-session -t 'git-clone-[a-f0-9]+'/),
      expect.objectContaining({
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-token",
      }),
    );
  });

  it("treats an already-closed clone terminal as an idempotent close", async () => {
    mockedExecInWorkspace
      .mockResolvedValueOnce({ stdout: "kethalia/hive\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "can't find session", exitCode: 1 });

    const result = await closeGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data?.sessionName).toMatch(new RegExp(`^${CLONE_TERMINAL_SESSION_PREFIX}`));
  });

  it("returns a sanitized error when the clone proof secret is not configured", async () => {
    vi.stubEnv("COOKIE_SECRET", "");

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "We couldn't prepare a secure Git terminal. Refresh and try again.",
    );
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain(
      "cloneProof_secret_missing",
    );
  });

  it("refuses stale or tampered selections that do not match both key and path", async () => {
    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: "kethalia/other",
    });

    expect(result?.serverError).toBe(
      "We couldn't verify that Git repository. Refresh and try again.",
    );
    expect(result?.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("refuses missing repositories after scanner revalidation", async () => {
    mockedExecInWorkspace.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "We couldn't verify that Git repository. Refresh and try again.",
    );
    expect(result?.data).toBeUndefined();
  });

  it("returns a sanitized unavailable error when the configured root is missing", async () => {
    mockedExecInWorkspace.mockResolvedValue({
      stdout: "__HIVE_PROJECTS_ROOT_MISSING__\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "Configured home folder is not available. Mount the home root, then refresh.",
    );
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("returns a generic scan failure when workspace scan errors contain path secrets", async () => {
    mockedExecInWorkspace.mockResolvedValue({
      stdout: "",
      stderr: `scan exploded at ${PRIVATE_ROOT} with SUPER_SECRET_TOKEN`,
      exitCode: 1,
    });

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "We couldn't scan the home folder for Git clones. Refresh and try again.",
    );
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_TOKEN");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("rejects malformed or traversal-like input before invoking the scanner", async () => {
    const emptyResult = await resolveGitCloneTerminalAction({
      cloneSessionKey: "",
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });
    const traversalResult = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: "../secrets/repo",
    });

    expect(emptyResult?.validationErrors).toBeDefined();
    expect(traversalResult?.validationErrors).toBeDefined();
    expect(mockedExecInWorkspace).not.toHaveBeenCalled();
  });

  it("requires authentication before resolving or scanning clone terminals", async () => {
    mockedGetRequestSession.mockResolvedValueOnce(null);
    mockedGetSession.mockResolvedValueOnce(null);

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockedExecInWorkspace).not.toHaveBeenCalled();
  });
});

const repositoryNode = {
  id: "git-repository:Git/home/kethalia/hive",
  kind: "repository",
  label: "hive",
  relativePath: "kethalia/hive",
  relativePathSegments: ["kethalia", "hive"],
  displaySegments: ["Git", "home", "kethalia", "hive"],
  cloneSessionKey: "git-clone:kethalia/hive",
} satisfies CloneTreeNode;

const directoryNode = {
  id: "git-directory:Git/home/kethalia",
  kind: "directory",
  label: "kethalia",
  relativePath: "kethalia",
  relativePathSegments: ["kethalia"],
  displaySegments: ["Git", "home", "kethalia"],
  children: [repositoryNode],
} satisfies CloneTreeNode;
