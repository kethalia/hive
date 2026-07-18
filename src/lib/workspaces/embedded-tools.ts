export type EmbeddedWorkspaceTool = "code" | "files";

export const WORKSPACE_TOOL_POPUP_FEATURES = [
  "popup=yes",
  "width=1440",
  "height=960",
  "left=80",
  "top=60",
  "location=no",
  "toolbar=no",
  "menubar=no",
  "status=no",
  "resizable=yes",
  "scrollbars=yes",
].join(",");

export function workspaceToolPopupTarget(tool: EmbeddedWorkspaceTool): string {
  return `hive-${tool}-popup`;
}

export function openWorkspaceToolPopup(url: string, tool: EmbeddedWorkspaceTool): Window | null {
  const popup = window.open(url, workspaceToolPopupTarget(tool), WORKSPACE_TOOL_POPUP_FEATURES);
  if (popup) popup.opener = null;
  return popup;
}
