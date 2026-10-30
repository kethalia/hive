const registration = "/api/codex-host/registrations";
const heartbeat =
  /^\/api\/codex-host\/registrations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/heartbeat$/;

export type HostCallbackCapabilities = {
  [name: string]: unknown;
  HIVE_GUARDIAN_ENABLED?: unknown;
  HIVE_DELIVERY_MANAGER_ENABLED?: unknown;
  HIVE_DELIVERY_EXECUTION_ENABLED?: unknown;
  HIVE_DELIVERY_NATIVE_ENABLED?: unknown;
  HIVE_DELIVERY_GITHUB_SOURCE_ENABLED?: unknown;
  HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED?: unknown;
};

/** Only a transport exception. Existing native signature/replay checks remain mandatory. */
export function isHostCallbackTransport(
  request: Request,
  enabled: unknown,
  capabilities: HostCallbackCapabilities = {},
): boolean {
  if (enabled !== "true" || request.method !== "POST") return false;
  const url = new URL(request.url);
  if (
    request.url.includes("?") ||
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
  // Exact installed transports only. Feature flags open transport to their
  // existing signature/replay checks; neither cookies nor this predicate grant
  // producer, task, source, or execution authority.
  const manager = capabilities.HIVE_DELIVERY_MANAGER_ENABLED === "true";
  const limits: Record<string, number> = {
    [registration]: 65536,
    ...(capabilities.HIVE_GUARDIAN_ENABLED === "true"
      ? { "/api/codex-host/guardians": 65536 }
      : {}),
    ...(manager ? { "/api/delivery/host": 65536 } : {}),
    ...(manager && capabilities.HIVE_DELIVERY_EXECUTION_ENABLED === "true"
      ? { "/api/delivery/host/status": 16384 }
      : {}),
    ...(manager && capabilities.HIVE_DELIVERY_NATIVE_ENABLED === "true"
      ? { "/api/delivery/native": 65536 }
      : {}),
    ...(manager && capabilities.HIVE_DELIVERY_GITHUB_SOURCE_ENABLED === "true"
      ? {
          "/api/delivery/github-source/challenge": 65536,
          "/api/delivery/github-source": 1152 * 1024,
        }
      : {}),
    ...(manager && capabilities.HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED === "true"
      ? {
          "/api/delivery/source-publication/policy": 65536,
          "/api/delivery/source-publication/challenge": 65536,
          "/api/delivery/source-publication": 65536,
          "/api/delivery/source-publication/state": 16384,
        }
      : {}),
  };
  const limit = Object.hasOwn(limits, url.pathname)
    ? limits[url.pathname]
    : heartbeat.test(url.pathname)
      ? 4096
      : 0;
  if (!limit) return false;
  const length = request.headers.get("Content-Length");
  return length === null || (/^\d+$/.test(length) && Number(length) <= limit);
}
