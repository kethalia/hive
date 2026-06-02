// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GitCloneSidebarTree } from "@/components/git-clone-sidebar-tree";
import type { PublicCloneTree } from "@/lib/git/clone-actions-contract";
import type { CloneTreeRepositoryNode } from "@/lib/git/clone-tree";

const PRIVATE_ROOT = "/home/coder/SUPER_SECRET_TOKEN";

const repositoryNode = makeRepositoryNode("kethalia", "hive");

function makeRepositoryNode(org: string, repo: string): CloneTreeRepositoryNode {
  return {
    id: `git-repository:Git/home/${org}/${repo}`,
    kind: "repository",
    label: repo,
    relativePath: `${org}/${repo}`,
    relativePathSegments: [org, repo],
    displaySegments: ["Git", "home", org, repo],
    cloneSessionKey: `git-clone:${org}/${repo}`,
  };
}

function makeCloneTree(overrides: Partial<PublicCloneTree> = {}): PublicCloneTree {
  return {
    root: {
      id: "git-directory:Git/home",
      label: "Git",
      projectsLabel: "home",
      displaySegments: ["Git", "home"],
    },
    nodes: [makeDirectoryNode("kethalia", [repositoryNode])],
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

function makeDeepMultiBranchCloneTree(): PublicCloneTree {
  return makeCloneTree({
    nodes: [
      makeDirectoryNode("kethalia", [
        repositoryNode,
        makeRepositoryNode("kethalia", "sidecar"),
      ]),
      makeDirectoryNode("phlox-labs", [makeRepositoryNode("phlox-labs", "platform")]),
    ],
    diagnostics: {
      rootLabel: "Git",
      repoCount: 3,
      directoryCount: 2,
      skippedPaths: [],
      truncated: false,
      durationMs: 18,
    },
  });
}

function makeDirectoryNode(
  org: string,
  children: PublicCloneTree["nodes"],
): Extract<PublicCloneTree["nodes"][number], { kind: "directory" }> {
  return {
    id: `git-directory:Git/home/${org}`,
    kind: "directory",
    label: org,
    relativePath: org,
    relativePathSegments: [org],
    displaySegments: ["Git", "home", org],
    children,
  };
}

describe("GitCloneSidebarTree", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps repository buttons hidden until their directory branch is opened", () => {
    render(<GitCloneSidebarTree tree={makeDeepMultiBranchCloneTree()} />);

    expect(screen.getByText("home")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Git folder kethalia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Git folder phlox-labs" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Git repository kethalia / hive" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Git repository kethalia / sidecar" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Git repository phlox-labs / platform" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Git folder kethalia" }));

    const repoButton = screen.getByRole("button", {
      name: "Open Git repository kethalia / hive",
    });
    expect(repoButton).toHaveAttribute("data-clone-session-key", "git-clone:kethalia/hive");
    expect(repoButton).toHaveAttribute("data-relative-path", "kethalia/hive");
    expect(
      screen.getByRole("button", { name: "Open Git repository kethalia / sidecar" }),
    ).toHaveAttribute("data-clone-session-key", "git-clone:kethalia/sidecar");
    expect(
      screen.queryByRole("button", { name: "Open Git repository phlox-labs / platform" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Git folder phlox-labs" }));

    expect(
      screen.getByRole("button", { name: "Open Git repository phlox-labs / platform" }),
    ).toHaveAttribute("data-clone-session-key", "git-clone:phlox-labs/platform");
  });

  it("passes the sanitized repository node to onRepositorySelect", () => {
    const onRepositorySelect = vi.fn();

    render(<GitCloneSidebarTree tree={makeCloneTree()} onRepositorySelect={onRepositorySelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Git folder kethalia" }));
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
