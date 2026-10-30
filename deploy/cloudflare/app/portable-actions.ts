export type PortableActions = {
  schemaVersion: number;
  actions: Record<string, { paths: readonly string[] }>;
};

/** Runtime compatibility only: Next's CSRF, authentication, input validation and
 * current Coder authorization still run. Action IDs come from this exact build. */
export function isPortableServerAction(request: Request, manifest: PortableActions): boolean {
  if (manifest.schemaVersion !== 1 || request.method !== "POST") return false;
  const id = request.headers.get("Next-Action");
  if (!id || !/^[0-7][a-f0-9]{41}$/.test(id) || !Object.hasOwn(manifest.actions, id)) return false;
  const url = new URL(request.url);
  const length = request.headers.get("Content-Length");
  return (
    !request.url.includes("?") &&
    !url.hash &&
    !url.pathname.includes("%") &&
    manifest.actions[id].paths.includes(url.pathname) &&
    request.headers.get("Origin") === url.origin &&
    (!request.headers.has("Sec-Fetch-Site") ||
      request.headers.get("Sec-Fetch-Site") === "same-origin") &&
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "text/plain" &&
    !request.headers.has("Content-Encoding") &&
    !request.headers.has("Upgrade") &&
    (length === null || (/^\d+$/.test(length) && Number(length) <= 65536))
  );
}

const discoveryPaths = new Set([
  "/api/discovery/workspaces",
  "/api/discovery/template-options",
  "/api/discovery/agent",
  "/api/discovery/templates",
]);
export function isPortableDiscovery(request: Request): boolean {
  return request.method === "GET" && discoveryPaths.has(new URL(request.url).pathname);
}

export function isUnsupportedPageMutation(request: Request, manifest: PortableActions): boolean {
  // Next also dispatches headerless multipart/$ACTION_ID forms. They must not
  // bypass the export allowlist merely by omitting the Next-Action header.
  return (
    !new URL(request.url).pathname.startsWith("/api/") &&
    !["GET", "HEAD"].includes(request.method) &&
    !isPortableServerAction(request, manifest)
  );
}
