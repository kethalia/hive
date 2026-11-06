import { type RuntimeOriginEnvironment, runtimeRelayOrigin } from "./preview-auth";

/** Transport exception only. The fixed Next route still verifies the source
 * bearer against current PostgreSQL state; this grants no browser Preview access. */
export function isAgentNotificationCallback(
  request: Request,
  enabled: string | undefined,
  env: RuntimeOriginEnvironment,
) {
  if (
    enabled !== "true" ||
    request.method !== "POST" ||
    request.headers.has("Next-Action") ||
    request.headers.has("Upgrade")
  )
    return false;
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/notifications/events" ||
    request.url.includes("?") ||
    url.search ||
    url.hash
  )
    return false;
  try {
    return url.origin === runtimeRelayOrigin(env);
  } catch {
    return false;
  }
}
