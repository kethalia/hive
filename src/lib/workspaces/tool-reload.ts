import type { WorkspaceTool } from "@/components/workspaces/WorkspaceSessionTools";

const WORKSPACE_TOOL_RELOAD_KEY = "hive:pending-workspace-tool";

export interface PendingWorkspaceToolIntent {
  workspaceId: string;
  boardKey: string;
  sessionName: string;
  tool: WorkspaceTool;
}

function isPendingWorkspaceToolIntent(value: unknown): value is PendingWorkspaceToolIntent {
  if (typeof value !== "object" || value === null) return false;
  const properties = Object.fromEntries(Object.entries(value));
  return (
    typeof properties.workspaceId === "string" &&
    properties.workspaceId.length > 0 &&
    typeof properties.boardKey === "string" &&
    properties.boardKey.length > 0 &&
    typeof properties.sessionName === "string" &&
    properties.sessionName.length > 0 &&
    (properties.tool === "code" || properties.tool === "files")
  );
}

export function readPendingWorkspaceToolIntent(): PendingWorkspaceToolIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const serialized = window.sessionStorage.getItem(WORKSPACE_TOOL_RELOAD_KEY);
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    return isPendingWorkspaceToolIntent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingWorkspaceToolIntent(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(WORKSPACE_TOOL_RELOAD_KEY);
}

export function reloadForWorkspaceTool(intent: PendingWorkspaceToolIntent): void {
  window.sessionStorage.setItem(WORKSPACE_TOOL_RELOAD_KEY, JSON.stringify(intent));
  window.location.reload();
}
