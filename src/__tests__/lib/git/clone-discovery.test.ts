import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverProjectCloneTree } from "../../../lib/git/clone-discovery";
import type { CloneTreeNode, CloneTreeRepositoryNode } from "../../../lib/git/clone-tree";

describe("discoverProjectCloneTree", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clone-discovery-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("discovers Git clones into the Git -> home hierarchy without reading file contents", async () => {
    await makeGitRepository(tempDir, "kethalia/hive");
    await makeGitRepository(tempDir, "chillwhales/reef", "file");
    await makeGitRepository(tempDir, "phlox-labs/platform/orchard");
    await mkdir(join(tempDir, "kethalia", "scratch"), { recursive: true });
    await writeFile(
      join(tempDir, "kethalia", "hive", "README.md"),
      "SUPER_SECRET_TOKEN=do-not-leak",
    );

    const result = await discoverProjectCloneTree(tempDir, { now: fixedDurationNow(37) });

    expect(result.root).toMatchObject({
      label: "Git",
      projectsLabel: "home",
      displaySegments: ["Git", "home"],
    });
    expect(result.diagnostics).toEqual({
      rootLabel: "Git",
      repoCount: 3,
      directoryCount: 4,
      skippedPaths: [],
      truncated: false,
      durationMs: 37,
    });
    expect(result.nodes.map((node) => `${node.kind}:${node.relativePath}`)).toEqual([
      "directory:chillwhales",
      "directory:kethalia",
      "directory:phlox-labs",
    ]);

    expect(
      collectRepositories(result.nodes).map((repo) => ({
        id: repo.id,
        relativePath: repo.relativePath,
        displaySegments: repo.displaySegments,
        cloneSessionKey: repo.cloneSessionKey,
      })),
    ).toEqual([
      {
        id: "git-repository:Git/home/chillwhales/reef",
        relativePath: "chillwhales/reef",
        displaySegments: ["Git", "home", "chillwhales", "reef"],
        cloneSessionKey: "git-clone:chillwhales/reef",
      },
      {
        id: "git-repository:Git/home/kethalia/hive",
        relativePath: "kethalia/hive",
        displaySegments: ["Git", "home", "kethalia", "hive"],
        cloneSessionKey: "git-clone:kethalia/hive",
      },
      {
        id: "git-repository:Git/home/phlox-labs/platform/orchard",
        relativePath: "phlox-labs/platform/orchard",
        displaySegments: ["Git", "home", "phlox-labs", "platform", "orchard"],
        cloneSessionKey: "git-clone:phlox-labs/platform/orchard",
      },
    ]);
    expect(JSON.stringify(result.nodes)).not.toContain(tempDir);
    expect(JSON.stringify(result.diagnostics)).not.toContain(tempDir);
    expect(JSON.stringify(result.nodes)).not.toContain("SUPER_SECRET_TOKEN");
    expect(JSON.stringify(result.diagnostics)).not.toContain("SUPER_SECRET_TOKEN");
    expect(JSON.stringify(result.nodes)).not.toContain("scratch");
  });

  it("returns an empty tree and diagnostics when there are no repositories", async () => {
    await mkdir(join(tempDir, "kethalia", "scratch"), { recursive: true });
    await mkdir(join(tempDir, "chillwhales", "notes"), { recursive: true });

    const result = await discoverProjectCloneTree(tempDir, { now: fixedDurationNow(4) });

    expect(result.nodes).toEqual([]);
    expect(result.diagnostics).toEqual({
      rootLabel: "Git",
      repoCount: 0,
      directoryCount: 0,
      skippedPaths: [],
      truncated: false,
      durationMs: 4,
    });
  });

  it("skips noisy directories and symlinks without following them", async () => {
    await makeGitRepository(tempDir, "kethalia/hive");
    await makeGitRepository(tempDir, "node_modules/leaky-repo");
    await makeGitRepository(tempDir, ".ssh/private-repo");
    await makeGitRepository(tempDir, ".hidden-worktrees/internal-repo");
    await makeGitRepository(tempDir, "chillwhales/build/output-repo");
    await mkdir(join(tempDir, "phlox-labs"), { recursive: true });

    let symlinkCreated = false;
    try {
      await symlink(tempDir, join(tempDir, "phlox-labs", "loop"), "dir");
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    const result = await discoverProjectCloneTree(tempDir);

    expect(collectRepositories(result.nodes).map((repo) => repo.relativePath)).toEqual([
      "kethalia/hive",
    ]);
    expect(result.diagnostics.repoCount).toBe(1);
    expect(result.diagnostics.truncated).toBe(false);
    expect(result.diagnostics.skippedPaths).toEqual(
      expect.arrayContaining([
        { relativePath: ".hidden-worktrees", reason: "invalid-path" },
        { relativePath: ".ssh", reason: "invalid-path" },
        { relativePath: "chillwhales/build", reason: "invalid-path" },
        { relativePath: "node_modules", reason: "invalid-path" },
      ]),
    );

    if (symlinkCreated) {
      expect(result.diagnostics.skippedPaths).toEqual(
        expect.arrayContaining([{ relativePath: "phlox-labs/loop", reason: "invalid-path" }]),
      );
    }
  });

  it("enforces max depth and marks the scan as truncated", async () => {
    await makeGitRepository(tempDir, "kethalia/platform/hive");

    const result = await discoverProjectCloneTree(tempDir, { maxDepth: 2 });

    expect(result.nodes).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      repoCount: 0,
      directoryCount: 0,
      truncated: true,
    });
    expect(result.diagnostics.skippedPaths).toEqual([
      { relativePath: "kethalia/platform", reason: "too-deep" },
    ]);
  });

  it("enforces max repository count and returns the deterministic prefix of the scan", async () => {
    await makeGitRepository(tempDir, "kethalia/hive");
    await makeGitRepository(tempDir, "chillwhales/reef");
    await makeGitRepository(tempDir, "phlox-labs/orchard");

    const result = await discoverProjectCloneTree(tempDir, { maxRepositories: 2 });

    expect(collectRepositories(result.nodes).map((repo) => repo.relativePath)).toEqual([
      "chillwhales/reef",
      "kethalia/hive",
    ]);
    expect(result.diagnostics).toMatchObject({
      repoCount: 2,
      directoryCount: 2,
      truncated: true,
    });
  });

  it("returns a safe skipped-path diagnostic when the configured root is unavailable", async () => {
    const result = await discoverProjectCloneTree(join(tempDir, "missing"), {
      now: fixedDurationNow(9),
    });

    expect(result.nodes).toEqual([]);
    expect(result.diagnostics).toEqual({
      rootLabel: "Git",
      repoCount: 0,
      directoryCount: 0,
      skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
      truncated: false,
      durationMs: 9,
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain(tempDir);
  });
});

async function makeGitRepository(
  rootPath: string,
  relativePath: string,
  metadataKind: "directory" | "file" = "directory",
): Promise<void> {
  const repositoryPath = join(rootPath, ...relativePath.split("/"));
  await mkdir(repositoryPath, { recursive: true });

  if (metadataKind === "file") {
    await writeFile(join(repositoryPath, ".git"), "gitdir: ../.git/worktrees/repository\n");
    return;
  }

  await mkdir(join(repositoryPath, ".git"), { recursive: true });
}

function collectRepositories(nodes: readonly CloneTreeNode[]): CloneTreeRepositoryNode[] {
  const repositories: CloneTreeRepositoryNode[] = [];

  for (const node of nodes) {
    if (node.kind === "repository") {
      repositories.push(node);
    } else {
      repositories.push(...collectRepositories(node.children));
    }
  }

  return repositories;
}

function fixedDurationNow(durationMs: number): () => number {
  let callCount = 0;

  return () => {
    callCount += 1;
    return callCount === 1 ? 1_000 : 1_000 + durationMs;
  };
}
