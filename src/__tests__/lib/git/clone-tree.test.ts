import { describe, expect, it } from "vitest";

import { SAFE_IDENTIFIER_RE } from "../../../lib/constants";
import {
  CLONE_TERMINAL_SESSION_PREFIX,
  CLONE_TREE_PROJECTS_LABEL,
  CLONE_TREE_ROOT_LABEL,
  createCloneSessionKey,
  createCloneTreeDirectoryNode,
  createCloneTreeNodeId,
  createCloneTreeRepositoryNode,
  createCloneTreeRootMetadata,
  createSafeCloneTerminalSessionName,
  deriveCloneDisplaySegments,
  isCloneTerminalSessionName,
  normalizeRootContainedClonePath,
} from "../../../lib/git/clone-tree";

describe("clone-tree contract helpers", () => {
  it("normalizes root-contained clone paths into a safe display hierarchy", () => {
    const normalized = normalizeRootContainedClonePath(
      "/home/coder/projects",
      "/home/coder/projects/kethalia/hive/",
    );

    expect(normalized).toEqual({
      rootPath: "/home/coder/projects",
      absolutePath: "/home/coder/projects/kethalia/hive",
      relativePath: "kethalia/hive",
      relativePathSegments: ["kethalia", "hive"],
      displaySegments: [CLONE_TREE_ROOT_LABEL, CLONE_TREE_PROJECTS_LABEL, "kethalia", "hive"],
    });
  });

  it("normalizes relative clone paths against the configured root", () => {
    const normalized = normalizeRootContainedClonePath(
      "/home/coder/projects",
      "./chillwhales/reef/../reef",
    );

    expect(normalized?.absolutePath).toBe("/home/coder/projects/chillwhales/reef");
    expect(normalized?.relativePath).toBe("chillwhales/reef");
    expect(normalized?.displaySegments).toEqual(["Git", "projects", "chillwhales", "reef"]);
  });

  it("rejects paths outside the configured root, including path-prefix siblings", () => {
    expect(
      normalizeRootContainedClonePath("/home/coder/projects", "/home/coder/other/repo"),
    ).toBeNull();
    expect(
      normalizeRootContainedClonePath("/home/coder/projects", "/home/coder/projects-old/repo"),
    ).toBeNull();
    expect(normalizeRootContainedClonePath("/home/coder/projects", "../secrets/repo")).toBeNull();
    expect(
      normalizeRootContainedClonePath("/home/coder/projects", "/home/coder/projects"),
    ).toBeNull();
  });

  it("derives display segments with Git as the root and projects as the first child", () => {
    expect(deriveCloneDisplaySegments(["phlox-labs", "hive"])).toEqual([
      "Git",
      "projects",
      "phlox-labs",
      "hive",
    ]);

    expect(
      deriveCloneDisplaySegments(["team", "repo"], {
        rootLabel: "Source",
        projectsLabel: "workspace-clones",
      }),
    ).toEqual(["Source", "workspace-clones", "team", "repo"]);
  });

  it("creates stable IDs and clone session keys without embedding absolute paths", () => {
    const displaySegments = ["Git", "projects", "kethalia", "hive"];

    expect(createCloneTreeNodeId("repository", displaySegments)).toBe(
      "git-repository:Git/projects/kethalia/hive",
    );
    expect(createCloneSessionKey(displaySegments)).toBe("git-clone:Git/projects/kethalia/hive");
    expect(createCloneSessionKey(displaySegments)).not.toContain("/home/coder");
  });

  it("URL-encodes hierarchy segments for deterministic IDs and session keys", () => {
    const displaySegments = ["Git", "projects", "org name", "repo#1"];

    expect(createCloneTreeNodeId("directory", displaySegments)).toBe(
      "git-directory:Git/projects/org%20name/repo%231",
    );
    expect(createCloneSessionKey(displaySegments)).toBe(
      "git-clone:Git/projects/org%20name/repo%231",
    );
  });

  it("maps clone session keys to reserved deterministic tmux-safe terminal session names", () => {
    const cloneSessionKey = createCloneSessionKey(["Git", "projects", "org name", "repo#1"]);
    const safeSessionName = createSafeCloneTerminalSessionName(cloneSessionKey);

    expect(safeSessionName).toMatch(SAFE_IDENTIFIER_RE);
    expect(safeSessionName).toMatch(new RegExp(`^${CLONE_TERMINAL_SESSION_PREFIX}`));
    expect(safeSessionName).not.toContain(":");
    expect(safeSessionName).not.toContain("/");
    expect(safeSessionName).not.toContain("/home/coder");
    expect(safeSessionName).toBe(createSafeCloneTerminalSessionName(cloneSessionKey));
    expect(safeSessionName).not.toBe(
      createSafeCloneTerminalSessionName(
        createCloneSessionKey(["Git", "projects", "org name", "other"]),
      ),
    );
    expect(isCloneTerminalSessionName(safeSessionName)).toBe(true);
    expect(isCloneTerminalSessionName("session-123")).toBe(false);
  });

  it("builds root metadata and typed directory/repository nodes from normalized paths", () => {
    const root = createCloneTreeRootMetadata("/home/coder/projects/");
    const normalized = normalizeRootContainedClonePath(
      "/home/coder/projects",
      "/home/coder/projects/kethalia/hive",
    );

    expect(root).toEqual({
      id: "git-directory:Git/projects",
      path: "/home/coder/projects",
      label: "Git",
      projectsLabel: "projects",
      displaySegments: ["Git", "projects"],
    });
    expect(normalized).not.toBeNull();

    const repo = createCloneTreeRepositoryNode(normalized!);
    const directory = createCloneTreeDirectoryNode(normalized!, [repo]);

    expect(repo).toMatchObject({
      id: "git-repository:Git/projects/kethalia/hive",
      kind: "repository",
      label: "hive",
      relativePath: "kethalia/hive",
      cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
    });
    expect(directory).toMatchObject({
      id: "git-directory:Git/projects/kethalia/hive",
      kind: "directory",
      label: "hive",
      children: [repo],
    });
  });
});
