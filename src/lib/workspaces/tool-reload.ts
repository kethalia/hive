import type { WorkspaceTool } from "@/components/workspaces/WorkspaceSessionTools";

const WORKSPACE_TOOL_RELOAD_KEY = "hive:pending-workspace-tool";

export interface PendingWorkspaceToolIntent {
  workspaceId: string;
  boardKey: string;
  sessionName: string;
  tool: WorkspaceTool;
  cloneSessionKey?: string;
  relativePath?: string;
  label?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasValidOptionalCloneIdentity(properties: Record<string, unknown>): boolean {
  const cloneIdentityValues = [
    properties.cloneSessionKey,
    properties.relativePath,
    properties.label,
  ];
  const hasNoCloneIdentity = cloneIdentityValues.every((candidate) => candidate === undefined);
  const hasCompleteCloneIdentity = cloneIdentityValues.every(isNonEmptyString);
  return hasNoCloneIdentity || hasCompleteCloneIdentity;
}

function isPendingWorkspaceToolIntent(value: unknown): value is PendingWorkspaceToolIntent {
  if (typeof value !== "object" || value === null) return false;
  const properties = Object.fromEntries(Object.entries(value));
  const requiredIdentifiers = [properties.workspaceId, properties.boardKey, properties.sessionName];
  const hasRequiredIdentifiers = requiredIdentifiers.every(isNonEmptyString);
  const hasValidTool = ["code", "files"].includes(String(properties.tool));
  return hasRequiredIdentifiers && hasValidTool && hasValidOptionalCloneIdentity(properties);
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
