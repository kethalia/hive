"use server";

import { resolve } from "node:path";
import { discoverProjectCloneTree } from "@/lib/git/clone-discovery";
import type {
  CloneTree,
  CloneTreeDiagnostics,
  CloneTreeSkippedPathReason,
} from "@/lib/git/clone-tree";
import { authActionClient } from "@/lib/safe-action";

const PROJECTS_ROOT_ENV_KEY = "HIVE_PROJECTS_ROOT";
const DEFAULT_PROJECTS_ROOT_PATH = "/home/coder/projects";

const SUCCESS_MESSAGE = "Git clones discovered.";
const EMPTY_MESSAGE = "No Git clones found in the configured projects root.";
const MISSING_ROOT_MESSAGE =
  "Projects folder is not available. Create or mount the configured projects root, then refresh.";
const SCAN_FAILED_MESSAGE = "We couldn't scan projects for Git clones. Refresh and try again.";

export type PublicCloneTree = Omit<CloneTree, "root"> & {
  root: Omit<CloneTree["root"], "path">;
};

export type GitCloneDiscoveryErrorCode = "missing-root" | "scan-failed";
export type GitCloneDiscoveryStatus = "success" | "empty" | GitCloneDiscoveryErrorCode;

export type GitCloneDiscoveryActionResult =
  | {
      ok: true;
      status: "success" | "empty";
      message: string;
      tree: PublicCloneTree;
      diagnostics: CloneTreeDiagnostics;
      error: null;
    }
  | {
      ok: false;
      status: GitCloneDiscoveryErrorCode;
      message: string;
      tree: null;
      diagnostics: CloneTreeDiagnostics | null;
      error: {
        code: GitCloneDiscoveryErrorCode;
        message: string;
      };
    };

export const listGitClonesAction = authActionClient.action(
  async (): Promise<GitCloneDiscoveryActionResult> => {
    const projectsRootPath = resolveConfiguredProjectsRoot();

    try {
      const tree = await discoverProjectCloneTree(projectsRootPath);
      const publicTree = toPublicCloneTree(tree);
      const rootSkippedReason = getRootSkippedReason(tree.diagnostics);

      if (rootSkippedReason === "not-directory") {
        logDiscoveryOutcome("missing-root", tree.diagnostics);
        return createErrorResult("missing-root", MISSING_ROOT_MESSAGE, tree.diagnostics);
      }

      if (rootSkippedReason) {
        logDiscoveryOutcome("scan-failed", tree.diagnostics);
        return createErrorResult("scan-failed", SCAN_FAILED_MESSAGE, tree.diagnostics);
      }

      if (tree.diagnostics.repoCount === 0) {
        logDiscoveryOutcome("empty", tree.diagnostics);
        return {
          ok: true,
          status: "empty",
          message: EMPTY_MESSAGE,
          tree: publicTree,
          diagnostics: publicTree.diagnostics,
          error: null,
        };
      }

      logDiscoveryOutcome("success", tree.diagnostics);
      return {
        ok: true,
        status: "success",
        message: SUCCESS_MESSAGE,
        tree: publicTree,
        diagnostics: publicTree.diagnostics,
        error: null,
      };
    } catch (error) {
      console.error(`[git-clones] Discovery scan failed (${describeErrorForLogs(error)})`);
      return createErrorResult("scan-failed", SCAN_FAILED_MESSAGE, null);
    }
  },
);

function resolveConfiguredProjectsRoot(): string {
  const configuredRoot = process.env[PROJECTS_ROOT_ENV_KEY]?.trim();
  return resolve(configuredRoot || DEFAULT_PROJECTS_ROOT_PATH);
}

function toPublicCloneTree(tree: CloneTree): PublicCloneTree {
  const { path: _path, ...publicRoot } = tree.root;

  return {
    root: publicRoot,
    nodes: tree.nodes,
    diagnostics: tree.diagnostics,
  };
}

function getRootSkippedReason(
  diagnostics: CloneTreeDiagnostics,
): CloneTreeSkippedPathReason | undefined {
  return diagnostics.skippedPaths.find((skippedPath) => skippedPath.relativePath === ".")?.reason;
}

function createErrorResult(
  code: GitCloneDiscoveryErrorCode,
  message: string,
  diagnostics: CloneTreeDiagnostics | null,
): GitCloneDiscoveryActionResult {
  return {
    ok: false,
    status: code,
    message,
    tree: null,
    diagnostics,
    error: {
      code,
      message,
    },
  };
}

function logDiscoveryOutcome(
  status: GitCloneDiscoveryStatus,
  diagnostics: CloneTreeDiagnostics,
): void {
  const level = status === "scan-failed" ? console.error : console.log;
  level(
    `[git-clones] Discovery ${status}: repos=${diagnostics.repoCount} directories=${diagnostics.directoryCount} skipped=${diagnostics.skippedPaths.length} truncated=${diagnostics.truncated} durationMs=${diagnostics.durationMs}`,
  );
}

function describeErrorForLogs(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
