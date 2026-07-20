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
  const coderOrigin = new URL(stripped);
  const coderHost = coderOrigin.host;
  const appProtocol = coderOrigin.protocol;
  const workspaceAppHost = getWorkspaceAppHost(coderHost, wildcardAccessUrl);
  const appHost = (slug: string) => `${slug}${workspaceAppHost}`;
  const appSlug = (application: string) =>
    `${application}--${agentName}--${workspace.name}--${workspace.owner_name}`;

  return {
    filebrowser: `${appProtocol}//${appHost(appSlug("filebrowser"))}`,
    kasmvnc: `${appProtocol}//${appHost(appSlug("kasm-vnc"))}`,
    codeServer: `${appProtocol}//${appHost(appSlug("code-server"))}`,
    dashboard: `${stripped}/@${workspace.owner_name}/${workspace.name}`,
  };
}

export function getWorkspaceAppHost(coderHost: string, wildcardAccessUrl?: string): string {
  if (!wildcardAccessUrl?.trim()) return `.${coderHost}`;

  const withProtocol = wildcardAccessUrl.includes("://")
    ? wildcardAccessUrl
    : `https://${wildcardAccessUrl}`;
  if (!withProtocol.includes("*")) return `.${new URL(withProtocol).host}`;
  const placeholder = "hive-workspace-app-placeholder";
  const host = new URL(withProtocol.replace("*", placeholder)).host;
  return host.replace(placeholder, "");
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
  const absoluteFolderPath = folderPath.trim().startsWith("/")
    ? folderPath.trim()
    : `/${folderPath.trim()}`;
  const fileBrowserRoot = "/home/coder";
  const normalizedFolderPath =
    absoluteFolderPath === fileBrowserRoot
      ? "/"
      : absoluteFolderPath.startsWith(`${fileBrowserRoot}/`)
        ? absoluteFolderPath.slice(fileBrowserRoot.length)
        : "/";
  const encodedFolderPath = normalizedFolderPath.split("/").map(encodeURIComponent).join("/");
  url.pathname = `${basePath}/files${encodedFolderPath}`;
  if (!fileBrowserUrl.startsWith("/")) return url.toString();

  return `${url.pathname}${url.search}${url.hash}`;
}
