const registration = "/api/codex-host/registrations";
const heartbeat =
  /^\/api\/codex-host\/registrations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/heartbeat$/;

/** Only a transport exception. Existing native signature/replay checks remain mandatory. */
export function isHostCallbackTransport(request: Request, enabled: unknown): boolean {
  if (enabled !== "true" || request.method !== "POST") return false;
  const url = new URL(request.url);
  if (
    url.search ||
    url.hash ||
    url.pathname.includes("%") ||
    request.headers.has("Origin") ||
    request.headers.has("Sec-Fetch-Site") ||
    request.headers.has("Upgrade") ||
    request.headers.has("Next-Action") ||
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("Content-Encoding")
  )
    return false;
  const limit = url.pathname === registration ? 65536 : heartbeat.test(url.pathname) ? 4096 : 0;
  if (!limit) return false;
  const length = request.headers.get("Content-Length");
  return length === null || (/^\d+$/.test(length) && Number(length) <= limit);
}
