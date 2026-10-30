"use server";

import { posix } from "node:path";
import { SESSION_MAX_AGE_SECONDS } from "@hive/auth";
import { cookies } from "next/headers";
import { z } from "zod";
import { usesSecureSessionCookies } from "@/lib/auth/session-cookie";
import type { CoderWorkspace } from "@/lib/coder/types";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import type { VerifiedHostBinding } from "@/lib/codex-session/registration.server";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import { resolveConfiguredProjectsRoot } from "@/lib/git/clone-actions-contract";
import { isSafeCloneRelativePath } from "@/lib/git/clone-public-identifiers";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import { authActionClient } from "@/lib/safe-action";
import {
  CODER_HOST_COOKIE,
  coderFrameConfiguredUrls,
} from "@/lib/security/content-security-policy";
import { assertWorkspaceAppIsolated } from "@/lib/security/workspace-app-isolation";
import { isRetiredWorkspaceTemplate, workspaceTemplateCapabilities } from "@/lib/templates/catalog";
import { TERMINAL_PATH_BATCH_SIZE } from "@/lib/terminal/link-target";
import { execInWorkspace } from "@/lib/workspace/exec";
import {
  getIsolatedWorkspaceAppAuthRedirect,
  getWorkspaceAppIsolationContext,
} from "@/lib/workspaces/app-access";
import {
  usesWorkspaceReadTransport,
  workspaceReadActions,
} from "@/lib/workspaces/read-actions.server";
import { filterGenericTmuxSessions, parseTmuxSessions } from "@/lib/workspaces/sessions";
import { resolveTerminalFilePath } from "@/lib/workspaces/terminal-file-path";
import {
  buildCodeServerFolderUrl,
  buildFileBrowserFolderUrl,
  buildWorkspaceUrls,
} from "@/lib/workspaces/urls";

const WORKSPACE_TOOL_DIRECTORY_TIMEOUT_MS = 5_000;

export const listWorkspacesAction = authActionClient.action(async ({ ctx }) => {
  const client = await getCoderClientForUser(ctx.user.id);
  const result = await client.listWorkspaces({ owner: "me" });
  return result.workspaces;
});

export const listWorkspaceTemplatesAction = authActionClient.action(async ({ ctx }) => {
  const client = await getCoderClientForUser(ctx.user.id);
  const templates = await client.listTemplates();
  return templates.filter(({ name }) => !isRetiredWorkspaceTemplate(name));
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
    const templates = await client.listTemplates();
    const selectedTemplate = templates.find(({ id }) => id === parsedInput.templateId);
    if (!selectedTemplate) {
      throw new Error("The selected workspace template is no longer available.");
    }
    if (isRetiredWorkspaceTemplate(selectedTemplate.name)) {
      throw new Error(
        "The orchestrator template is retired. Use ai-dev-k8s for development and orchestration.",
      );
    }
    return client.createWorkspace(parsedInput.templateId, parsedInput.name);
  });

const workspaceLifecycleSchema = z.object({
  workspaceId: z.string().trim().min(1, "workspaceId is required"),
});

function assertWorkspaceOwner(workspace: CoderWorkspace, username: string) {
  if (workspace.owner_name !== username) {
    throw new Error("Workspace is not owned by the current Coder user.");
  }
}

export const startWorkspaceAction = authActionClient
  .inputSchema(workspaceLifecycleSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(parsedInput.workspaceId);
    assertWorkspaceOwner(workspace, ctx.user.username);
    const status = workspace.latest_build.status;

    if (status === "running") {
      return { workspaceId: workspace.id, status };
    }
    if (status !== "stopped") {
      throw new Error(`Workspace must be stopped before it can start. Current status: ${status}.`);
    }

    await client.startWorkspace(workspace.id);
    await client.waitForBuild(workspace.id, "running");
    return { workspaceId: workspace.id, status: "running" as const };
  });

export const stopWorkspaceAction = authActionClient
  .inputSchema(workspaceLifecycleSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(parsedInput.workspaceId);
    assertWorkspaceOwner(workspace, ctx.user.username);
    const status = workspace.latest_build.status;

    if (status === "stopped") {
      return { workspaceId: workspace.id, status };
    }
    if (status !== "running") {
      throw new Error(`Workspace must be running before it can stop. Current status: ${status}.`);
    }

    await client.stopWorkspace(workspace.id);
    await client.waitForBuild(workspace.id, "stopped");
    return { workspaceId: workspace.id, status: "stopped" as const };
  });

const deleteWorkspaceSchema = workspaceLifecycleSchema.extend({
  confirmationName: z.string().trim().min(1, "Type the workspace name to confirm deletion"),
});

const BLOCKED_DELETE_STATUSES: ReadonlySet<string> = new Set(["pending", "starting", "canceling"]);

export const deleteWorkspaceAction = authActionClient
  .inputSchema(deleteWorkspaceSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(parsedInput.workspaceId);
    assertWorkspaceOwner(workspace, ctx.user.username);
    const status = workspace.latest_build.status;

    if (parsedInput.confirmationName !== workspace.name) {
      throw new Error("Workspace name confirmation does not match.");
    }
    if (status === "deleted" || status === "deleting") {
      return { workspaceId: workspace.id, status };
    }
    if (BLOCKED_DELETE_STATUSES.has(status)) {
      throw new Error(`Wait for the workspace transition to finish before deleting it: ${status}.`);
    }

    if (status === "running") {
      await client.stopWorkspace(workspace.id);
      await client.waitForBuild(workspace.id, "stopped");
    } else if (status === "stopping") {
      await client.waitForBuild(workspace.id, "stopped");
    }

    await client.deleteWorkspace(workspace.id);
    return { workspaceId: workspace.id, status: "deleting" as const };
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
    const workspace = await client.getWorkspace(parsedInput.workspaceId);
    const resources = await client.getWorkspaceResources(
      parsedInput.workspaceId,
      workspace.latest_build.id,
    );
    for (const resource of resources) {
      if (resource.agents && resource.agents.length > 0) {
        return {
          agentId: resource.agents[0].id,
          agentName: resource.agents[0].name,
          agentStatus: resource.agents[0].status,
          templateName: workspace.template_name ?? "",
        };
      }
    }
    throw new Error(`No agents found for workspace ${parsedInput.workspaceId}`);
  });

const getWorkspaceSessionsSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

const workspaceSessionToolsSchema = z.object({
  filePath: z.string().min(1).max(4096).optional(),
  download: z.boolean().optional(),
  workspaceId: z.string().min(1, "workspaceId is required"),
  sessionName: z
    .string()
    .trim()
    .min(1, "sessionName is required")
    .regex(SAFE_IDENTIFIER_RE, "Invalid session name"),
  fallbackPath: z.string().trim().min(1).optional(),
  documentFrameHosts: z.array(z.string().trim().min(1).max(253)).max(8),
  tool: z.enum(["code", "files"]),
});

function normalizeWorkspaceDirectory(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith("/")) return null;
  if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) return null;
  return trimmed;
}

function resolveWorkspaceFallbackDirectory(value: string | undefined): string | null {
  const absolute = normalizeWorkspaceDirectory(value);
  if (absolute) return absolute;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) {
    return null;
  }
  const projectsRoot = resolveConfiguredProjectsRoot();
  const resolved = posix.resolve(projectsRoot, trimmed);
  return projectsRoot === "/" ||
    resolved === projectsRoot ||
    resolved.startsWith(`${projectsRoot}/`)
    ? resolved
    : null;
}

async function getWorkspaceWithAgent(
  userId: string,
  workspaceId: string,
  expected?: VerifiedHostBinding,
) {
  if (expected) {
    const client = await getCoderClientForUser(userId);
    const workspace = await client.getWorkspace(workspaceId);
    const matches = (value: CoderWorkspace) =>
      value.id === expected.workspaceId &&
      value.owner_id === expected.ownerId &&
      value.template_id === expected.templateId &&
      value.latest_build.id === expected.buildId &&
      value.latest_build.status === "running";
    if (!matches(workspace) || client.getBaseUrl() !== expected.coderOrigin)
      throw new Error("Workspace changed. Refresh and reopen the tool.");
    const [resources, applicationsHost] = await Promise.all([
      client.getWorkspaceResources(workspaceId, expected.buildId),
      client.getApplicationsHost(),
    ]);
    const agents = resources
      .flatMap((resource) => resource.agents ?? [])
      .filter((agent) => agent.id === expected.agentId);
    if (
      agents.length !== 1 ||
      agents[0].status !== "connected" ||
      !matches(await client.getWorkspace(workspaceId))
    )
      throw new Error("Workspace changed. Refresh and reopen the tool.");
    return { client, workspace, agent: agents[0], applicationsHost };
  }
  const client = await getCoderClientForUser(userId);
  const [workspace, resources, applicationsHost] = await Promise.all([
    client.getWorkspace(workspaceId),
    client.getWorkspaceResources(workspaceId),
    client.getApplicationsHost().catch(() => ""),
  ]);
  const agent = resources.flatMap((resource) => resource.agents ?? [])[0];
  if (!agent) throw new Error(`No agents found for workspace ${workspaceId}`);
  return { agent, applicationsHost, client, workspace };
}

async function synchronizeCoderFrameHosts(
  coderUrl: string,
  applicationsHost: string,
  documentFrameHosts: readonly string[],
): Promise<boolean> {
  const coderFrameUrls = coderFrameConfiguredUrls(coderUrl, applicationsHost);
  const cookieStore = await cookies();
  const reloadRequired = coderFrameUrls.some((frameUrl) => !documentFrameHosts.includes(frameUrl));
  cookieStore.set(CODER_HOST_COOKIE, coderFrameUrls.join("~"), {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: usesSecureSessionCookies(),
    path: "/",
  });
  return reloadRequired;
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
    { coderUrl, sessionToken, timeoutMs: WORKSPACE_TOOL_DIRECTORY_TIMEOUT_MS },
  );
  return result.exitCode === 0 ? normalizeWorkspaceDirectory(result.stdout) : null;
}

export const getWorkspaceSessionsAction = authActionClient
  .inputSchema(getWorkspaceSessionsSchema)
  .action(async ({ parsedInput, ctx }) => {
    if (usesWorkspaceReadTransport())
      return workspaceReadActions(ctx.user).sessions(parsedInput.workspaceId);
    const client = await getCoderClientForUser(ctx.user.id);

    const workspace = await client.getWorkspace(parsedInput.workspaceId);
    if (workspace.latest_build.status !== "running") throw new Error("Start this workspace first.");
    const resources = await client.getWorkspaceResources(
      parsedInput.workspaceId,
      workspace.latest_build.id,
    );
    const agent = resources.flatMap((resource) => resource.agents ?? [])[0];
    if (!agent) return [];
    if (agent.status !== "connected") {
      throw new Error(
        `Workspace agent is ${agent.status}. Restart the workspace or wait for the agent to reconnect.`,
      );
    }

    const agentTarget = `${workspace.name}.${agent.name}`;

    const result = await execInWorkspace(
      agentTarget,
      "tmux -L web list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'",
      {
        timeoutMs: 8_000,
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
      },
    );

    if (result.exitCode !== 0) {
      // tmux exits non-zero when its server has stopped or the web socket has
      // never been created. Both mean this workspace has no Hive sessions.
      // Match the missing socket narrowly so missing-tool, SSH, and timeout
      // failures cannot be confused with "user has zero sessions".
      const diagnostic = [result.stderr, result.stdout]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
      if (
        /no server running/i.test(diagnostic) ||
        (result.exitCode === 1 &&
          /^error connecting to \/[^\r\n]+\/web \(No such file or directory\)$/m.test(diagnostic))
      ) {
        return [];
      }
      const message = diagnostic || "no diagnostics returned by workspace command";
      console.log(`[workspaces] tmux list-sessions failed (exit ${result.exitCode}): ${message}`);
      throw new Error(`Failed to list tmux sessions (exit ${result.exitCode}): ${message}`);
    }

    return filterGenericTmuxSessions(parseTmuxSessions(result.stdout));
  });

// Return only candidates backed by a regular file or directory in this workspace.
export const getExistingTerminalPathsAction = authActionClient
  .inputSchema(
    workspaceSessionToolsSchema
      .pick({ workspaceId: true, sessionName: true, fallbackPath: true })
      .extend({
        paths: z.array(z.string().min(1).max(4096)).max(TERMINAL_PATH_BATCH_SIZE),
      }),
  )
  .action(async ({ parsedInput, ctx }) => {
    if (!parsedInput.paths.length) return [];
    if (usesWorkspaceReadTransport()) return workspaceReadActions(ctx.user).paths(parsedInput);
    const { agent, client, workspace } = await getWorkspaceWithAgent(
      ctx.user.id,
      parsedInput.workspaceId,
    );
    if (!workspaceTemplateCapabilities(workspace.template_name ?? "").fileBrowser) return [];
    const agentTarget = `${workspace.name}.${agent.name}`;
    const cwd = await getSessionCurrentDirectory({
      agentTarget,
      coderUrl: client.getBaseUrl(),
      sessionToken: client.getSessionToken(),
      sessionName: parsedInput.sessionName,
    });
    const currentPath =
      cwd ?? resolveWorkspaceFallbackDirectory(parsedInput.fallbackPath) ?? undefined;
    const candidates = parsedInput.paths.flatMap((path, index) => {
      try {
        return [
          {
            index,
            path: resolveTerminalFilePath(path, currentPath, resolveConfiguredProjectsRoot()),
          },
        ];
      } catch {
        return [];
      }
    });
    if (!candidates.length) return [];
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const result = await execInWorkspace(
      agentTarget,
      candidates
        .map(
          ({ index, path }) =>
            `if [ -f ${quote(path)} ] || [ -d ${quote(path)} ]; then printf '%s\\n' ${index}; fi`,
        )
        .join("\n"),
      {
        coderUrl: client.getBaseUrl(),
        sessionToken: client.getSessionToken(),
        timeoutMs: WORKSPACE_TOOL_DIRECTORY_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0) return [];
    const existing = new Set(result.stdout.trim().split(/\s+/));
    return candidates
      .filter(({ index }) => existing.has(String(index)))
      .map(({ index }) => parsedInput.paths[index]);
  });

export const getWorkspaceSessionToolsAction = authActionClient
  .inputSchema(workspaceSessionToolsSchema)
  .action(async ({ parsedInput, ctx }) => {
    const portableDirectory = usesWorkspaceReadTransport()
      ? await workspaceReadActions(ctx.user).directoryWithBinding(
          parsedInput.workspaceId,
          parsedInput.sessionName,
        )
      : null;
    const { agent, applicationsHost, client, workspace } = await getWorkspaceWithAgent(
      ctx.user.id,
      parsedInput.workspaceId,
      portableDirectory?.binding,
    );
    const capabilities = workspaceTemplateCapabilities(workspace.template_name ?? "");
    const toolAvailable =
      parsedInput.tool === "code" ? capabilities.editor : capabilities.fileBrowser;
    if (!toolAvailable) {
      throw new Error(
        `${parsedInput.tool === "code" ? "VS Code" : "File Browser"} is not provisioned for this workspace template.`,
      );
    }

    const currentDirectory = portableDirectory
      ? portableDirectory.data.cwd
      : await getSessionCurrentDirectory({
          agentTarget: `${workspace.name}.${agent.name}`,
          coderUrl: client.getBaseUrl(),
          sessionName: parsedInput.sessionName,
          sessionToken: client.getSessionToken(),
        });
    const currentPath =
      currentDirectory ?? resolveWorkspaceFallbackDirectory(parsedInput.fallbackPath) ?? undefined;
    const folderPath = parsedInput.filePath
      ? resolveTerminalFilePath(parsedInput.filePath, currentPath, resolveConfiguredProjectsRoot())
      : currentPath;
    const urls = buildWorkspaceUrls(workspace, agent.name, client.getBaseUrl(), applicationsHost);
    if (!urls) throw new Error("Coder URL is unavailable for workspace tools");
    // Coder app subdomains are isolated browser origins and are the supported
    // browser-facing surface for embedded workspace apps. CODER_CA_CERT only
    // extends trust for Hive's server-side requests; it must not switch the browser
    // to a same-origin Coder path app, whose framing and sharing rules differ.
    const requestedCodeUrl = buildCodeServerFolderUrl(urls.codeServer, folderPath);
    let requestedFilesUrl = buildFileBrowserFolderUrl(
      urls.filebrowser,
      folderPath,
      resolveConfiguredProjectsRoot(),
    );

    if (parsedInput.download && parsedInput.filePath) {
      const downloadUrl = new URL(requestedFilesUrl);
      downloadUrl.pathname = downloadUrl.pathname.replace(/^\/files(?=\/|$)/, "/api/raw");
      requestedFilesUrl = downloadUrl.toString();
    }

    const isolation = await getWorkspaceAppIsolationContext();
    assertWorkspaceAppIsolated(
      requestedCodeUrl,
      isolation.hiveHostname,
      isolation.cookieDomains,
      isolation.hiveHostnames,
    );
    assertWorkspaceAppIsolated(
      requestedFilesUrl,
      isolation.hiveHostname,
      isolation.cookieDomains,
      isolation.hiveHostnames,
    );
    const codeUrl =
      parsedInput.tool === "code"
        ? await getIsolatedWorkspaceAppAuthRedirect(client, requestedCodeUrl, isolation)
        : requestedCodeUrl;
    const filesUrl =
      parsedInput.tool === "files"
        ? await getIsolatedWorkspaceAppAuthRedirect(client, requestedFilesUrl, isolation)
        : requestedFilesUrl;
    const reloadRequired = await synchronizeCoderFrameHosts(
      client.getBaseUrl(),
      applicationsHost,
      parsedInput.documentFrameHosts,
    );

    return {
      codeUrl,
      filesUrl,
      folderPath: folderPath ?? null,
      reloadRequired,
      source: getWorkspaceDirectorySource(currentDirectory, folderPath),
    };
  });

export const getWorkspaceAppToolAction = authActionClient
  .inputSchema(
    z.object({
      workspaceId: z.string().min(1),
      tool: z.enum(["filebrowser", "kasmvnc", "code"]),
      projectPath: z.string().max(512).refine(isSafeCloneRelativePath).optional(),
      documentFrameHosts: z.array(z.string().trim().min(1).max(253)).max(8),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const { agent, applicationsHost, client, workspace } = await getWorkspaceWithAgent(
      ctx.user.id,
      parsedInput.workspaceId,
    );
    const capabilities = workspaceTemplateCapabilities(workspace.template_name ?? "");
    const available = {
      filebrowser: capabilities.fileBrowser,
      kasmvnc: capabilities.desktop,
      code: capabilities.editor,
    };
    if (!available[parsedInput.tool]) {
      throw new Error("The selected tool is not provisioned for this workspace template.");
    }
    const urls = buildWorkspaceUrls(workspace, agent.name, client.getBaseUrl(), applicationsHost);
    if (!urls) throw new Error("Coder URL is unavailable for workspace tools");
    if (parsedInput.projectPath && parsedInput.tool === "kasmvnc") {
      throw new Error("Desktop does not support a project folder.");
    }
    const root = resolveConfiguredProjectsRoot();
    const folderPath = parsedInput.projectPath
      ? posix.join(root, parsedInput.projectPath)
      : undefined;
    const directUrl = {
      filebrowser: buildFileBrowserFolderUrl(urls.filebrowser, folderPath, root),
      kasmvnc: urls.kasmvnc,
      code: buildCodeServerFolderUrl(urls.codeServer, folderPath),
    }[parsedInput.tool];
    const isolation = await getWorkspaceAppIsolationContext();
    const url = await getIsolatedWorkspaceAppAuthRedirect(client, directUrl, isolation);
    const reloadRequired = await synchronizeCoderFrameHosts(
      client.getBaseUrl(),
      applicationsHost,
      parsedInput.documentFrameHosts,
    );
    return { url, directUrl, reloadRequired };
  });

function getWorkspaceDirectorySource(
  currentDirectory: string | null,
  folderPath: string | undefined,
): "tmux" | "fallback" | "default" {
  if (currentDirectory) return "tmux";
  return folderPath ? "fallback" : "default";
}

const restartWorkspaceSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

export const restartWorkspaceAction = authActionClient
  .inputSchema(restartWorkspaceSchema)
  .action(async ({ parsedInput, ctx }) => {
    const client = await getCoderClientForUser(ctx.user.id);
    const workspace = await client.getWorkspace(parsedInput.workspaceId);

    if (workspace.latest_build.status !== "stopped") {
      await client.stopWorkspace(parsedInput.workspaceId);
      await client.waitForBuild(parsedInput.workspaceId, "stopped");
    }

    await client.startWorkspace(parsedInput.workspaceId);
    await client.waitForBuild(parsedInput.workspaceId, "running");
    return { workspaceId: parsedInput.workspaceId, status: "running" };
  });

const createSessionSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  sessionName: z.string().optional(),
});

export const createSessionAction = authActionClient
  .inputSchema(createSessionSchema)
  .action(async ({ parsedInput }) => {
    if (
      process.env.HIVE_RUNTIME_TARGET === "cloudflare" &&
      process.env.HIVE_GENERIC_TERMINAL_ENABLED !== "true"
    )
      throw new Error("Generic terminal transport is disabled.");
    const name = parsedInput.sessionName ?? `session-${Date.now()}`;
    if (name.length > 128) throw new Error("Session name is too long.");
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
