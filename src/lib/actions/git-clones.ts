"use server";

import { createCloneTerminalProof } from "@hive/auth";
import { z } from "zod";
import type { CoderWorkspace, WorkspaceAgent } from "@/lib/coder/types";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import {
  type GitCloneDiscoveryActionResult,
  type GitCloneDiscoveryErrorCode,
  type GitCloneDiscoveryStatus,
  type GitCloneTerminalIdentity,
  type PublicCloneTree,
  resolveConfiguredProjectsRoot,
} from "@/lib/git/clone-actions-contract";
import { createCloneTreeFromRepositoryRelativePaths } from "@/lib/git/clone-discovery";
import {
  type CloneTree,
  type CloneTreeDiagnostics,
  type CloneTreeNode,
  type CloneTreeRepositoryNode,
  type CloneTreeSkippedPathReason,
  createSafeCloneTerminalSessionName,
} from "@/lib/git/clone-tree";
import { authActionClient } from "@/lib/safe-action";
import { execInWorkspace } from "@/lib/workspace/exec";

const SUCCESS_MESSAGE = "Git clones discovered.";
const EMPTY_MESSAGE = "No Git clones found under the configured home root.";
const MISSING_ROOT_MESSAGE =
  "Configured home folder is not available. Mount the home root, then refresh.";
const SCAN_FAILED_MESSAGE =
  "We couldn't scan the home folder for Git clones. Refresh and try again.";
const INVALID_SELECTION_MESSAGE = "We couldn't verify that Git repository. Refresh and try again.";
const WORKSPACE_AGENT_UNAVAILABLE_MESSAGE =
  "We couldn't verify that workspace terminal. Refresh and try again.";
const TERMINAL_PROOF_UNAVAILABLE_MESSAGE =
  "We couldn't prepare a secure Git terminal. Refresh and try again.";
const WORKSPACE_DISCOVERY_TIMEOUT_MS = 15_000;
const WORKSPACE_ROOT_MISSING_SENTINEL = "__HIVE_PROJECTS_ROOT_MISSING__";
const WORKSPACE_CLONE_SCAN_LIMIT = 201;

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
  async ({ ctx }): Promise<GitCloneDiscoveryActionResult> => {
    try {
      const projectsRootPath = resolveConfiguredProjectsRoot();
      const tree = await discoverWorkspaceCloneTree(ctx.user.id, projectsRootPath);
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
  .action(async ({ parsedInput, ctx }): Promise<GitCloneTerminalIdentity> => {
    const agentId = await resolveAuthorizedWorkspaceAgentId(
      ctx.user.id,
      parsedInput.workspaceId,
      parsedInput.agentId,
    );
    let tree: CloneTree;

    try {
      const projectsRootPath = resolveConfiguredProjectsRoot();
      tree = await discoverWorkspaceCloneTree(
        ctx.user.id,
        projectsRootPath,
        parsedInput.workspaceId,
      );
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
        agentId,
        sessionId: ctx.session.sessionId,
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

async function discoverWorkspaceCloneTree(
  userId: string,
  projectsRootPath: string,
  workspaceId?: string,
): Promise<CloneTree> {
  const client = await getCoderClientForUser(userId);
  const workspace = workspaceId
    ? await client.getWorkspace(workspaceId)
    : selectDiscoveryWorkspace((await client.listWorkspaces({ owner: "me" })).workspaces);

  if (!workspace) {
    return createCloneTreeFromRepositoryRelativePaths(projectsRootPath, []);
  }

  const agentTarget = await client.getWorkspaceAgentName(workspace.id);
  const result = await execInWorkspace(
    agentTarget,
    buildWorkspaceCloneDiscoveryCommand(projectsRootPath),
    {
      coderUrl: client.getBaseUrl(),
      sessionToken: client.getSessionToken(),
      timeoutMs: WORKSPACE_DISCOVERY_TIMEOUT_MS,
    },
  );

  if (result.exitCode !== 0) {
    console.error(
      `[git-clones] Workspace discovery failed: workspace=${workspace.id} exit=${result.exitCode}`,
    );
    throw new Error("workspace_clone_discovery_failed");
  }

  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(WORKSPACE_ROOT_MISSING_SENTINEL)) {
    return createCloneTreeWithMissingRoot(projectsRootPath);
  }

  const safeRelativePaths = lines
    .filter(isSafeCloneRelativePath)
    .slice(0, WORKSPACE_CLONE_SCAN_LIMIT);
  return createCloneTreeFromRepositoryRelativePaths(projectsRootPath, safeRelativePaths, {
    maxRepositories: WORKSPACE_CLONE_SCAN_LIMIT,
  });
}

function selectDiscoveryWorkspace(workspaces: readonly CoderWorkspace[]): CoderWorkspace | null {
  return (
    workspaces.find((workspace) => workspace.latest_build.status === "running") ??
    workspaces[0] ??
    null
  );
}

function createCloneTreeWithMissingRoot(projectsRootPath: string): CloneTree {
  const tree = createCloneTreeFromRepositoryRelativePaths(projectsRootPath, []);
  return {
    ...tree,
    diagnostics: {
      ...tree.diagnostics,
      skippedPaths: [{ relativePath: ".", reason: "not-directory" }],
    },
  };
}

function buildWorkspaceCloneDiscoveryCommand(projectsRootPath: string): string {
  const root = shellQuote(projectsRootPath);
  const skippedNames = ["node_modules", "build", "coverage", "dist", "out", ".next", ".turbo"];
  const skippedNameExpression = skippedNames
    .map((name) => `-name ${shellQuote(name)}`)
    .join(" -o ");

  return [
    `root=${root}`,
    `if [ ! -d "$root" ]; then printf '%s\\n' ${shellQuote(WORKSPACE_ROOT_MISSING_SENTINEL)}; exit 0; fi`,
    `find "$root" -mindepth 1 -maxdepth 5 \\( -type d -name '.*' -prune \\) -o \\( -type d \\( ${skippedNameExpression} \\) -prune \\) -o \\( -type d -exec test -e '{}/.git' \\; -print \\) | awk -v prefix="$root/" 'index($0, prefix) == 1 { print substr($0, length(prefix) + 1) }' | sort | head -n ${WORKSPACE_CLONE_SCAN_LIMIT}`,
  ].join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getCloneTerminalProofSecret(): string {
  const secret = process.env.COOKIE_SECRET?.trim();
  if (!secret) {
    console.error("[git-clones] Terminal proof mint failed: cloneProof_secret_missing");
    throw new Error(TERMINAL_PROOF_UNAVAILABLE_MESSAGE);
  }
  return secret;
}

async function resolveAuthorizedWorkspaceAgentId(
  userId: string,
  workspaceId: string,
  requestedAgentId: string | undefined,
): Promise<string> {
  try {
    const client = await getCoderClientForUser(userId);
    const resources = await client.getWorkspaceResources(workspaceId);
    const agents = resources.flatMap((resource) => resource.agents ?? []);

    if (requestedAgentId) {
      const requestedAgent = agents.find((agent) => agent.id === requestedAgentId);
      if (!requestedAgent) {
        throw new Error("workspace_agent_mismatch");
      }
      return requestedAgent.id;
    }

    const firstAgent = getFirstWorkspaceAgent(agents);
    if (!firstAgent) {
      throw new Error("workspace_agent_missing");
    }
    return firstAgent.id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : describeErrorForLogs(error);
    const safeReason = reason.startsWith("workspace_agent_") ? reason : describeErrorForLogs(error);
    console.warn(`[git-clones] Workspace agent verification failed (${safeReason})`);
    throw new Error(WORKSPACE_AGENT_UNAVAILABLE_MESSAGE);
  }
}

function getFirstWorkspaceAgent(agents: readonly WorkspaceAgent[]): WorkspaceAgent | null {
  return agents[0] ?? null;
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
