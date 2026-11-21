"use server";

import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { discoveryCacheKey, invalidateDiscovery } from "@/lib/discovery/server-cache";
import { resolveConfiguredProjectsRoot } from "@/lib/git/clone-actions-contract";
import { isSafeCloneRelativePath } from "@/lib/git/clone-public-identifiers";
import { createCloneSessionKey, createSafeCloneTerminalSessionName } from "@/lib/git/clone-tree";
import { projectCheckoutCommand } from "@/lib/projects/checkout-command";
import { authActionClient } from "@/lib/safe-action";
import { execInWorkspace } from "@/lib/workspace/exec";
import type { TerminalPane } from "@/lib/workspaces/general-workspace";

const githubId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const input = z
  .object({
    workspaceId: z.string().uuid(),
    buildId: z.string().uuid(),
    repositoryId: githubId,
    providerAccountId: githubId,
    cloneMissing: z.boolean(),
  })
  .strict();
const errors = {
  github_unavailable: "Could not verify repository access. Check GitHub in this workspace.",
  github_account_changed:
    "The GitHub account changed. Refresh Projects and select the repository again.",
  checkout_unavailable: "Could not use this project checkout. Check the workspace and try again.",
  checkout_outside_root: "This checkout is outside the configured projects root.",
  checkout_busy: "A checkout for this owner is already being prepared. Try again shortly.",
  clone_failed: "Could not clone the repository. Check workspace GitHub access and try again.",
};
const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((name) => !name.endsWith("/.") && !name.endsWith("/.."));
const reply = z.union([
  z.object({ checkout: z.literal("missing") }),
  z
    .object({
      fullName: repositoryName,
      relativePath: z.string().max(512).refine(isSafeCloneRelativePath),
    })
    .refine(
      ({ fullName, relativePath }) =>
        relativePath === fullName ||
        relativePath.endsWith(`/${fullName}`) ||
        fullName.endsWith(`/${relativePath}`),
    ),
  z.object({ error: z.string() }),
]);

export const openProjectTerminalAction = authActionClient
  .inputSchema(input)
  .action(async ({ ctx, parsedInput }): Promise<TerminalPane | { checkout: "missing" }> => {
    if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true")
      throw new Error("Projects are unavailable on this Hive deployment.");
    const { workspaceId, buildId } = parsedInput;
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(workspaceId);
    if (workspace.owner_id !== ctx.user.coderUserId || workspace.id !== workspaceId)
      throw new Error("Choose a Coder workspace you own.");
    if (workspace.latest_build.status !== "running" || workspace.latest_build.id !== buildId)
      throw new Error("The workspace build changed. Reopen Projects to use the current build.");
    const resources = await client.getWorkspaceResources(workspaceId, buildId);
    const agents = resources.flatMap((resource) => resource.agents ?? []);
    const [agent] = agents;
    if (agents.length !== 1 || agent.status !== "connected")
      throw new Error("Projects need a workspace with one connected agent.");
    const projectsRoot = resolveConfiguredProjectsRoot();
    const execution = await execInWorkspace(
      `${workspace.name}.${agent.name}`,
      projectCheckoutCommand,
      {
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
        credentialSource: client.getCredentialSource(),
        expected: { workspaceId, buildId, agentId: agent.id },
        loginShell: true,
        stdin: JSON.stringify({ ...parsedInput, projectsRoot }),
        timeoutMs: 115_000,
        maxBufferBytes: 4096,
      },
    );
    if (execution.exitCode !== 0)
      throw new Error("Could not confirm the workspace operation. Try again.");
    let value: unknown;
    try {
      value = JSON.parse(execution.stdout);
    } catch {
      throw new Error("Could not confirm the workspace operation. Try again.");
    }
    const result = reply.safeParse(value);
    if (!result.success) throw new Error("The workspace returned an invalid project result.");
    if ("error" in result.data)
      throw new Error(
        Object.hasOwn(errors, result.data.error)
          ? errors[result.data.error as keyof typeof errors]
          : "Could not complete the project operation.",
      );
    const latest = await client.getWorkspace(workspaceId);
    if (
      latest.owner_id !== ctx.user.coderUserId ||
      latest.latest_build.id !== buildId ||
      latest.latest_build.status !== "running"
    )
      throw new Error("The workspace build changed before the terminal could open.");
    if ("checkout" in result.data) return result.data;
    const { fullName, relativePath } = result.data;
    await invalidateDiscovery(
      discoveryCacheKey([
        "repositories",
        client.getBaseUrl(),
        ctx.user.id,
        workspaceId,
        buildId,
        projectsRoot,
      ]),
    );
    const cloneSessionKey = createCloneSessionKey(relativePath.split("/"));
    return {
      kind: "terminal",
      workspaceId,
      label: fullName,
      cloneSessionKey,
      relativePath,
      sessionName: createSafeCloneTerminalSessionName(cloneSessionKey),
    };
  });
