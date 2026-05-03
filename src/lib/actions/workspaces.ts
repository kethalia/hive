"use server";

import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import { authActionClient } from "@/lib/safe-action";
import { execInWorkspace } from "@/lib/workspace/exec";
import { parseTmuxSessions } from "@/lib/workspaces/sessions";

export const listWorkspacesAction = authActionClient.action(async ({ ctx }) => {
  const client = await getCoderClientForUser(ctx.user.id);
  const result = await client.listWorkspaces({ owner: "me" });
  return result.workspaces;
});

const getWorkspaceAgentSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

const getWorkspaceSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

export const getWorkspaceAction = authActionClient
  .inputSchema(getWorkspaceSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    return client.getWorkspace(parsedInput.workspaceId);
  });

export const getWorkspaceAgentAction = authActionClient
  .inputSchema(getWorkspaceAgentSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    const resources = await client.getWorkspaceResources(parsedInput.workspaceId);
    for (const resource of resources) {
      if (resource.agents && resource.agents.length > 0) {
        return { agentId: resource.agents[0].id, agentName: resource.agents[0].name };
      }
    }
    throw new Error(`No agents found for workspace ${parsedInput.workspaceId}`);
  });

const getWorkspaceSessionsSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

export const getWorkspaceSessionsAction = authActionClient
  .inputSchema(getWorkspaceSessionsSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);

    let agentTarget: string;
    try {
      agentTarget = await client.getWorkspaceAgentName(parsedInput.workspaceId);
    } catch {
      console.log(
        `[workspaces] No agents found for workspace ${parsedInput.workspaceId}, returning empty sessions`,
      );
      return [];
    }

    const result = await execInWorkspace(
      agentTarget,
      "tmux -L web list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'",
    );

    if (result.exitCode !== 0) {
      console.log(
        `[workspaces] tmux list-sessions failed (exit ${result.exitCode}): ${result.stderr}`,
      );
      return [];
    }

    return parseTmuxSessions(result.stdout);
  });

const createSessionSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  sessionName: z.string().optional(),
});

export const createSessionAction = authActionClient
  .inputSchema(createSessionSchema)
  .action(async ({ parsedInput }) => {
    const name = parsedInput.sessionName ?? `session-${Date.now()}`;
    if (!SAFE_IDENTIFIER_RE.test(name)) {
      throw new Error(`Invalid session name: ${name}`);
    }

    console.log(
      `[workspaces] Session name "${name}" allocated for workspace ${parsedInput.workspaceId} (tmux creates on PTY connect)`,
    );
    return { name };
  });

const renameSessionSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  oldName: z.string().min(1, "oldName is required"),
  newName: z.string().min(1, "newName is required"),
});

export const renameSessionAction = authActionClient
  .inputSchema(renameSessionSchema)
  .action(async ({ parsedInput, ctx }) => {
    if (!SAFE_IDENTIFIER_RE.test(parsedInput.oldName)) {
      throw new Error(`Invalid session name: ${parsedInput.oldName}`);
    }
    if (!SAFE_IDENTIFIER_RE.test(parsedInput.newName)) {
      throw new Error(`Invalid session name: ${parsedInput.newName}`);
    }

    const client = await getCoderClientForUser(ctx.user.id);
    const agentTarget = await client.getWorkspaceAgentName(parsedInput.workspaceId);

    const result = await execInWorkspace(
      agentTarget,
      `tmux -L web rename-session -t ${parsedInput.oldName} ${parsedInput.newName}`,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to rename session "${parsedInput.oldName}" to "${parsedInput.newName}": ${result.stderr}`,
      );
    }

    console.log(
      `[workspaces] Renamed tmux session "${parsedInput.oldName}" → "${parsedInput.newName}" in workspace ${parsedInput.workspaceId}`,
    );
    return { oldName: parsedInput.oldName, newName: parsedInput.newName };
  });

const killSessionSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  sessionName: z.string().min(1, "sessionName is required"),
});

export const killSessionAction = authActionClient
  .inputSchema(killSessionSchema)
  .action(async ({ parsedInput, ctx }) => {
    if (!SAFE_IDENTIFIER_RE.test(parsedInput.sessionName)) {
      throw new Error(`Invalid session name: ${parsedInput.sessionName}`);
    }

    const client = await getCoderClientForUser(ctx.user.id);
    const agentTarget = await client.getWorkspaceAgentName(parsedInput.workspaceId);

    const result = await execInWorkspace(
      agentTarget,
      `tmux -L web kill-session -t ${parsedInput.sessionName}`,
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to kill session "${parsedInput.sessionName}": ${result.stderr}`);
    }

    console.log(
      `[workspaces] Killed tmux session "${parsedInput.sessionName}" in workspace ${parsedInput.workspaceId}`,
    );
    return { name: parsedInput.sessionName };
  });
