export const WORKSPACE_APP_FRAME_ALLOW =
  "fullscreen; clipboard-read; clipboard-write; camera 'none'; microphone 'none'";
export const WORKSPACE_APP_FRAME_SANDBOX =
  "allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts";

/** Cookie scope ignores ports, so a different origin alone is insufficient. */
export function assertWorkspaceAppIsolated(
  appUrl: string,
  hiveHostname: string,
  cookieDomains: readonly string[] = [],
  hiveHostnames: readonly string[] = [],
): URL {
  const error = "Workspace apps must use a separate host outside Hive's session cookie scope.";
  let target: URL;
  try {
    target = new URL(appUrl);
  } catch {
    throw new Error(error);
  }
  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  const hiveHost = hiveHostname.toLowerCase().replace(/\.$/, "");
  const matchesHiveHost = [hiveHost, ...hiveHostnames].some(
    (host) => hostname === host.toLowerCase().replace(/\.$/, ""),
  );
  const overlapsCookieDomain = cookieDomains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
  if (
    !hiveHost ||
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.username ||
    target.password ||
    matchesHiveHost ||
    overlapsCookieDomain
  ) {
    throw new Error(error);
  }
  return target;
}
