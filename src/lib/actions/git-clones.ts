"use server";

import { createCloneTerminalProof } from "@hive/auth";
import { z } from "zod";
import {
  type GitCloneDiscoveryActionResult,
  type GitCloneDiscoveryErrorCode,
  type GitCloneDiscoveryStatus,
  type GitCloneTerminalIdentity,
  type PublicCloneTree,
  resolveConfiguredProjectsRoot,
} from "@/lib/git/clone-actions-contract";
import { discoverProjectCloneTree } from "@/lib/git/clone-discovery";
import {
  type CloneTree,
  type CloneTreeDiagnostics,
  type CloneTreeNode,
  type CloneTreeRepositoryNode,
  type CloneTreeSkippedPathReason,
  createSafeCloneTerminalSessionName,
} from "@/lib/git/clone-tree";
import { authActionClient } from "@/lib/safe-action";

const SUCCESS_MESSAGE = "Git clones discovered.";
const EMPTY_MESSAGE = "No Git clones found in the configured projects root.";
const MISSING_ROOT_MESSAGE =
  "Projects folder is not available. Create or mount the configured projects root, then refresh.";
const SCAN_FAILED_MESSAGE = "We couldn't scan projects for Git clones. Refresh and try again.";
const INVALID_SELECTION_MESSAGE = "We couldn't verify that Git repository. Refresh and try again.";
const TERMINAL_PROOF_UNAVAILABLE_MESSAGE =
  "We couldn't prepare a secure Git terminal. Refresh and try again.";

type GitCloneTerminalResolveStatus =
  | "success"
  | "missing-root"
  | "scan-failed"
  | "invalid-selection";

const resolveGitCloneTerminalSchema = z
  .object({
    cloneSessionKey: z
      .string()
      .trim()
      .min(1, "cloneSessionKey is required")
      .refine(isExpectedCloneSessionKey, "cloneSessionKey is invalid"),
    workspaceId: z.string().trim().min(1, "workspaceId is required"),
    agentId: z.string().trim().min(1, "agentId is required").optional(),
    relativePath: z
      .string()
      .trim()
      .min(1, "relativePath is required")
      .refine(isSafeCloneRelativePath, "relativePath must be a root-relative clone path"),
  })
  .strict();

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

export const resolveGitCloneTerminalAction = authActionClient
  .inputSchema(resolveGitCloneTerminalSchema)
  .action(async ({ parsedInput }): Promise<GitCloneTerminalIdentity> => {
    const projectsRootPath = resolveConfiguredProjectsRoot();
    let tree: CloneTree;

    try {
      tree = await discoverProjectCloneTree(projectsRootPath);
    } catch (error) {
      console.error(
        `[git-clones] Terminal resolution scan failed (${describeErrorForLogs(error)})`,
      );
      throw new Error(SCAN_FAILED_MESSAGE);
    }

    const rootSkippedReason = getRootSkippedReason(tree.diagnostics);
    if (rootSkippedReason === "not-directory") {
      logTerminalResolveOutcome("missing-root", tree.diagnostics);
      throw new Error(MISSING_ROOT_MESSAGE);
    }

    if (rootSkippedReason) {
      logTerminalResolveOutcome("scan-failed", tree.diagnostics);
      throw new Error(SCAN_FAILED_MESSAGE);
    }

    const repository = findRepositoryNode(
      tree.nodes,
      parsedInput.cloneSessionKey,
      parsedInput.relativePath,
    );

    if (!repository) {
      logTerminalResolveOutcome("invalid-selection", tree.diagnostics);
      throw new Error(INVALID_SELECTION_MESSAGE);
    }

    const sessionName = createSafeCloneTerminalSessionName(repository.cloneSessionKey);
    const cloneProof = createCloneTerminalProof(
      {
        workspaceId: parsedInput.workspaceId,
        agentId: parsedInput.agentId ?? null,
        sessionName,
        clonePath: repository.relativePath,
      },
      getCloneTerminalProofSecret(),
    );

    logTerminalResolveOutcome("success", tree.diagnostics);
    return {
      sessionName,
      clonePath: repository.relativePath,
      cloneSessionKey: repository.cloneSessionKey,
      cloneProof,
    };
  });

function getCloneTerminalProofSecret(): string {
  const secret = process.env.COOKIE_SECRET?.trim();
  if (!secret) {
    console.error("[git-clones] Terminal proof mint failed: cloneProof_secret_missing");
    throw new Error(TERMINAL_PROOF_UNAVAILABLE_MESSAGE);
  }
  return secret;
}

function toPublicCloneTree(tree: CloneTree): PublicCloneTree {
  const { path: _path, ...publicRoot } = tree.root;

  return {
    root: publicRoot,
    nodes: tree.nodes,
    diagnostics: tree.diagnostics,
  };
}

function findRepositoryNode(
  nodes: readonly CloneTreeNode[],
  cloneSessionKey: string,
  relativePath: string,
): CloneTreeRepositoryNode | null {
  for (const node of nodes) {
    if (node.kind === "repository") {
      if (node.cloneSessionKey === cloneSessionKey && node.relativePath === relativePath) {
        return node;
      }
      continue;
    }

    const match = findRepositoryNode(node.children, cloneSessionKey, relativePath);
    if (match) {
      return match;
    }
  }

  return null;
}

function isExpectedCloneSessionKey(value: string): boolean {
  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith("git-clone:")) {
    return false;
  }

  return isSafeSlashDelimitedPath(trimmedValue.slice("git-clone:".length));
}

function isSafeCloneRelativePath(value: string): boolean {
  return isSafeSlashDelimitedPath(value.trim());
}

function isSafeSlashDelimitedPath(value: string): boolean {
  if (
    !value ||
    value === "." ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }

  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
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

function logTerminalResolveOutcome(
  status: GitCloneTerminalResolveStatus,
  diagnostics: CloneTreeDiagnostics,
): void {
  const level = status === "scan-failed" ? console.error : console.log;
  level(
    `[git-clones] Terminal resolution ${status}: repos=${diagnostics.repoCount} directories=${diagnostics.directoryCount} skipped=${diagnostics.skippedPaths.length} truncated=${diagnostics.truncated} durationMs=${diagnostics.durationMs}`,
  );
}

function describeErrorForLogs(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
