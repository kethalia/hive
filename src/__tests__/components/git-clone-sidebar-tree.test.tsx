// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GitCloneSidebarTree } from "@/components/git-clone-sidebar-tree";
import type { PublicCloneTree } from "@/lib/git/clone-actions-contract";
import type { CloneTreeRepositoryNode } from "@/lib/git/clone-tree";

const PRIVATE_ROOT = "/home/coder/projects/SUPER_SECRET_TOKEN";

const repositoryNode = {
  id: "git-repository:Git/projects/kethalia/hive",
  kind: "repository",
  label: "hive",
  relativePath: "kethalia/hive",
  relativePathSegments: ["kethalia", "hive"],
  displaySegments: ["Git", "projects", "kethalia", "hive"],
  cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
} as const satisfies CloneTreeRepositoryNode;

function makeCloneTree(overrides: Partial<PublicCloneTree> = {}): PublicCloneTree {
  return {
    root: {
      id: "git-directory:Git/projects",
      label: "Git",
      projectsLabel: "projects",
      displaySegments: ["Git", "projects"],
      path: PRIVATE_ROOT,
    } as PublicCloneTree["root"],
    nodes: [
      {
        id: "git-directory:Git/projects/kethalia",
        kind: "directory",
        label: "kethalia",
        relativePath: "kethalia",
        relativePathSegments: ["kethalia"],
        displaySegments: ["Git", "projects", "kethalia"],
        children: [repositoryNode],
      },
    ],
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

describe("GitCloneSidebarTree", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nested directories and repository buttons with clone metadata", () => {
    render(<GitCloneSidebarTree tree={makeCloneTree()} />);

    const repoButton = screen.getByRole("button", {
      name: "Open Git repository kethalia / hive",
    });

    expect(repoButton).toHaveAttribute(
      "data-clone-session-key",
      "git-clone:Git/projects/kethalia/hive",
    );
    expect(repoButton).toHaveAttribute("data-relative-path", "kethalia/hive");
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("kethalia")).toBeInTheDocument();
  });

  it("passes the sanitized repository node to onRepositorySelect", () => {
    const onRepositorySelect = vi.fn();

    render(<GitCloneSidebarTree tree={makeCloneTree()} onRepositorySelect={onRepositorySelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Git repository kethalia / hive" }));

    expect(onRepositorySelect).toHaveBeenCalledWith(repositoryNode);
  });

  it("renders compact diagnostics for skipped and truncated scans", () => {
    render(
      <GitCloneSidebarTree
        tree={makeCloneTree({
          diagnostics: {
            rootLabel: "Git",
            repoCount: 2,
            directoryCount: 3,
            skippedPaths: [
              { relativePath: "node_modules", reason: "invalid-path" },
              { relativePath: "phlox-labs/platform", reason: "too-deep" },
            ],
            truncated: true,
            durationMs: 44,
          },
        })}
      />,
    );

    const diagnostics = screen.getByRole("group", { name: "Git clone scan diagnostics" });

    expect(diagnostics).toHaveTextContent("Repos 2");
    expect(diagnostics).toHaveTextContent("Directories 3");
    expect(diagnostics).toHaveTextContent("Skipped 2");
    expect(diagnostics).toHaveTextContent("Truncated");
    expect(diagnostics).toHaveTextContent("44ms");
  });

  it("does not render server-only absolute paths", () => {
    render(<GitCloneSidebarTree tree={makeCloneTree()} />);

    expect(document.body).not.toHaveTextContent(PRIVATE_ROOT);
    expect(document.body).not.toHaveTextContent("/home/coder");
    expect(document.body.innerHTML).not.toContain(PRIVATE_ROOT);
  });
});
