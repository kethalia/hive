export const WORKSPACE_TOOL_PANE_STATE_VERSION = 1;

export type PersistedWorkspaceTool = "code" | "files" | "logs";

export interface PersistedWorkspaceToolPane {
  boardKey: string;
  sessionName: string;
  tool: PersistedWorkspaceTool;
  label: string;
  cloneSessionKey?: string;
  relativePath?: string;
}

interface PersistedWorkspaceToolPaneState {
  version: typeof WORKSPACE_TOOL_PANE_STATE_VERSION;
  panes: PersistedWorkspaceToolPane[];
}

const MAX_PANES = 32;
const MAX_VALUE_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_VALUE_LENGTH) return null;
  return normalized;
}

function safeRelativePath(value: unknown): string | null {
  const relativePath = safeString(value);
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) return null;
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return relativePath;
}

function safeTool(value: unknown): PersistedWorkspaceTool | null {
  if (value === "code") return value;
  if (value === "files") return value;
  if (value === "logs") return value;
  return null;
}

function parsePane(value: unknown): PersistedWorkspaceToolPane | null {
  if (!isRecord(value)) return null;
  const boardKey = safeString(value.boardKey);
  const sessionName = safeString(value.sessionName);
  const label = safeString(value.label);
  const tool = safeTool(value.tool);
  if (!boardKey) return null;
  if (!sessionName) return null;
  if (!label) return null;
  if (!tool) return null;

  const cloneSessionKey = safeString(value.cloneSessionKey);
  const relativePath = safeRelativePath(value.relativePath);
  if (Boolean(cloneSessionKey) !== Boolean(relativePath)) return null;

  const pane = {
    boardKey,
    sessionName,
    tool,
    label,
  };
  if (cloneSessionKey && relativePath) return { ...pane, cloneSessionKey, relativePath };
  return pane;
}

export function workspaceToolPaneStorageKey(
  workspaceId: string,
  source: "workspace" | "unified",
): string {
  return `workspace-tool-panes:${source}:${workspaceId}`;
}

export function parsePersistedWorkspaceToolPanes(
  persistedJson: string | null,
): PersistedWorkspaceToolPane[] {
  if (!persistedJson) return [];

  try {
    const parsed = JSON.parse(persistedJson) as unknown;
    if (!isRecord(parsed) || parsed.version !== WORKSPACE_TOOL_PANE_STATE_VERSION) return [];
    if (!Array.isArray(parsed.panes)) return [];

    const seen = new Set<string>();
    const panes: PersistedWorkspaceToolPane[] = [];
    for (const candidate of parsed.panes.slice(0, MAX_PANES)) {
      const pane = parsePane(candidate);
      if (!pane) continue;
      const identity = `${pane.boardKey}\0${pane.sessionName}\0${pane.tool}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      panes.push(pane);
    }
    return panes;
  } catch {
    return [];
  }
}

export function serializeWorkspaceToolPanes(panes: readonly PersistedWorkspaceToolPane[]): string {
  const state: PersistedWorkspaceToolPaneState = {
    version: WORKSPACE_TOOL_PANE_STATE_VERSION,
    panes: panes.slice(0, MAX_PANES),
  };
  return JSON.stringify(state);
}
