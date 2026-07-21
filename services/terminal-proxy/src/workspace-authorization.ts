import { fetchCoderApi } from "./coder-fetch.js";

const WORKSPACE_AUTHORIZATION_TIMEOUT_MS = 5_000;

export type WorkspaceAgentAccessResult = { ok: true } | { ok: false; status: 403 | 502 };

interface WorkspaceAgentAccessInput {
  coderUrl: string;
  token: string;
  workspaceId: string;
  agentId: string;
}

function objectProperty(value: unknown, property: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, property) : undefined;
}

function workspaceContainsAgent(workspace: unknown, agentId: string): boolean {
  const latestBuild = objectProperty(workspace, "latest_build");
  const resources = objectProperty(latestBuild, "resources");
  if (!Array.isArray(resources)) return false;

  return resources.some((resource) => {
    const agents = objectProperty(resource, "agents");
    return Array.isArray(agents) && agents.some((agent) => objectProperty(agent, "id") === agentId);
  });
}

export async function verifyWorkspaceAgentAccess({
  coderUrl,
  token,
  workspaceId,
  agentId,
}: WorkspaceAgentAccessInput): Promise<WorkspaceAgentAccessResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WORKSPACE_AUTHORIZATION_TIMEOUT_MS);
    try {
      const response = await fetchCoderApi(
        `${coderUrl.replace(/\/+$/, "")}/api/v2/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          headers: {
            "Content-Type": "application/json",
            "Coder-Session-Token": token,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return { ok: false, status: response.status >= 500 ? 502 : 403 };
      }

      const workspace: unknown = await response.json();
      return workspaceContainsAgent(workspace, agentId) ? { ok: true } : { ok: false, status: 403 };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return { ok: false, status: 502 };
  }
}
