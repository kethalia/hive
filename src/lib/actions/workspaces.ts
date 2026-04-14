"use server";

import { z } from "zod";
import { actionClient } from "@/lib/safe-action";
import { CoderClient } from "@/lib/coder/client";
import { execInWorkspace } from "@/lib/workspace/exec";
import { parseTmuxSessions } from "@/lib/workspaces/sessions";

function getCoderClient(): CoderClient {
  return new CoderClient({
    baseUrl: process.env.CODER_URL!,
    sessionToken: process.env.CODER_SESSION_TOKEN!,
  });
}

export const listWorkspacesAction = actionClient.action(async () => {
  const client = getCoderClient();
  const result = await client.listWorkspaces({ owner: "me" });
  return result.workspaces;
});

const getWorkspaceSessionsSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

export const getWorkspaceSessionsAction = actionClient
  .inputSchema(getWorkspaceSessionsSchema)
  .action(async ({ parsedInput }) => {
    const client = getCoderClient();

    let agentTarget: string;
    try {
      agentTarget = await client.getWorkspaceAgentName(
        parsedInput.workspaceId,
      );
    } catch {
      console.log(
        `[workspaces] No agents found for workspace ${parsedInput.workspaceId}, returning empty sessions`,
      );
      return [];
    }

    const result = await execInWorkspace(
      agentTarget,
      "tmux list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'",
    );

    if (result.exitCode !== 0) {
      console.log(
        `[workspaces] tmux list-sessions failed (exit ${result.exitCode}): ${result.stderr}`,
      );
      return [];
    }

    return parseTmuxSessions(result.stdout);
  });
