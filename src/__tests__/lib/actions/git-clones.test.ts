import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/git/clone-discovery", () => ({
  discoverProjectCloneTree: vi.fn(),
}));

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: vi.fn(),
}));

import { verifyCloneTerminalProof } from "@hive/auth";
import { cookies } from "next/headers";
import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import {
  DEFAULT_PROJECTS_ROOT_PATH,
  PROJECTS_ROOT_ENV_KEY,
  resolveConfiguredProjectsRoot,
} from "@/lib/git/clone-actions-contract";
import { discoverProjectCloneTree } from "@/lib/git/clone-discovery";
import {
  CLONE_TERMINAL_SESSION_PREFIX,
  type CloneTree,
  type CloneTreeNode,
} from "@/lib/git/clone-tree";

const mockedCookies = vi.mocked(cookies);
const mockedGetSession = vi.mocked(getSession);
const mockedDiscoverProjectCloneTree = vi.mocked(discoverProjectCloneTree);
const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);

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
    mockedGetSession.mockResolvedValue(MOCK_SESSION);
  });

  it("returns a sanitized clone tree with diagnostics for an authenticated user", async () => {
    mockedDiscoverProjectCloneTree.mockResolvedValue(makeCloneTree());

    const result = await listGitClonesAction();

    expect(mockedDiscoverProjectCloneTree).toHaveBeenCalledWith(resolve(PRIVATE_ROOT));
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
        durationMs: 12,
      },
      error: null,
    });
    expect(result?.data?.tree?.root).toEqual({
      id: "git-directory:Git/projects",
      label: "Git",
      projectsLabel: "projects",
      displaySegments: ["Git", "projects"],
    });
    expect(result?.data?.tree?.nodes).toEqual([repositoryNode]);
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("distinguishes an empty projects root from scan failures", async () => {
    mockedDiscoverProjectCloneTree.mockResolvedValue(
      makeCloneTree({
        nodes: [],
        diagnostics: {
          rootLabel: "Git",
          repoCount: 0,
          directoryCount: 0,
          skippedPaths: [],
          truncated: false,
          durationMs: 4,
        },
      }),
    );

    const result = await listGitClonesAction();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toMatchObject({
      ok: true,
      status: "empty",
      message: "No Git clones found in the configured projects root.",
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
    mockedDiscoverProjectCloneTree.mockResolvedValue(
      makeCloneTree({
        nodes: [],
        diagnostics: {
          rootLabel: "Git",
          repoCount: 0,
          directoryCount: 0,
          skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
          truncated: false,
          durationMs: 9,
        },
      }),
    );

    const result = await listGitClonesAction();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      ok: false,
      status: "missing-root",
      message:
        "Projects folder is not available. Create or mount the configured projects root, then refresh.",
      tree: null,
      diagnostics: {
        rootLabel: "Git",
        repoCount: 0,
        directoryCount: 0,
        skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
        truncated: false,
        durationMs: 9,
      },
      error: {
        code: "missing-root",
        message:
          "Projects folder is not available. Create or mount the configured projects root, then refresh.",
      },
    });
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("returns a sanitized scan-failed response when the scanner throws", async () => {
    mockedDiscoverProjectCloneTree.mockRejectedValue(
      new Error(`scan exploded at ${PRIVATE_ROOT} with SUPER_SECRET_TOKEN`),
    );

    const result = await listGitClonesAction();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      ok: false,
      status: "scan-failed",
      message: "We couldn't scan projects for Git clones. Refresh and try again.",
      tree: null,
      diagnostics: null,
      error: {
        code: "scan-failed",
        message: "We couldn't scan projects for Git clones. Refresh and try again.",
      },
    });
    expect(JSON.stringify(result?.data)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result?.data)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("requires authentication before invoking the scanner", async () => {
    mockedGetSession.mockResolvedValueOnce(null);

    const result = await listGitClonesAction();

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockedDiscoverProjectCloneTree).not.toHaveBeenCalled();
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
    mockedGetSession.mockResolvedValue(MOCK_SESSION);
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspaceResources: vi.fn().mockResolvedValue([
        {
          id: "resource-1",
          name: "workspace-resource",
          type: "docker_container",
          agents: [{ id: AGENT_ID, name: "main", status: "connected" }],
        },
      ]),
    } as never);
  });

  it("exports projects-root configuration helpers without changing list behavior", () => {
    expect(resolveConfiguredProjectsRoot()).toBe(resolve(PRIVATE_ROOT));

    vi.unstubAllEnvs();

    expect(resolveConfiguredProjectsRoot()).toBe(resolve(DEFAULT_PROJECTS_ROOT_PATH));
  });

  it("revalidates a selected repository and returns only safe route-ready terminal identity", async () => {
    mockedDiscoverProjectCloneTree.mockResolvedValue(
      makeCloneTree({
        nodes: [directoryNode],
      }),
    );

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(mockedGetCoderClientForUser).toHaveBeenCalledWith(MOCK_SESSION.user.id);
    expect(mockedDiscoverProjectCloneTree).toHaveBeenCalledWith(resolve(PRIVATE_ROOT));
    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      sessionName: expect.any(String),
      clonePath: "kethalia/hive",
      cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
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
    mockedDiscoverProjectCloneTree.mockResolvedValue(makeCloneTree());

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
    expect(mockedDiscoverProjectCloneTree).not.toHaveBeenCalled();
  });

  it("returns a sanitized error when the clone proof secret is not configured", async () => {
    vi.stubEnv("COOKIE_SECRET", "");
    mockedDiscoverProjectCloneTree.mockResolvedValue(makeCloneTree());

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
    mockedDiscoverProjectCloneTree.mockResolvedValue(makeCloneTree());

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
    mockedDiscoverProjectCloneTree.mockResolvedValue(makeCloneTree({ nodes: [] }));

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
    mockedDiscoverProjectCloneTree.mockResolvedValue(
      makeCloneTree({
        nodes: [],
        diagnostics: {
          rootLabel: "Git",
          repoCount: 0,
          directoryCount: 0,
          skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
          truncated: false,
          durationMs: 9,
        },
      }),
    );

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "Projects folder is not available. Create or mount the configured projects root, then refresh.",
    );
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ROOT);
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_TOKEN");
  });

  it("returns a generic scan failure when scanner errors contain path secrets", async () => {
    mockedDiscoverProjectCloneTree.mockRejectedValue(
      new Error(`scan exploded at ${PRIVATE_ROOT} with SUPER_SECRET_TOKEN`),
    );

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe(
      "We couldn't scan projects for Git clones. Refresh and try again.",
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
    expect(mockedDiscoverProjectCloneTree).not.toHaveBeenCalled();
  });

  it("requires authentication before resolving or scanning clone terminals", async () => {
    mockedGetSession.mockResolvedValueOnce(null);

    const result = await resolveGitCloneTerminalAction({
      cloneSessionKey: repositoryNode.cloneSessionKey,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      relativePath: repositoryNode.relativePath,
    });

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockedDiscoverProjectCloneTree).not.toHaveBeenCalled();
  });
});

const repositoryNode = {
  id: "git-repository:Git/projects/kethalia/hive",
  kind: "repository",
  label: "hive",
  relativePath: "kethalia/hive",
  relativePathSegments: ["kethalia", "hive"],
  displaySegments: ["Git", "projects", "kethalia", "hive"],
  cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
} satisfies CloneTreeNode;

const directoryNode = {
  id: "git-directory:Git/projects/kethalia",
  kind: "directory",
  label: "kethalia",
  relativePath: "kethalia",
  relativePathSegments: ["kethalia"],
  displaySegments: ["Git", "projects", "kethalia"],
  children: [repositoryNode],
} satisfies CloneTreeNode;

function makeCloneTree(overrides: Partial<CloneTree> = {}): CloneTree {
  return {
    root: {
      id: "git-directory:Git/projects",
      path: PRIVATE_ROOT,
      label: "Git",
      projectsLabel: "projects",
      displaySegments: ["Git", "projects"],
    },
    nodes: [repositoryNode],
    diagnostics: {
      rootLabel: "Git",
      repoCount: 1,
      directoryCount: 1,
      skippedPaths: [],
      truncated: false,
      durationMs: 12,
    },
    ...overrides,
  };
}
