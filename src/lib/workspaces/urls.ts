import type { CoderWorkspace } from "@/lib/coder/types";

export interface WorkspaceUrls {
  filebrowser: string;
  kasmvnc: string;
  dashboard: string;
}

export function buildWorkspaceUrls(
  workspace: Pick<CoderWorkspace, "name" | "owner_name">,
  agentName: string,
  coderUrl: string,
): WorkspaceUrls {
  const stripped = coderUrl.replace(/\/+$/, "");
  const coderHost = stripped.replace(/^https?:\/\//, "");

  return {
    filebrowser: `https://filebrowser--${agentName}--${workspace.name}--${workspace.owner_name}.${coderHost}`,
    kasmvnc: `https://kasmvnc--${agentName}--${workspace.name}--${workspace.owner_name}.${coderHost}`,
    dashboard: `${stripped}/@${workspace.owner_name}/${workspace.name}`,
  };
}
