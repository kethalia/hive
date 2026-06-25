"use server";

import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import { authActionClient } from "@/lib/safe-action";
import { execInWorkspace } from "@/lib/workspace/exec";
import { filterGenericTmuxSessions, parseTmuxSessions } from "@/lib/workspaces/sessions";
import { buildCodeServerFolderUrl, buildWorkspaceUrls } from "@/lib/workspaces/urls";

export const listWorkspacesAction = authActionClient.action(async ({ ctx }) => {
  const client = await getCoderClientForUser(ctx.user.id);
  const result = await client.listWorkspaces({ owner: "me" });
  return result.workspaces;
});

export const listWorkspaceTemplatesAction = authActionClient.action(async ({ ctx }) => {
  const client = await getCoderClientForUser(ctx.user.id);
  return client.listTemplates();
});

const createWorkspaceSchema = z.object({
  templateId: z.string().trim().min(1, "Template is required"),
  name: z
    .string()
    .trim()
    .min(1, "Workspace name is required")
    .max(64, "Workspace name is too long")
    .regex(SAFE_IDENTIFIER_RE, "Use letters, numbers, dots, underscores, or hyphens"),
});

export const createWorkspaceAction = authActionClient
  .inputSchema(createWorkspaceSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    return client.createWorkspace(parsedInput.templateId, parsedInput.name);
  });

const getWorkspaceAgentSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

const getWorkspaceSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

function assertGenericSessionName(sessionName: string, operation: "create" | "rename" | "kill") {
  if (isCloneTerminalSessionName(sessionName)) {
    console.warn(`[workspaces] Rejected generic ${operation} for reserved clone terminal session`);
    throw new Error(
      "Cannot manage reserved clone terminal session through generic session actions",
    );
  }

  if (!SAFE_IDENTIFIER_RE.test(sessionName)) {
    throw new Error(`Invalid session name: ${sessionName}`);
  }
}

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

const codeServerSessionSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  sessionName: z
    .string()
    .trim()
    .min(1, "sessionName is required")
    .regex(SAFE_IDENTIFIER_RE, "Invalid session name"),
  fallbackPath: z.string().trim().min(1).optional(),
});

function normalizeWorkspaceDirectory(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith("/")) return null;
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) return null;
  return trimmed;
}

async function getSessionCurrentDirectory({
  agentTarget,
  coderUrl,
  sessionName,
  sessionToken,
}: {
  agentTarget: string;
  coderUrl: string;
  sessionName: string;
  sessionToken: string;
}): Promise<string | null> {
  const result = await execInWorkspace(
    agentTarget,
    `tmux -L web display-message -p -t ${sessionName}: '#{pane_current_path}'`,
    {
      coderUrl,
      sessionToken,
    },
  );

  if (result.exitCode !== 0) return null;
  return normalizeWorkspaceDirectory(result.stdout);
}

export const getWorkspaceSessionsAction = authActionClient
  .inputSchema(getWorkspaceSessionsSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);

    let agentTarget: string;
    try {
      agentTarget = await client.getWorkspaceAgentName(parsedInput.workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no agents? found/i.test(message)) {
        console.log(
          `[workspaces] No agents found for workspace ${parsedInput.workspaceId}, returning empty sessions`,
        );
        return [];
      }
      console.log(
        `[workspaces] Failed to resolve agent for workspace ${parsedInput.workspaceId}: ${message}`,
      );
      throw new Error(`Failed to resolve workspace agent: ${message}`);
    }

    const result = await execInWorkspace(
      agentTarget,
      "tmux -L web list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'",
      {
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
      },
    );

    if (result.exitCode !== 0) {
      // "no server running" is the legitimate empty case — tmux exits non-zero
      // when no sessions exist on the configured socket. Treat anything else
      // (ssh failures, timeouts, agent unreachable) as a real error so callers
      // don't confuse a transient outage with "user has zero sessions".
      const diagnostic = [result.stderr, result.stdout]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
      if (/no server running/i.test(diagnostic)) {
        return [];
      }
      const message = diagnostic || "no diagnostics returned by workspace command";
      console.log(`[workspaces] tmux list-sessions failed (exit ${result.exitCode}): ${message}`);
      throw new Error(`Failed to list tmux sessions (exit ${result.exitCode}): ${message}`);
    }

    return filterGenericTmuxSessions(parseTmuxSessions(result.stdout));
  });

export const getCodeServerSessionUrlAction = authActionClient
  .inputSchema(codeServerSessionSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(parsedInput.workspaceId);
    const resources = await client.getWorkspaceResources(parsedInput.workspaceId);
    const agent = resources.flatMap((resource) => resource.agents ?? [])[0];
    if (!agent) {
      throw new Error(`No agents found for workspace ${parsedInput.workspaceId}`);
    }

    const urls = buildWorkspaceUrls(workspace, agent.name, client.getBaseUrl());
    if (!urls) {
      throw new Error("Coder URL is unavailable for code-server");
    }

    const agentTarget = `${workspace.name}.${agent.name}`;
    const currentDirectory = await getSessionCurrentDirectory({
      agentTarget,
      coderUrl: client.getBaseUrl(),
      sessionName: parsedInput.sessionName,
      sessionToken: client.getSessionToken(),
    });
    const folderPath =
      currentDirectory ?? normalizeWorkspaceDirectory(parsedInput.fallbackPath) ?? undefined;

    return {
      url: buildCodeServerFolderUrl(urls.codeServer, folderPath),
      folderPath: folderPath ?? null,
      source: currentDirectory ? "tmux" : folderPath ? "fallback" : "default",
    };
  });

const createSessionSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  sessionName: z.string().optional(),
});

export const createSessionAction = authActionClient
  .inputSchema(createSessionSchema)
  .action(async ({ parsedInput }) => {
    const name = parsedInput.sessionName ?? `session-${Date.now()}`;
    assertGenericSessionName(name, "create");

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
    assertGenericSessionName(parsedInput.oldName, "rename");
    assertGenericSessionName(parsedInput.newName, "rename");

    const client = await getCoderClientForUser(ctx.user.id);
    const agentTarget = await client.getWorkspaceAgentName(parsedInput.workspaceId);

    const result = await execInWorkspace(
      agentTarget,
      `tmux -L web rename-session -t ${parsedInput.oldName} ${parsedInput.newName}`,
      {
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
      },
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
    assertGenericSessionName(parsedInput.sessionName, "kill");

    const client = await getCoderClientForUser(ctx.user.id);
    const agentTarget = await client.getWorkspaceAgentName(parsedInput.workspaceId);

    const result = await execInWorkspace(
      agentTarget,
      `tmux -L web kill-session -t ${parsedInput.sessionName}`,
      {
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
      },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to kill session "${parsedInput.sessionName}": ${result.stderr}`);
    }

    console.log(
      `[workspaces] Killed tmux session "${parsedInput.sessionName}" in workspace ${parsedInput.workspaceId}`,
    );
    return { name: parsedInput.sessionName };
  });
