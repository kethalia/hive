/** A machine transport exception only: the route independently verifies OIDC,
 * the accepted plan, current release lease and per-operation authority. */
export function isDatabaseJobTransport(request: Request, enabled?: string) {
  if (enabled !== "true" || request.method !== "POST" || request.headers.has("origin"))
    return false;
  const url = new URL(request.url);
  if (
    url.search ||
    url.hash ||
    !["/api/delivery/database-jobs/approve", "/api/delivery/database-jobs/authorize"].includes(
      url.pathname,
    )
  )
    return false;
  const token = request.headers.get("x-hive-database-oidc") ?? "";
  const size = request.headers.get("content-length");
  return (
    /^[A-Za-z0-9_.-]{1,16384}$/.test(token) &&
    (size === null || (/^\d+$/.test(size) && Number(size) <= 49152))
  );
}
