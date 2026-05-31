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

import { cookies } from "next/headers";
import { listGitClonesAction } from "@/lib/actions/git-clones";
import { getSession } from "@/lib/auth/session";
import { discoverProjectCloneTree } from "@/lib/git/clone-discovery";
import type { CloneTree, CloneTreeNode } from "@/lib/git/clone-tree";

const mockedCookies = vi.mocked(cookies);
const mockedGetSession = vi.mocked(getSession);
const mockedDiscoverProjectCloneTree = vi.mocked(discoverProjectCloneTree);

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

describe("listGitClonesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("HIVE_PROJECTS_ROOT", PRIVATE_ROOT);
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

const repositoryNode = {
  id: "git-repository:Git/projects/kethalia/hive",
  kind: "repository",
  label: "hive",
  relativePath: "kethalia/hive",
  relativePathSegments: ["kethalia", "hive"],
  displaySegments: ["Git", "projects", "kethalia", "hive"],
  cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
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
