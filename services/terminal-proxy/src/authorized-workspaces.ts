import type { AuthSuccess } from "./auth.js";
import { fetchCoderApi } from "./coder-fetch.js";

const WORKSPACE_LIST_AUTHORIZATION_TIMEOUT_MS = 5_000;

function objectProperty(value: unknown, property: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, property) : undefined;
}

function workspaceIdsFromPayload(payload: unknown): Set<string> {
  const workspaces = objectProperty(payload, "workspaces");
  if (!Array.isArray(workspaces)) return new Set();

  return new Set(
    workspaces
      .map((workspace) => objectProperty(workspace, "id"))
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

export async function resolveAuthorizedWorkspaceIds(auth: AuthSuccess): Promise<Set<string>> {
  const coderUrl = (
    auth.coderUrl ||
    process.env.CODER_URL ||
    process.env.CODER_AGENT_URL ||
    ""
  ).replace(/\/+$/, "");
  if (!coderUrl) throw new Error("coder_url_missing");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WORKSPACE_LIST_AUTHORIZATION_TIMEOUT_MS);
  try {
    const response = await fetchCoderApi(
      `${coderUrl}/api/v2/workspaces?q=${encodeURIComponent("owner:me")}`,
      {
        headers: {
          "Content-Type": "application/json",
          "Coder-Session-Token": auth.token,
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`coder_workspaces_unavailable:${response.status}`);

    const payload: unknown = await response.json();
    return workspaceIdsFromPayload(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}
