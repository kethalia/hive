import { listGitClonesAction, resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import type { CloneTreeNode, CloneTreeRepositoryNode } from "@/lib/git/clone-tree";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";

function repositories(nodes: readonly CloneTreeNode[]): CloneTreeRepositoryNode[] {
  return nodes.flatMap((node) =>
    node.kind === "repository" ? [node] : repositories(node.children),
  );
}

export function terminalNameError(name: string): string | null {
  if (name.length > 200) return "Use a terminal name of 200 characters or fewer.";
  if (!SAFE_IDENTIFIER_RE.test(name)) return "Use letters, numbers, dots, underscores, or hyphens.";
  if (isCloneTerminalSessionName(name))
    return "The git-clone- prefix is reserved for repository terminals.";
  return null;
}

export async function loadWorkspaceTerminals(workspaceId: string) {
  const [sessions, clones] = await Promise.allSettled([
    getWorkspaceSessionsAction({ workspaceId }),
    listGitClonesAction({ workspaceId }),
  ]);
  const sessionData = sessions.status === "fulfilled" ? sessions.value?.data : undefined;
  const cloneData = clones.status === "fulfilled" ? clones.value?.data : undefined;
  return {
    workspaceId,
    // Repository sessions must carry their clone identity, supplied by the repository result.
    sessions:
      sessionData
        ?.map((session) => session.name)
        .filter((name) => !isCloneTerminalSessionName(name)) ?? [],
    repositories: cloneData?.ok ? repositories(cloneData.tree.nodes) : [],
    error:
      !sessionData || !cloneData?.ok
        ? "Some terminals could not be listed. Retry to refresh the available sessions and repositories."
        : undefined,
  };
}

export async function repositoryTerminalPane(
  workspaceId: string,
  repository: CloneTreeRepositoryNode,
): Promise<GeneralPane> {
  const result = await resolveGitCloneTerminalAction({
    workspaceId,
    cloneSessionKey: repository.cloneSessionKey,
    relativePath: repository.relativePath,
  });
  if (!result?.data) throw new Error(result?.serverError ?? "Could not open repository terminal.");
  return {
    kind: "terminal",
    workspaceId,
    sessionName: result.data.sessionName,
    label: repository.label,
    cloneSessionKey: repository.cloneSessionKey,
    relativePath: repository.relativePath,
  };
}
