"use server";

import { getCoderClientForUser } from "@/lib/coder/user-client";
import { discoveryCacheKey, invalidateDiscovery } from "@/lib/discovery/server-cache";
import { resolveConfiguredProjectsRoot } from "@/lib/git/clone-actions-contract";
import { cloneProjectCommand, cloneProjectSchema } from "@/lib/git/clone-project";
import { createCloneSessionKey, createSafeCloneTerminalSessionName } from "@/lib/git/clone-tree";
import { authActionClient } from "@/lib/safe-action";
import { execInWorkspace } from "@/lib/workspace/exec";
import type { GeneralPane } from "@/lib/workspaces/general-workspace";

export const cloneProjectAction = authActionClient
  .inputSchema(cloneProjectSchema)
  .action(async ({ ctx, parsedInput }): Promise<GeneralPane> => {
    const { workspaceId, organization, repository } = parsedInput;
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(workspaceId);
    if (workspace.owner_name !== ctx.user.username)
      throw new Error("Choose a Coder workspace you own.");
    if (workspace.latest_build.status !== "running")
      throw new Error("Start this workspace before cloning a project.");
    const root = resolveConfiguredProjectsRoot();
    const target = await client.getWorkspaceAgentName(workspace.id);
    const result = await execInWorkspace(
      target,
      cloneProjectCommand(root, organization, repository),
      { coderUrl: client.getBaseUrl(), sessionToken: client.getSessionToken(), timeoutMs: 110_000 },
    );
    if (result.exitCode !== 0) {
      if (result.stdout.trim() === "already-exists")
        throw new Error("That project folder already exists. Open it from Projects in search.");
      if (result.stdout.trim() === "unsafe-parent")
        throw new Error(
          "The project parent folder must be a directory inside the workspace home, without symlinks.",
        );
      throw new Error(
        "Could not clone the repository. Check its name, access, and GitHub sign-in in this Coder workspace.",
      );
    }
    await invalidateDiscovery(
      discoveryCacheKey([
        "repositories",
        client.getBaseUrl(),
        ctx.user.id,
        workspaceId,
        workspace.latest_build.id,
        root,
      ]),
    );
    const segments = ["projects", organization, repository];
    const cloneSessionKey = createCloneSessionKey(segments);
    return {
      kind: "terminal",
      workspaceId,
      label: repository,
      cloneSessionKey,
      relativePath: segments.join("/"),
      sessionName: createSafeCloneTerminalSessionName(cloneSessionKey),
    };
  });
