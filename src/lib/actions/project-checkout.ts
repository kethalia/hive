"use server";

import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { projectCheckoutCommand } from "@/lib/projects/checkout-command";
import { authActionClient } from "@/lib/safe-action";
import { execInWorkspace } from "@/lib/workspace/exec";

const githubId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const input = z
  .object({
    action: z.enum(["open", "cleanup"]),
    workspaceId: z.string().uuid(),
    buildId: z.string().uuid(),
    repositoryId: githubId,
    providerAccountId: githubId,
  })
  .strict();
const errors = {
  github_unavailable: "Could not verify repository access. Check GitHub in this workspace.",
  github_account_changed:
    "The GitHub account changed. Refresh Projects and select the repository again.",
  checkout_unavailable: "Could not use this project checkout. Check the workspace and try again.",
  checkout_busy: "This project is already preparing or cleaning up. Try again shortly.",
  clone_failed: "Could not clone the repository. Check workspace GitHub access and try again.",
  codex_unavailable:
    "Could not start Codex. Check that Codex and tmux are available in this workspace.",
  checkout_in_use: "This checkout is in use. Exit Codex and close any other sessions using it.",
  checkout_dirty: "This checkout has local changes or files. Save your work before cleaning up.",
  cleanup_unverified:
    "Could not confirm the checkout was safe to remove. Try again after closing workspace sessions and checking GitHub access.",
  checkout_unpublished:
    "This checkout has unpublished commits. Push or preserve them before cleaning up.",
};
const reply = z.union([
  z.object({ status: z.enum(["absent", "removed"]) }),
  z.object({
    status: z.literal("opened"),
    sessionName: z.string().regex(/^hive-project-[0-9a-f]{32}$/),
    fullName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
  }),
  z.object({ error: z.string() }),
]);

export const manageProjectCheckoutAction = authActionClient
  .inputSchema(input)
  .action(async ({ ctx, parsedInput }) => {
    if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true")
      throw new Error("Projects are unavailable on this Hive deployment.");
    const { workspaceId, buildId, action } = parsedInput;
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
    const execution = await execInWorkspace(
      `${workspace.name}.${agent.name}`,
      projectCheckoutCommand,
      {
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
        credentialSource: client.getCredentialSource(),
        expected: { workspaceId, buildId, agentId: agent.id },
        loginShell: true,
        stdin: JSON.stringify(parsedInput),
        timeoutMs: 115_000,
        maxBufferBytes: 4096,
      },
    );
    if (execution.exitCode !== 0)
      throw new Error("Could not confirm the workspace operation. Retry from Projects.");
    let value: unknown;
    try {
      value = JSON.parse(execution.stdout);
    } catch {
      throw new Error("Could not confirm the workspace operation. Retry from Projects.");
    }
    const result = reply.safeParse(value);
    if (!result.success) throw new Error("The workspace returned an invalid project result.");
    if ("error" in result.data)
      throw new Error(
        Object.hasOwn(errors, result.data.error)
          ? errors[result.data.error as keyof typeof errors]
          : "Could not complete the project operation.",
      );
    if (action === "cleanup" && result.data.status !== "opened") return result.data;
    if (action !== "open" || result.data.status !== "opened")
      throw new Error("The workspace returned an invalid project result.");
    const latest = await client.getWorkspace(workspaceId);
    if (
      latest.owner_id !== ctx.user.coderUserId ||
      latest.latest_build.id !== buildId ||
      latest.latest_build.status !== "running"
    )
      throw new Error("The workspace build changed before Codex could open.");
    return result.data;
  });
