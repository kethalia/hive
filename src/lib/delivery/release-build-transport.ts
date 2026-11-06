/** Exact machine-only route exception; the route still verifies GitHub OIDC and
 * journal authority. The Cloudflare private-preview gate runs before this. */
export function isReleaseBuildTransport(
  request: Request,
  enabled: string | undefined,
  testedEnabled?: string,
) {
  if (enabled !== "true" || request.method !== "POST" || request.headers.has("origin"))
    return false;
  const url = new URL(request.url);
  const build = [
    "/api/internal/release-build/challenge",
    "/api/internal/release-build/attestation",
    "/api/internal/native-release/artifact",
    "/api/internal/native-release/grant",
    "/api/internal/native-release/reauthorize",
    "/api/internal/native-release/receipt",
  ].includes(url.pathname);
  const tested =
    testedEnabled === "true" &&
    ["/api/internal/release-tested/challenge", "/api/internal/release-tested/attestation"].includes(
      url.pathname,
    );
  if (url.search || (!build && !tested)) return false;
  const token = request.headers.get("x-hive-release-oidc") ?? "",
    size = request.headers.get("content-length");
  return (
    /^[A-Za-z0-9_.-]{1,16384}$/.test(token) &&
    (size === null || (/^\d+$/.test(size) && Number(size) <= 32768))
  );
}
