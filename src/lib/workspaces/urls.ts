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

export function buildCodeServerFolderUrl(
  codeServerUrl: string,
  folderPath?: string | null,
): string {
  if (!folderPath?.trim()) return codeServerUrl;

  const url = new URL(codeServerUrl);
  url.searchParams.set("folder", folderPath.trim());
  return url.toString();
}

export function buildFileBrowserFolderUrl(
  fileBrowserUrl: string,
  folderPath?: string | null,
): string {
  if (!folderPath?.trim()) return fileBrowserUrl;

  const isRelative = fileBrowserUrl.startsWith("/");
  const url = new URL(fileBrowserUrl, "https://hive.local");
  url.pathname = `/files${folderPath.trim()}`;
  if (!isRelative) return url.toString();

  const proxyPrefix = fileBrowserUrl.replace(/\/+$/, "");
  return `${proxyPrefix}/files${folderPath.trim()}`;
}
