import type { CoderWorkspace } from "@/lib/coder/types";

export interface WorkspaceUrls {
  filebrowser: string;
  kasmvnc: string;
  codeServer: string;
  dashboard: string;
}

export function buildWorkspaceUrls(
  workspace: Pick<CoderWorkspace, "name" | "owner_name">,
  agentName: string,
  coderUrl: string,
): WorkspaceUrls | null {
  if (!coderUrl) return null;

  const stripped = coderUrl.replace(/\/+$/, "");
  const coderHost = new URL(stripped).host;

  return {
    filebrowser: `https://filebrowser--${agentName}--${workspace.name}--${workspace.owner_name}.${coderHost}`,
    kasmvnc: `https://kasm-vnc--${agentName}--${workspace.name}--${workspace.owner_name}.${coderHost}`,
    codeServer: `https://code-server--${agentName}--${workspace.name}--${workspace.owner_name}.${coderHost}`,
    dashboard: `${stripped}/@${workspace.owner_name}/${workspace.name}`,
  };
}
