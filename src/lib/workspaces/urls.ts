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
  wildcardAccessUrl?: string,
): WorkspaceUrls | null {
  if (!coderUrl) return null;

  const stripped = coderUrl.replace(/\/+$/, "");
  const coderHost = new URL(stripped).host;
  const workspaceAppHost = getWorkspaceAppHost(coderHost, wildcardAccessUrl);

  return {
    filebrowser: `https://filebrowser--${agentName}--${workspace.name}--${workspace.owner_name}.${workspaceAppHost}`,
    kasmvnc: `https://kasm-vnc--${agentName}--${workspace.name}--${workspace.owner_name}.${workspaceAppHost}`,
    codeServer: `https://code-server--${agentName}--${workspace.name}--${workspace.owner_name}.${workspaceAppHost}`,
    dashboard: `${stripped}/@${workspace.owner_name}/${workspace.name}`,
  };
}

export function getWorkspaceAppHost(coderHost: string, wildcardAccessUrl?: string): string {
  if (!wildcardAccessUrl?.trim()) return coderHost;

  const withProtocol = wildcardAccessUrl.includes("://")
    ? wildcardAccessUrl
    : `https://${wildcardAccessUrl}`;
  return new URL(withProtocol.replace("*.", "placeholder.")).host.replace(/^placeholder\./, "");
}

export function buildCodeServerFolderUrl(
  codeServerUrl: string,
  folderPath?: string | null,
): string {
  if (!folderPath?.trim()) return codeServerUrl;

  const isRelative = codeServerUrl.startsWith("/");
  const url = new URL(codeServerUrl, "https://hive.local");
  url.searchParams.set("folder", folderPath.trim());
  return isRelative ? `${url.pathname}${url.search}` : url.toString();
}

export function buildFileBrowserFolderUrl(
  fileBrowserUrl: string,
  folderPath?: string | null,
): string {
  if (!folderPath?.trim()) return fileBrowserUrl;

  const url = new URL(fileBrowserUrl, "https://hive.local");
  const basePath = url.pathname.replace(/\/+$/, "");
  const normalizedFolderPath = folderPath.trim().startsWith("/")
    ? folderPath.trim()
    : `/${folderPath.trim()}`;
  url.pathname = `${basePath}/files${normalizedFolderPath}`;
  if (!fileBrowserUrl.startsWith("/")) return url.toString();

  return `${url.pathname}${url.search}${url.hash}`;
}
